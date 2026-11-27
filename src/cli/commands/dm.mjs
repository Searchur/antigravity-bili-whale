import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { bundledStickerRoot, userStickerRoot, DATA_PATHS, shotsPath, workDirPath } from '../../core/paths.mjs'
import { lifeStore } from '../../life/runtime.mjs'
import { guardSend } from '../../social/send-guard.mjs'
import { uploadPic, dmContent } from '../../bili/upload-pic.mjs'
import { guardedFetch as fetch } from '../../bili/traffic.mjs'
import { config } from '../../config/index.mjs'
import { gate, lockQuotaForSend, flushQuotaReceipts } from '../../social/quota-gate.mjs'
import { exactJson } from '../../core/json-exact.mjs'
import { enforceOutboundSafety } from '../../social/content-safety.mjs'
import { isFollowerOfWhale } from '../../bili/relation.mjs'
import { checkFanQuota, lockFanReplyQuota, recordFanReply } from '../../social/fan-quota.mjs'
import { requireWritePreview } from '../../social/write-preview.mjs'
import { dmListenerScope } from '../../social/dm-listener-scope.mjs'
import { atomicWriteJson } from '../../core/atomic-json.mjs'
import { localDay } from '../../core/local-date.mjs'
import { loadCred, missingForWrite, explainCode, looksLikeJct } from '../../bili/cookie.mjs'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
function assertSafeAttachmentPath(filePath) {
  const realTarget = fs.realpathSync(filePath)
  if (!IMAGE_EXTS.has(path.extname(realTarget).toLowerCase())) throw Error('只允许附带 png/jpg/gif/webp 图片文件')
  const allowedRoots = [
    shotsPath,
    workDirPath,
    userStickerRoot,
    bundledStickerRoot,
  ]
  const inside = allowedRoots.some(root => {
    try {
      const realRoot = fs.realpathSync(root)
      const rel = path.relative(realRoot, realTarget)
      return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel)
    } catch { return false }
  })
  if (!inside) throw Error('图片路径不在允许目录内（仅限插件内置表情包或大鲸鱼数据目录下的图片）')
  const stat = fs.statSync(realTarget)
  if (!stat.isFile() || !stat.size || stat.size > 10 * 1024 * 1024) throw Error('图片必须是非空且不超过 10MB 的文件')
  return realTarget
}

function stableDevId() {
  const file = DATA_PATHS.deviceId
  try {
    const v = fs.readFileSync(file, 'utf8').trim()
    if (/^WEB-[0-9A-F-]{20,}$/i.test(v)) return v
  } catch {}
  const v = 'WEB-' + crypto.randomUUID().toUpperCase()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, v + '\n', { mode: 0o600 })
  } catch (e) { throw new Error('无法保存私信设备 ID，已停止发送：' + e.message) }
  return v
}

const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[argv[i].slice(2)] = true
    else { opt[argv[i].slice(2)] = v; i += 1 }
  }
}

if (opt['affect-plan'] !== undefined && typeof opt['affect-plan'] !== 'string') { console.error('主动补话计划 ID 无效'); process.exit(2) }
const AFFECT_PLAN = typeof opt['affect-plan'] === 'string' ? opt['affect-plan'] : ''
const BATCH_PART = typeof opt['batch-part'] === 'string' ? opt['batch-part'] : ''
const SHARE = !!opt.share
if (AFFECT_PLAN && SHARE) { console.error('主动补话不能与 --share 同时使用'); process.exit(2) }

const BV = (String(opt.msg ?? '').match(/BV[0-9A-Za-z]{10}/) ?? [])[0] ?? ''
const DRY = !!opt.dry
const GO = !!opt.go
const STATUS = !!opt.status
const MSG = String(opt.msg ?? '').trim()
const PIC_RAW = String(opt.pic ?? '').trim()

