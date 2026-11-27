/**
 * CLI 命令 `deps`：逐项探测 Node.js、ffmpeg、B 站登录态、限流与防风控等运行环境依赖。
 */
import fs from 'node:fs'
import path from 'node:path'
import { WHALE_HOME, credentialsPath, configPath, DATA_PATHS } from '../../core/paths.mjs'
import { guardedFetch as fetch, trafficGuard } from '../../bili/traffic.mjs'
import { deliveryStatus } from '../../daemon/delivery-state.mjs'
import { readSchedulerHealth } from '../../daemon/scheduler-health.mjs'
import { ffmpegInfo } from '../../media/ffmpeg.mjs'
import { apiState } from '../../bili/api.mjs'

const cred = credentialsPath
const asJson = process.argv.includes('--json')
const items = []

// 1. B站 cookie
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
let credOk = false, credNote = ''
try {
  const c = JSON.parse(fs.readFileSync(cred, 'utf8'))
  const miss = ['sessdata', 'bili_jct'].filter((k) => !c[k] || !String(c[k]).trim())
  if (miss.length) { credNote = `缺字段：${miss.join(', ')}` }
  else {
    const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: `SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct}; buvid3=${c.buvid3}` },
    })).json()
    credOk = nav.code === 0 && !!nav.data?.isLogin
    credNote = credOk
      ? `已登录：${nav.data.uname}（mid ${nav.data.mid}）`
      : `cookie 无效：code=${nav.code} ${nav.message ?? ''} —— 请在左侧栏「哔哩哔哩大鲸鱼」重新扫码登录`
  }
} catch (e) { credNote = e.code === 'BILI_TRAFFIC_PAUSED' ? e.message : `尚未登录或无法验证凭据：${e.message}` }
items.push({
  name: 'B站 cookie',
  ok: credOk,
  detail: credNote,
  fix: '在左侧栏「哔哩哔哩大鲸鱼」→「大鲸鱼与主人」扫码登录；若处于请求保护暂停请先等待恢复。',
})

// 2. ffmpeg
const ff = ffmpegInfo()
items.push({
  name: 'ffmpeg（抽帧看画面）',
  ok: ff.ok,
  detail: ff.ok ? `${ff.version}\n  路径：${ff.path}` : (ff.path ? `找到了但跑不起来：${ff.version ?? ff.error}` : '未安装（视频抽帧必需，未安装时无法查看视频画面）'),
  fix: '请在终端执行 winget install -e --id Gyan.FFmpeg，或设置 FFMPEG 指向已有的 ffmpeg.exe。',
})

// 3. Node.js
const [major] = process.versions.node.split('.').map(Number)
items.push({
  name: 'Node.js',
  ok: major >= 24,
  detail: `v${process.versions.node}`,
  fix: '使用 Windows Node.js 24 LTS+',
})

// 4. Node 运行时
try {
  const { NODE_EXE, isRealNode } = await import('../../core/node-binary.mjs')
  const real = isRealNode()
  items.push({
    name: 'node 运行时',
    ok: real,
    detail: real ? NODE_EXE : ('无效运行时：' + NODE_EXE),
    fix: '安装 Node.js 或设置环境变量 BILI_WHALE_NODE 指向 node.exe',
  })
} catch (e) {
  items.push({ name: 'node 运行时', ok: false, detail: '检查失败：' + String(e?.message ?? e).slice(0, 80), fix: '设置 BILI_WHALE_NODE' })
}

// 5. 独立数据目录可写
let dirOk = false
try {
  fs.mkdirSync(DATA_PATHS.runtimeDir, { recursive: true })
  const probe = path.join(DATA_PATHS.runtimeDir, '.write-probe')
  fs.writeFileSync(probe, 'ok')
  fs.unlinkSync(probe)
  dirOk = true
} catch {}
items.push({ name: '独立数据目录可写', ok: dirOk, detail: WHALE_HOME, fix: '检查目录写入权限' })

// 6. B站 限流
try {
  const st = apiState()
  items.push({
    name: 'B站 限流',
    ok: !st.banned,
    detail: st.banned
      ? `熔断中，约 ${st.banMinutesLeft} 分钟后恢复（原因 ${st.banWhy ?? '-'}）；缓存里 ${st.cacheEntries} 条可撑`
      : `正常 · 元信息缓存 ${st.cacheEntries} 条`,
    fix: '等待退避恢复，期间只读缓存，勿频繁重试',
  })
} catch {}

