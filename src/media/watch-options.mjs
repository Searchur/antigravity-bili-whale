import { normalizeWatch } from '../config/index.mjs'

export function parseGrid(gridStr = '3x3') {
  const norm = String(gridStr ?? '3x3').trim().toLowerCase()
  const [cols, rows] = norm.split('x').map(Number)
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols * rows > 64) {
    throw Error('格子格式应是 2x2 / 3x3 / 4x4 这样')
  }
  return { cols, rows, perSheet: cols * rows, grid: `${cols}x${rows}` }
}

export function formatDurationZh(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0))
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m === 0) return `${s} 秒`
  return s === 0 ? `${m} 分钟` : `${m} 分 ${s} 秒`
}

export function resolveWatchProfile(cfg = {}, rawProfile = 'auto') {
  const w = normalizeWatch(cfg?.watch)
  const p = String(rawProfile ?? 'auto').trim().toLowerCase()
  if (p === 'owner' || p === 'owner-mention') return { profile: 'owner', settings: w.ownerMention }
  if (p === 'fan' || p === 'fan-mention') return { profile: 'fan', settings: w.fanMention }
  return { profile: 'auto', settings: w.auto }
}

export function checkWatchDuration(durationSec, { profile = 'auto', settings = {}, confirmed = false } = {}) {
  const dur = Number(durationSec)
  if (!Number.isFinite(dur) || dur <= 0) {
    return { ok: false, code: 'invalid_duration', reason: '视频时长无效，无法继续观看。' }
  }
  if (profile === 'owner') {
    const autoMaxMin = Math.max(1, Number(settings.autoMaxMin ?? 10))
    const confirmMaxMin = Math.max(autoMaxMin, Number(settings.confirmMaxMin ?? 20))
    if (dur > confirmMaxMin * 60) {
      return {
        ok: false,
        code: 'too_long',
        reason: `视频时长 ${formatDurationZh(dur)} 超过主人 @ 观看上限（${confirmMaxMin} 分钟），一律不看，请礼貌回复主人说明超过时长上限。`,
      }
    }
    if (dur > autoMaxMin * 60 && !confirmed) {
      return {
        ok: false,
        code: 'needs_confirm',
        reason: `视频时长 ${formatDurationZh(dur)} 介于主人直接观看上限（${autoMaxMin} 分钟）与确认上限（${confirmMaxMin} 分钟）之间，请先回复主人告知时长并询问确认；主人确认后再带 --confirmed 观看。`,
      }
    }
    return { ok: true }
  }
  if (profile === 'fan') {
    const autoMaxMin = Math.max(1, Number(settings.autoMaxMin ?? 10))
    if (dur > autoMaxMin * 60) {
      return {
        ok: false,
        code: 'too_long',
        reason: `视频时长 ${formatDurationZh(dur)} 超过粉丝 @ 观看上限（${autoMaxMin} 分钟），一律不看，请礼貌回复该粉丝说明超过时长上限。`,
      }
    }
    return { ok: true }
  }
  const minSec = Math.max(0, Number(settings.minDurationSec ?? 60))
  const maxMin = Math.max(1, Number(settings.maxDurationMin ?? 10))
  if (dur < minSec) {
    return {
      ok: false,
      code: 'too_short',
      reason: `视频时长 ${formatDurationZh(dur)} 低于自主观看最短时长限制（${formatDurationZh(minSec)}），已跳过。`,
    }
  }
  if (dur > maxMin * 60) {
    return {
      ok: false,
      code: 'too_long',
      reason: `视频时长 ${formatDurationZh(dur)} 超过自主观看最长时长限制（${maxMin} 分钟），已拦截不看。`,
    }
  }
  return { ok: true }
}

/**
 * 固定间隔抽帧 + 固定拼图格数分片计划：
 * - 起始帧即为间隔（不使用每段中点采样，0 秒不算第 1 帧）；
 * - 时长不能被间隔整除时向上取整（Math.ceil）；
 * - 若超过最多抽帧上限，则封顶并按整片等间隔重采样；
 * - 每张拼图严格按固定 cols×rows 排版，最后一张不足格数时由 ffmpeg 补黑留白。
 */
