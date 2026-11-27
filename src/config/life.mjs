/**
 * 长期状态与记忆归纳配置默认值及合法范围校验。
 */
import {affectConfig,AFFECT_DEFAULTS} from './affect.mjs'
import {dynamicConfig,DYNAMIC_DEFAULTS} from './dynamic-memory.mjs'

export const LIFE_DEFAULTS = {
  affect: AFFECT_DEFAULTS,
  dynamicMemory: DYNAMIC_DEFAULTS,
  enabled: true, paused: false,
  threadReplies: 4, threadDaily: 8, cooldownMinutes: 60, duplicateHours: 24,
  memoryChars: 5000, recentEvents: 20, retentionDays: 30, maxEvents: 1200,
  autonomy: false, learnFromLikes: false,
  learningEnabled: true, formationWakeIntervalSec: 21600, learningIntervalSec: 300,
  learningLeaseSec: 600, learningDailyJobs: 24, learningMaxMemories: 1000,
  commentVerifySeconds: 30,
}

const KNOWN_LIFE_KEYS = Object.keys(LIFE_DEFAULTS)

export function lifeConfig(input = {}) {
  const picked = {}
  if (input && typeof input === 'object') {
    for (const key of KNOWN_LIFE_KEYS) {
      if (input[key] !== undefined) picked[key] = input[key]
    }
  }
  const c = {
    ...LIFE_DEFAULTS,
    ...picked,
    affect: affectConfig(input?.affect),
    dynamicMemory: { ...dynamicConfig(input?.dynamicMemory), enabled: true, shadow: false },
  }
  for (const key of ['enabled', 'paused', 'autonomy', 'learnFromLikes', 'learningEnabled']) {
    if (typeof c[key] !== 'boolean') throw Error('life.' + key + ' 必须是布尔值')
  }
  for (const [key, min, max] of [
    ['formationWakeIntervalSec', 300, 86400], ['learningIntervalSec', 30, 86400],
    ['learningLeaseSec', 60, 3600], ['learningDailyJobs', 0, 100], ['learningMaxMemories', 200, 10000],
    ['threadReplies', 1, 30], ['threadDaily', 1, 100], ['cooldownMinutes', 1, 10080],
    ['duplicateHours', 1, 720], ['memoryChars', 500, 20000], ['recentEvents', 1, 100],
    ['retentionDays', 7, 365], ['maxEvents', 100, 10000], ['commentVerifySeconds', 1, 30],
  ]) {
    if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max) throw Error('life.' + key + ' 超出范围 ' + min + '–' + max)
  }
  return c
}
