import { credentialsPath } from '../../core/paths.mjs'
// Exit contract: 0 = message/ack/baseline; 1 + {hit:false} = normal empty; 2 = invalid input; 3 = failure.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from '../../config/index.mjs'
import { readHistory } from '../../social/dm-history.mjs'
import { acquireProcessLock } from '../../core/process-lock.mjs'
import { exactJson } from '../../core/json-exact.mjs'
import { guardedFetch as fetch } from '../../bili/traffic.mjs'
import { checkRelation } from '../../bili/relation.mjs'
import { checkFanQuota } from '../../social/fan-quota.mjs'
import { dmListenerScope } from '../../social/dm-listener-scope.mjs'
import { apiGet } from '../../bili/api.mjs'
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
  if (message.isFan) {
    const fanCursors = { ...(state.fanCursors ?? {}) }
    const prev = fanCursors[message.mid] ?? {}
    const same = Number(prev.lastSeen) === message.ts
    fanCursors[message.mid] = {
      lastSeen: message.ts,
      lastKey: message.key,
      lastKeys: [...new Set([...(same ? (prev.lastKeys ?? (prev.lastKey ? [prev.lastKey] : [])) : []), message.key])],
    }
    return { ...state, fanCursors, pending: undefined, queue: state.queue ?? [], at: new Date().toISOString() }
  }
  const same = Number(state.lastSeen) === message.ts
  return {
    ...state,
    owner,
    lastSeen: message.ts,
    lastKey: message.key,
    lastKeys: [...new Set([...(same ? (state.lastKeys ?? (state.lastKey ? [state.lastKey] : [])) : []), message.key])],
    pending: undefined,
    queue: state.queue ?? [],
    at: new Date().toISOString(),
  }
}

const UNCONFIRMED_MAX = 50
function markUnconfirmed(state, p) {
  const entry = { key: p.key, mid: p.mid, isFan: !!p.isFan, ts: p.ts, receipt: p.receipt, text: String(p.text ?? '').slice(0, 200), at: new Date().toISOString() }
  const list = [...(state.unconfirmed ?? []).filter(x => x.key !== entry.key), entry].slice(-UNCONFIRMED_MAX)
  const next = acknowledge({ ...state, unconfirmed: list }, p)
  return { ...next, unconfirmed: list }
}

function emit(message) {
  if (!channelOn(message, checkScope())) return empty()
  console.log(json ? JSON.stringify(message) : `DM_HIT mid=${message.mid} fan=${!!message.isFan} text=${message.text}`)
  return 0
}

function empty() {
  console.log(json ? JSON.stringify({ hit: false }) : '无新私信')
  return 1
}

