/**
 * CLI 命令 `like`：在暂停保护与写前预检下为指定 B 站视频点赞。
 */
import { lifeStore } from '../../life/runtime.mjs'
import { biliHeaders, loadCred, missingForWrite } from '../../bili/cookie.mjs'
import { interactionData, verifyInteractionAccount } from '../../bili/interaction-api.mjs'
import { requireWritePreview } from '../../social/write-preview.mjs'
import { config } from '../../config/index.mjs'

const args = process.argv.slice(2)
const modes = args.filter(x => ['--dry', '--go', '--check'].includes(x))
const target = args[0]
if (args.length !== 2 || modes.length !== 1 || args[1] !== modes[0] || !/^BV[0-9A-Za-z]{10}$/.test(target)) {
  console.error('用法: node bili.mjs like <BV> --dry|--go|--check')
  process.exit(2)
}
try {
  let cred
  try { cred = loadCred() } catch { throw Error('无法读取凭据') }
  if (missingForWrite(cred).length) throw Error('凭据不完整')
  const expected = String(config().self?.mid ?? '')
  const headers = biliHeaders(cred, { origin: 'https://www.bilibili.com', userAgent: 'Mozilla/5.0' })
  await verifyInteractionAccount(expected, headers)
  console.log(`账号 mid=${expected}；目标 BV=${target}`)
  async function check() {
    const data = await interactionData('likeState', { query: { bvid: target }, headers, noCache: true })
    if (data !== 0 && data !== 1) throw Error('点赞状态响应无效')
    return data === 1
  }
  const before = await check()
  console.log(`当前状态：${before ? '已点赞' : '未点赞'}`)
  if (modes[0] === '--check') process.exit(0)
  if (before) { console.log('已经点赞，无需写入'); process.exit(0) }
  const dry = modes[0] === '--dry'
  requireWritePreview('like', { target }, { dry, credentials: cred })
  if (dry) { console.log('[dry] 将点赞，未写入'); process.exit(0) }
  if (config().life?.paused || lifeStore().read().settings.paused) throw Error('鲸鱼已暂停，不能执行账号写操作')
  const body = new URLSearchParams({ bvid: target, like: '1', csrf: String(cred.bili_jct) })
  await interactionData('likeChange', {
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!await check()) throw Error('接口返回成功，但回读未确认点赞；请先检查再决定是否重试')
  console.log('已点赞，回读确认')
} catch (error) {
  const known = /^(鲸鱼已暂停，不能执行账号写操作|无法读取凭据|凭据不完整|配置中缺少有效的 self\.mid，无法核对账号|登录账号与配置 self\.mid 不一致或未登录|不能关注自己|目标处于黑名单，不能关注|点赞状态响应无效|关注关系响应无效|缺少匹配的预览.*|预览已过期.*|登录态已变化.*|接口 HTTP \d+|接口拒绝请求 code=-?\d+|接口返回成功，但回读未确认(?:点赞|关注)；请先检查再决定是否重试)$/.test(error.message)
  console.error(`操作失败：${known ? error.message : '请求或处理失败；如已提交，请先检查状态再决定是否重试'}`)
  process.exit(1)
}
