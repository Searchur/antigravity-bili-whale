/**
 * 宿主与安装安全单元测试：覆盖运行包校验、原地回滚、双层安全复审预算与脱敏诊断导出。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { copyRuntimeFixture } from '../fixtures/plugin-package.mjs'
import { modelUsageFixture } from '../fixtures/model-usage.mjs'
import { installPluginPayload, validatePluginPayload } from '../../src/plugin/install.mjs'
import { createSafetyReviewer } from '../../src/daemon/safety-worker.mjs'
import { enforceOutboundSafety } from '../../src/social/content-safety.mjs'
import { createApiHandlers } from '../../src/console/api-handlers.mjs'
import { checkForUpdate } from '../../src/plugin/updater.mjs'
import { createScopedDelivery } from '../../src/daemon/scoped-delivery.mjs'
import { evaluateModelQuota } from '../../src/host/model-quota-guard.mjs'
import { createLifeStore } from '../../src/life/store.mjs'
import { dataPathsFor } from '../../src/core/data-paths.mjs'

function temporaryDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-host-regression-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('installer rejects missing release files and preserves the existing install', async t => {
  const dir = temporaryDirectory(t)
  const source = path.join(dir, 'source')
  const destination = path.join(dir, 'installed')
  copyRuntimeFixture(source, '1.6.5')
  fs.mkdirSync(destination)
  fs.writeFileSync(path.join(destination, 'old.txt'), 'keep')
  fs.unlinkSync(path.join(source, 'src/cli/commands/favorites.mjs'))
  await assert.rejects(installPluginPayload({source, destination, dataPaths: []}), /favorites\.mjs/)
  assert.deepEqual(fs.readdirSync(destination), ['old.txt'])
  assert.equal(fs.readFileSync(path.join(destination, 'old.txt'), 'utf8'), 'keep')
})

test('legacy packages resolve both host entry points and transitive local imports without running them', t => {
  const source = temporaryDirectory(t)
  copyRuntimeFixture(source, '1.6.4')
  const pkgPath = path.join(source, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  delete pkg.whaleRuntimeFiles
  fs.writeFileSync(pkgPath, JSON.stringify(pkg))
  assert.equal(validatePluginPayload(source).version, '1.6.4')
  const bridge = path.join(source, 'src', 'plugin', 'fixture-bridge.mjs')
  fs.writeFileSync(bridge, "export { value } from './fixture-absent.mjs'\nthrow Error('unexpected evaluation')\n")
  for (const [entry, extraImport] of [
    ['src/mcp/server.mjs', "import '../plugin/fixture-bridge.mjs'"],
    ['sidecars/whale/main.mjs', "import '../../src/plugin/fixture-bridge.mjs'"],
  ]) {
    const entryFile = path.join(source, entry)
    const original = fs.readFileSync(entryFile, 'utf8')
    fs.appendFileSync(entryFile, '\n' + extraImport + '\n')
    assert.throws(() => validatePluginPayload(source), /fixture-absent\.mjs/, entry)
    fs.writeFileSync(entryFile, original)
  }
})

test('a newer package may replace a release-specific resource using its own file inventory', t => {
  const source = temporaryDirectory(t)
  copyRuntimeFixture(source, '1.7.0')
  const manifestPath = path.join(source, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const oldName = pkg.whaleRuntimeFiles.find(name => name.startsWith('stickers/') && name.endsWith('.png'))
  const newName = 'stickers/new-version-art.png'
  fs.renameSync(path.join(source, oldName), path.join(source, newName))
  pkg.whaleRuntimeFiles[pkg.whaleRuntimeFiles.indexOf(oldName)] = newName
  fs.writeFileSync(manifestPath, JSON.stringify(pkg))
  assert.equal(validatePluginPayload(source).version, '1.7.0')
})

test('a running Windows in-place updater keeps its trusted checker when the new version renames it', async t => {
  const dir = temporaryDirectory(t)
  const installed = path.join(dir, 'installed')
  const source = path.join(dir, 'future')
  copyRuntimeFixture(installed, '1.6.5')
  copyRuntimeFixture(source, '1.7.0')
  const { installPluginPayload: update } = await import(pathToFileURL(path.join(installed, 'src/plugin/install.mjs')))
  const oldName = 'module-check.mjs'
  const newName = 'renamed-checker.mjs'
  fs.renameSync(path.join(source, 'src', 'plugin', oldName), path.join(source, 'src', 'plugin', newName))
  for (const name of ['src/plugin/install.mjs','package.json']) {
    const file = path.join(source, name)
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll(oldName, newName))
  }
  const rename = fs.renameSync
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.resolve(from) === installed) throw Object.assign(Error('occupied root'), {code:'EBUSY'})
    return rename(from, to)
  })
  const result = await update({source, destination:installed, dataPaths:[]})
  assert.equal(result.mode, 'in_place')
  assert.equal(result.manifest.version, '1.7.0')
  assert.equal(fs.existsSync(path.join(installed, 'src', 'plugin', oldName)), false)
})

test('dual safety review receives the complete outbound text including its final characters', async t => {
  const text = '今天观察到一群鲸鱼。'.repeat(145) + '最后一段记录了海面颜色。'
  const reviewed = []
  const complete = Object.assign(async ({ prompt }) => {
    reviewed.push(JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)).outboundText)
    return '{"decision":"pass"}'
  }, {available: () => true})
  const reviewer = createSafetyReviewer({completeImpl: complete})
  const result = await enforceOutboundSafety({text, channel: 'dynamic', whaleHome: temporaryDirectory(t),
    cfg: {safety: {mode: 'dual', enabled: true}},
    ipcClient: async (_, {body}) => ({running: true, ...await reviewer.review(body)})})
  assert.equal(result.ok, true)
  assert.equal(reviewed.length, 1)
  assert.equal(reviewed[0].length, text.length)
  assert.equal(reviewed[0], text)
})

test('text over the real review input budget remains unsent', async t => {
  let created = 0
  const reviewer = createSafetyReviewer({rpc: {available: () => true, createConversation() { created++; throw Error('unexpected RPC') }}})
  const result = await enforceOutboundSafety({text: '🌊'.repeat(3000), channel: 'dynamic', whaleHome: temporaryDirectory(t),
    cfg: {safety: {mode: 'dual', enabled: true}},
    ipcClient: async (_, {body}) => ({running: true, ...await reviewer.review(body)})})
  assert.equal(result.blocked, true)
  assert.match(result.reason, /超限|缩短/)
  assert.equal(created, 0)
})

test('diagnostic export retains counts while excluding message, safety and scheduler previews', async t => {
  const dir = temporaryDirectory(t)
  const api = createApiHandlers({whaleHome: dir, cfgFile: path.join(dir, 'config.json'), credFile: path.join(dir, 'cred.json'),
    biliMjs: path.join(dir, 'missing.mjs'), ipcClient: async () => ({running: false})})
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({self:{mid:'100'},owner:{mid:'200'}}))
  const dp = dataPathsFor(dir)
  const store = createLifeStore({whaleHome:dir,account:'100',owner:'200'})
  await store.ingestOwnerMessage({actor:'200',messageId:'fixture-dm',text:'private-example-3'})
  fs.mkdirSync(dp.logsDir, { recursive: true })
  fs.mkdirSync(dp.stateDir, { recursive: true })
  fs.writeFileSync(dp.safetyLog, JSON.stringify({at: Date.now(), channel:'dm', layer:'local', category:'fixture', preview:'private-example-1'}) + '\n')
  fs.writeFileSync(dp.schedulerHealth, JSON.stringify({schema:1, instanceId:'fixture', status:'idle', recent:[{error:'private-example-2'}]}))
  const normal = await api.getStatus()
  assert.match(JSON.stringify(normal), /private-example-1/)
  assert.match(JSON.stringify(normal), /private-example-3/)
  const { filePath, payload } = await api.exportDiagnostics()
  assert.equal(payload.runtimeStatus.safetyBlockedCount, 1)
  assert.doesNotMatch(fs.readFileSync(filePath,'utf8'), /private-example-/)
  assert.doesNotMatch(JSON.stringify(payload), /private-example-/)
})

test('partial update metadata compares known commits and reports missing evidence separately', async t => {
  const dir = temporaryDirectory(t)
  const sha = 'a'.repeat(40)
  const receipt = path.join(dir,'.whale-install.json')
  fs.writeFileSync(path.join(dir,'plugin.json'),JSON.stringify({name:'antigravity-bili-whale',version:'1.6.5'}))
  const fetchImpl = async url => url.endsWith('main.atom')
    ? new Response('<entry><id>Commit/' + sha + '</id></entry>') : new Response(null,{status:503})
  const check = () => checkForUpdate({pluginRoot: dir, whaleHome: dir, fetchImpl})
  for (const [baseline, expected, hasUpdate] of [['b'.repeat(40),'commit_available',true],[null,'incomplete',false],[sha,'up_to_date',false]]) {
    fs.writeFileSync(receipt,JSON.stringify({installedVersion:'1.6.5',installedCommit:baseline}))
    const result = await check()
    assert.equal(result.status,expected)
    assert.equal(result.hasUpdate,hasUpdate)
    assert.equal(result.remote.mainVersion,null)
  }
  fs.unlinkSync(receipt)
  const result = await checkForUpdate({pluginRoot:dir,whaleHome:dir,fetchImpl:async url=>url.endsWith('plugin.json')
    ? Response.json({name:'antigravity-bili-whale',version:'1.6.5'}) : fetchImpl(url)})
  assert.equal(result.status,'incomplete')
  fs.writeFileSync(path.join(dir,'plugin.json'),JSON.stringify({name:'antigravity-bili-whale',version:'2.0.0'}))
  const olderMain = async url => url.endsWith('plugin.json')
    ? Response.json({name:'antigravity-bili-whale',version:'1.9.0'}) : new Response(null,{status:503})
  const partial = await checkForUpdate({pluginRoot:dir,whaleHome:dir,fetchImpl:olderMain})
  assert.equal(partial.status,'incomplete')
  assert.equal(partial.hasUpdate,false)
  assert.match(partial.summary,/1\.9\.0/)
})

test('confirmation reads a bounded number of ledgers and recovers retained tasks after restart', async t => {
  const dir = temporaryDirectory(t)
  const ledger = dataPathsFor(dir).deliveries
  const identity = {account:'100',owner:'200'}
  let deliveries = 0, reads = 0
  const options = {whaleHome:dir, config:()=>({self:{mid:'100'},owner:{mid:'200'}}), persona:()=> 'fixture',
    controller:{async createAndPrompt(){deliveries++}}}
  const sender = createScopedDelivery(options)
  const readFile = fs.readFileSync
  t.mock.method(fs,'readFileSync',function(file,...args){ if(file===ledger) reads++;return readFile.call(this,file,...args) })
  for(let i=0;i<10;i++){
    const id='bili-whale-fandm-'+i
    await sender.send({identity,requestId:id,memoryScene:'reply',taskKind:'fan-dm',content:[{type:'text',text:'fixture'}]},undefined,{retainUntilAck:true})
    reads=0
    const confirming = i===9 ? createScopedDelivery(options) : sender
    await confirming.confirm(id)
    assert.ok(reads<=4, 'ledger reads: '+reads)
    const records=JSON.parse(readFile(ledger,'utf8')).records
    assert.equal(records.find(r=>r.requestId===id).retained,false)
  }
  assert.equal(deliveries,10)
})

test('all supported quota thresholds keep equality available and report fractional remaining quota', () => {
  const model = 'gemini-fixture-model'
  for(let threshold=1;threshold<=80;threshold++){
    const config = {main:model,worker:model,minQuotaPercent:threshold}
    for(const [fraction,paused] of [[threshold/100,false],[(threshold-0.01)/100,true],[(threshold+0.01)/100,false]]){
      const result=evaluateModelQuota({ source: 'live', models: [{ id: model }], usage: modelUsageFixture({ gemini: fraction }) },config)
      assert.equal(result.paused,paused,threshold+'%')
      if(paused)assert.ok(result.remainingPercent<threshold, 'display must report a value below '+threshold)
    }
  }
})
