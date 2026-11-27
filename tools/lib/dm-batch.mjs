import crypto from 'node:crypto'
import path from 'node:path'
import {acquireProcessLock} from './process-lock.mjs'
import {chatConfig} from './chat-config.mjs'

const SKIP=new Set(['不回','不说','不发','（不回）','（不说）','（不发）','(不回)','(不说)','(不发)'])

export const dmBatchBusy=(s)=>(s?.settings?.dmBatches??[]).some(b=>['sending','unconfirmed'].includes(b.status))

export function parseMessages(input,maxParts=6){
  const value=typeof input==='string'?input.trim():input
  if(!value||typeof value==='string'&&SKIP.has(value))return []
  const rows=Array.isArray(value)?value:String(value).split(/\r?\n/).filter(x=>x.trim()&&!/^[-–—]{3,}$/.test(x.trim()))
  if(rows.some(x=>typeof x!=='string'))throw Error('多段正文必须是字符串数组')
  const messages=rows.map(x=>x.trim()).filter(x=>x&&!SKIP.has(x))
  if(messages.length>maxParts)throw Error('超过 '+maxParts+' 条，未截断或发送；请整理后重试')
  if(messages.some(x=>x.length>300))throw Error('单条超过 300 字；未截断或发送')
  if(new Set(messages).size!==messages.length)throw Error('同组有重复正文，请合并后重试')
  return messages
}

export async function createBatch(store,input,{config={},taskId=null,key=''}={}){
  const release=await acquireProcessLock(path.join(store.dir,'dm-batch-create'))
  try{return await prepareBatch(store,input,{config,taskId,key})}finally{await release()}
}

async function prepareBatch(store,input,{config={},taskId=null,key=''}={}){
  const c=chatConfig(config.chat),messages=parseMessages(input,c.multi?c.maxParts:1)
  if(!messages.length)return null
  const signature=crypto.createHash('sha256').update(JSON.stringify([messages,taskId])).digest('hex')
  const existing=(store.read().settings.dmBatches??[]).find(b=>(key?b.key===key:b.signature===signature)&&store.now()-b.at<86400000)
  if(existing){if(existing.signature!==signature)throw Error('同一任务的正文已变化，请先核查原发送组');return existing}
  return await store.tx(s=>{
    const batches=s.settings.dmBatches??=[]
    if(batches.filter(b=>b.status!=='sent'&&b.status!=='cancelled').length>=30)throw Error('待发送组过多，请先处理')
    const b={
      id:crypto.randomUUID(),
      key,
      signature,
      taskId:taskId??null,
      at:store.now(),
      owner:String(config.owner?.mid??''),
      policy:s.settings.policyRevision??0,
      status:'ready',
      parts:messages.map(text=>({partId:crypto.randomUUID(),text,status:'ready'})),
    }
    batches.push(b)
    s.settings.dmBatches=batches.filter(x=>x.status!=='sent'||store.now()-x.at<7*86400000)
    return b
  })
}

export async function sendBatch(store,id,{run,config,signal}={}){
  const release=await acquireProcessLock(path.join(store.dir,'dm-batch-send'))
  const update=fn=>store.tx(s=>{const b=(s.settings.dmBatches??[]).find(x=>x.id===id);if(!b)throw Error('发送组不存在');return fn(b,s)})
  try{
    let b=(store.read().settings.dmBatches??[]).find(x=>x.id===id)
    if(!b)throw Error('发送组不存在')
    if(b.status==='sent')return b
    if(b.status==='cancelled')throw Error('发送组已取消')
    for(let i=0;i<b.parts.length;i++){
      signal?.throwIfAborted()
      const full=typeof config==='function'?config():config
      const s=store.read(),part=b.parts[i],partId=part.partId??part.draftId
      if(b.owner!==String(full.owner?.mid)||b.policy!==(s.settings.policyRevision??0)||store.now()-b.at>86400000)throw Error('发送组目标/策略变化或已过期，请核查剩余正文')
      if(part.status==='sent')continue
      const alreadySent=s.events.some(e=>e.kind==='sent'&&partId&&e.data?.batchPartId===partId)
      if(alreadySent){await update(x=>{x.parts[i].status='sent'});continue}
      if(partId&&Object.values(s.pending).some(p=>p.batchPartId===partId)){
        await update(x=>{x.status='unconfirmed';x.parts[i].status='unconfirmed'});throw Error('第 '+(i+1)+' 条回执未知，先核查；剩余正文已保留')
      }
      const args=['dm','--account',String(full.self?.mid??''),'--to',String(full.owner?.mid??''),'--msg',part.text,'--batch-part',partId,'--auto']
      const dry=await run([...args,'--dry'],signal)
      signal?.throwIfAborted()
      if(!dry.ok)throw Error('第 '+(i+1)+' 条预检失败：'+String(dry.err??'').slice(-300))
      await update(x=>{x.status='sending';x.parts[i].status='sending'})
      const result=await run([...args,'--go'],signal)
      const after=store.read()
      const confirmed=after.events.some(e=>e.kind==='sent'&&partId&&e.data?.batchPartId===partId)
      const uncertain=partId&&Object.values(after.pending).some(p=>p.batchPartId===partId)
      await update(x=>{x.parts[i].status=confirmed?'sent':uncertain?'unconfirmed':'ready';x.status=confirmed?'sending':uncertain?'unconfirmed':'partial'})
      if(!confirmed)throw Error('第 '+(i+1)+' 条未确认，剩余正文已保留：'+String(result.err??'').slice(-300))
      b=(store.read().settings.dmBatches??[]).find(x=>x.id===id)
    }
    return await update(x=>{x.status='sent';return x})
  }finally{await release()}
}

export async function cancelBatch(store,id){
  const release=await acquireProcessLock(path.join(store.dir,'dm-batch-send'))
  try{return await store.tx(s=>{
    const b=(s.settings.dmBatches??[]).find(x=>x.id===id);if(!b)throw Error('发送组不存在')
    if(b.parts.some(part=>{const pid=part.partId??part.draftId;return pid&&Object.values(s.pending).some(p=>p.batchPartId===pid)}))throw Error('存在未确认发送，先核查回执')
    for(const part of b.parts){const pid=part.partId??part.draftId;if(pid&&s.events.some(e=>e.kind==='sent'&&e.data?.batchPartId===pid))part.status='sent'}
    b.status='cancelled';return b
  })}finally{await release()}
}