const QUOTA = DATA_PATHS.dmQuota
let cred
try {
  cred = loadCred()
} catch (e) {
  console.error('✗ ' + e.message)
  process.exit(3)
}
const miss = missingForWrite(cred)
if (miss.length) {
  console.error('✗ 凭据不完整，无法发送私信：')
  for (const m of miss) console.error('   · 缺 ' + m)
  console.error('  请在控制台「大鲸鱼与主人」重新扫码登录。')
  process.exit(2)
}
if (!looksLikeJct(cred.bili_jct)) {
  console.error('⚠️ bili_jct 格式异常，发送可能被拒，请在控制台重新扫码登录。')
}

const cfg = config()
const OWNER = String(cfg.owner?.mid ?? '').trim()
const OWNER_NAME = String(cfg.owner?.name ?? '主人')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const H = {
  'user-agent': UA,
  referer: 'https://www.bilibili.com/',
  cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`,
}
const jget = async (u) => (await fetch(u, { headers: H })).json()
const loadQ = () => { try { return JSON.parse(fs.readFileSync(QUOTA, 'utf8')) } catch { return {} } }
const saveQ = (o) => { atomicWriteJson(QUOTA, o) }
const today = () => localDay()

const REPLY_FAN = !!opt['reply-fan']
const RECEIPT = String(opt.receipt ?? '').trim()
const EXPLICIT_TO = String(opt.to ?? '').trim()
const IS_FAN_REPLY = REPLY_FAN && EXPLICIT_TO && EXPLICIT_TO !== OWNER
const ONLY_TO = IS_FAN_REPLY ? EXPLICIT_TO : OWNER
const REQUIRE_MUTUAL = !IS_FAN_REPLY
const targetBV = BV || (String(opt.target ?? '').match(/^(?:BV:)?(BV[0-9A-Za-z]{10})$/) ?? [])[1]
if (SHARE && !STATUS) {
  if (cfg.share?.enabled !== true) {
    console.error('主动分享已在设置中关闭（share.enabled = false），本次不发送。')
    process.exit(3)
  }
  if (String(cfg.share?.via ?? 'comment') !== 'dm') {
    console.error('当前分享通道设置为评论区（share.via = comment），请改用 comment --share 或在控制台切换分享通道。')
    process.exit(2)
  }
  if (!targetBV) { console.error('分享需要正文或 --target 中的有效 BV 号'); process.exit(2) }
}
const SHARE_TARGET = targetBV ? 'BV:' + targetBV : 'dm:' + ONLY_TO

function verifyFanReceipt(account, mid, receipt) {
  const scope = dmListenerScope(cfg)
  if (!receipt || scope?.account !== account) return false
  try {
    const map = JSON.parse(fs.readFileSync(scope.receiptsFile, 'utf8'))
    const entry = map?.[receipt]
    return Boolean(entry && String(entry.mid) === String(mid) && Date.now() - Number(entry.at ?? 0) < 24 * 3600_000)
  } catch { return false }
}

function consumeFanReceipt(account, receipt) {
  const scope = dmListenerScope(cfg)
  if (!receipt || scope?.account !== account) return
  try {
    const map = JSON.parse(fs.readFileSync(scope.receiptsFile, 'utf8'))
    if (map && Object.hasOwn(map, receipt)) {
      delete map[receipt]
      atomicWriteJson(scope.receiptsFile, map)
    }
  } catch {}
}

async function me() {
  const nav = await jget('https://api.bilibili.com/x/web-interface/nav')
  if (!nav.data?.isLogin) { console.error('✗ 未登录（登录态已失效，请在控制台重新扫码登录）'); process.exit(3) }
  return { mid: String(nav.data.mid), uname: nav.data.uname }
}

async function relation(toMid) {
  if (!toMid) return { ok: false, attribute: -1, why: '尚未配置收信人 UID' }
  const j = await jget(`https://api.bilibili.com/x/relation?fid=${toMid}`)
  if (j.code !== 0) return { ok: false, attribute: -1, why: `关系接口 code=${j.code}` }
  return { ok: true, attribute: Number(j.data?.attribute ?? -1), beAttribute: j.data?.be_relation?.attribute == null ? null : Number(j.data.be_relation.attribute) }
}

