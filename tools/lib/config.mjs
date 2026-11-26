import fs from 'node:fs'
import { LIFE_DEFAULTS } from './life-config.mjs'
import { CHAT_DEFAULTS } from './chat-config.mjs'
import { configPath } from './paths.mjs'

export { configPath } from './paths.mjs'

export const BROWSE_DEFAULTS = Object.freeze({
  enabled: false,
})

export const LISTEN_DEFAULTS = Object.freeze({
  dmOwner: false,
  dmFan: false,
  dmIntervalSec: 300,
  commentOwner: false,
  commentFan: false,
  commentIntervalSec: 300,
  mentionSummaryOwner: false,
  mentionSummaryFan: false,
  allDay: false,
})

export const FAN_LIMITS_DEFAULTS = Object.freeze({
  dmPerUserDaily: 2,
  dmTotalDaily: 10,
  commentPerUserDaily: 1,
  commentTotalDaily: 10,
  mentionPerUserDaily: 1,
  mentionTotalDaily: 5,
})

export const SAFETY_DEFAULTS = Object.freeze({
  enabled: true,
  mode: 'dual',
  scope: 'all',
  customWords: [],
})

export const MODEL_DEFAULTS = Object.freeze({
  main: 'flash',
  worker: 'flash_lite',
  minQuotaPercent: 20,
})

const WATCH_MODE_BASE = Object.freeze({
  mode: 'auto',
  frameStrategy: 'interval',
  frameEverySec: 15,
  maxFrames: 16,
  frameGrid: '3x3',
})

export const WATCH_DEFAULTS = Object.freeze({
  auto: Object.freeze({
    maxDurationMin: 10,
    minDurationSec: 60,
    ...WATCH_MODE_BASE,
    mode: 'always_frames',
  }),
  ownerMention: Object.freeze({
    autoMaxMin: 10,
    confirmMaxMin: 20,
    replyStyle: 'comment',
    ...WATCH_MODE_BASE,
  }),
  fanMention: Object.freeze({
    autoMaxMin: 5,
    confirmMaxMin: 5,
    ...WATCH_MODE_BASE,
    mode: 'auto',
  }),
})

export const MAX_LIKE_TAGS = 6
export const MAX_DISLIKE_TAGS = 12
export const MAX_PERSONA_CHARS = 4000
export const MAX_CUSTOM_SAFETY_WORDS = 50

/** 中性默认值：使用 Antigravity 自适应模型；对外分享/监听开关默认关闭（自主评论除外）；安全审核默认开启。 */
export const DEFAULTS = {
  browse: { ...BROWSE_DEFAULTS },
  chat: { ...CHAT_DEFAULTS },
  life: { ...LIFE_DEFAULTS, autonomy: false },
  models: { ...MODEL_DEFAULTS },
  watch: {
    auto: { ...WATCH_DEFAULTS.auto },
    ownerMention: { ...WATCH_DEFAULTS.ownerMention },
    fanMention: { ...WATCH_DEFAULTS.fanMention },
  },
  fanLimits: { ...FAN_LIMITS_DEFAULTS },
  safety: { ...SAFETY_DEFAULTS, customWords: [] },
  sessionRotateDays: 7,
  personaOncePerSession: true,
  risk: { minGapMs: 1500, readHourly: 600, readDaily: 3000, writeHourly: 12, writeDaily: 30, writeGapSec: 120, dmGapSec: 60 },
  persona: {
    name: '大鲸鱼',
    ownerTitle: '主人',
    selfClaim: '我',
  },
  preferences: {
    like: ['AI 工具', '科技新闻', '编程开发', '数码评测'],
    dislike: ['带货', '擦边', '标题党', '纯搬运'],
    keywords: [],
  },
  aliases: [],
  owner: { mid: '', name: '' },
  self: { mid: '', name: '' },
  quota: { shareDaily: 3 },
  share: { enabled: false, via: 'comment', minScore: 13, silentAfterDays: 3 },
  listen: { ...LISTEN_DEFAULTS },
  night: { windows: [{ start: '00:00', end: '24:00', wakes: 5 }], skipChance: 0.2, minGapMin: 10, maxVideos: 5, deepWatchMax: 3, maxWakesPerDay: 5 },
}

export function withoutRetiredListening(cfg) {
  const listen = { ...cfg.listen }
  for (const key of ['live', 'liveRoom', 'liveScope', 'oncePerPerson', 'scope']) delete listen[key]
  return { ...cfg, listen }
}

const clampInt = (v, min, max, fallback) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback
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
    minQuotaPercent: clampInt(src.minQuotaPercent, 0, 80, MODEL_DEFAULTS.minQuotaPercent),
  }
}

function normalizeWatchView(src, defaults) {
  const s = src && typeof src === 'object' ? src : {}
  const rawMode = s.mode ?? s.frameMode
  return {
    mode: ['text_only', 'auto', 'always_frames'].includes(rawMode) ? rawMode : defaults.mode,
    frameStrategy: 'interval',
    frameEverySec: clampInt(s.frameEverySec, 3, 120, defaults.frameEverySec),
    maxFrames: clampInt(s.maxFrames, 4, 60, defaults.maxFrames),
    frameGrid: ['2x2', '3x3', '4x4'].includes(s.frameGrid) ? s.frameGrid : defaults.frameGrid,
  }
}