export function planIntervalFrames({ durationSec, everySec = 15, maxFrames = 36, grid = '3x3' }) {
  const dur = Number(durationSec)
  if (!Number.isFinite(dur) || dur <= 0) throw Error('视频时长无效')
  const every = Math.max(1, Number(everySec) || 15)
  const cap = Math.min(60, Math.max(1, Math.floor(Number(maxFrames) || 36)))
  const { cols, rows, perSheet, grid: normGrid } = parseGrid(grid)

  const rawFrames = Math.max(1, Math.ceil(dur / every))
  const capped = rawFrames > cap
  const frameCount = Math.min(cap, rawFrames)
  const effectiveStep = capped ? dur / frameCount : every
  const safeEnd = dur > 1 ? Math.max(0, dur - Math.min(1.5, dur * 0.1)) : Math.max(0, dur * 0.5)

  const times = []
  for (let idx = 0; idx < frameCount; idx++) {
    const nominal = (idx + 1) * effectiveStep
    const clamped = Math.min(nominal, safeEnd)
    // Avoid clamping the last frame onto the exact same timestamp as the previous frame
    if (times.length > 0 && clamped <= times.at(-1) + 0.05) {
      const mid = (times.at(-1) + dur) / 2
      times.push(Math.min(dur > 0.2 ? dur - 0.1 : dur, mid))
    } else {
      times.push(clamped)
    }
  }
  const sheetCount = Math.ceil(frameCount / perSheet)
  const lastSheetFrames = frameCount % perSheet || perSheet

  return {
    durationSec: dur,
    everySec: every,
    maxFrames: cap,
    rawFrames,
    capped,
    frameCount,
    effectiveStep,
    cols,
    rows,
    perSheet,
    grid: normGrid,
    sheetCount,
    lastSheetFrames,
    times,
  }
}

export function watchOptions(args, defaultDir) {
  const positional = []
  let tile = 720
  let everySec = null
  let maxFrames = null
  let profile = null
  let confirmed = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--tile' || arg.startsWith('--tile=')) {
      const value = arg === '--tile' ? args[++i] : arg.slice(7)
      tile = Number(value)
      if (!Number.isInteger(tile) || tile < 240 || tile > 1280) throw Error('--tile 必须是 240–1280 的整数')
    } else if (arg === '--every' || arg.startsWith('--every=')) {
      const value = arg === '--every' ? args[++i] : arg.slice(8)
      everySec = Number(value)
      if (!Number.isFinite(everySec) || everySec < 3 || everySec > 120) throw Error('--every 必须是 3–120 的秒数')
    } else if (arg === '--max-frames' || arg.startsWith('--max-frames=')) {
      const value = arg === '--max-frames' ? args[++i] : arg.slice(13)
      maxFrames = Number(value)
      if (!Number.isInteger(maxFrames) || maxFrames < 4 || maxFrames > 60) throw Error('--max-frames 必须是 4–60 的整数')
    } else if (arg === '--profile' || arg.startsWith('--profile=')) {
      const value = arg === '--profile' ? args[++i] : arg.slice(10)
      profile = String(value ?? 'auto').trim().toLowerCase()
    } else if (arg === '--confirmed') {
      confirmed = true
    } else if (!arg.startsWith('--')) {
      positional.push(arg)
    } else if (arg !== '--full-download') {
      throw Error('未知抽帧选项：' + arg)
    }
  }
  return {
    bvid: positional[0],
    grid: positional[1] ? positional[1].toLowerCase() : null,
    outDir: positional[2] ?? defaultDir,
    tile,
    ...(everySec !== null ? { everySec } : {}),
    ...(maxFrames !== null ? { maxFrames } : {}),
    ...(profile !== null ? { profile } : {}),
    confirmed,
    ...(args.includes('--full-download') ? { fullDownload: true } : {}),
  }
}
