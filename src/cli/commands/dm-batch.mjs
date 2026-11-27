import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { NODE_EXE } from '../../core/nodebin.mjs'
import { workDirPath } from '../../core/paths.mjs'
import { config } from '../../config/index.mjs'
import { lifeStore } from '../../life/runtime.mjs'
import { parseMessages, createBatch, sendBatch, cancelBatch } from '../../social/dm-batch.mjs'
import { chatConfig } from '../../config/chat.mjs'
import { requireWritePreview } from '../../social/write-preview.mjs'
import { enforceOutboundSafety } from '../../social/content-safety.mjs'

function readSafeJsonFile(filePath) {
  const realTarget = fs.realpathSync(filePath)
  const allowedRoots = [workDirPath, os.tmpdir()]
  const inside = allowedRoots.some(root => {
    try {
      const realRoot = fs.realpathSync(root)
      const rel = path.relative(realRoot, realTarget)
      return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel)
    } catch { return false }
  })
  if (!inside) throw Error('--file 路径必须在工作目录（whale-work）或临时目录内')
  const st = fs.statSync(realTarget)
  if (!st.isFile() || st.size > 128_000) throw Error('多段私信文件无效或超过 128 KB')
  return JSON.parse(fs.readFileSync(realTarget, 'utf8'))
}

const args = new Map()
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) args.set(argv[i].slice(2), argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true)
}
const cfg = config()
const store = lifeStore()
const controller = new AbortController()
process.once('SIGTERM', () => controller.abort())
process.once('SIGINT', () => controller.abort())

const account = String(cfg.self?.mid ?? '')
const owner = String(cfg.owner?.mid ?? '')
const run = (cmdArgs, signal) => new Promise(resolve => execFile(
  NODE_EXE,
  [fileURLToPath(new URL('./dm.mjs', import.meta.url)), ...cmdArgs.slice(1)],
  { env: process.env, windowsHide: true, timeout: 240000, signal },
  (err, out, stderr) => resolve({ ok: !err, out, err: stderr }),
))

try {
  if ((args.has('account') && args.get('account') !== account) || (args.has('to') && args.get('to') !== owner)) {
    throw Error('当前账号或主人与发送组任务不一致')
  }
  if (args.has('status')) {
    console.log(JSON.stringify(store.read().settings.dmBatches ?? [], null, 2))
  } else if (args.has('cancel')) {
    console.log(JSON.stringify(await cancelBatch(store, String(args.get('cancel'))), null, 2))
  } else {
    const dry = args.has('dry')
    if (dry === args.has('go')) throw Error('必须且只能给 --dry 或 --go')
    const hasFile = args.has('file')
    const hasResume = args.has('resume')
    if (hasFile === hasResume) throw Error('使用 --file 正文.json 或 --resume 组ID 二选一')
    let batch
    if (hasFile) {
      const input = readSafeJsonFile(String(args.get('file')))
      const c = chatConfig(cfg.chat)
      const messages = parseMessages(input, c.multi ? c.maxParts : 1)
      for (const msg of messages) {
        const safety = await enforceOutboundSafety({ text: msg, channel: 'dm', isOwnerTarget: true, cfg })
        if (safety.blocked) throw Error(`[安全审核拦截] ${safety.reason}（类别：${safety.category}）`)
      }
      requireWritePreview('dm-batch', { messages, task: args.get('task') }, { dry })
      if (dry) {
        console.log(JSON.stringify({ messages, preview: true, note: '预检通过，尚未发送；正式发送逐条执行校验与冷却' }, null, 2))
      } else {
        batch = await createBatch(store, messages, { config: cfg, taskId: typeof args.get('task') === 'string' ? args.get('task') : null })
      }
    } else {
      batch = (store.read().settings.dmBatches ?? []).find(x => x.id === String(args.get('resume')))
      if (!batch) throw Error('发送组不存在')
      requireWritePreview('dm-batch-resume', { id: batch.id, parts: batch.parts }, { dry })
      if (dry) console.log(JSON.stringify(batch, null, 2))
    }
    if (batch && !dry) {
      console.log('发送组 ' + batch.id + '；按配置冷却逐条发出，进度可用 --status 查看')
      console.log(JSON.stringify(await sendBatch(store, batch.id, { run, config: () => config({ fresh: true }), signal: controller.signal }), null, 2))
    }
  }
} catch (e) {
  console.error(e.message)
  process.exitCode = 1
}
