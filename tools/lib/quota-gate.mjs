// 限额闸的统一入口（评论 / 动态等写通道共用检查与记账）
import { execFileSync } from './capture.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NODE_EXE } from './nodebin.mjs'   // 2026-10-21：别用 process.execPath（Electron 里它是主程序 ✗）
import { acquireProcessLock } from './process-lock.mjs'
import { dataPath } from './paths.mjs'
export { flushQuotaReceipts } from './quota-ledger.mjs'

const QUOTA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'commands', 'quota.mjs')

function run(args) {
  try {
    return { code: 0, out: execFileSync(NODE_EXE, [QUOTA, ...args], { encoding: 'utf8' }).trim() }
  } catch (e) {
    return { code: e.status ?? 1, out: [e.stdout, e.stderr].filter(Boolean).join('\n').trim() || e.message }
  }
}

/**
 * 发之前过闸。返回 true = 放行。
 * @param {{type:string, target?:string, auto?:boolean, share?:boolean}} o
 */
export function gate({ type, target = '', auto = true, share = false }) {
  const r = run(['check', '--type', type, '--target', target, ...(share ? ['--share'] : auto ? ['--auto'] : [])])
  console.log(`[限额闸] ${r.out}`)
  return r.code === 0
}

export async function lockQuotaForSend(options) {
  const release = await acquireProcessLock(dataPath('quota-send'), { retries: 40 })
  try {
    if (!gate(options)) throw Error('额度检查未通过，停止发送')
    return release
  } catch (error) {
    await release()
    throw error
  }
}
