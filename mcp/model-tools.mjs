import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { PLUGIN_ROOT, WHALE_HOME, configPath, shotsPath, workDirPath } from '../tools/lib/paths.mjs'
import { resolveNodeRuntime, nodeEnv } from '../lib/node-runtime.js'
import { publicScene } from '../tools/lib/memory-scope.mjs'

const MAX_OUTPUT_CHARS = 120_000
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const IMAGE_MIMES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

const GROUPS = [
  {
    name: 'bili_browse',
    title: 'B站选片与检索',
    description: '只读浏览与选题工具。支持命令：feed（按口味选题）、discover（按新鲜度选片）、round（批量找片深读汇总）、search（WBI 关键词搜索）、whois（按 mid 查昵称）、covers（抓取封面图）。',
    commands: ['feed', 'discover', 'round', 'search', 'whois', 'covers'],
    timeoutMs: 180_000,
  },
  {
    name: 'bili_inspect',
    title: 'B站视频深读与画面抽帧',
    description: '视频内容与评论深读工具。支持命令：debrief（一条龙：封面+简介+字幕+弹幕热区+热评+画面抽帧，自动附带画面图）、watch-video（抽帧拼图并附带画面图）、subtitles（官方字幕辅助查看）、comments（热评/最新评论）、batch-debrief（有限并发深读）、read-shot（按路径读取 shots 缓存内的封面或抽帧图）。',
    commands: ['debrief', 'watch-video', 'subtitles', 'comments', 'batch-debrief', 'read-shot'],
    timeoutMs: 300_000,
  },
  {
    name: 'bili_interact',
    title: 'B站公开互动写操作（强制 --dry/--go）',
    description: '评论、动态、点赞、收藏、关注工具。支持命令：comment、comment-del、dynamic、dynamic-image、like、fav、follow。写操作先用 --dry 预览，再用相同参数改为 --go。',
    commands: ['comment', 'comment-del', 'dynamic', 'dynamic-image', 'like', 'fav', 'follow'],
    timeoutMs: 360_000,
  },
  {
    name: 'bili_dm',
    title: 'B站主人私信与粉丝来信回复（强制 --dry/--go）',
    description: '主人私信及粉丝来信回复。支持命令：dm（主人私信或持有效来信回执回复粉丝）、dm-batch（主人多段私信）。先 --dry 预览再 --go 发送。',
    commands: ['dm', 'dm-batch'],
    timeoutMs: 360_000,
  },
  {
    name: 'bili_inbox',
    title: 'B站收件箱与发送复核',
    description: '只读收件箱与发后回读复核工具。支持命令：comment-digest（回复+@ 汇总）、likes（收到的赞）、thread（评论楼中楼结构）、check-comment（按 rpid 核实评论存在）、check-dynamic（查动态结构）、check-mention（核查动态 @ 提及）、recon（评论区侦查）。',
    commands: ['comment-digest', 'likes', 'thread', 'check-comment', 'check-dynamic', 'check-mention', 'recon'],
    timeoutMs: 120_000,
  },
  {
    name: 'bili_life',
    title: '鲸鱼长期记忆与作息状态',
    description: '长期记忆、额度与作息工具。支持命令：life（有界记忆与上下文检索）、quota（分享/评论/动态额度查询）、night（作息状态）、traffic（请求保护只读状态）。',
    commands: ['life', 'quota', 'night', 'traffic'],
    timeoutMs: 120_000,
  },
  {
    name: 'bili_stickers',
    title: '鲸鱼表情包目录（42 张随包内置）',
    description: '查询随插件内置的 42 张表情包路径（无需手动复制）。支持命令：list（分页列出目录）、get（按 ID 或情绪名取本地图片绝对路径，供 dm/comment --pic 使用）。',
    commands: ['list', 'get'],
    timeoutMs: 30_000,
  },
  {
    name: 'bili_ops',
    title: '鲸鱼运维与规范阅读',
    description: '运维与行为规范工具。支持命令：deps（依赖体检）、selftest（启动自检）、session（确认当前登录账号）、behavior（行为规范）、config（只读查看选片参数）、read-prompt（读取已授权的唤醒上下文文件）。',
    commands: ['deps', 'selftest', 'session', 'behavior', 'config', 'read-prompt'],
    timeoutMs: 120_000,
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
  biliMjs = path.join(PLUGIN_ROOT, 'tools', 'bili.mjs'),
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
    if (toolName === 'bili_life' && command === 'life') {
      extra = modelLifeArgs(extra)
      if (!extra) return restricted()
    }
    if (toolName === 'bili_life' && command === 'quota') {
      if (extra[0] === 'status') extra = ['status', '--summary-only']
      else if (extra[0] !== 'check') return restricted()
    }
    if (toolName === 'bili_life' && command === 'traffic') {
      if (extra.length === 0) extra = ['status']
      else if (!(extra.length === 1 && extra[0] === 'status')) return restricted()
    }
    if (toolName === 'bili_ops' && command === 'config') {
      if (extra.length === 0) extra = ['show']
      else if (!(extra.length === 1 && extra[0] === 'show')) return restricted()
    }
    if (toolName === 'bili_dm') {
      const hasUid = flag => extra.filter(value => value === flag).length === 1 && /^[1-9]\d{0,19}$/.test(extra[extra.indexOf(flag) + 1] ?? '')
      if (extra.includes('--status') || !hasUid('--account') || !hasUid('--to')) {
        return { isError: true, content: [{ type: 'text', text: '私信操作需要本任务的 --account 大鲸鱼UID 和 --to 收信人UID。' }] }
      }
    }
    if (toolName === 'bili_life' && command === 'night' && (extra.length !== 1 || extra[0] !== 'status')) return restricted()

    // Portable built-in helper: read oversized prompt materialized in whale-work/.prompts/
    if (toolName === 'bili_ops' && command === 'read-prompt') {
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
    if (toolName === 'bili_inspect' && command === 'read-shot') {
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

    const cliArgv = toolName === 'bili_stickers' ? ['stickers', command, ...extra] : [command, ...extra]
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
    if (res.ok && toolName === 'bili_inspect' && ['debrief', 'watch-video'].includes(command)) {
      content.push(...extractInlineShotBlocks(shotsDir, res.stdout))
    }
    return {
      isError: !res.ok,
      content,
    }
  }
}
