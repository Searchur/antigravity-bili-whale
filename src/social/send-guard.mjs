/**
 * 社交互动外发写操作守卫：在执行平台发送前完成长期状态校验、预占令牌与配额追踪。
 */
import { config } from '../config/index.mjs'
import { lifeStore } from '../life/runtime.mjs'
import { trackQuotaOperation } from './quota-ledger.mjs'

export async function guardSend(request, { dry = false } = {}) {
  const cfg = config()
  const store = lifeStore(cfg)
  // Preferences are evaluated inside reserve as well; a concurrent approval
  // must not leave a check-to-send bypass window.
  request.ownerName = String(config().owner?.name ?? '')
  const result = store.check(request)
  if (!result.allow) throw Error(result.reason)
  if (dry) return { store, token: null }
  const token = await store.reserve(request)
  if (request.quotaTarget) {
    try { trackQuotaOperation(token, String(cfg.self.mid), String(cfg.owner.mid)) }
    catch (error) {
      await store.settle(token, { status: 'not-sent', verified: true })
      throw error
    }
  }
  return { store, token }
}