// 7. 生物钟与后台守护
try {
  const statePath = DATA_PATHS.schedule
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch {}
  const night = cfg.night ?? { windows: [{ start: '20:00', end: '24:00', wakes: 1 }] }
  const windows = Array.isArray(night.windows) ? night.windows : []
  const maxW = Number(night.maxWakesPerDay ?? 1) || 1
  if (!windows.length) {
    items.push({ name: '生物钟', ok: false, detail: '配置里没有任何作息窗口 → 永远不醒', fix: '在「哔哩哔哩大鲸鱼」→「人设与作息」至少添加一个窗口' })
  } else {
    let st = null
    try { st = JSON.parse(fs.readFileSync(statePath, 'utf8')) } catch {}
    const now = Date.now()
    const woke = Number(st?.wakes ?? 0)
    const atMs = Number(st?.atMs ?? 0)
    const action = String(st?.action ?? '')
    let ok = true, detail = '', fix = ''
    const delivery = deliveryStatus(WHALE_HOME), runtime = readSchedulerHealth(WHALE_HOME)
    if (!runtime) {
      ok = false; detail = '尚无后台调度心跳，请确认 Antigravity 插件与后台守护已启用'
      fix = '检查 Antigravity 插件页与 Automations，确保 antigravity-bili-whale 已开启并等待首次 tick'
    } else if (runtime.error || runtime.lastError) {
      ok = false; detail = '调度循环异常：' + (runtime.error ?? runtime.lastError.message)
      fix = '查看「哔哩哔哩大鲸鱼」→「环境与依赖」中的错误详情'
    } else if (runtime.status === 'stopped' || !runtime.lastTickAt || now - runtime.lastTickAt > 150_000) {
      ok = false; detail = '调度循环已停止或超过 150 秒无心跳'
      fix = '重启 Antigravity App 或重新启用插件，等待首次 tick'
    } else if (runtime.lastReason === 'sessionController-missing' || runtime.lastReason === 'life-paused') {
      ok = false; detail = '最近调度被阻止：' + runtime.lastReason
      fix = '检查 Antigravity 会话接口或恢复主动活动开关'
    } else if (delivery.lastWake && ['dispatching', 'unconfirmed', 'failed'].includes(delivery.lastWake.status)) {
      ok = false
      detail = `上次唤醒投递${delivery.lastWake.status === 'failed' ? '失败' : '未确认'}；${delivery.unconfirmed} 条待核查`
      fix = '检查 Antigravity 会话列表与运行概览，勿直接重发未确认任务'
    } else if (!st) {
      ok = false; detail = '还没有今日作息计划（调度器可能刚启动）'
      fix = '等待 1 分钟后再体检'
    } else if (action === 'wake' && atMs) {
      const mins = Math.round((atMs - now) / 60000)
      if (st.fired === true || st.woke === true) {
        detail = `每 60 秒 tick · 今日机会已用 ${woke}/${maxW} · 计划 ${st.atText ?? ''} 已投递`
      } else if (atMs < now - 15 * 60000) {
        ok = false; detail = `计划 ${st.atText ?? ''} 已过期 ${Math.abs(mins)} 分钟未执行`
        fix = '重启 Antigravity App 并检查后台守护日志'
      } else {
        detail = `每 60 秒 tick · 下次 ${st.atText ?? new Date(atMs).toLocaleString('zh-CN')}${mins > 0 ? `（${mins} 分钟后）` : '（马上）'} · 今日已用 ${woke}/${maxW}`
      }
    } else if (action === 'done') {
      detail = `今日机会已用 ${woke}/${maxW} · 今晚不再安排（${st.reason ?? '窗口已用完'}）`
    } else if (action === 'skip') {
      detail = `这趟是「不看」· 今日机会已用 ${woke}/${maxW}（${st.window ?? ''}）`
    } else {
      detail = `状态 ${action || '(空)'} · 今日机会已用 ${woke}/${maxW}`
    }
    items.push({ name: '生物钟', ok, detail, fix })
  }
} catch (e) {
  items.push({ name: '生物钟', ok: false, detail: '检查失败：' + String(e?.message ?? e).slice(0, 80), fix: '运行 node src/cli/bili.mjs night status' })
}

// 8. 全局请求保护
try {
  const state = trafficGuard().status()
  const manual = Object.keys(state.manual ?? {}).length
  let currentPause
  try { const c = JSON.parse(fs.readFileSync(cred, 'utf8')); currentPause = trafficGuard().pauseReason({ cookie: `SESSDATA=${c.sessdata}` }) } catch {}
  const pending = Object.values(state.operations ?? {}).filter(x => ['pending', 'unknown'].includes(x.status)).length
  items.push({
    name: '全局请求保护',
    ok: !currentPause && !pending,
    detail: `${currentPause ?? '当前账号可请求'}；${manual} 个会话凭据曾需人工处理，${pending} 条发送结果待核查`,
    fix: '运行 node src/cli/bili.mjs traffic status 查看。人工核查前不要重发或解除暂停。',
  })
} catch (e) {
  items.push({ name: '全局请求保护', ok: false, detail: e.message, fix: '检查请求保护状态文件' })
}

const bad = items.filter((i) => !i.ok)
if (asJson) {
  console.log(JSON.stringify({ ok: bad.length === 0, node: process.versions.node, items }, null, 2))
} else {
  console.log('== Antigravity B 站鲸鱼 · 依赖体检 ==')
  for (const i of items) {
    console.log(`${i.ok ? '✓' : '✗'} ${i.name}  ${i.detail ? '— ' + i.detail : ''}`)
    if (!i.ok && i.fix) console.log(`    修：${i.fix}`)
  }
  console.log(bad.length ? `\n✗ ${bad.length} 项需要关注` : '\n✓ 全部可用')
}
process.exit(bad.length ? 3 : 0)
