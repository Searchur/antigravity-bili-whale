/**
 * CLI 命令 `selftest`：执行内置行为规范章节与运行链路自检。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PLUGIN_ROOT, WHALE_HOME, configPath, DATA_PATHS } from '../../core/paths.mjs'
import { NODE_EXE } from '../../core/node-binary.mjs'
import { config } from '../../config/index.mjs'
import { lifeConfig } from '../../config/life.mjs'
import { BEHAVIOR_IDS, loadBehavior } from '../../core/behavior.mjs'

if (process.argv.includes('--docs')) {
  const sections = loadBehavior(BEHAVIOR_IDS)
  if (sections.length !== BEHAVIOR_IDS.length) throw Error('行为规范章节缺失')
  for (const file of ['life.mjs', 'comment.mjs', 'dm.mjs', 'debrief.mjs', 'dynamic.mjs', 'feed.mjs']) {
    if (!fs.existsSync(new URL(file, import.meta.url))) throw Error('缺少命令 ' + file)
  }
  console.log(`行为规范（${sections.length} 节）及 life/comment/dm/debrief/dynamic/feed 入口检查通过`)
  process.exit(0)
}

const OK = '✓', NO = '✗', WARN = '!'
let failures = 0
function line(mark, label, detail) {
  if (mark === NO) failures++
  console.log(`  ${mark} ${label} — ${detail}`)
}

const pkgVersion = (() => { try { return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')).version ?? '?' } catch { return '?' } })()
console.log('哔哩哔哩大鲸鱼（antigravity-bili-whale）' + pkgVersion + ' · 启动检查')

let current
try {
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw Error('invalid config')
  current = config()
  lifeConfig(current.life)
  line(OK, '配置文件', configPath)
  line(current.self?.mid ? OK : NO, 'B 站账号', current.self?.mid ?? '请在左侧栏「哔哩哔哩大鲸鱼」→「大鲸鱼与主人」扫码登录')
  line(current.owner?.mid ? OK : NO, '主人 UID', current.owner?.mid ?? '请在左侧栏「哔哩哔哩大鲸鱼」→「大鲸鱼与主人」填写主人 UID')
  line(OK, '内置模型配置', `前台 ${current.models?.main ?? 'flash'} · 后台 Worker ${current.models?.worker ?? 'flash_lite'}`)
} catch {
  line(NO, '配置文件', configPath + '（缺失或不合法，请先在左侧栏「哔哩哔哩大鲸鱼」保存一次配置）')
}
line(fs.existsSync(WHALE_HOME) ? OK : NO, '独立数据目录', WHALE_HOME)

try {
  const result = spawnSync(NODE_EXE, [fileURLToPath(new URL('./deps.mjs', import.meta.url)), '--json'], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
  })
  if (result.error || ![0, 3].includes(result.status)) throw Error('deps failed')
  const { items } = JSON.parse(result.stdout)
  for (const item of items) {
    const optional = item.name.startsWith('ffmpeg')
    line(item.ok ? OK : optional ? WARN : NO, item.name, item.detail || item.fix || '请查看依赖体检')
    if (!item.ok && item.fix) console.log('    ' + item.fix)
  }
} catch {
  line(NO, '依赖体检', '无法读取结果，请运行 node src/cli/bili.mjs deps')
}

if (failures === 0) {
  try {
    fs.mkdirSync(path.dirname(DATA_PATHS.selftest), { recursive: true })
    fs.writeFileSync(DATA_PATHS.selftest, JSON.stringify({ at: new Date().toISOString() }, null, 2))
  } catch {}
  console.log('✓ 启动检查通过')
} else {
  console.log(`✗ ${failures} 项需要处理。可在左侧栏「哔哩哔哩大鲸鱼」→「环境与依赖」查看详情。`)
}
process.exitCode = failures === 0 ? 0 : 1
