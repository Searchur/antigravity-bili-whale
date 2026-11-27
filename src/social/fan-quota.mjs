/**
 * 已关注粉丝每日私信、评论与 @ 总结配额校验、加锁占用与跨天历史记录器。
 */
import fs from 'node:fs'
import { WHALE_HOME, dataPathsFor } from '../core/paths.mjs'
import { localDay } from '../core/local-date.mjs'
import { acquireProcessLock } from '../core/process-lock.mjs'
import { atomicWriteJson } from '../core/atomic-json.mjs'

const CHANNELS = ['dm', 'comment', 'mentionSummary']
const MAX_HISTORY_DAYS = 365

function quotaFile(whaleHome = WHALE_HOME) {
  return dataPathsFor(whaleHome).fanQuota
}

function emptyDay(date, history = {}) {
  return {
    date,
    lastAt: 0,
    dm: { total: 0, byUid: {} },
    comment: { total: 0, byUid: {} },
    mentionSummary: { total: 0, byUid: {} },
    history,
  }
}

function summarizeDay(state) {
  return {
    dmTotal: Math.max(0, Number(state?.dm?.total) || 0),
    dmUsers: Object.keys(state?.dm?.byUid ?? {}).length,
    commentTotal: Math.max(0, Number(state?.comment?.total) || 0),
    commentUsers: Object.keys(state?.comment?.byUid ?? {}).length,
    mentionSummaryTotal: Math.max(0, Number(state?.mentionSummary?.total) || 0),
    ...(Number.isFinite(Number(state?.lastAt)) && Number(state.lastAt) > 0 ? { lastAt: Number(state.lastAt) } : {}),
  }
}

function sanitizeHistory(rawHistory) {
  const out = {}
  if (!rawHistory || typeof rawHistory !== 'object' || Array.isArray(rawHistory)) return out
  const keys = Object.keys(rawHistory).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort().slice(-MAX_HISTORY_DAYS)
  for (const k of keys) {
    const v = rawHistory[k]
    if (!v || typeof v !== 'object') continue
    const dmTotal = Math.max(0, Number(v.dmTotal) || 0)
    const commentTotal = Math.max(0, Number(v.commentTotal) || 0)
    const mentionSummaryTotal = Math.max(0, Number(v.mentionSummaryTotal) || 0)
    if (dmTotal + commentTotal + mentionSummaryTotal <= 0) continue
    out[k] = {
      dmTotal,
      dmUsers: Math.max(0, Number(v.dmUsers) || 0),
      commentTotal,
      commentUsers: Math.max(0, Number(v.commentUsers) || 0),
      mentionSummaryTotal,
      ...(Number.isFinite(Number(v.lastAt)) && Number(v.lastAt) > 0 ? { lastAt: Number(v.lastAt) } : {}),
    }
  }
  return out
}

function readState(whaleHome = WHALE_HOME, now = Date.now) {
  const today = localDay(now())
  try {
    const raw = JSON.parse(fs.readFileSync(quotaFile(whaleHome), 'utf8'))
    const history = sanitizeHistory(raw?.history)
    if (raw && raw.date === today) {
      const base = emptyDay(today, history)
      base.lastAt = Math.max(0, Number(raw.lastAt) || 0)
      for (const ch of CHANNELS) {
        if (raw[ch] && typeof raw[ch] === 'object') {
          base[ch] = {
            total: Math.max(0, Number(raw[ch].total) || 0),
            byUid: raw[ch].byUid && typeof raw[ch].byUid === 'object' ? { ...raw[ch].byUid } : {},
          }
        }
      }
      return base
    }
    if (raw && /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date ?? ''))) {
      const prev = summarizeDay(raw)
      if (prev.dmTotal + prev.commentTotal + prev.mentionSummaryTotal > 0) {
        history[raw.date] = prev
      }
    }
    return emptyDay(today, sanitizeHistory(history))
  } catch (err) {
    if (err.code !== 'ENOENT') throw Error('粉丝额度记录无法读取，请检查数据文件', { cause: err })
  }
  return emptyDay(today)
}

