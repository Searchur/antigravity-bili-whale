import { createHash } from 'node:crypto'
import path from 'node:path'
import { WHALE_HOME } from '../core/paths.mjs'

export function dmListenerScope(cfg, dataDir = WHALE_HOME) {
  const account = String(cfg.self?.mid ?? '').trim()
  const owner = String(cfg.owner?.mid ?? '').trim()
  if (![account, owner].every(mid => /^[1-9]\d{0,19}$/.test(mid))) return null

  const key = createHash('sha256').update(JSON.stringify([account, owner])).digest('hex')
  const dir = path.join(dataDir, 'dm-listeners', key)
  return { account, owner, stateFile: path.join(dir, 'state.json'), receiptsFile: path.join(dir, 'receipts.json') }
}
