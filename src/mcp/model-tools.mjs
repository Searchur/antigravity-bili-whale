import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { biliCliPath, WHALE_HOME, configPath, shotsPath, workDirPath } from '../core/paths.mjs'
import { resolveNodeRuntime, nodeEnv } from '../core/node-runtime.mjs'
import { publicScene } from '../memory/scope.mjs'

const MAX_OUTPUT_CHARS = 120_000
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const IMAGE_MIMES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

const GROUPS = [
  {
    name: 'bili_read',
    title: 'B站只读浏览、深读看图与状态查询',
    description: '全部只读工具，不产生 B 站外发副作用。支持命令：选片检索（feed / discover / round / search / whois / covers）、视频深读与画面抽帧（debrief / watch-video / subtitles / comments / batch-debrief / read-shot，debrief 与 watch-video 自动附带画面图）、收件箱与复核（comment-digest / likes / thread / check-comment / check-dynamic / check-mention / recon）、记忆与状态（life / quota / night / traffic）、表情包目录（stickers，传 ["list"] 或 ["get","名称"]）以及运维规范（deps / selftest / session / behavior / config / read-prompt）。',
    commands: [
      'feed', 'discover', 'round', 'search', 'whois', 'covers',
      'debrief', 'watch-video', 'subtitles', 'comments', 'batch-debrief', 'read-shot',
      'comment-digest', 'likes', 'thread', 'check-comment', 'check-dynamic', 'check-mention', 'recon',
      'life', 'quota', 'night', 'traffic',
      'stickers',
      'deps', 'selftest', 'session', 'behavior', 'config', 'read-prompt',
    ],
    timeoutMs: 300_000,
  },
  {
    name: 'bili_write',
    title: 'B站外发写操作（强制 --dry/--go 与安全审核）',
    description: '全部 B 站公开互动与私信写操作工具。支持命令：公开互动（comment / comment-del / dynamic / dynamic-image / like / fav / follow）与私信（dm / dm-batch，须附带本任务的 --account 大鲸鱼UID 与 --to 收信人UID）。所有外发写操作须先 --dry 预览再以相同参数改 --go 发送，系统自动执行外发安全审核。',
    commands: ['comment', 'comment-del', 'dynamic', 'dynamic-image', 'like', 'fav', 'follow', 'dm', 'dm-batch'],
    timeoutMs: 360_000,
  },
]

const GROUP_MAP = new Map(GROUPS.map(g => [g.name, g]))

const TASK_MEMORY_ACTIONS = new Set(['memory-catalog', 'memory-history', 'memory-fetch', 'decision'])
const PUBLIC_MEMORY_ACTIONS = new Set([
  'context', 'context-explain', 'recall', 'explain', 'source',
  'memory-catalog-preview', 'memory-history-preview', 'memory-explain',
])

function modelLifeArgs(args) {
  const [action, value, scene = 'public'] = args
  // Private retrieval requires the existing unguessable task ID and exact scene
  // from the Sidecar's recorded context. Model-supplied roles authorize nothing.
  if (TASK_MEMORY_ACTIONS.has(action)) return args
  if (PUBLIC_MEMORY_ACTIONS.has(action)) return publicScene(scene) ? [action, value ?? '', scene] : null
  if (action === 'search') return args.slice(2).includes('--private') ? null : args
  return null
}

function isInsideDir(baseDir, targetFile) {
  try {
    const realBase = fs.realpathSync(baseDir)
    const realTarget = fs.realpathSync(targetFile)
    const rel = path.relative(realBase, realTarget)
    return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel)
  } catch {
    return false
  }
}

function readShotImageBlock(shotsDir, filePath) {
  if (!filePath || !isInsideDir(shotsDir, filePath)) return null
  const ext = path.extname(filePath).toLowerCase()
  const mimeType = IMAGE_MIMES[ext]
  if (!mimeType) return null
  const st = fs.statSync(filePath)
  if (!st.isFile() || st.size <= 0 || st.size > MAX_IMAGE_BYTES) return null
  return {
    type: 'image',
    data: fs.readFileSync(filePath).toString('base64'),
    mimeType,
  }
}

const MAX_INLINE_SHOT_BLOCKS = 16

function extractInlineShotBlocks(shotsDir, text) {
  const blocks = []
  const seen = new Set()
  const sheetMatches = []
  const subsMatches = []
  for (const match of String(text ?? '').matchAll(/^\s*(SHEET|SUBS)\s*:\s*(.+?)\s*$/gm)) {
    const kind = match[1]
    const candidate = match[2].trim()
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    if (kind === 'SHEET') sheetMatches.push(candidate)
    else subsMatches.push(candidate)
  }
  for (const candidate of [...sheetMatches, ...subsMatches]) {
    const block = readShotImageBlock(shotsDir, candidate)
    if (block) blocks.push(block)
    if (blocks.length >= MAX_INLINE_SHOT_BLOCKS) break
  }
  return blocks
}

export function modelToolDefinitions() {
  return GROUPS.map(g => ({
    name: g.name,
    title: g.title,
    description: g.description,
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          enum: g.commands,
          description: `要执行的子命令：${g.commands.join(' / ')}`,
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '透传给该命令的参数数组，例如 ["BV1xx...", "--profile", "auto"] 或 ["--dry"]',
          default: [],
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    _meta: {
      ui: { visibility: ['model'] },
    },
  }))
}