function relationLines(rel, meInfo) {
  if (!rel.ok) return [rel.why + '，无法确认关注方向，请稍后重试']
  const outgoing = [2, 6].includes(rel.attribute)
  const incoming = rel.attribute === 6 || (rel.beAttribute != null ? [2, 6].includes(rel.beAttribute) : null)
  const lines = [
    `大鲸鱼 → 主人：${outgoing ? '已关注' : '未关注'}`,
    `主人 → 大鲸鱼：${incoming === null ? '未知（请在主人账号确认）' : incoming ? '已关注' : '未关注'}`,
  ]
  if (!outgoing) lines.push(`请登录大鲸鱼账号，在 https://space.bilibili.com/${ONLY_TO} 手动关注主人。`)
  if (incoming !== true) lines.push(`请登录主人账号，在 https://space.bilibili.com/${meInfo.mid} 确认并手动关注大鲸鱼。`)
  if (rel.attribute === 128 || rel.beAttribute === 128) lines.push('存在拉黑关系，请先检查双方黑名单。')
  return lines
}

async function send(toMid, text, dispatch, pic) {
  const body = new URLSearchParams()
  body.set('msg[sender_uid]', meInfo.mid)
  body.set('msg[receiver_id]', String(toMid))
  body.set('msg[receiver_type]', '1')
  body.set('msg[msg_type]', pic ? '2' : '1')
  body.set('msg[msg_status]', '0')
  body.set('msg[timestamp]', String(Math.floor(Date.now() / 1000)))
  body.set('msg[dev_id]', stableDevId())
  body.set('msg[content]', pic ? dmContent(pic) : JSON.stringify({ content: text }))
  body.set('csrf', String(cred.bili_jct))
  const r = await fetch('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', {
    method: 'POST',
    waitWriteMs: 180000,
    dispatch,
    headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const j = await exactJson(r).catch(() => ({}))
  return { http: r.status, code: j.code, message: j.message, data: j.data }
}

if (STATUS) {
  const q = loadQ()
  const meInfo = await me()
  console.log(`账号: ${meInfo.uname}（UID ${meInfo.mid}）`)
  console.log(`主人对象: ${OWNER_NAME}（UID ${ONLY_TO || '未配置'}）`)
  console.log(`今日已发主人私信: ${q.date === today() ? Number(q.count ?? 0) : 0} 条`)
  if (!ONLY_TO) process.exit(0)
  const rel = await relation(ONLY_TO)
  console.log(`互关状态: attribute=${rel.attribute} ${rel.attribute === 6 ? '（已互关，可发送）' : '（未互关，不可发送）'}`)
  for (const line of relationLines(rel, meInfo)) console.log(line)
  if (!rel.ok) process.exit(3)
  process.exit(0)
}

if (!MSG && !PIC_RAW) { console.error('用法: node dm.mjs --account <UID> --to <UID> --msg "…" [--pic 图片路径] --dry|--go'); process.exit(2) }

if (EXPLICIT_TO && EXPLICIT_TO !== OWNER && !REPLY_FAN) {
  console.error('✗ 禁止主动向非主人发送私信（仅允许回复已关注粉丝的来信，需带 --reply-fan --receipt <回执>）。')
  process.exit(4)
}
if (!ONLY_TO) { console.error('✗ 缺少收信人 UID（请先在控制台配置主人 UID）'); process.exit(2) }
if (MSG.length > 300) { console.error(`✗ 私信过长（${MSG.length} > 300 字），请精简或拆分为多段发送。`); process.exit(2) }

const safetyRes = await enforceOutboundSafety({ text: MSG, channel: 'dm', isOwnerTarget: !IS_FAN_REPLY, cfg })
if (safetyRes.blocked) {
  console.error(`✗ [安全审核拦截] ${safetyRes.reason}（类别：${safetyRes.category}）`)
  process.exit(4)
}

const meInfo = await me()
if (opt.account && (String(opt.account) !== String(meInfo.mid) || String(opt.account) !== String(cfg.self?.mid))) {
  console.error('当前登录的大鲸鱼账号与任务账号不一致，已停止发送。')
  process.exit(4)
}
if (String(meInfo.mid) === ONLY_TO) {
  console.error('✗ 不能给自己发私信（目标 UID 与当前登录账号相同）')
  process.exit(2)
}

let fanQuotaRequest = null
if (IS_FAN_REPLY) {
  if (SHARE) { console.error('✗ 禁止向粉丝主动分享视频，仅允许被动回复来信'); process.exit(4) }
  if (!cfg.listen?.dmFan) { console.error('✗ 当前未开启「回复粉丝私信」开关'); process.exit(4) }
  if (!verifyFanReceipt(String(meInfo.mid), ONLY_TO, RECEIPT)) {
    console.error('✗ 缺少有效的粉丝来信回执（--receipt），严禁无来信主动向粉丝发起私信。')
    process.exit(4)
  }
  const fanOk = await isFollowerOfWhale(ONLY_TO, H)
  if (!fanOk) {
    console.error(`✗ 对方（UID ${ONLY_TO}）未关注大鲸鱼，仅回复已关注粉丝的私信。`)
    process.exit(4)
  }
  fanQuotaRequest = {
    channel: 'dm',
    uid: ONLY_TO,
    perUserDaily: cfg.fanLimits?.dmPerUserDaily ?? 2,
    totalDaily: cfg.fanLimits?.dmTotalDaily ?? 10,
  }
  const fq = checkFanQuota(fanQuotaRequest)
  if (!fq.allowed) {
    console.error(`✗ [粉丝私信限额] ${fq.reason}`)
    process.exit(4)
  }
  console.log(`[dm:fan-reply] ${meInfo.uname} → 粉丝 UID ${ONLY_TO}（今日 ${fq.userUsed + 1}/${cfg.fanLimits?.dmPerUserDaily ?? 2}）`)
} else {
  const rel = await relation(ONLY_TO)
  if (!rel.ok) { console.error(`✗ ${rel.why}`); process.exit(3) }
  if (REQUIRE_MUTUAL && rel.attribute !== 6) {
    console.error(`✗ 未互关（attribute=${rel.attribute}）—— 主人私信通道要求双方互相关注`)
    for (const line of relationLines(rel, meInfo)) console.error(line)
    process.exit(4)
  }
  const q = loadQ()
  const used = q.date === today() ? Number(q.count ?? 0) : 0
  console.log(`[dm] ${meInfo.uname} → ${OWNER_NAME}（UID ${ONLY_TO}）`)
  console.log(`  正文 ${MSG.length} 字：${MSG.slice(0, 80)}${MSG.length > 80 ? '…' : ''}`)
  console.log(`  已互关 · 今天第 ${used + 1} 条（主人私信通道）`)
}

if (GO === DRY) { console.error('✗ 必须且只能给 --dry 或 --go'); process.exit(2) }

if (AFFECT_PLAN) { lifeStore().validateAffectPlanRequest(AFFECT_PLAN, MSG, cfg) }
if (SHARE) {
  const ok = gate({ type: 'dm', target: SHARE_TARGET, auto: true, share: true })
  if (!ok) { console.error('✗ 分享额度不允许（见上面的 [限额闸] 输出）'); process.exit(4) }
}

let PIC = ''
let imageHash
if (PIC_RAW) {
  try {
    PIC = assertSafeAttachmentPath(PIC_RAW)
    imageHash = crypto.createHash('sha256').update(fs.readFileSync(PIC)).digest('hex')
  } catch (error) { console.error('--pic 校验失败：' + error.message); process.exit(2) }
}
const imageText = imageHash ? '[图片 sha256:' + imageHash + ']' : ''
const request = {
  channel: 'dm',
  scene: SHARE ? 'private-recommendation' : 'private-reply',
  target: String(ONLY_TO),
  text: MSG || imageText,
  auto: SHARE || !!AFFECT_PLAN || !!opt.auto,
  share: SHARE,
  video: SHARE ? SHARE_TARGET : undefined,
  quotaTarget: SHARE ? SHARE_TARGET : undefined,
  affectPlanId: AFFECT_PLAN || undefined,
  batchPartId: BATCH_PART || undefined,
  ...(BATCH_PART && typeof opt.task === 'string' ? {taskId:opt.task} : {}),
  ...(PIC ? { dmImageHash: imageHash, dmImageOnly: !MSG } : {}),
}
await guardSend(request, { dry: true })
requireWritePreview('dm', { request, receipt: RECEIPT }, { dry: DRY, credentials: cred })
if (DRY) {
  if (PIC) console.log(MSG ? '  [dry] 将分别发送文字和图片，各有独立回执' : '  [dry] 将仅发送图片')
  console.log('  [dry] 预检通过，未上传或发送；正式发送会重新检查额度与安全规则')
  process.exit(0)
}

let activeGuard
let textReceipt = ''
async function releasePrepared() {
  if (!activeGuard) return
  const pending = activeGuard.store.read().pending[activeGuard.token]
  if (pending?.phase === 'prepared') await activeGuard.store.settle(activeGuard.token, { status: 'not-sent', verified: true })
}
async function deliver(guard, text, pic) {
  const result = await send(ONLY_TO, text, invoke => guard.store.dispatch(guard.token, invoke), pic)
  if (result.http >= 200 && result.http < 300 && result.code === 0) {
    const receipt = result.data?.msg_key ?? result.data?.msg_seqno
    if (receipt == null || !String(receipt)) throw Error('平台接受但未返回消息回执，保留未知发送占位')
    await guard.store.settle(guard.token, { status: 'sent', receipt: String(receipt) })
    if (SHARE) await flushQuotaReceipts(guard.store)
    if (IS_FAN_REPLY) {
      recordFanReply(fanQuotaRequest)
    } else {
      const quota = loadQ()
      saveQ({ date: today(), count: (quota.date === today() ? Number(quota.count ?? 0) : 0) + 1, mid: ONLY_TO, at: new Date().toISOString() })
    }
    return String(receipt)
  }
  if (Number.isFinite(result.code) && result.code !== 0) await guard.store.settle(guard.token, { status: 'rejected' })
  throw Error('发送失败：HTTP ' + result.http + ' ' + explainCode(result.code))
}

let releaseQuota
let releaseShareQuota
try {
  if (SHARE) releaseShareQuota = await lockQuotaForSend({ type: 'dm', target: SHARE_TARGET, auto: true, share: true })
  releaseQuota = await lockFanReplyQuota(fanQuotaRequest, MSG && PIC ? 2 : 1)
  activeGuard = await guardSend(request)
  let picData = null
  if (PIC) {
    console.log('  正在上传图片；发送将遵守配置的写入冷却')
    picData = await uploadPic(PIC, cred.bili_jct, H, { expectedHash: imageHash })
  }
  if (MSG) {
    textReceipt = await deliver(activeGuard, MSG, null)
    console.log('  文字已确认，回执 ' + textReceipt)
    if (PIC) {
      const parent = activeGuard.store.read().events.find(event => event.kind === 'sent' && event.operationId === activeGuard.token)
      activeGuard = await guardSend({
        channel: 'dm',
        scene: request.scene,
        target: request.target,
        text: imageText,
        auto: request.auto,
        share: false,
        video: request.video,
        taskId: parent?.taskId,
        dmImageHash: imageHash,
        dmAttachmentOf: activeGuard.token,
      })
    }
  }
  if (PIC) {
    console.log('  正在发送图片，可能需要等待配置的私信冷却')
    const receipt = await deliver(activeGuard, '', picData)
    console.log('  图片已确认，回执 ' + receipt)
  }
  if (IS_FAN_REPLY && RECEIPT) consumeFanReceipt(String(meInfo.mid), RECEIPT)
  console.log('  已发送' + (MSG && PIC ? '文字和图片' : '') + '；账本按各自回执记录')
} catch (error) {
  await releasePrepared()
  if (textReceipt) console.error('文字已发送，图片未确认；不要重发正文。明确失败后可用 --pic 单独重试；结果未知时先核查回执。')
  console.error('  ✗ ' + error.message)
  process.exitCode = 1
} finally {
  await releaseQuota?.()
  await releaseShareQuota?.()
}
