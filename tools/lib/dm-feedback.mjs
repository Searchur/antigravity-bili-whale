import fs from 'node:fs'
import path from 'node:path'
import { WHALE_HOME } from './paths.mjs'
export function latestFeedback(last, owner, dataDir = WHALE_HOME, now = Date.now()) {
  let state = {}
  try { state = JSON.parse(fs.readFileSync(path.join(dataDir, 'dm-await-state.json'), 'utf8')) } catch {}
  const dm = state.owner === String(owner) && owner ? Number(state.lastIncoming) * 1000 : 0
  const previous = Date.parse(last)
  const valid = [previous, dm].filter(t => Number.isFinite(t) && t > 0 && t <= now)
  return valid.length ? new Date(Math.max(...valid)).toISOString() : null
}
