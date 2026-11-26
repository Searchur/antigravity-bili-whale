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
  oncePerPerson: true,
  allDay: false,
  dm: true,
  dmIntervalSec: 60,
})

export const MODEL_DEFAULTS = Object.freeze({
  main: 'flash',
  worker: 'flash_lite',
})

/** 中性默认值：全部基于 Antigravity 内置模型，不依赖外部 API。 */
export const DEFAULTS = {
  chat: CHAT_DEFAULTS,
  life: LIFE_DEFAULTS,
  models: { ...MODEL_DEFAULTS },
  sessionRotateDays: 0,
  personaOncePerSession: true,
  risk: { minGapMs: 1500, readHourly: 600, readDaily: 3000, writeHourly: 12, writeDaily: 30, writeGapSec: 120, dmGapSec: 60 },
  persona: {
    name: '',
    ownerTitle: '主人',
    selfClaim: '我',
    diaryTitle: '今日摘要',
  },
  preferences: {
    like: ['AI 工具与插件', '鬼畜与怀旧向剪辑', '猫咪', 'Live2D/模型'],
    dislike: ['带货', '擦边', '标题党', '纯搬运'],
    keywords: [],
  },
  notify: { type: 'none', url: '', template: 'text', cmd: '', args: [] },
  aliases: [],
  owner: { mid: '', name: '' },
  self: { mid: '', name: '' },
  quota: { shareDaily: 3 },
  diary: { push: true, enabled: true },
  share: { aiCommentGuard: false, aiThreshold: 30, enabled: true, via: 'dm', minScore: 13, silentAfterDays: 3 },
  listen: { ...LISTEN_DEFAULTS },
  night: { windows: [{ start: '20:00', end: '24:00', wakes: 1 }], skipChance: 0.3, minGapMin: 10, maxVideos: 5 },
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
  merged.__hasUserFile = Object.keys(user).length > 0
  cache = merged
  return cache
}
