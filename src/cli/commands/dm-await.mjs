/**
 * CLI 命令 `dm-await`：监听主人与已关注粉丝的新私信，支持预览、确认回执与待核查标记。
 */
// 退出码约定：0 = 命中消息/确认/基线初始化；1 + {hit:false} = 正常无新消息；2 = 参数无效；3 = 执行失败。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from '../../config/index.mjs'
import { advanceDmCursor, anchorDmCursor, hasDmCursor, readHistory } from '../../social/dm-history.mjs'
import { pollFanSessions } from '../../social/dm-fan-scan.mjs'
import { acquireProcessLock } from '../../core/process-lock.mjs'
import { dmReadIssue } from '../../bili/private-messages.mjs'
import { dmListenerScope } from '../../social/dm-listener-scope.mjs'
import { requestBili } from '../../bili/api.mjs'
import { biliHeaders, loadCred } from '../../bili/cookie.mjs'
import { atomicWriteJson } from '../../core/atomic-json.mjs'

const argv = process.argv.slice(2)
const peek = argv.includes('--peek')
const json = argv.includes('--json')
const cfg = config()
const scope = dmListenerScope(cfg)
const { account: selfMid, owner, stateFile: file, receiptsFile } = scope ?? {}
const ownerName = String(cfg.owner?.name ?? '主人')

function checkScope() {
  const currentConfig = config({ fresh: true })
  const current = dmListenerScope(currentConfig)
  if (current?.stateFile !== file) throw Error('B 站账号或主人已变化，停止旧私信任务')
  return currentConfig.listen
}

const channelOn = (message, listen) => listen[message.isFan ? 'dmFan' : 'dmOwner'] === true

function save(state) {
  checkScope()
  atomicWriteJson(file, state)
}

function recordFanReceipt(receipt, mid) {
  checkScope()
  let map = {}
  try { map = JSON.parse(fs.readFileSync(receiptsFile, 'utf8')) ?? {} } catch {}
  const now = Date.now()
  for (const [k, v] of Object.entries(map)) {
    if (now - Number(v?.at ?? 0) > 24 * 3600_000) delete map[k]
  }
  map[receipt] = { mid: String(mid), at: now }
  atomicWriteJson(receiptsFile, map)
}

function acknowledge(state, message) {
  const settled = { ...state, pending: undefined, queue: state.queue ?? [], at: new Date().toISOString() }
  if (message.isFan) {
    return { ...settled, fanCursors: {
      ...state.fanCursors,
      [message.mid]: advanceDmCursor(state.fanCursors?.[message.mid] ?? {}, message),
    } }
  }
  return { ...advanceDmCursor(settled, message), owner }
}

const UNCONFIRMED_MAX = 50
function markUnconfirmed(state, p) {
  const entry = { key: p.key, seq: p.seq, mid: p.mid, isFan: !!p.isFan, ts: p.ts, receipt: p.receipt, text: String(p.text ?? '').slice(0, 200), at: new Date().toISOString() }
  const list = [...(state.unconfirmed ?? []).filter(x => x.receipt !== p.receipt), entry].slice(-UNCONFIRMED_MAX)
  const next = acknowledge({ ...state, unconfirmed: list }, p)
  return { ...next, unconfirmed: list }
}

function emit(message, readErrors = []) {
  if (!channelOn(message, checkScope())) return empty(readErrors)
  if (json) console.log(JSON.stringify(readErrors.length ? { ...message, readErrors } : message))
  else {
    console.log(`DM_HIT mid=${message.mid} fan=${!!message.isFan} text=${message.text}`)
    reportReadErrors(readErrors)
  }
  return 0
}

function reportReadErrors(readErrors) {
  for (const { stage, code } of readErrors) console.error(`私信读取失败（阶段 ${stage}，错误码 ${code}）`)
}

function empty(readErrors = []) {
  if (readErrors.length) {
    if (json) console.log(JSON.stringify({ hit: false, readErrors }))
    else reportReadErrors(readErrors)
    return 3
  }
  console.log(json ? JSON.stringify({ hit: false }) : '无新私信')
  return 1
}

