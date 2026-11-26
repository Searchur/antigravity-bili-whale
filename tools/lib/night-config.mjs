import fs from 'node:fs'
import path from 'node:path'
import { WHALE_HOME, configPath } from './paths.mjs'

export const NIGHT_DEFAULTS = Object.freeze({
  windows: [{ start: '20:00', end: '24:00', wakes: 1 }],
  skipChance: 0.2,
  minGapMin: 10,
  maxVideos: 5,
  deepWatchMax: 3,
})

export function mergeNightConfig({ user = {}, defaults = NIGHT_DEFAULTS } = {}) {
  return { merged: { ...defaults, ...user }, migrated: false }
}

const configFile = (home) => process.env.BILI_WHALE_CONFIG || (home === WHALE_HOME ? configPath : path.join(home, 'config.json'))

export function readNightConfig(home = WHALE_HOME) {
  let user = {}
  try {
    const whole = JSON.parse(fs.readFileSync(configFile(home), 'utf8'))
    user = whole?.night ?? {}
  } catch {}
  return { ...NIGHT_DEFAULTS, ...user }
}