export function createModelToolRunner({
  whaleHome = WHALE_HOME,
  cfgFile = configPath,
  biliMjs = biliCliPath,
} = {}) {
  const nodeExe = resolveNodeRuntime(whaleHome)
  const baseEnv = { ...nodeEnv(whaleHome), BILI_WHALE_HOME: whaleHome, BILI_WHALE_CONFIG: cfgFile }
  const shotsDir = whaleHome === WHALE_HOME ? shotsPath : path.join(whaleHome, 'shots')
  const promptsDir = path.join(whaleHome === WHALE_HOME ? workDirPath : path.join(whaleHome, 'whale-work'), '.prompts')

  function runCli(argv, timeoutMs) {
    return new Promise((resolve) => {
      execFile(nodeExe, [biliMjs, ...argv], {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: baseEnv,
      }, (err, stdout, stderr) => {
        const out = String(stdout ?? '')
        const errText = String(stderr ?? '')
        const code = err ? (Number.isInteger(err.code) ? err.code : 1) : 0
        resolve({ ok: !err, code, stdout: out, stderr: errText })
      })
    })
  }

  return async function invokeModelTool(toolName, rawArgs = {}) {
    const group = GROUP_MAP.get(toolName)
    if (!group) return null
    const command = String(rawArgs?.command ?? '').trim()
    if (!group.commands.includes(command)) {
      return {
        isError: true,
        content: [{ type: 'text', text: `不支持的命令 "${command}"；${toolName} 仅允许：${group.commands.join(', ')}` }],
      }
    }
    let extra = Array.isArray(rawArgs?.args) ? rawArgs.args.map(v => String(v)) : []
    const restricted = () => ({
      isError: true,
      content: [{ type: 'text', text: '该模型工具仅提供公开资料和本任务授权的上下文，管理数据请在控制台查看。' }],
    })
    if (toolName === 'bili_read' && command === 'life') {
      extra = modelLifeArgs(extra)
      if (!extra) return restricted()
    }
    if (toolName === 'bili_read' && command === 'quota') {
      if (extra[0] === 'status') extra = ['status', '--summary-only']
      else if (extra[0] !== 'check') return restricted()
    }
    if (toolName === 'bili_read' && command === 'traffic') {
      if (extra.length === 0) extra = ['status']
      else if (!(extra.length === 1 && extra[0] === 'status')) return restricted()
    }
    if (toolName === 'bili_read' && command === 'config') {
      if (extra.length === 0) extra = ['show']
      else if (!(extra.length === 1 && extra[0] === 'show')) return restricted()
    }
    if (toolName === 'bili_read' && command === 'stickers') {
      if (!extra.length) extra = ['list']
      else if (!['list', 'get'].includes(extra[0])) return restricted()
    }
    if (toolName === 'bili_write' && (command === 'dm' || command === 'dm-batch')) {
      const hasUid = flag => extra.filter(value => value === flag).length === 1 && /^[1-9]\d{0,19}$/.test(extra[extra.indexOf(flag) + 1] ?? '')
      if (extra.includes('--status') || !hasUid('--account') || !hasUid('--to')) {
        return { isError: true, content: [{ type: 'text', text: '私信操作需要本任务的 --account 大鲸鱼UID 和 --to 收信人UID。' }] }
      }
    }
    if (toolName === 'bili_read' && command === 'night' && (extra.length !== 1 || extra[0] !== 'status')) return restricted()

    // Portable built-in helper: read oversized prompt materialized in whale-work/.prompts/
    if (toolName === 'bili_read' && command === 'read-prompt') {
      const name = extra[0]
      if (!/^[a-f0-9]{48}\.json$/.test(name)) return restricted()
      const target = path.join(promptsDir, name)
      if (!isInsideDir(promptsDir, target)) return restricted()
      try {
        const prompt = JSON.parse(fs.readFileSync(target, 'utf8'))
        const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
        if (!prompt.account || !prompt.owner || !(Date.now() < prompt.expiresAt) ||
          String(cfg.self?.mid ?? '').trim() !== prompt.account || String(cfg.owner?.mid ?? '').trim() !== prompt.owner ||
          typeof prompt.text !== 'string') return restricted()
        return { isError: false, content: [{ type: 'text', text: prompt.text }] }
      } catch { return restricted() }
    }

    // Portable built-in helper: read cover / frame image strictly inside shots/
    if (toolName === 'bili_read' && command === 'read-shot') {
      const rawPath = String(extra[0] ?? '').trim()
      const resolved = path.isAbsolute(rawPath) ? rawPath : path.join(shotsDir, rawPath)
      const img = readShotImageBlock(shotsDir, resolved)
      if (!img) {
        return { isError: true, content: [{ type: 'text', text: '未找到或无权读取指定 shots 图片（仅限独立数据目录 shots/ 下的 2MiB 以内图片）' }] }
      }
      return {
        isError: false,
        content: [{ type: 'text', text: `已读取图片：${resolved}` }, img],
      }
    }

    const cliArgv = [command, ...extra]
    const res = await runCli(cliArgv, group.timeoutMs)
    const parts = []
    if (res.stdout.trim()) parts.push(res.stdout.trim())
    if (res.stderr.trim()) parts.push('[stderr]\n' + res.stderr.trim())
    if (!parts.length) parts.push(res.ok ? '(执行完成，无输出)' : `(命令退出码 ${res.code})`)
    let text = parts.join('\n\n')
    if (text.length > MAX_OUTPUT_CHARS) {
      text = text.slice(0, MAX_OUTPUT_CHARS) + `\n\n...(输出已截断，总长 ${text.length} 字符)`
    }
    const content = [{ type: 'text', text }]
    if (res.ok && toolName === 'bili_read' && ['debrief', 'watch-video'].includes(command)) {
      content.push(...extractInlineShotBlocks(shotsDir, res.stdout))
    }
    return {
      isError: !res.ok,
      content,
    }
  }
}
