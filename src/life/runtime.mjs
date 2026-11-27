/**
 * 长期状态运行时入口：按当前配置构建隔离的 lifeStore 实例与评论线程键。
 */
import { config } from '../config/index.mjs'
import { createLifeStore } from './store.mjs'

export function lifeStore(cfg = config(), extra = {}) {
  return createLifeStore({
    account: String(cfg.self?.mid ?? ''),
    owner: String(cfg.owner?.mid ?? ''),
    ownerName: String(cfg.owner?.name ?? ''),
    config: cfg.life,
    fullConfig: () => config({ fresh: true }),
    ...extra,
  })
}

export const threadKey = (type, oid, root) => [String(type ?? 1), String(oid), String(root || 'top')].join(':')
