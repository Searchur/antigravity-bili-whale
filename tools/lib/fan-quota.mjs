import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { WHALE_HOME } from './paths.mjs'
import { localDay } from './local-date.mjs'

const CHANNELS = ['dm', 'comment', 'mentionSummary']

function quotaFile(whaleHome = WHALE_HOME) {
  return path.join(whaleHome, 'fan-quota.json')
}

function emptyDay(date) {
  return {
    date,
    dm: { total: 0, byUid: {} },
    comment: { total: 0, byUid: {} },
    mentionSummary: { total: 0, byUid: {} },
  }
}

function readState(whaleHome = WHALE_HOME, now = Date.now) {
  const today = localDay(now())
  try {
    const raw = JSON.parse(fs.readFileSync(quotaFile(whaleHome), 'utf8'))
    if (raw && raw.date === today) {
      const base = emptyDay(today)
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
  } catch {}
  return emptyDay(today)
}

function writeState(state, whaleHome = WHALE_HOME) {
  const file = quotaFile(whaleHome)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, file)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
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

/**
 * 记录一次成功的粉丝回复计数。
 */
export function recordFanReply({ channel, uid, whaleHome = WHALE_HOME, now = Date.now }) {
  if (!CHANNELS.includes(channel)) return
  const mid = String(uid ?? '').trim()
  if (!mid) return
  const state = readState(whaleHome, now)
  state[channel].total = Number(state[channel].total ?? 0) + 1
  state[channel].byUid[mid] = Number(state[channel].byUid[mid] ?? 0) + 1
  writeState(state, whaleHome)
}

/**
 * 读取今日粉丝互动统计（供控制台「动态与记忆」卡片展示）。
 */
export function readFanQuotaSummary(whaleHome = WHALE_HOME, now = Date.now) {
  const s = readState(whaleHome, now)
  return {
    date: s.date,
    dmTotal: s.dm.total,
    dmUsers: Object.keys(s.dm.byUid).length,
    commentTotal: s.comment.total,
    commentUsers: Object.keys(s.comment.byUid).length,
    mentionSummaryTotal: s.mentionSummary.total,
  }
}
