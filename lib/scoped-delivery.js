import crypto from 'node:crypto'
import {createSessionDelivery} from './session-delivery.js'
import {readDeliveries} from './delivery-state.js'
import {assertScene} from '../tools/lib/memory-context.mjs'

const hash=parts=>crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0,24)
export function captureDeliveryIdentity(cfg) {
  return { account: String(cfg.self?.mid ?? '').trim(), owner: String(cfg.owner?.mid ?? '').trim() }
}

export function assertDeliveryIdentity(cfg, expected) {
  const identity = captureDeliveryIdentity(cfg)
  if (!expected || !identity.account || !identity.owner || identity.account !== expected.account || identity.owner !== expected.owner) {
    throw Object.assign(Error('账号或主人已变化，停止旧任务'), { code: 'DELIVERY_IDENTITY_CHANGED' })
  }
  return cfg
}

export function legacyScopeKeys(account,owner,scene,taskId){
 const privateScene=scene.startsWith('private-'),volatile=scene==='reply'
 return [...new Set([
  hash([account,owner,privateScene?'private-main':scene,privateScene?'main':taskId]),
  hash([account,owner,privateScene?'private-main':volatile?taskId:scene,privateScene?'main':volatile?taskId:'main'])
 ])]
}
// Routing metadata is trusted adapter input, never inferred from message text.
export function createScopedDelivery(options){
 const routes=new Map()
 const pending=new Map()
 function route(scene,taskId,role,identity,expectedScope){
  assertScene(scene)
  assertDeliveryIdentity(options.config(), identity)
  const {account,owner}=identity
  role??=scene.startsWith('private-')?'private-main':'public-task'
  if(!['private-main','browse-main','public-task'].includes(role)||role==='private-main'&&!scene.startsWith('private-')||role==='browse-main'&&scene!=='public-recommendation'||role==='public-task'&&scene.startsWith('private-'))throw Error('会话角色与场景不一致')
  // Retain the verified private-main namespace; new roles use schema 2 keys.
  const key=role==='private-main'?hash([account,owner,'private-main','main']):hash([account,owner,2,role,role==='browse-main'?'main':scene,role==='browse-main'?'main':taskId])
  const legacy=role==='browse-main'?['public-recommendation','private-recommendation'].flatMap(s=>legacyScopeKeys(account,owner,s,taskId)):legacyScopeKeys(account,owner,scene,taskId)
  if(expectedScope&&key!==expectedScope&&!legacy.includes(expectedScope))return null
  const checkIdentity=()=>assertDeliveryIdentity(options.config(), identity)
  if(!routes.has(key)){
   const delivery=createSessionDelivery({...options,sessionRole:role,scopeKey:key,config:checkIdentity,memoryContext:r=>{checkIdentity();return options.memoryContext?.(r)??''},sessionId:crypto.randomUUID(),sessionFile:'whale-session-'+key+'.json',contextGeneration:()=>{checkIdentity();return options.contextGeneration?.()??options.permissionVersion?.()??0}})
   routes.set(key,{delivery,key,role,active:0})
  }
  return {record:routes.get(key),legacy,identity}
 }
 function release(record,id){
  record.active--
  if(record.role==='public-task'&&!record.active&&pending.get(id)?.record!==record)routes.delete(record.key)
 }
 return {
  send(request,signal,flags){
   const {identity,memoryScene,sessionRole,taskKind,memoryQuery,sourceEventIds,...hostRequest}=request
   const id=hostRequest.requestId,r=route(memoryScene,id,sessionRole,identity)
   const record=r.record
   record.active++
   if(flags?.retainUntilAck)pending.set(id,r)
   return record.delivery.send(hostRequest,signal,{...flags,memoryScene,sessionRole:record.role,taskKind,memoryQuery,sourceEventIds,compatibleScopeKeys:r.legacy})
    .catch(error=>{if(pending.get(id)===r)pending.delete(id);throw error})
    .finally(()=>release(record,id))
  },
  async confirm(id){
   let r=pending.get(id)
   if(!r){
    const entry=readDeliveries(options.dshHome).find(row=>row.requestId===id)
    if(!entry?.scopeKey||!entry.memoryScene)return
    r=route(entry.memoryScene,id,entry.sessionRole,captureDeliveryIdentity(options.config()),entry.scopeKey)
    if(!r)return
   }
   const record=r.record
   record.active++
   try{
    assertDeliveryIdentity(options.config(),r.identity)
    await record.delivery.confirm(id,r.legacy)
    if(pending.get(id)===r)pending.delete(id)
   }finally{release(record,id)}
  },
 }
}
