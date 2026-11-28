/**
 * B 站点赞与关注接口的账号核验与响应处理。
 */
import { requestBili } from './api.mjs'

export async function interactionData(id, options) {
  const result = await requestBili(id, options)
  if (result.status < 200 || result.status >= 300) throw Error(`接口 HTTP ${result.status}`)
  if (!result.ok) throw Error(`接口拒绝请求 code=${result.code}`)
  return result.data
}

export async function verifyInteractionAccount(expected, headers) {
  if (!/^[1-9]\d*$/.test(expected)) throw Error('配置中缺少有效的 self.mid，无法核对账号')
  const nav = await interactionData('nav', { headers, noCache: true })
  if (nav?.isLogin !== true || String(nav.mid) !== expected) throw Error('登录账号与配置 self.mid 不一致或未登录')
}
