/**
 * 活动日历统计聚合器：汇总本地配额、长期记忆、作息计划、粉丝互动与安全拦截记录。
 */
import fs from 'node:fs'
import path from 'node:path'
import { localDay } from '../core/local-date.mjs'
import { dataPathsFor } from '../core/paths.mjs'
import { readFanQuotaHistory } from '../social/fan-quota.mjs'
import { readLifeArchive } from '../life/archive.mjs'

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

function emptyBucket() {
  return {
    watched: 0,
    shares: 0,
    autoComments: 0,
    dynamics: 0,
    ownerInteract: 0,
    ownerDm: 0,
    ownerComment: 0,
    fanInteract: 0,
    fanDm: 0,
    fanComment: 0,
    fanMention: 0,
    wakes: 0,
    opportunitiesUsed: 0,
    safetyBlocked: 0,
    total: 0,
    items: [],
  }
}

function safeDay(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'string' && DAY_RE.test(value)) return value
  try {
    return localDay(value)
  } catch {
    return null
  }
}

function fmtClock(at) {
  const d = new Date(at)
  if (!Number.isFinite(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function loadAllLifeEvents(store, diagnostics) {
  if (!store) return []
  let state = null
  try { state = store.read() } catch { diagnostics.push({code:'LIFE_STATE_UNAVAILABLE'});return [] }
  const out = []
  for (const a of state.archives ?? []) {
    try {
      for (const event of readLifeArchive(store.dir,a).data.events) out.push(event)
    } catch { diagnostics.push({code:'ARCHIVE_UNAVAILABLE',archive:a?.name??null}) }
  }
  if (Array.isArray(state.events)) out.push(...state.events)
  return out
}

/**
 * 汇总本地真实数据（state/quota.json / memory / state/schedule.json / state/fan-quota.json / logs/safety-blocked.jsonl），
 * 按本地日期生成交互式月历所需的每日分类统计与全局累计汇总。
 */
export function buildActivityCalendar({
  whaleHome,
  cfg = {},
  store = null,
  now = Date.now,
} = {}) {
  const nowMs = typeof now === 'function' ? now() : Number(now) || Date.now()
  const today = localDay(nowMs)
  const days = new Map()
  const getDay = (dayStr) => {
    if (!dayStr || !DAY_RE.test(dayStr)) return null
    let bucket = days.get(dayStr)
    if (!bucket) {
      bucket = emptyBucket()
      days.set(dayStr, bucket)
    }
    return bucket
  }
  const pushItem = (bucket, at, kind, label, text, explicitTime = null) => {
    const ts = at == null ? 0 : (Number.isFinite(Number(at)) ? Number(at) : Date.parse(at))
    bucket.items.push({
      at: Number.isFinite(ts) ? ts : 0,
      time: explicitTime ?? (ts > 0 && Number.isFinite(ts) ? fmtClock(ts) : ''),
      kind,
      label,
      text: String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 140),
    })
  }

  const dp = dataPathsFor(whaleHome)
  // 1. state/quota.json：主动分享给主人 + 公开发表动态
  const quota = readJsonSafe(dp.quota)
  for (const entry of quota?.log ?? []) {
    const d = safeDay(entry?.at)
    const b = getDay(d)
    if (!b) continue
    if (entry.share) {
      b.shares++
      pushItem(b, entry.at, 'share', '主动分享', entry.note || entry.target || '分享了一条视频')
    } else if (entry.type === 'dynamic') {
      b.dynamics++
      pushItem(b, entry.at, 'dynamic', '公开动态', entry.note || entry.target || '发布了一条公开动态')
    } else if (entry.type === 'comment' && entry.auto) {
      b.autoComments++
      pushItem(b, entry.at, 'comment', '自主评论', entry.note || entry.target || '发表了一条视频评论')
    }
  }

  // 2. memory 事件与归档：观看视频 / 主人互动 / 作息唤醒
  const ownerMid = String(cfg?.owner?.mid ?? '').trim()
  const diagnostics = []
  const events = loadAllLifeEvents(store, diagnostics)

  for (const ev of events) {
    const d = safeDay(ev?.at)
    const b = getDay(d)
    if (!b) continue

    if (ev.kind === 'video-read') {
      b.watched++
      const title = ev.data?.title || ev.text || ev.target || '观看了一条视频'
      pushItem(b, ev.at, 'watch', '观看视频', ev.target && !String(title).includes(ev.target) ? `${title}（${ev.target}）` : title)
    } else if (ev.kind === 'received') {
      const isOwner = ownerMid && String(ev.actor ?? '') === ownerMid
      if (isOwner) {
        b.ownerInteract++
        const isDm = ['dm','bili-dm'].includes(ev.channel ?? ev.data?.channel)
        if (isDm) b.ownerDm++
        else b.ownerComment++
        pushItem(b, ev.at, 'owner', isDm ? '收到主人私信' : '收到主人互动', ev.text || ev.target || '')
      }
    } else if (ev.kind === 'sent') {
      if (ev.data?.share || ev.channel === 'dynamic') continue
      const targetStr = String(ev.target ?? '')
      const isOwnerTarget = Boolean(
        ownerMid && (
          (ev.channel === 'dm' && targetStr === ownerMid)
          || (ev.channel === 'comment' && String(ev.data?.replyToMid ?? '') === ownerMid)
          || (!targetStr && ev.scene === 'private-reply')
        ),
      )
      if (isOwnerTarget) {
        b.ownerInteract++
        if (ev.channel === 'dm') b.ownerDm++
        else b.ownerComment++
        pushItem(b, ev.at, 'owner', ev.channel === 'dm' ? '回复主人私信' : '回复主人评论', ev.text || '')
      }
    } else if (ev.kind === 'wake-delivery-accepted') {
      b.wakes++
      pushItem(b, ev.at, 'wake', '作息唤醒', ev.target || '按作息唤醒一次')
    }
  }

  // 3. 机会按窗口的起始日期归属。跨午夜窗口仍只记一次。
  const night = readJsonSafe(dp.schedule)
  if (night) {
    const usedByDay = new Map()
    for (const [k, cnt] of Object.entries(night.usedCount ?? {})) {
      const dayPart = String(k).slice(0, 10)
      if (DAY_RE.test(dayPart)) {
        usedByDay.set(dayPart, (usedByDay.get(dayPart) ?? 0) + Math.max(0, Number(cnt) || 0))
      }
    }
    for (const [d, cnt] of usedByDay.entries()) {
      if (cnt <= 0) continue
      const b = getDay(d)
      if (b) b.opportunitiesUsed = cnt
    }
    const nightDay = safeDay(night.date)
    const nightWakes = Math.max(0, Number(night.wakes) || 0)
    if (usedByDay.size === 0 && nightDay && nightWakes > 0) {
      const b = getDay(nightDay)
      if (b) b.opportunitiesUsed = nightWakes
    }
  }

  // 4. fan-quota.json：粉丝互动（当日 + 跨天历史）
  const fanHistory = readFanQuotaHistory(whaleHome, () => nowMs)
  for (const [d, fq] of Object.entries(fanHistory.days ?? {})) {
    const dm = Math.max(0, Number(fq?.dmTotal) || 0)
    const cm = Math.max(0, Number(fq?.commentTotal) || 0)
    const ms = Math.max(0, Number(fq?.mentionSummaryTotal) || 0)
    const sum = dm + cm + ms
    if (sum <= 0) continue
    const b = getDay(d)
    if (!b) continue
    b.fanDm = dm
    b.fanComment = cm
    b.fanMention = ms
    b.fanInteract = sum
    const parts = []
    if (dm > 0) parts.push(`私信 ${dm} 条`)
    if (cm > 0) parts.push(`评论 ${cm} 条`)
    if (ms > 0) parts.push(`@ 总结 ${ms} 次`)
    const fanAt = Number.isFinite(Number(fq?.lastAt)) && Number(fq.lastAt) > 0
      ? Number(fq.lastAt)
      : Math.min(nowMs, Date.parse(`${d}T23:59:59`))
    pushItem(b, fanAt, 'fan', '粉丝互动', parts.join(' · '), '当日汇总')
  }

  // 5. logs/safety-blocked.jsonl：按日统计内容安全审核拦截
  try {
    const safetyFile = dp.safetyLog
    if (fs.existsSync(safetyFile)) {
      const lines = fs.readFileSync(safetyFile, 'utf8').split(/\r?\n/).filter(Boolean).slice(-2000)
      for (const line of lines) {
        let entry = null
        try { entry = JSON.parse(line) } catch { continue }
        const d = safeDay(entry?.at)
        const b = getDay(d)
        if (!b) continue
        b.safetyBlocked++
        pushItem(b, entry.at, 'safety', '安全拦截', `${entry.category || '合规拦截'}：${entry.reason || entry.preview || ''}`)
      }
    }
  } catch {}

  // 确保今天始终存在
  getDay(today)

  const totals = emptyBucket()
  delete totals.items
  const serializedDays = {}
  let activeDays = 0

  for (const d of [...days.keys()].sort()) {
    const b = days.get(d)
    b.total = b.watched + b.shares + b.autoComments + b.dynamics + b.ownerInteract + b.fanInteract + b.wakes + b.safetyBlocked
    if (b.total <= 0 && b.opportunitiesUsed === 0 && d !== today) continue
    if (b.total > 0) activeDays++
    b.items.sort((a, x) => x.at - a.at)
    b.items = b.items.slice(0, 5)
    serializedDays[d] = b

    totals.watched += b.watched
    totals.shares += b.shares
    totals.autoComments += b.autoComments
    totals.dynamics += b.dynamics
    totals.ownerInteract += b.ownerInteract
    totals.ownerDm += b.ownerDm
    totals.ownerComment += b.ownerComment
    totals.fanInteract += b.fanInteract
    totals.fanDm += b.fanDm
    totals.fanComment += b.fanComment
    totals.fanMention += b.fanMention
    totals.wakes += b.wakes
    totals.opportunitiesUsed += b.opportunitiesUsed
    totals.safetyBlocked += b.safetyBlocked
    totals.total += b.total
  }

  return {
    today,
    activeDays,
    incomplete: diagnostics.length > 0,
    diagnostics,
    totals,
    days: serializedDays,
  }
}
