/**
 * CLI 命令 `comment-delete`：在写前预检与暂停保护下删除大鲸鱼已发出的评论。
 */
import { requestBili } from '../../bili/api.mjs'
import { biliEndpoint } from '../../bili/endpoints.mjs'
import { requireWritePreview } from '../../social/write-preview.mjs'
import { config } from '../../config/index.mjs'
import { lifeStore } from '../../life/runtime.mjs'
import { biliHeaders, loadCred, missingForWrite } from '../../bili/cookie.mjs'

const argv = process.argv.slice(2)
const args = new Map()
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a.startsWith('--')) args.set(a.slice(2), argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true)
}
const oid = args.get('oid')
const rpid = args.get('rpid')
const bvid = args.get('bvid')
const type = String(args.get('type') ?? '1')
const isDry = args.has('dry')
const isGo = args.has('go')
if (!oid || !rpid) { console.error('需要 --oid <aid|comment_id_str> --rpid <rpid> [--type 1|11|17] [--bvid <BV>] --dry|--go'); process.exit(2) }
if (!['1', '11', '17'].includes(type)) { console.error('--type 仅支持 1 / 11 / 17'); process.exit(2) }
if (isDry === isGo) { console.error('必须且只能给一个 --dry 或 --go'); process.exit(2) }

let cred
try {
  cred = loadCred()
  const miss = missingForWrite(cred)
  if (miss.length) { console.error(`凭据不完整，缺少：${miss.join('、')}`); process.exit(3) }
} catch (e) { console.error(e.message); process.exit(3) }

const endpoint = biliEndpoint('deleteComment')

console.log('=== 将删除 ===')
console.log(`  ${endpoint.method} ${endpoint.origin}${endpoint.path}`)
console.log(`  type=${type}  oid=${oid}  rpid=${rpid}  csrf=***csrf***   cookie=SESSDATA=***`)
if (bvid) console.log(`  referer=https://www.bilibili.com/video/${bvid}/`)
requireWritePreview('comment-delete', { type, oid, rpid, bvid }, { dry: isDry, credentials: cred })
if (isDry) { console.log('\n[dry] 预检通过，未删除。'); process.exit(0) }
if (config().life?.paused || lifeStore().read().settings.paused) {
  console.error('大鲸鱼主动活动已暂停，不能执行删除操作。')
  process.exit(4)
}

const out = await requestBili('deleteComment', {
  headers: {
    ...biliHeaders(cred, {
      referer: bvid ? `https://www.bilibili.com/video/${bvid}/` : 'https://www.bilibili.com/',
      origin: 'https://www.bilibili.com',
    }),
    'content-type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({ type, oid: String(oid), rpid: String(rpid), csrf: String(cred.bili_jct) }).toString(),
})
const hints = { 0: '成功', '-101': '未登录', '-111': 'csrf 不对', '-403': '权限不足（不是自己的评论）', '-404': '无此项', 12022: '已经被删除了' }
const message = out.payload ? out.message ?? '' : '非 JSON 响应'
const hint = out.ok || out.rejected ? hints[out.code] ?? '' : '删除结果未确认，请先回读核查'
console.log(`\n[go] HTTP ${out.status}  code=${out.code ?? -1} ${message}   ${hint}`)
process.exit(out.ok ? 0 : 1)