export function normalizeWatch(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const a = src.auto && typeof src.auto === 'object' ? src.auto : {}
  // 兼容旧版 watch.mention -> watch.ownerMention
  const om = (src.ownerMention && typeof src.ownerMention === 'object')
    ? src.ownerMention
    : (src.mention && typeof src.mention === 'object' ? src.mention : {})
  const fm = src.fanMention && typeof src.fanMention === 'object' ? src.fanMention : {}

  const maxDurationMin = clampInt(a.maxDurationMin, 1, 30, WATCH_DEFAULTS.auto.maxDurationMin)
  const minDurationSec = Math.max(0, Math.min(maxDurationMin * 60 - 1, clampInt(a.minDurationSec, 0, 600, WATCH_DEFAULTS.auto.minDurationSec)))

  const ownerAutoMax = clampInt(om.autoMaxMin, 1, 60, WATCH_DEFAULTS.ownerMention.autoMaxMin)
  const ownerConfirmMax = Math.max(ownerAutoMax, clampInt(om.confirmMaxMin, 1, 120, WATCH_DEFAULTS.ownerMention.confirmMaxMin))

  const fanAutoMax = clampInt(fm.autoMaxMin, 1, 30, WATCH_DEFAULTS.fanMention.autoMaxMin)

  return {
    auto: {
      maxDurationMin,
      minDurationSec,
      ...normalizeWatchView(a, WATCH_DEFAULTS.auto),
    },
    ownerMention: {
      autoMaxMin: ownerAutoMax,
      confirmMaxMin: ownerConfirmMax,
      replyStyle: ['comment', 'dm', 'both'].includes(om.replyStyle) ? om.replyStyle : WATCH_DEFAULTS.ownerMention.replyStyle,
      ...normalizeWatchView(om, WATCH_DEFAULTS.ownerMention),
    },
    fanMention: {
      autoMaxMin: fanAutoMax,
      confirmMaxMin: fanAutoMax,
      ...normalizeWatchView(fm, WATCH_DEFAULTS.fanMention),
    },
  }
}

export function normalizeListen(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  // 兼容旧版 dm / comment / mentionSummary 字段平滑升级
  const dmOwner = typeof src.dmOwner === 'boolean' ? src.dmOwner : (src.dm === true)
  const dmFan = src.dmFan === true
  const commentOwner = typeof src.commentOwner === 'boolean' ? src.commentOwner : (src.comment === true)
  const commentFan = typeof src.commentFan === 'boolean' ? src.commentFan : (src.comment === true && src.onlyOwner !== true)
  const mentionSummaryOwner = typeof src.mentionSummaryOwner === 'boolean' ? src.mentionSummaryOwner : (src.mentionSummary === true)
  const mentionSummaryFan = src.mentionSummaryFan === true
  return {
    dmOwner,
    dmFan,
    dmIntervalSec: clampInt(src.dmIntervalSec, 20, 600, LISTEN_DEFAULTS.dmIntervalSec),
    commentOwner,
    commentFan,
    commentIntervalSec: clampInt(src.commentIntervalSec, 20, 600, LISTEN_DEFAULTS.commentIntervalSec),
    mentionSummaryOwner,
    mentionSummaryFan,
    allDay: src.allDay === true,
  }
}

export function normalizeFanLimits(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const dmPerUserDaily = clampInt(src.dmPerUserDaily, 1, 10, FAN_LIMITS_DEFAULTS.dmPerUserDaily)
  const dmTotalDaily = Math.max(dmPerUserDaily, clampInt(src.dmTotalDaily, 1, 100, FAN_LIMITS_DEFAULTS.dmTotalDaily))
  const commentPerUserDaily = clampInt(src.commentPerUserDaily, 1, 10, FAN_LIMITS_DEFAULTS.commentPerUserDaily)
  const commentTotalDaily = Math.max(commentPerUserDaily, clampInt(src.commentTotalDaily, 1, 100, FAN_LIMITS_DEFAULTS.commentTotalDaily))
  const mentionPerUserDaily = clampInt(src.mentionPerUserDaily, 1, 5, FAN_LIMITS_DEFAULTS.mentionPerUserDaily)
  const mentionTotalDaily = Math.max(mentionPerUserDaily, clampInt(src.mentionTotalDaily, 1, 10, FAN_LIMITS_DEFAULTS.mentionTotalDaily))
  return {
    dmPerUserDaily,
    dmTotalDaily,
    commentPerUserDaily,
    commentTotalDaily,
    mentionPerUserDaily,
    mentionTotalDaily,
  }
}

export function normalizeSafety(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const words = [...new Set((Array.isArray(src.customWords) ? src.customWords : []).map(s => String(s ?? '').trim()).filter(Boolean))].slice(0, MAX_CUSTOM_SAFETY_WORDS)
  return {
    enabled: src.enabled !== false,
    mode: ['dual', 'local_only'].includes(src.mode) ? src.mode : SAFETY_DEFAULTS.mode,
    scope: ['all', 'external_only'].includes(src.scope) ? src.scope : SAFETY_DEFAULTS.scope,
    customWords: words,
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
  merged.browse = { enabled: user.browse?.enabled === true }
  merged.models = normalizeModels(merged.models)
  merged.watch = normalizeWatch(user.watch)
  merged.listen = normalizeListen(user.listen ?? merged.listen)
  merged.fanLimits = normalizeFanLimits(merged.fanLimits)
  merged.safety = normalizeSafety(merged.safety)
  delete merged.diary
  delete merged.notify
  merged.life = { ...(merged.life ?? {}), autonomy: false }
  merged.personaOncePerSession = true
  if (!String(merged.persona?.name ?? '').trim()) merged.persona = { ...(merged.persona ?? {}), name: '大鲸鱼' }
  merged.__hasUserFile = Object.keys(user).length > 0
  cache = merged
  return cache
}
