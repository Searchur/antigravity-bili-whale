/**
 * B 站登录凭据加载与错误码解释工具：读取凭据、检查写操作必需字段并格式化接口错误提示。
 */
import fs from 'node:fs'

import { credentialsPath } from '../core/paths.mjs'
export const CRED_PATH = credentialsPath

/** 读凭据：统一 trim，容忍 BOM / 首尾空白。 */
export function loadCred(file = CRED_PATH) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    throw new Error(`没有凭据文件：${file}\n  请在 Antigravity 控制台【大鲸鱼与主人】使用 B 站扫码登录`)
  }
  let j
  try {
    j = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    throw new Error(`凭据文件不是合法 JSON：${file}\n  请重新扫码登录`)
  }
  const clean = (v) => String(v ?? '').replace(/^["'\s]+|["'\s]+$/g, '')
  return {
    sessdata: clean(j.sessdata),
    bili_jct: clean(j.bili_jct),
    buvid3: clean(j.buvid3),
  }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const credentialKeys = [['SESSDATA', 'sessdata'], ['bili_jct', 'bili_jct'], ['buvid3', 'buvid3']]

export function biliHeaders(cred = {}, { referer = 'https://www.bilibili.com/', origin, userAgent = UA } = {}) {
  const cookie = credentialKeys.flatMap(([name, key]) => {
    const value = String(cred?.[key] ?? '').trim()
    return value && !/[;\r\n]/.test(value) && !['undefined', 'null'].includes(value) ? [name + '=' + value] : []
  }).join('; ')
  return { 'user-agent': userAgent, ...(referer ? { referer } : {}), ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) }
}

export function redactBiliMessage(message, headers) {
  const credentials = new Headers(headers)
  const secrets = (credentials.get('cookie') ?? '').split(';').map(pair => pair.trim().replace(/^[^=]+=/, '')).filter(Boolean)
  const authorization = credentials.get('authorization')
  if (authorization) secrets.push(authorization)
  let value = String(message ?? '')
  for (const secret of secrets) {
    for (const variant of new Set([secret, encodeURIComponent(secret)])) value = value.split(variant).join('【已隐藏】')
  }
  return value
    .replace(/(\b(?:SESSDATA|bili_jct|buvid3|csrf(?:_token)?|biliCSRF|qrcode_key|w_rid)\b["']?\s*[=:]\s*["']?)[^\s&;,"']+/gi, '$1【已隐藏】')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 1000)
}

/**
 * 写操作前检查。
 * @param {object} cred
 * @param {{needBuvid3?: boolean}} [opt]
 * @returns {string[]} 缺什么（空数组 = 可以继续）
 */
export function missingForWrite(cred, opt = {}) {
  const miss = []
  if (!cred.sessdata) miss.push('SESSDATA（登录态）')
  if (!cred.bili_jct) miss.push('bili_jct（写操作必须的 csrf token）')
  if (opt.needBuvid3 && !cred.buvid3) miss.push('buvid3')
  return miss
}

/** bili_jct 的格式自检：B站 目前是 32 位十六进制。 */
export function looksLikeJct(v) {
  return /^[0-9a-fA-F]{32}$/.test(String(v ?? ''))
}

/** 常见返回码 → 人话 + 怎么办 */
export const CODE_HINTS = {
  0: '成功',
  '-101': '账号未登录，请在控制台【大鲸鱼与主人】重新扫码登录',
  '-111': 'CSRF 校验失败，请在控制台【大鲸鱼与主人】重新扫码登录',
  '-400': '请求参数错误',
  '-352': '触发平台限制，等待冷却结束',
  '-799': '请求过于频繁，等待冷却结束',
  10031: '操作过于频繁，等待冷却结束',
  12015: '需要人工完成安全验证',
  12051: '触发重复评论限制，需要人工核查',
  12002: '评论区已关闭',
}

/** 把返回码变成一行可读的说明（含数字，方便搜）。 */
export function explainCode(code) {
  const k = String(code)
  const h = CODE_HINTS[k]
  return h ? `code=${k} ${h}` : `code=${k}（未知返回码）`
}
