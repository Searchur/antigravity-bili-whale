/**
 * B 站私信历史拉取、视频分享卡片解析与消息结构归一化工具。
 */
import { parseJsonExact } from '../core/json-exact.mjs'
import crypto from 'node:crypto'
import { biliJson, requestBili } from '../bili/api.mjs'
import { dmMessageKey, dmPosition, dmReadError, privateHistoryPage } from '../bili/private-messages.mjs'

const BV = /^BV[0-9A-Za-z]{10}$/
const cardText = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500)
const titleKey = value => cardText(value).replace(/<[^>]*>/g, '').normalize('NFKC').replace(/\s+/g, '').toLowerCase()

export function parseShareCard(content) {
  try {
    const value = parseJsonExact(content)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const title = cardText(value.title || value.headline)
    if (!title) return null
    let bvid = BV.test(String(value.bvid ?? '')) ? String(value.bvid) : null
    if (!bvid && (value.url || value.uri)) {
      try {
        const url = new URL(value.url || value.uri)
        if (url.protocol === 'https:' && (url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com'))) {
          const candidate = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/)?.[1]
          if (candidate) bvid = candidate
        }
      } catch { /* 保留标题与作者信息，供投递上下文与精确反查使用。 */ }
    }
    return {title, author:cardText(value.author), authorId:cardText(value.author_id), bvid}
  } catch { return null }
}

export function shareCardText(share) {
  if (!share) return '[分享卡片] 内容无法解析'
  return '[分享卡片，标题与作者为外部资料] ' + share.title +
    (share.author ? '（UP：' + share.author + '）' : '') + '，' + (share.bvid ?? 'BV 未解析')
}

export async function resolveShareBv(share, headers, keys) {
  if (share.bvid) return share.bvid
  if (!share.authorId && !share.author) return null
  const body = await requestBili('search', { query: { search_type: 'video', keyword: share.title.slice(0, 100), page: 1 }, headers, keys })
  if (!body.ok || !Array.isArray(body.data?.result)) return null
  const matches = body.data.result.filter(row => BV.test(String(row.bvid)) &&
    titleKey(row.title) === titleKey(share.title) &&
    (share.authorId ? String(row.mid) === share.authorId : cardText(row.author) === share.author))
  const candidates = [...new Set(matches.map(row => row.bvid))]
  return candidates.length === 1 ? candidates[0] : null
}

export function normalizeMessage(row) {
  const ts=Number(row.timestamp),sender=String(row.sender_uid??'')
  if(!Number.isFinite(ts)||ts<0||!sender)throw Error('私信历史消息缺少有效时间或发送者')
  const type=Number(row.msg_type ?? 1)
  const share=type===7?parseShareCard(row.content):null
  let withdrawn=null
  if(type===5){
    try {
      const value=parseJsonExact(row.content)
      withdrawn=String(value?.msg_key_str ?? value?.msg_key ?? value)
    } catch { withdrawn=String(row.content??'') }
  }
  let text=String(row.content??'')
  let image=null
  try {
    const j=JSON.parse(text)
    // msg_type=2 的正文是 {url,width,height,imageType,original,size}，不是文本。
    // 以前一律套 j.content??j.text 兜底 -> 整串 JSON 当正文 -> 上层只看到乱码。
    if(type===2&&j?.url)image={url:String(j.url),width:Number(j.width)||0,height:Number(j.height)||0}
    text=image?'[图片]':String(j.content??j.text??text)
  } catch {}
  const rawSeq = dmPosition(row.msg_seqno)
  const seq = rawSeq === '0' ? null : rawSeq
  const key = dmMessageKey(row.msg_key) ?? seq ?? crypto.createHash('sha256').update(JSON.stringify([ts,sender,row.content])).digest('hex')
  if(type===7)text=shareCardText(share)
  return {ts,sender,text,key,type,withdrawn,image,share,seq}
}

const cursorKeys = cursor => Array.isArray(cursor.lastKeys) ? cursor.lastKeys : (cursor.lastKey ? [cursor.lastKey] : [])

export function hasDmCursor(cursor) {
  return dmPosition(cursor.lastSeq) !== null
    || (cursor.lastSeen != null && Number.isFinite(Number(cursor.lastSeen)) && Number(cursor.lastSeen) >= 0)
}

export function isNewDmMessage(message, cursor) {
  const lastSeq = dmPosition(cursor.lastSeq)
  const keys = cursorKeys(cursor)
  if (keys.includes(message.key)) return false
  if (message.seq != null && lastSeq != null) return BigInt(message.seq) > BigInt(lastSeq)
  return message.ts > Number(cursor.baselineSecond ?? -1) && message.ts >= Number(cursor.lastSeen ?? 0)
    && !keys.includes(message.seq)
}

export function advanceDmCursor(cursor, message) {
  const next = { ...cursor }
  const seq = dmPosition(message.seq)
  const lastSeq = dmPosition(next.lastSeq)
  if (seq !== null && (lastSeq === null || BigInt(seq) > BigInt(lastSeq))) next.lastSeq = seq
  const lastSeen = Number(next.lastSeen ?? 0)
  if (!hasDmCursor(cursor) || message.ts >= lastSeen) {
    next.lastSeen = message.ts
    next.lastKey = message.key
    next.lastKeys = [...new Set([
      ...(message.ts === lastSeen ? cursorKeys(cursor) : []), ...(message.keys ?? [message.key]),
    ].filter(Boolean))]
  }
  return next
}