async function main() {
  if (!scope) return empty()
  let state = {}
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw Error('invalid state')
  } catch (e) {
    if (e.code !== 'ENOENT') throw Error('私信状态无法读取，已停止推进已读位置：' + e.message)
  }
  const ackIndex = argv.indexOf('--ack')
  const unconfirmedIndex = argv.indexOf('--mark-unconfirmed')
  if (ackIndex >= 0 || unconfirmedIndex >= 0) {
    const receipt = argv[(ackIndex >= 0 ? ackIndex : unconfirmedIndex) + 1]
    const queued = state.queue ?? []
    const message = receipt && (state.pending?.receipt === receipt ? state.pending : queued.find(m => m.receipt === receipt))
    if (!message) {
      console.error('私信确认凭据不匹配，未推进已读状态')
      return 2
    }
    const next = ackIndex >= 0 ? acknowledge(state, message) : markUnconfirmed(state, message)
    if (message !== state.pending) {
      next.pending = state.pending
      next.queue = queued.filter(m => m !== message)
    }
    save(next)
    console.log(ackIndex >= 0 ? '私信交付已确认' : '私信结果未确认，已转入待核查')
    return 0
  }

  if (argv.includes('--list-unconfirmed')) {
    checkScope()
    const list = (state.unconfirmed ?? []).filter(x => x && x.key)
    console.log(JSON.stringify({ count: list.length, items: list }))
    return 0
  }

  const listen = checkScope()
  if (!listen.dmOwner && !listen.dmFan) return empty()
  const explicitBaseline = argv.includes('--baseline')
  if (explicitBaseline && !listen.dmOwner) return empty()
  if (state.pending && channelOn(state.pending, listen) && !explicitBaseline) return emit(state.pending)

  // 暂停的通道保留队列与既有回执，另一通道可继续消费。
  const queued = [...(state.pending ? [state.pending] : []), ...(state.queue ?? [])]
  state = { ...state, pending: undefined, queue: queued }
  const readErrors = []

  if (!queued.some(message => channelOn(message, listen)) || explicitBaseline) {
    const headers = biliHeaders(loadCred())
    let nav
    try {
      nav = await requestBili('nav', { headers })
    } catch (error) {
      return empty([dmReadIssue('identity', error)])
    }
    if (!nav.ok) return empty([dmReadIssue('identity', { code: nav.code || 'HTTP_' + nav.status })])
    if (nav.data?.isLogin !== true || String(nav.data.mid) !== selfMid)
      throw Error('当前 B 站登录账号与配置不一致，未推进私信游标')
    checkScope()

    if (listen.dmOwner && owner) {
      const baseline = explicitBaseline || !hasDmCursor(state)
      const result = await readHistory(owner, headers, state, { baseline, nav, scan: state.ownerScan })
        .catch(error => ({ error, scan: state.ownerScan }))
      if (checkScope().dmOwner) {
        if (result.error) {
          readErrors.push(dmReadIssue('owner-history', result.error))
          if (explicitBaseline) return empty(readErrors)
        } else if (baseline) {
          state = { ...anchorDmCursor(state, result.head), owner }
          if (explicitBaseline) state.queue = queued.filter(message => message.isFan)
        } else if (result.messages.length) {
          const ownerMessages = result.messages.map(message => ({ ...message, mid: owner, name: ownerName, isFan: false }))
          state = {
            ...state, owner, queue: [...state.queue, ...ownerMessages],
            lastIncoming: ownerMessages.reduce((latest, message) => Math.max(latest, message.ts), Number(state.lastIncoming ?? 0)),
          }
        } else if (!result.scan) {
          state = advanceDmCursor(state, result.head)
        }
        state.ownerScan = result.scan ?? undefined
        save(state)
        if (explicitBaseline) {
          console.log('已把当前私信状态标记为已读')
          return 0
        }
      }
    }

    if (listen.dmFan && checkScope().dmFan && !explicitBaseline && !readErrors.some(issue => issue.code === 'BILI_TRAFFIC_PAUSED')) {
      const result = await pollFanSessions({ headers, nav, state, owner, account: selfMid, fanLimits: cfg.fanLimits })
      if (checkScope().dmFan) {
        readErrors.push(...result.readErrors)
        const combined = [...state.queue.slice(queued.length), ...result.messages].sort((a, b) => a.ts - b.ts)
        state = {
          ...state, fanCursors: result.fanCursors, fanBaselineAt: result.fanBaselineAt, fanScan: result.fanScan,
          queue: [...queued, ...combined],
        }
        save(state)
      }
    }
  }

  const currentListen = checkScope()
  const index = state.queue.findIndex(message => channelOn(message, currentListen))
  if (index === -1) return empty(readErrors)
  const [row] = state.queue.splice(index, 1)
  const receipt = row.receipt || crypto.randomUUID()
  const message = {
    hit: true,
    isFan: !!row.isFan,
    mid: row.mid || owner,
    name: row.name || ownerName,
    text: row.text,
    image: row.image ?? null,
    share: row.share ?? null,
    contentKind: row.contentKind ?? (row.type === 7 ? 'share' : 'message'),
    ts: row.ts,
    key: row.key,
    seq: row.seq ?? undefined,
    receipt,
  }
  if (!channelOn(message, checkScope())) return empty(readErrors)
  if (message.isFan) recordFanReceipt(receipt, message.mid)
  if (peek) save({ ...state, pending: message })
  else save(acknowledge(state, message))
  return emit(message, readErrors)
}

let release
try {
  if (scope) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    release = await acquireProcessLock(file, { retries: 20, delayMs: 50 })
  }
  process.exitCode = await main()
} catch (e) {
  console.error(e.message)
  process.exitCode = 3
} finally {
  if (release) await release()
}
