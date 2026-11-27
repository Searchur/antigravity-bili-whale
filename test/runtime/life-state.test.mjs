/**
 * 长期状态事务、记忆召回、心情覆盖与批次私信恢复单元测试。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createBatch, sendBatch } from '../../src/social/dm-batch.mjs'
import { readHistory } from '../../src/social/dm-history.mjs'
import { createLifeStore } from '../../src/life/store.mjs'
import { archiveDigest } from '../../src/life/archive.mjs'
import { createAffectWorker } from '../../src/daemon/affect-worker.mjs'
import { buildActivityCalendar } from '../../src/console/activity-stats.mjs'
import { makePlan, completePlan, dayOf } from '../../src/config/night-plan.mjs'

const full = { self: { mid: '100' }, owner: { mid: '200' } }
function localStore(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-state-regression-'))
  t.after(() => fs.rmSync(home, {recursive:true, force:true}))
  return createLifeStore({whaleHome:home, account:'100', owner:'200', ...options})
}

test('D03 live evidence survives compaction until its last reference is released', async t => {
  let clock = Date.UTC(2026, 0, 1)
  const store = localStore(t, {now:()=>clock})
  const references = []
  for (const text of ['primary', 'counterexample', 'independent origin', 'relation source']) {
    references.push(await store.record('observed', {origin:'tool', text}))
  }
  const [source, counter, origin, tag] = references.map(e=>e.id)
  await store.tx(s => s.memories.push({id:'m', active:true, sourceIds:[source], counterEvidenceIds:[counter],
    originEvidenceIds:[origin], relevance:{schema:1, version:1, tags:[{key:'a'.repeat(64),eventId:tag,at:clock,method:'lexical',relation:'related'}]}}))
  clock += 31 * 86400000
  await store.archive()
  assert.deepEqual(store.read().events.map(e=>e.id), [source, counter, origin, tag])
  await store.revoke('m')
  const state = store.read()
  assert.equal(state.events.some(e=>references.some(r=>r.id===e.id)), false)
  assert.equal(state.settings.forgottenEvents, 4)
})

test('D04 same-page withdrawals remove exactly the referenced 64-bit messages', async t => {
  const ids = ['9876543210987654321','9876543210987654322','9876543210987654323']
  const keys = [...ids,'9876543210987654324']
  const messages = keys.map(msg_key=>({msg_key, sender_uid:'200', timestamp:100, msg_type:1, content:'hello'}))
  const withdrawals = [ids[0], '{"msg_key":'+ids[1]+'}', JSON.stringify({msg_key:'old',msg_key_str:ids[2]})]
  withdrawals.forEach((content,i)=>messages.push({msg_key:'withdraw'+i, sender_uid:'200', timestamp:101, msg_type:5, content}))
  const original = process.env.BILI_TRAFFIC_TEST
  const context = process.env.NODE_TEST_CONTEXT
  process.env.BILI_TRAFFIC_TEST = '1'
  process.env.NODE_TEST_CONTEXT ??= 'audit-state-test'
  t.after(()=>{if(context===undefined)delete process.env.NODE_TEST_CONTEXT})
  t.after(()=>{if(original===undefined)delete process.env.BILI_TRAFFIC_TEST;else process.env.BILI_TRAFFIC_TEST=original})
  t.mock.method(globalThis, 'fetch', async ()=>Response.json({code:0,data:{messages,has_more:0}}))
  const keysForSigning = {img_url:'https://example.invalid/'+'x'.repeat(32)+'.png', sub_url:'https://example.invalid/'+'y'.repeat(32)+'.png'}
  const result=await readHistory('200',{}, {lastSeen:1}, {nav:{code:0,data:{wbi_img:keysForSigning}}})
  assert.deepEqual(result.messages.map(m=>m.key), [keys[3]])
})

test('D06 batch preview and resumed dispatch use the saved task decision and receipts', async t => {
  const store=localStore(t)
  const taskId='task-one'
  await store.captureContext(taskId,'','private-reply','session')
  const batch=await createBatch(store,['first','second'],{config:full,taskId})
  const partRequest=i=>({channel:'dm',scene:'private-reply',target:'200',text:batch.parts[i].text,batchPartId:batch.parts[i].partId,auto:true})
  await store.recordDecision({taskId,action:'abstain',reason:'no reply',memoryIds:[]})
  assert.equal(store.check(partRequest(0)).allow,false)
  await store.recordDecision({taskId,action:'reply',reason:'reply',memoryIds:[]})
  const token = await store.reserve(partRequest(0))
  await store.dispatch(token,()=>Promise.resolve())
  await store.settle(token,{status:'sent',receipt:'first-receipt'})
  const secondToken = await store.reserve(partRequest(1))
  await store.recordDecision({taskId,action:'abstain',reason:'stop after first',memoryIds:[]})
  await assert.rejects(store.dispatch(secondToken,()=>assert.fail('unexpected dispatch')),/不行动/)
  assert.deepEqual(store.decisionTraces()[0].outcomes.map(o=>o.receipt),['first-receipt'])
  assert.equal(store.read().pending[secondToken].taskId,taskId)
})

test('D06 each batch child gets the same task on first send and resume', async t => {
  const store=localStore(t), taskId='resumable-task'
  const batch=await createBatch(store,['one','two'],{config:full,taskId})
  const confirmed=[]
  let interrupted=false
  async function run(args) {
    const arg=key=>args[args.indexOf(key)+1]
    assert.ok(args.includes('--task'))
    assert.equal(arg('--task'),taskId)
    if(arg('--msg')==='two'&&!interrupted){interrupted=true;return {ok:false,err:'simulated interruption'}}
    if(args.includes('--go')){
      const request={channel:'dm',target:arg('--to'),scene:'private-reply',batchPartId:arg('--batch-part'),text:arg('--msg'),auto:true}
      const token=await store.reserve(request)
      await store.dispatch(token,()=>Promise.resolve())
      await store.settle(token,{status:'sent',receipt:request.text})
      confirmed.push(request.text)
    }
    return {ok:true}
  }
  await assert.rejects(sendBatch(store,batch.id,{config:full,run}),/simulated interruption/)
  await sendBatch(store,batch.id,{config:full,run})
  assert.deepEqual(confirmed,['one','two'])
})

async function sendFixture(store, request, receipt) {
  const token=await store.reserve(request)
  await store.dispatch(token,()=>Promise.resolve())
  await store.settle(token,{status:'sent',receipt})
}

async function seedTopic(store) {
  await store.tx(s=>s.affect.topics.push({id:'topic',revision:1,status:'open',expiresAt:store.now()+86400000,
    summary:'a'.repeat(180),reasonToShare:'b'.repeat(180),sourceEventIds:[],sources:[],priority:0.9,credit:10,
    accrualAdded:0,creditReleased:false,visibility:'private',nextAccrualAt:store.now()+86400000}))
}

test('D14 a valid analysis returned after 60 seconds commits under its original lease', async t=>{
  let clock=Date.UTC(2026,0,1)
  const store=localStore(t,{now:()=>clock})
  await store.ingestOwnerMessage({actor:'200',messageId:'m',text:'hello'})
  clock+=30001
  const worker=createAffectWorker({store:()=>store,config:()=>full,now:()=>clock,complete:async()=>{
    clock+=60000
    return JSON.stringify({moodEffects:[],topicEffects:[],contextHints:[]})
  }})
  assert.equal((await worker.tick()).status,'idle')
  assert.equal(store.read().affect.jobs.length,0)
  assert.equal(store.read().affect.recentChanges.at(-1).code,'analysis-committed')
})

test('D14 coverage can commit after 60 seconds but rejects a different lease', async t=>{
  let clock=Date.UTC(2026,0,1)
  const store=localStore(t,{now:()=>clock})
  await seedTopic(store)
  await sendFixture(store,{channel:'dm',target:'200',scene:'private-reply',text:'owner text'},'r')
  const job=await store.claimAffectCoverage()
  const coverage=JSON.stringify({covered:true,quote:'owner'})
  await assert.rejects(store.commitAffectCoverage({...job,lease:'other'},coverage),/STALE/)
  clock+=60000
  assert.equal((await store.commitAffectCoverage(job,coverage)).covered,true)
})

test('D20 only an owner DM receipt can start reconciling the owner private topic', async t=>{
  const store=localStore(t)
  await seedTopic(store)
  const fan={channel:'dm',target:'300',scene:'private-reply',text:'fan reply'}
  const token=await store.reserve(fan)
  assert.deepEqual(store.read().pending[token].affectTopicRefs??[],[])
  // 既有检查点中可能保留早期在收件人校验上线前生成的绑定记录。
  await store.tx(s=>{s.pending[token].affectTopicRefs=[{topicId:'topic',revision:1}]})
  await store.dispatch(token,()=>Promise.resolve())
  await store.settle(token,{status:'sent',receipt:'fan'})
  assert.equal(store.read().affect.topics[0].status,'open')
  await sendFixture(store,{...fan,target:'200',text:'owner reply'},'owner')
  assert.equal(store.read().affect.topics[0].status,'needs-reconcile')
})

test('D21 explicit and implicit owner replies only reference this owner DM conversation', async t=>{
  const store=localStore(t)
  await sendFixture(store,{channel:'comment',target:'video',thread:'1:12:top',scene:'public-comment',text:'public'},'1')
  const incoming=id=>store.ingestOwnerMessage({actor:'200',messageId:id,text:'reply'})
  assert.equal((await incoming('a')).replyTo,null)
  await sendFixture(store,{channel:'dm',target:'300',scene:'private-reply',text:'fan'},'2')
  assert.equal((await store.ingestOwnerMessage({actor:'200',messageId:'b',text:'reply',replyTo:'2'})).replyTo,null)
  await sendFixture(store,{channel:'dm',target:'200',scene:'private-reply',text:'owner'},'3')
  const ownerSend=store.read().events.find(e=>e.receipt==='3')
  assert.equal((await incoming('c')).replyTo,ownerSend.id)
})

test('D22 context budget, segments and identifier describe the exact delivered text', async t=>{
  const store=localStore(t)
  await seedTopic(store)
  const snapshot=limit=>store.contextSnapshot('','private-reply',{limit})
  const small=snapshot(500), normal=snapshot(2000)
  assert.ok([...small.text].length<=500)
  assert.equal(normal.text,normal.segments.map(s=>s.text).join('\n'))
  assert.equal(normal.budget.used,[...normal.text].length)
  await store.tx(s=>{s.affect.topics[0].summary='c'.repeat(180)})
  const changed=snapshot(2000)
  assert.notEqual(changed.text,normal.text)
  assert.notEqual(changed.contextId,normal.contextId)
})

test('D28 calendar counts verified archives and reports missing or mismatched data',async t=>{
  const store=localStore(t), dir=path.join(store.dir,'archive')
  fs.mkdirSync(dir,{recursive:true})
  const raw=JSON.stringify({events:[{kind:'video-read',at:store.now(),text:'fixture'}]})
  fs.writeFileSync(path.join(dir,'ok.json'),raw)
  fs.writeFileSync(path.join(dir,'incorrect.json'),raw)
  await store.tx(s=>s.archives.push({name:'ok.json',digest:archiveDigest(raw)},{name:'incorrect.json',digest:'wrong'},{name:'missing.json',digest:archiveDigest(raw)}))
  const calendar=buildActivityCalendar({whaleHome:store.dir,store,cfg:full})
  assert.equal(calendar.totals.watched,1)
  assert.equal(calendar.incomplete,true)
  assert.equal(calendar.diagnostics.length,2)
})

test('D29 calendar classifies incoming owner DMs and verified owner comment replies independently',async t=>{
  const store=localStore(t)
  await store.ingestOwnerMessage({actor:'200',messageId:'m',text:'owner DM'})
  const request={channel:'comment',thread:'1:12:34',target:'video',scene:'reply',text:'reply'}
  await sendFixture(store,{...request,parent:'36',replyToMid:'200'},'owner-comment')
  await sendFixture(store,{...request,parent:'37',text:'other',replyToMid:'300'},'fan-comment')
  const {totals}=buildActivityCalendar({whaleHome:store.dir,store,cfg:full})
  assert.deepEqual([totals.ownerDm,totals.ownerComment,totals.ownerInteract],[1,1,2])
})

test('D30 a skipped plan consumes a window opportunity while only accepted deliveries count as wakes', async t => {
  const now = new Date(2026, 10, 26, 21).getTime()
  const store = localStore(t, {now: () => now})
  const plan = makePlan({windows: [{start:'20:00', end:'24:00', wakes:2}], skipChance:0.8}, {}, now, () => 0)
  assert.equal(plan.action, 'skip')
  fs.mkdirSync(store.dir, {recursive:true})
  fs.mkdirSync(path.join(store.dir, 'state'), { recursive: true })
  fs.writeFileSync(path.join(store.dir, 'state', 'schedule.json'), JSON.stringify(completePlan(plan, now)))
  const calendar = () => buildActivityCalendar({whaleHome:store.dir, store, cfg:full, now:() => now})
  await store.recordScheduler('night-triggered', {runId:'manual'})
  await store.recordDelivery({channel:'wake', requestId:'unconfirmed', attempt:1, status:'unconfirmed'})
  assert.equal(calendar().totals.wakes, 0)
  assert.equal(calendar().days[dayOf(now)].opportunitiesUsed, 1)
  assert.equal(calendar().activeDays, 0)
  await store.recordDelivery({channel:'wake', requestId:'accepted', attempt:1, status:'accepted'})
  assert.equal(calendar().totals.wakes, 1)
  assert.equal(calendar().totals.opportunitiesUsed, 1)
})