async function pollFanSessions(headers, state, nav) {
  const fanCursors = { ...(state.fanCursors ?? {}) }
  const nowSec = Math.floor(Date.now() / 1000)
  const firstFanPoll = !Number.isFinite(Number(state.fanBaselineAt)) || Number(state.fanBaselineAt) <= 0
  const fanBaselineAt = firstFanPoll ? nowSec : Number(state.fanBaselineAt)

  const url = 'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_fold=1&unfollow_fold=0&sort_rule=2&size=20&build=0&mobi_app=web'
  const res = await exactJson(await fetch(url, { headers }))
  if (res?.code !== 0 || !Array.isArray(res.data?.session_list)) {
    return { messages: [], fanCursors, fanBaselineAt }
  }

  const out = []
  for (const sess of res.data.session_list.slice(0, 12)) {
    const talker = String(sess.talker_id ?? '').trim()
    if (!/^[1-9]\d{0,19}$/.test(talker)) continue
    if (talker === owner || talker === selfMid) continue
    const lastTs = Number(sess.last_msg?.timestamp ?? 0)
    const senderUid = String(sess.last_msg?.sender_uid ?? '')

    let cursor = fanCursors[talker]
    if (!cursor) {
      if (firstFanPoll || lastTs <= fanBaselineAt) {
        // 首次开启粉丝私信监听时的历史会话：记录基线，不倒灌历史旧私信
        fanCursors[talker] = { lastSeen: lastTs, lastKey: '', lastKeys: [] }
        continue
      }
      // 监听启用后新发来私信的新粉丝：立即投递首条消息，绝不静默丢弃！
      cursor = { lastSeen: fanBaselineAt, lastKey: '', lastKeys: [] }
    }

    if (senderUid && senderUid !== talker) continue
    const lastSeen = Number(cursor.lastSeen ?? 0)
    const lastKey = String(sess.last_msg?.msg_key ?? '')
    const known = cursor.lastKeys ?? (cursor.lastKey ? [cursor.lastKey] : [])
    if (lastTs < lastSeen || (lastTs === lastSeen &&
        (lastTs <= fanBaselineAt || (lastKey && known.includes(lastKey))))) continue

    const relation = await checkRelation(talker, headers)
    if (!relation.ok) continue
    const skipped = { lastSeen: lastTs, lastKey, lastKeys: lastKey ? [lastKey] : [] }
    if (!relation.isFollower) {
      fanCursors[talker] = skipped
      continue
    }
    const fq = checkFanQuota({
      channel: 'dm',
      uid: talker,
      perUserDaily: cfg.fanLimits?.dmPerUserDaily ?? 2,
      totalDaily: cfg.fanLimits?.dmTotalDaily ?? 10,
    })
    if (!fq.allowed) {
      // 超出当日限额的来信推进游标，避免次日积压倒灌或每次轮询重复打关系接口
      fanCursors[talker] = skipped
      continue
    }

    try {
      const hist = await readHistory(talker, headers, cursor, { nav })
      for (const m of hist.messages) {
        out.push({
          ...m,
          mid: talker,
          name: sess.account_info?.name || `粉丝(${talker})`,
          isFan: true,
        })
      }
      if (hist.messages.length === 0 && lastTs > Number(cursor.lastSeen ?? 0)) {
        fanCursors[talker] = { lastSeen: lastTs, lastKey: '', lastKeys: [] }
      }
    } catch {}
    if (out.length >= 5) break
  }
  return { messages: out, fanCursors, fanBaselineAt }
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

  // A paused channel keeps its queue and its existing receipt, while the other channel can drain.
  const queued = [...(state.pending ? [state.pending] : []), ...(state.queue ?? [])]
  state = { ...state, pending: undefined, queue: queued }

  if (!queued.some(message => channelOn(message, listen)) || explicitBaseline) {
    const cred = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))
    const headers = {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      referer: 'https://www.bilibili.com/',
      cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3 ?? ''}`,
    }
    const nav = await apiGet('https://api.bilibili.com/x/web-interface/nav', headers)
    if (nav.code !== 0 || nav.data?.isLogin !== true || String(nav.data.mid) !== selfMid)
      throw Error('当前 B 站登录账号与配置不一致，未推进私信游标')
    checkScope()

    const combined = []
    if (listen.dmOwner && owner) {
      const baseline = explicitBaseline
      const result = await readHistory(owner, headers, state, { baseline, nav })
      if (!checkScope().dmOwner) return empty()
      if (baseline) {
        const latest = result.all.at(-1)
        const ts = latest?.ts ?? 0
        state = {
          ...state,
          owner,
          lastSeen: ts,
          lastKey: latest?.key,
          lastKeys: result.all.filter(r => r.ts === ts).map(r => r.key),
          pending: undefined,
          queue: queued.filter(m => m.isFan),
        }
        if (explicitBaseline) {
          save(state)
          console.log('已把当前私信状态标记为已读')
          return 0
        }
      } else {
        for (const m of result.messages) {
          combined.push({ ...m, mid: owner, name: ownerName, isFan: false })
        }
        state = { ...state, owner, lastIncoming: Math.max(Number(state.lastIncoming ?? 0), ...result.messages.map(r => r.ts)) }
      }
    }

    if (listen.dmFan && !explicitBaseline) {
      const fanRes = await pollFanSessions(headers, state, nav)
      if (!checkScope().dmFan) return empty()
      state = { ...state, fanCursors: fanRes.fanCursors, fanBaselineAt: fanRes.fanBaselineAt }
      combined.push(...fanRes.messages)
    }

    combined.sort((a, b) => a.ts - b.ts)
    state = { ...state, queue: [...state.queue, ...combined] }
    save(state)
  }

  const currentListen = checkScope()
  const index = state.queue.findIndex(message => channelOn(message, currentListen))
  if (index === -1) return empty()
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
    receipt,
  }
  if (!channelOn(message, checkScope())) return empty()
  if (message.isFan) recordFanReceipt(receipt, message.mid)
  if (peek) save({ ...state, pending: message })
  else save(acknowledge(state, message))
  return emit(message)
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
