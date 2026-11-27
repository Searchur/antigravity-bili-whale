// 限额闸的统一入口（评论 / 动态等写通道共用检查与记账）
import { execFileSync } from './capture.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NODE_EXE } from './nodebin.mjs'   // 2026-10-21：别用 process.execPath（Electron 里它是主程序 ✗）

const QUOTA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'commands', 'quota.mjs')

function run(args) {
  try {
    return { code: 0, out: execFileSync(NODE_EXE, [QUOTA, ...args], { encoding: 'utf8' }).trim() }
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? e.message).trim() }
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

/** 发成功之后记账（失败也算失败，不该记账） */
export function record({ type, target = '', note = '', auto = true, share = false }) {
  const r = run(['record', '--type', type, '--target', target, '--note', String(note).slice(0, 40), ...(share ? ['--share'] : auto ? ['--auto'] : [])])
  console.log(`[限额闸] ${r.out}`)
}
