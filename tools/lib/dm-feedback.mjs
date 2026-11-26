import fs from 'node:fs'
import { WHALE_HOME } from './paths.mjs'
import { dmListenerScope } from './dm-listener-scope.mjs'

export function latestFeedback(last, config, dataDir = WHALE_HOME, now = Date.now()) {
  const scope = dmListenerScope(config, dataDir)
  let dm = 0
  try { if (scope) dm = Number(JSON.parse(fs.readFileSync(scope.stateFile, 'utf8')).lastIncoming) * 1000 } catch {}
  const previous = Date.parse(last)
  const valid = [previous, dm].filter(t => Number.isFinite(t) && t > 0 && t <= now)
  return valid.length ? new Date(Math.max(...valid)).toISOString() : null
}
