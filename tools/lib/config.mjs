import fs from 'node:fs'
import { LIFE_DEFAULTS } from './life-config.mjs'
import { CHAT_DEFAULTS } from './chat-config.mjs'
import { configPath } from './paths.mjs'

export { configPath } from './paths.mjs'

export const LISTEN_DEFAULTS = Object.freeze({
  onlyOwner: false,
  comment: false,
  commentIntervalSec: 60,
  scope: 'both',
  oncePerPerson: false,
  allDay: false,
  dm: false,
  dmIntervalSec: 60,
  mentionSummary: false,
})

export const MODEL_DEFAULTS = Object.freeze({
  main: 'flash',
  worker: 'flash_lite',
})

export const WATCH_DEFAULTS = Object.freeze({
  auto: Object.freeze({
    maxDurationMin: 15,
    minDurationSec: 30,
    mode: 'auto',
    frameStrategy: 'interval',
    frameEverySec: 15,
    maxFrames: 16,
    frameGrid: '3x3',
  }),
  mention: Object.freeze({
    autoMaxMin: 5,
    confirmMaxMin: 10,
    frameMode: 'auto',
    replyStyle: 'comment',
  }),
})

export const MAX_LIKE_TAGS = 6
export const MAX_DISLIKE_TAGS = 12
export const MAX_PERSONA_CHARS = 4000

/** 中性默认值：全部基于 Antigravity 内置模型，不依赖外部 API；分享与监听项默认均不勾选。 */
export const DEFAULTS = {
  chat: CHAT_DEFAULTS,
  life: LIFE_DEFAULTS,
  models: { ...MODEL_DEFAULTS },
  watch: {
    auto: { ...WATCH_DEFAULTS.auto },
    mention: { ...WATCH_DEFAULTS.mention },
  },
  sessionRotateDays: 0,
  personaOncePerSession: true,
  risk: { minGapMs: 1500, readHourly: 600, readDaily: 3000, writeHourly: 12, writeDaily: 30, writeGapSec: 120, dmGapSec: 60 },
  persona: {
    name: '大鲸鱼',
    ownerTitle: '主人',
    selfClaim: '我',
    diaryTitle: '今日摘要',
  },
  preferences: {
    like: ['AI 工具', '科技新闻', '编程开发', '效率软件'],
    dislike: ['带货', '擦边', '标题党', '纯搬运'],
    keywords: [],
  },
  notify: { type: 'none', url: '', template: 'text', cmd: '', args: [] },
  aliases: [],
  owner: { mid: '', name: '' },
  self: { mid: '', name: '' },
  quota: { shareDaily: 3 },
  diary: { push: false, enabled: false },
  share: { aiCommentGuard: false, aiThreshold: 30, enabled: false, via: 'dm', minScore: 13, silentAfterDays: 3 },
  listen: { ...LISTEN_DEFAULTS },
  night: { windows: [{ start: '20:00', end: '24:00', wakes: 1 }], skipChance: 0.2, minGapMin: 10, maxVideos: 5, deepWatchMax: 3 },
}

export function withoutRetiredListening(cfg) {
  const listen = { ...cfg.listen }
  for (const key of ['live', 'liveRoom', 'liveScope']) delete listen[key]
  return { ...cfg, listen }
}

const VALID_MODEL_RE = /^[a-zA-Z0-9._:-]{2,128}$/
export function normalizeModels(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const pick = (v, fallback) => {
    const s = String(v ?? '').trim()
    return VALID_MODEL_RE.test(s) ? s : fallback
  }
  return {
    main: pick(src.main, MODEL_DEFAULTS.main),
    worker: pick(src.worker, MODEL_DEFAULTS.worker),
  }
}

export function normalizeWatch(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const a = src.auto && typeof src.auto === 'object' ? src.auto : {}
  const m = src.mention && typeof src.mention === 'object' ? src.mention : {}
  const clampInt = (v, min, max, fallback) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback
  }
  const maxDurationMin = clampInt(a.maxDurationMin, 1, 120, WATCH_DEFAULTS.auto.maxDurationMin)
  const minDurationSec = Math.min(maxDurationMin * 60 - 1, clampInt(a.minDurationSec, 0, 600, WATCH_DEFAULTS.auto.minDurationSec))
  const autoMaxMin = clampInt(m.autoMaxMin, 1, 60, WATCH_DEFAULTS.mention.autoMaxMin)
  const confirmMaxMin = Math.max(autoMaxMin, clampInt(m.confirmMaxMin, 1, 120, WATCH_DEFAULTS.mention.confirmMaxMin))
  return {
    auto: {
      maxDurationMin,
      minDurationSec: Math.max(0, minDurationSec),
      mode: ['text_only', 'auto', 'always_frames'].includes(a.mode) ? a.mode : WATCH_DEFAULTS.auto.mode,
      frameStrategy: ['interval', 'grid'].includes(a.frameStrategy) ? a.frameStrategy : WATCH_DEFAULTS.auto.frameStrategy,
      frameEverySec: clampInt(a.frameEverySec, 3, 120, WATCH_DEFAULTS.auto.frameEverySec),
      maxFrames: clampInt(a.maxFrames, 4, 36, WATCH_DEFAULTS.auto.maxFrames),
      frameGrid: ['2x2', '3x3', '4x4'].includes(a.frameGrid) ? a.frameGrid : WATCH_DEFAULTS.auto.frameGrid,
    },
    mention: {
      autoMaxMin,
      confirmMaxMin,
      frameMode: ['text_only', 'auto', 'always_frames'].includes(m.frameMode) ? m.frameMode : WATCH_DEFAULTS.mention.frameMode,
      replyStyle: ['comment', 'notify', 'both'].includes(m.replyStyle) ? m.replyStyle : WATCH_DEFAULTS.mention.replyStyle,
    },
  }
}

const merge = (base, over) => {
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? merge(base[k] ?? {}, v) : v
  }
  return out
}

let cache = null
/** 读取合并后的配置（带缓存）。 */
export function config({ fresh = false } = {}) {
  if (cache && !fresh) return cache
  let user = {}
  try { user = JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch { /* 首次运行用默认值 */ }
  const merged = withoutRetiredListening(merge(DEFAULTS, user))
  merged.models = normalizeModels(merged.models)
  merged.watch = normalizeWatch(merged.watch)
  if (!String(merged.persona?.name ?? '').trim()) merged.persona = { ...(merged.persona ?? {}), name: '大鲸鱼' }
  merged.__hasUserFile = Object.keys(user).length > 0
  cache = merged
  return cache
}
