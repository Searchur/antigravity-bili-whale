/**
 * CLI 命令 `comment`：在安全审核、写前预检与配额闸保护下发表或回复 B 站评论。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { bundledStickerRoot, userStickerRoot, shotsPath, workDirPath } from '../../core/paths.mjs'
import { verifyCommentVisibility } from '../../social/comment-visibility.mjs'
import { lifeConfig } from '../../config/life.mjs'
import { threadKey, lifeStore } from '../../life/runtime.mjs'
import { guardSend } from '../../social/send-guard.mjs'
import { checkCommentTarget } from '../../social/comment-target.mjs'
import { requestBili } from '../../bili/api.mjs'
import { biliEndpoint } from '../../bili/endpoints.mjs'
import { uploadPic, replyPictures } from '../../bili/upload-pic.mjs'
import { gate, lockQuotaForSend, flushQuotaReceipts } from '../../social/quota-gate.mjs'
import { config } from '../../config/index.mjs'
import { chatConfig } from '../../config/chat.mjs'
import { enforceOutboundSafety } from '../../social/content-safety.mjs'
import { isFollowerOfWhale } from '../../bili/relation.mjs'
import { checkFanQuota, lockFanReplyQuota, recordFanReply } from '../../social/fan-quota.mjs'
import { requireWritePreview } from '../../social/write-preview.mjs'
import { biliHeaders, loadCred, missingForWrite } from '../../bili/cookie.mjs'
import { fanCommentQuota } from '../../social/mention-summary.mjs'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
function assertSafeAttachmentPath(filePath) {
  const realTarget = fs.realpathSync(filePath)
  const ext = path.extname(realTarget).toLowerCase()
  if (!IMAGE_EXTS.has(ext)) throw Error('只允许附带 png/jpg/gif/webp 图片文件')
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
  const st = fs.statSync(realTarget)
  if (!st.isFile() || st.size <= 0 || st.size > 10 * 1024 * 1024) throw Error('图片文件无效或超过 10MB 上限')
  return realTarget
}

function formatShareText(text, ownerName) {
  const clean = String(text ?? '').trim()
  const name = String(ownerName ?? '').trim()
  if (!name) throw Error('--share 需要先配置主人昵称（owner.name）')
  if (/^@\S+/.test(clean)) {
    const mentioned = clean.slice(1).split(/\s+/)[0]
    if (mentioned !== name) throw Error(`--share 正文开头的 @ 对象必须是主人（@${name}），不能 @ 其他人`)
    return clean
  }
  return `@${name} ${clean}`
}

async function parentAuthor(aid, rootRpid, parentRpid, replyType) {
  for (let pn = 1; pn <= 4; pn += 1) {
    const j = await requestBili('commentThread', {
      query: { type: replyType, oid: aid, root: rootRpid, pn, ps: 20 },
      headers: biliHeaders(null, { userAgent: 'Mozilla/5.0' }),
    })
    if (!j.ok) return null
    const list = j.data?.replies ?? []
    const hit = list.find((r) => String(r.rpid) === String(parentRpid))
    if (hit) return { mid: String(hit.mid ?? hit.member?.mid ?? ''), name: hit.member?.uname ?? '' }
    const rt = j.data?.root
    if (rt && String(rt.rpid) === String(parentRpid)) {
      return { mid: String(rt.mid ?? rt.member?.mid ?? ''), name: rt.member?.uname ?? '' }
    }
    if (!list.length) break
  }
  return null
}

const args = new Map()
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i]
  if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i] ?? true)
}

const AUTO = args.has('auto')
const SHARE = args.has('share')
const oid = args.get('oid')
const bvid = args.get('bvid')
let message = args.get('message')
const PIC_RAW = String(args.get('pic') ?? '').trim()
let root = args.get('root')
const parent = args.get('parent')
if (parent && (!root || String(root) === '0')) root = String(parent)

const type = String(args.get('type') ?? '1')
const refererArg = args.get('referer') ? String(args.get('referer')) : ''
const dry = args.has('dry')
const go = args.has('go')
const CHECK = args.has('check')

const cfgNow = config()
if (CHECK) {
  if (!oid) { console.error('--check 需要 --oid'); process.exit(2) }
  const who = (root && parent) ? await parentAuthor(oid, root, parent, type) : null
  const ownerMid = String(cfgNow.owner?.mid ?? '')
  const lines = [`oid=${oid}  root=${root ?? '(未给)'}  parent=${parent ?? '(未给)'}  type=${type}`]
  if (!root || !parent) {
    lines.push('\n这是【顶层评论】（不带 --root/--parent）')
    console.log(lines.join('\n'))
    process.exit(0)
  }
  if (!who?.mid) {
    lines.push('\n✗ 查不到被回复者的 UID（可能评论已删除或坐标有误）')
    console.log(lines.join('\n'))
    process.exit(2)
  }
  lines.push(`\n被回复者：${who.name || '(无名)'}（UID ${who.mid}）`)
  if (ownerMid && String(who.mid) === ownerMid) {
    lines.push('被回复者是主人，可以回复。')
    console.log(lines.join('\n'))
    process.exit(0)
  }
  console.log(lines.join('\n'))
  process.exit(0)
}

if (!oid || (!bvid && !refererArg) || !message || typeof message !== 'string') {
  console.error('用法: --oid <aid|comment_id_str> [--bvid <BV...> | --referer <url>] --message "<text>" [--type 1|11|17] [--root <rpid> --parent <rpid>] [--share | --auto] [--pic <路径>] [--dry | --go] [--check]')
  process.exit(2)
}
if (dry && go) { console.error('必须且只能给 --dry 或 --go'); process.exit(2) }
if (!dry && !go) { console.error('缺少必需参数 --dry 或 --go'); process.exit(2) }

if (SHARE) {
  if (cfgNow.share?.enabled !== true) {
    console.error('主动分享已在设置中关闭（share.enabled = false），本次不发送。')
    process.exit(3)
  }
  if (String(cfgNow.share?.via ?? 'comment') !== 'comment') {
    console.error('当前分享通道设置为私信（share.via = dm），请改用 bili_write dm --share 或在控制台切换分享通道。')
    process.exit(2)
  }
  try { message = formatShareText(message, cfgNow.owner?.name) }
  catch (e) { console.error(e.message); process.exit(2) }
}

const msgCharLen = Array.from(String(message)).length
if (msgCharLen > 1000) {
  console.error(`✗ 正文长度 ${msgCharLen} 超过 B 站单条 1000 字符上限，请精简后再发。`)
  process.exit(2)
}

let PIC = ''
if (PIC_RAW) {
  try { PIC = assertSafeAttachmentPath(PIC_RAW) }
  catch (e) { console.error('✗ --pic 校验失败：' + e.message); process.exit(2) }
}

let cred
try {
  cred = loadCred()
  const miss = missingForWrite(cred)
  if (miss.length) {
    console.error('✗ 凭据不完整：缺少 ' + miss.join('、') + '，请在控制台【大鲸鱼与主人】重新扫码登录。')
    process.exit(3)
  }
} catch (e) {
  console.error('✗ ' + e.message)
  process.exit(3)
}

const referer = refererArg !== '' ? refererArg : `https://www.bilibili.com/video/${bvid}/`
const headers = biliHeaders(cred)
const pageHeaders = { ...headers, referer }

// ── 身份核验与粉丝每日限额硬闸门 ──
let replyTargetAuthor = null
let isOwnerReplyTarget = false
let fanQuotaRequest = null
if (parent && root) {
  replyTargetAuthor = await parentAuthor(oid, root, parent, type)
  const ownerMidNow = String(cfgNow.owner?.mid ?? '').trim()
  isOwnerReplyTarget = Boolean(replyTargetAuthor?.mid && ownerMidNow && String(replyTargetAuthor.mid) === ownerMidNow)
  if (!isOwnerReplyTarget) {
    if (!replyTargetAuthor?.mid) {
      console.error('✗ 无法确认被回复者 UID，按安全规则不回复陌生人。')
      process.exit(4)
    }
    const isFan = await isFollowerOfWhale(replyTargetAuthor.mid, headers)
    if (!isFan) {
      console.error(`✗ 对方（UID ${replyTargetAuthor.mid}）未关注大鲸鱼，仅回复主人或已关注粉丝的评论。`)
      process.exit(4)
    }
    const replyThread = threadKey(type, oid, root)
    const incoming = lifeStore(cfgNow).read().events.findLast(event => event.kind === 'received' && event.origin === 'external'
      && event.actor === replyTargetAuthor.mid && event.target === replyThread && String(event.data?.parent) === String(parent))
    fanQuotaRequest = fanCommentQuota(cfgNow, { mid: replyTargetAuthor.mid, kind: incoming?.data?.notificationKind, text: incoming?.text || '', quotedText: incoming?.data?.notificationTarget })
    const fq = checkFanQuota(fanQuotaRequest)
    if (!fq.allowed) {
      console.error(`✗ [粉丝评论限额] ${fq.reason}`)
      process.exit(4)
    }
  }
} else if (!SHARE) {
  const autoCommentEnabled = chatConfig(cfgNow.chat).autoComment === true
  if (!AUTO || !autoCommentEnabled) {
    console.error('✗ 未开启自主评论或缺少 --auto 参数（请在【分享与监听】开启允许自主发表评论，或带 --share 主动分享给主人）。')
    process.exit(4)
  }
}

const safetyCheck = await enforceOutboundSafety({
  text: message,
  channel: 'comment',
  isOwnerTarget: isOwnerReplyTarget || SHARE,
  cfg: cfgNow,
})
if (safetyCheck.blocked) {
  console.error(`✗ [安全审核拦截] ${safetyCheck.reason}（类别：${safetyCheck.category}）`)
  process.exit(4)
}

const nav = await requestBili('nav', { headers, noCache: true })
console.log('=== 登录态校验（只读） ===')
if (!nav.ok || !nav.data?.mid || nav.data.isLogin === false) {
  console.log(`  nav code=${nav.code} message=${nav.message}`)
  console.log('  → 登录态无效或已过期，请在控制台【大鲸鱼与主人】重新扫码登录')
  process.exit(4)
}
console.log(`  账号: ${nav.data.uname}   (UID ${nav.data.mid})`)
console.log(`  手机绑定: ${nav.data.mobile_verified ? '是' : '否'}   硬币 ${nav.data.money}`)

if (type === '11' || type === '17') {
  try { await checkCommentTarget(type, oid, pageHeaders) }
  catch (e) { console.error(e.message); process.exit(6) }
}

const params = { type, oid: String(oid), message, plat: '1', csrf: String(cred.bili_jct) }
if (root) params.root = String(root)
if (parent) params.parent = String(parent)
const keys = nav.data?.wbi_img ?? null
const endpoint = biliEndpoint('addComment')
const signature = keys?.img_url && keys?.sub_url ? '?w_rid=***&wts=...' : ''
const redactPreview = value => [cred.sessdata, cred.bili_jct, cred.buvid3].filter(Boolean)
  .reduce((text, secret) => text.replaceAll(secret, '***'), String(value))
const previewBody = new URLSearchParams(Object.entries({ ...params, csrf: '***csrf***' })
  .map(([key, value]) => [key, redactPreview(value)]))

console.log('\n=== 将要发出的请求 ===')
console.log(`  ${endpoint.method}  ${endpoint.origin}${endpoint.path}${signature}`)
console.log('  content-type: application/x-www-form-urlencoded')
console.log('  headers: UA(Chrome 131) + referer=' + redactPreview(referer))
console.log('  cookie : SESSDATA=***; bili_jct=***; buvid3=***   (已脱敏)')
console.log('  body   : ' + previewBody.toString())
console.log(`  正文长度 ${msgCharLen} 字符（B 站单条上限 1000 字符）；oid=${redactPreview(oid)}`)

const quotaOptions = { type: 'comment', target: bvid ? `BV:${bvid}` : `oid:${oid}`, share: SHARE, auto: AUTO }
if (!gate(quotaOptions)) {
  console.error('  → 拒绝发送（超过额度或对应开关已关闭）。')
  process.exit(2)
}

const lifeRequest = {
  channel: 'comment',
  quotaTarget: quotaOptions.target,
  scene: parent ? 'reply' : 'public-comment',
  target: String(bvid || oid),
  thread: threadKey(type, oid, root),
  parent: String(parent ?? ''),
  ...(replyTargetAuthor?.mid ? {replyToMid:String(replyTargetAuthor.mid)} : {}),
  text: String(message),
  auto: AUTO || SHARE,
  share: SHARE,
  video: bvid,
}
await guardSend(lifeRequest, { dry: true })
const attachment = PIC ? fs.readFileSync(PIC) : null
requireWritePreview('comment', { oid, referer, ...lifeRequest }, { dry, credentials: cred, attachment })
if (dry) {
  if (PIC) {
    const kb = (fs.statSync(PIC).size / 1024).toFixed(0)
    console.log(`\n[dry] 将附带图片：${PIC}（${kb} KB），dry 阶段不上传`)
  }
  console.log('\n[dry] 预检通过，未发送。改为 --go 时将重新检查额度与安全规则。')
  process.exit(0)
}

let releaseFanQuota = null
let releaseQuota = null
let lifeGuard = null
let sentRpid = null
try {
  if (AUTO || SHARE) releaseQuota = await lockQuotaForSend(quotaOptions)
  releaseFanQuota = await lockFanReplyQuota(fanQuotaRequest)
  lifeGuard = await guardSend(lifeRequest)

  if (PIC) {
    const picData = await uploadPic(
      PIC,
      cred.bili_jct,
      headers,
      { expectedHash: crypto.createHash('sha256').update(attachment).digest('hex') },
    )
    console.log(`\n[图] 已上传：${picData.image_url}（${picData.image_width}x${picData.image_height}）`)
    params.pictures = replyPictures(picData)
  }

  console.log('\n[go] 发送中…')
  const out = await requestBili('addComment', {
    keys,
    waitWriteMs: PIC ? 180000 : 0,
    dispatch: invoke => lifeGuard.store.dispatch(lifeGuard.token, invoke),
    headers: {
      ...pageHeaders,
      origin: 'https://www.bilibili.com',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  })
  console.log(`  HTTP ${out.status}`)
  const resultMessage = out.payload ? out.message ?? '' : '评论响应不是有效 JSON，请回读核查，不要直接重发'
  console.log(`  code=${out.code ?? undefined} message=${resultMessage}`)
  if (out.ok) {
    const rpid = out.data?.rpid_str ?? out.data?.rpid
    if (!rpid) throw Error('API 返回成功但缺少评论 ID；保留未确认发送，先回读核查')
    await lifeGuard.store.settle(lifeGuard.token, { status: 'sent', receipt: String(rpid) })
    console.log(`  平台已接受，评论 rpid=${rpid}`)
    if (fanQuotaRequest) recordFanReply(fanQuotaRequest)
    await flushQuotaReceipts(lifeGuard.store)
    sentRpid = String(rpid)
  } else {
    if (out.rejected) await lifeGuard.store.settle(lifeGuard.token, { status: 'rejected' })
    else console.log('  发送结果未确认，请先回读核查')
    const hints = {
      '-101': '账号未登录：登录态失效，请重新扫码登录',
      '-102': '账号被封停',
      '-111': 'csrf 校验失败：请重新扫码登录',
      '-509': '请求过于频繁',
      12015: '需要评论验证码（触发风控，已停止）',
      12016: '内容含敏感信息',
      12025: '评论字数过多（超过 B 站单条 1000 字符上限）',
      12035: '被 UP 主列入评论黑名单',
      12051: '重复评论被判刷屏',
      12002: '评论区已关闭',
    }
    if (hints[String(out.code)]) console.log(`  提示：${hints[String(out.code)]}`)
    process.exitCode = 6
  }
} catch (e) {
  if (lifeGuard) {
    try {
      const pending = lifeGuard.store.read().pending[lifeGuard.token]
      if (pending?.phase === 'prepared') await lifeGuard.store.settle(lifeGuard.token, { status: 'not-sent', verified: true })
    } catch {}
  }
  console.error('✗ ' + e.message)
  process.exitCode = 1
} finally {
  await releaseFanQuota?.()
  await releaseQuota?.()
}

if (sentRpid) {
  const visibility = await verifyCommentVisibility({
    oid: String(oid),
    type,
    root: root || '',
    rpid: sentRpid,
    referer,
    headers: pageHeaders,
    seconds: lifeConfig(config().life).commentVerifySeconds,
  })
  console.log('[回读] ' + visibility.message)
  try { await lifeGuard.store.recordVisibility(sentRpid, visibility) }
  catch (e) { console.log('[回读记录] ' + e.message + '；发送成功状态保留，不要重发') }
  console.log(bvid
    ? `  https://www.bilibili.com/video/${bvid}/#reply${sentRpid}`
    : `  ${referer.replace(/\/$/, '')}#reply${sentRpid}`)
  process.exit(0)
}
