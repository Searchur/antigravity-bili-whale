import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { workDirPath } from '../lib/paths.mjs'
import { lifeStore } from '../lib/life-runtime.mjs'
import { config } from '../lib/config.mjs'

const argv = process.argv.slice(2)
const [cmd, arg, ...rest] = argv
const store = lifeStore()
const json = value => console.log(JSON.stringify(value, null, 2))

const BLOCKED_BASENAMES = new Set(['credentials.json', 'sidecar-ipc.json', 'config.json'])
function readInput(raw) {
  if (!raw || typeof raw !== 'string') throw Error('需要 JSON 文件路径或内联 JSON 字符串')
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    if (Buffer.byteLength(trimmed, 'utf8') > 128_000) throw Error('内联 JSON 超过 128 KB 上限')
    return JSON.parse(trimmed)
  }
  const realTarget = fs.realpathSync(raw)
  if (BLOCKED_BASENAMES.has(path.basename(realTarget).toLowerCase())) {
    throw Error('禁止读取敏感配置文件')
  }
  const allowedRoots = [workDirPath, os.tmpdir()]
  const inside = allowedRoots.some(root => {
    try {
      const realRoot = fs.realpathSync(root)
      const rel = path.relative(realRoot, realTarget)
      return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel)
    } catch { return false }
  })
  if (!inside) throw Error('JSON 输入文件必须位于工作目录（whale-work）或临时目录内')
  const st = fs.statSync(realTarget)
  if (!st.isFile() || st.size > 128_000) throw Error('需要不超过 128 KB 的 JSON 文件')
  return JSON.parse(fs.readFileSync(realTarget, 'utf8'))
}

try {
  if (cmd === 'pause' || cmd === 'resume') json(await store.pause(cmd === 'pause'))
  else if (cmd === 'affect-status') json(store.affectStatus())
  else if (cmd === 'affect-explain') json(store.affectExplain())
  else if (cmd === 'affect-preview') json(store.affectPreview(config()))
  else if (cmd === 'dynamic-status') json(store.dynamicStatus())
  else if (cmd === 'memory-migrate') json(await store.dynamicMigrate({ apply: arg === '--apply' }))
  else if (cmd === 'memory-catalog-preview') json(store.reader(rest[0] ?? 'public').catalog(arg ? readInput(arg) : {}))
  else if (cmd === 'memory-catalog') console.log(JSON.stringify(await store.reader(rest[0] ?? 'public').taskCatalog(readInput(arg))))
  else if (cmd === 'memory-history-preview') json(store.reader(rest[0] ?? 'public').history(arg ? readInput(arg) : {}))
  else if (cmd === 'memory-history') console.log(JSON.stringify(await store.reader(rest[0] ?? 'public').taskCatalog({ ...readInput(arg), history: true })))
  else if (cmd === 'memory-fetch') console.log(JSON.stringify(await store.reader(rest[0] ?? 'public').readMemory(readInput(arg))))
  else if (cmd === 'memory-explain') json(store.reader(rest[0] ?? 'public').explain(arg))
  else if (cmd === 'learning-status') json(store.learningStatus())
  else if (cmd === 'induce-submit') json(await store.submitFormation(arg, rest[0], readInput(rest[1])))
  else if (cmd === 'induce-review') json(await store.commitFormation(arg, rest[0], readInput(rest[1])))
  else if (cmd === 'decision') json(await store.recordDecision(readInput(arg)))
  else if (cmd === 'traces') json(store.decisionTraces())
  else if (cmd === 'maintain') json(await store.maintainCognition())
  else if (cmd === 'status') json(store.status())
  else if (cmd === 'context') console.log(store.context(arg ?? '', rest[0] ?? 'private'))
  else if (cmd === 'context-explain') json(store.contextSnapshot(arg ?? '', rest[0] ?? 'private-reply'))
  else if (cmd === 'recall') json(store.reader(rest[0] ?? 'public').recall(arg ?? ''))
  else if (cmd === 'rebuild') json(store.rebuildIndex())
  else if (cmd === 'explain') json(store.reader(rest[0] ?? 'public').get(arg))
  else if (cmd === 'source') json(store.reader(rest[0] ?? 'public').sources([arg]))
  else if (cmd === 'search') json(store.search(arg ?? '', { archives: rest.includes('--archives'), scene: rest.includes('--private') ? 'private' : 'public' }))
  else if (cmd === 'reflect') json(await store.record('reflection', { ...readInput(arg), origin: 'model' }))
  else if (cmd === 'archive') json(await store.archive())
  else if (cmd === 'export') json(store.export())
  else if (cmd === 'close') json(await store.closeThread(arg, rest.join(' ') || 'completed'))
  else {
    console.log('life: status | pause | resume | context [query] [scene] | context-explain [query] [scene] | recall <query> [scene] | explain <id> [scene] | source <id> [scene] | search <query> [--archives] | memory-catalog <json> [scene] | memory-history <json> [scene] | memory-fetch <json> [scene] | memory-explain <id> [scene] | decision <json> | traces | affect-status | learning-status | dynamic-status | archive | export | close <thread> [reason]')
  }
} catch (e) {
  console.error(e.message)
  process.exitCode = 2
}