function writeState(state, whaleHome = WHALE_HOME) {
  atomicWriteJson(quotaFile(whaleHome), state)
}

/**
 * 检查某个粉丝在指定通道（dm / comment / mentionSummary）是否仍在每日限额内。
 */
export function checkFanQuota({ channel, uid, perUserDaily, totalDaily, whaleHome = WHALE_HOME, now = Date.now }) {
  if (!CHANNELS.includes(channel)) throw new Error('未知粉丝限额通道：' + channel)
  const mid = String(uid ?? '').trim()
  const state = readState(whaleHome, now)
  const bucket = state[channel]
  const userUsed = Number(bucket.byUid[mid] ?? 0)
  const totalUsed = Number(bucket.total ?? 0)
  const perLimit = Math.max(0, Math.floor(Number(perUserDaily) || 0))
  const totalLimit = Math.max(0, Math.floor(Number(totalDaily) || 0))

  if (totalUsed >= totalLimit) {
    return { allowed: false, reason: `今日粉丝${channel === 'dm' ? '私信' : channel === 'comment' ? '评论' : '@总结'}回复已达总上限（${totalUsed}/${totalLimit}）`, userUsed, totalUsed }
  }
  if (userUsed >= perLimit) {
    return { allowed: false, reason: `今日对该粉丝（UID ${mid}）已达回复上限（${userUsed}/${perLimit}）`, userUsed, totalUsed }
  }
  return { allowed: true, reason: '', userUsed, totalUsed }
}

export async function lockFanReplyQuota(request, count = 1) {
  if (!request) return () => {}
  const release = await acquireProcessLock(quotaFile(request.whaleHome))
  try {
    const quota = checkFanQuota(request)
    if (!quota.allowed) throw Error(quota.reason)
    const perLimit = Math.max(0, Math.floor(Number(request.perUserDaily) || 0))
    const totalLimit = Math.max(0, Math.floor(Number(request.totalDaily) || 0))
    if (quota.userUsed + count > perLimit || quota.totalUsed + count > totalLimit) {
      throw Error('剩余粉丝回复额度不足以发送全部内容')
    }
    return release
  } catch (error) {
    await release()
    throw error
  }
}

/**
 * 记录一次成功的粉丝回复计数。
 */
export function recordFanReply({ channel, uid, whaleHome = WHALE_HOME, now = Date.now }) {
  if (!CHANNELS.includes(channel)) return
  const mid = String(uid ?? '').trim()
  if (!mid) return
  const at = typeof now === 'function' ? now() : Date.now()
  const state = readState(whaleHome, () => at)
  state[channel].total = Number(state[channel].total ?? 0) + 1
  state[channel].byUid[mid] = Number(state[channel].byUid[mid] ?? 0) + 1
  state.lastAt = Math.max(Number(state.lastAt) || 0, at)
  state.history = sanitizeHistory({ ...(state.history ?? {}), [state.date]: summarizeDay(state) })
  writeState(state, whaleHome)
}

/**
 * 读取今日粉丝互动统计（供控制台「动态与记忆」卡片展示）。
 */
export function readFanQuotaSummary(whaleHome = WHALE_HOME, now = Date.now) {
  const s = readState(whaleHome, now)
  return {
    date: s.date,
    ...summarizeDay(s),
  }
}

/**
 * 读取历史按日粉丝互动统计（含今日最新计数），供日历统计聚合使用。
 */
export function readFanQuotaHistory(whaleHome = WHALE_HOME, now = Date.now) {
  const s = readState(whaleHome, now)
  const days = { ...(s.history ?? {}) }
  const todaySum = summarizeDay(s)
  if (todaySum.dmTotal + todaySum.commentTotal + todaySum.mentionSummaryTotal > 0) {
    days[s.date] = todaySum
  }
  return { today: s.date, days }
}