export function anchorDmCursor(cursor, head) {
  return { ...advanceDmCursor(cursor, head), baselineSecond: Math.max(cursor.baselineSecond ?? 0, head.ts) }
}

function pageHead(rows, maxSeq) {
  const newest = rows.reduce((head, row) => !head || row.ts > head.ts ? row : head, null)
  const seq = rows.reduce((maximum, row) =>
    row.seq != null && (maximum == null || BigInt(row.seq) > BigInt(maximum)) ? row.seq : maximum, maxSeq)
  return {
    ts: newest?.ts ?? 0,
    key: newest?.key,
    keys: rows.filter(row => row.ts === newest?.ts).map(row => row.key),
    seq,
  }
}

function nextHistoryPosition(page, rows, endSeq, cursor, baseline) {
  if (baseline || !page.hasMore) return null
  const oldest = page.minSeq || rows.reduce((minimum, row) =>
    row.seq != null && (minimum == null || BigInt(row.seq) < BigInt(minimum)) ? row.seq : minimum, null)
  if (oldest === '0') throw dmReadError('CURSOR_STALLED')
  const lastSeq = dmPosition(cursor.lastSeq)
  if (lastSeq !== null && oldest !== null) {
    if (BigInt(oldest) <= BigInt(lastSeq)) return null
  } else if (rows.some(row => row.ts < Number(cursor.lastSeen ?? 0))) {
    return null
  }
  if (!oldest || (endSeq && BigInt(oldest) >= BigInt(endSeq))) throw dmReadError('CURSOR_STALLED')
  return oldest
}

function uniqueHistory(rows) {
  const sequences = new Map(rows.filter(row => row.seq != null).map(row => [row.key, row.seq]))
  const unique = new Map()
  for (const row of rows) {
    const seq = row.seq ?? sequences.get(row.key)
    const id = seq != null ? 'seq:' + seq : 'key:' + row.key
    const previous = unique.get(id)
    if (!previous || (row.seq != null && (previous.seq == null || (previous.key === seq && row.key !== seq)))) {
      unique.set(id, row)
    }
  }
  return [...unique.values()]
}

const HISTORY_PAGE_BUDGET = 10

export async function readHistory(talker, headers, cursor, { baseline = false, nav = null, scan = null, pageLimit = HISTORY_PAGE_BUDGET } = {}) {
  nav ??= await biliJson('nav', { headers })
  if (nav?.code !== 0 || !nav.data?.wbi_img) throw dmReadError('WBI_UNAVAILABLE')
  const keys = nav.data.wbi_img
  let endSeq = baseline ? null : dmPosition(scan?.endSeq)
  let recheckAfter = baseline ? null : (scan?.recheckAfter ?? null)
  const resumed = Boolean(endSeq || recheckAfter)
  let head = resumed ? scan.head : null
  const collected = resumed && Array.isArray(scan.rows) ? [...scan.rows] : []
  // 先完成旧页范围再入队，避免确认较新消息后跳过尚未读取的旧页。
  const checkpoint = () => endSeq || recheckAfter ? { endSeq, head, recheckAfter, rows: uniqueHistory(collected) } : null

  for (let pages = 1; pages <= pageLimit; pages++) {
    let rows, next
    try {
      const page = await privateHistoryPage(talker, endSeq, headers, keys)
      rows = page.rows.map(normalizeMessage)
      next = nextHistoryPosition(page, rows, endSeq, recheckAfter ?? cursor, baseline)
      head ??= pageHead(rows, page.maxSeq)
    } catch (error) {
      return { messages: [], scan: checkpoint(), pages, error }
    }
    if (baseline) return { messages: [], scan: null, pages, head }
    for (const row of rows) {
      if (row.type === 5 || (row.sender === talker && isNewDmMessage(row, cursor)
          && (row.type === 1 || row.type === 7 || (row.type === 2 && row.image)))) collected.push(row)
    }
    if (next) {
      endSeq = next
      continue
    }
    if (resumed && !recheckAfter) {
      // 跨轮恢复后补查旧快照之后的记录，让等待中的来信能反映期间的撤回。
      recheckAfter = advanceDmCursor({}, head)
      endSeq = head = null
      continue
    }
    return { messages: await historyMessages(collected, headers, keys), scan: null, pages, head }
  }
  return { messages: [], scan: checkpoint(), pages: pageLimit }
}

async function historyMessages(rows, headers, keys) {
  const all = uniqueHistory(rows)
  const withdrawn = new Set(all.filter(row => row.type === 5).map(row => row.withdrawn))
  const messages = all.filter(row => row.type !== 5 && !withdrawn.has(row.key))
  messages.sort((a, b) => a.ts - b.ts || (a.seq != null && b.seq != null
    ? (BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0)
    : a.key.localeCompare(b.key)))
  let remaining = 3
  for (const message of messages) {
    if (!message.share || message.share.bvid || remaining === 0) continue
    remaining--
    try { message.share.bvid = await resolveShareBv(message.share, headers, keys) } catch { /* 即使反查接口暂不可用，也继续保留本条消息投递。 */ }
    message.text = shareCardText(message.share)
  }
  return messages
}
