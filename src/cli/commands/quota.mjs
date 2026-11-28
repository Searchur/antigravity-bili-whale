/**
 * CLI 命令 `quota`：查询与校验每日分享、公开动态及自主评论配额状态。
 */
import crypto from 'node:crypto'
import { DATA_PATHS } from '../../core/paths.mjs'
import { chatConfig } from '../../config/chat.mjs'
import { config } from '../../config/index.mjs'
import { appendQuotaRows, readQuotaLog, flushQuotaReceipts, recoverQuotaReceipts } from '../../social/quota-ledger.mjs'
import { lifeStore } from '../../life/runtime.mjs'
import { localDay } from '../../core/local-date.mjs'

const FILE = DATA_PATHS.quota
let corrupt = false

const load = () => {
  const cfg = config()
  const defaults = { shareDaily: cfg.quota?.shareDaily ?? 3, log: [] }
  try { return { ...defaults, log: readQuotaLog() } }
  catch (error) {
    corrupt = true
    console.error('额度账本无法读取：' + error.message)
    return defaults
  }
}

const today = () => localDay()
const dayOf = (at) => localDay(at)
const usedToday = (q) => q.log.filter((x) => dayOf(x.at) === today()).length

const argv = process.argv.slice(2)
const cmd = argv[0]
const opt = {}
for (let i = 1; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[argv[i].slice(2)] = true
    else { opt[argv[i].slice(2)] = v; i += 1 }
  } else if (!opt._a) opt._a = argv[i]
}
let reservations = []
if (['check', 'status', 'record'].includes(cmd)) {
  reservations = await recoverQuotaReceipts((account, owner) => lifeStore(config(), { account, owner }))
  await flushQuotaReceipts(lifeStore())
}
const q = load()
const settled = new Set(q.log.map(row => row.operationId))
const unresolved = reservations.filter(row => !settled.has(row.operationId))
if (corrupt && cmd !== 'check') process.exit(2)

if (cmd === 'status') {
  if (unresolved.length) console.log(`待核查的发送有 ${unresolved.length} 条，按派发日期暂占额度。`)
  const cfg = config()
  const chat = chatConfig(cfg.chat)
  const used = usedToday(q)
  const usedAutoComment = q.log.filter((x) => dayOf(x.at) === today() && x.type === 'comment' && x.auto && !x.share).length
  const usedShare = q.log.filter((x) => dayOf(x.at) === today() && x.share).length
  const usedDynamic = q.log.filter((x) => dayOf(x.at) === today() && x.type === 'dynamic').length
  console.log(`今日对外发言: 共 ${used} 条（主动分享 ${usedShare}/${q.shareDaily ?? 3}，自主评论 ${usedAutoComment}/${chat.autoCommentDailyMax}，公开动态 ${usedDynamic}/${chat.dynamicDailyMax}）   日期 ${today()}`)
  console.log(`当前规则：主动分享 ≤${q.shareDaily ?? 3}/天（同一视频 7 天一次），自主评论 ≤${chat.autoCommentDailyMax}/天（同一视频 7 天一次），公开动态 ≤${chat.dynamicDailyMax}/天`)
  if (!opt['summary-only']) {
    const recent = q.log.slice(-5)
    console.log(recent.length ? '最近记录:' : '最近记录: (无)')
    for (const r of recent) console.log(`  ${r.at}  ${r.type}  ${r.target ?? '-'}  ${r.note ?? ''}`)
  }
  process.exit(0)
}

if (cmd === 'check') {
  q.log.push(...unresolved)
  if (corrupt) {
    console.log('✗ 额度账本损坏（quota.json 不是合法 JSON）→ 状态未知，拒绝发言。')
    console.log(`   请检查 ${FILE}。`)
    process.exit(2)
  }
  const cfg = config()
  const auto = !!opt.auto
  const target = typeof opt.target === 'string' ? opt.target : ''
  const share = !!opt.share
  const shareDaily = q.shareDaily ?? 3
  const usedShare = q.log.filter((x) => dayOf(x.at) === today() && x.share).length
  const SEVEN = 7 * 24 * 3600 * 1000

  if (share) {
    if (cfg.share?.enabled !== true) { console.error('主动分享已关闭（share.enabled = false）'); process.exit(2) }
    if (usedShare >= shareDaily) {
      console.log(`✗ 分享额度已用完：今天已分享 ${usedShare} 条（上限 ${shareDaily}）—— 留到明天再发。`)
      process.exit(2)
    }
    if (target) {
      const dup = q.log.find((x) => x.share && String(x.target ?? '') === target && Date.now() - new Date(x.at).getTime() < SEVEN)
      if (dup) {
        console.log(`✗ 这个视频 7 天内已经分享过了：${dup.at}（${dup.target}）`)
        process.exit(2)
      }
    }
    console.log(`分享额度内（${usedShare}/${shareDaily}）${target ? `，target=${target}` : ''}`)
    process.exit(0)
  }

  if (opt.type === 'dynamic') {
    const chat = chatConfig(cfg.chat)
    if (chat.dynamic !== true) {
      console.error('公开动态已关闭（chat.dynamic = false）')
      process.exit(2)
    }
    const dynamicMax = chat.dynamicDailyMax
    const usedDynamic = q.log.filter((x) => dayOf(x.at) === today() && x.type === 'dynamic').length
    if (usedDynamic >= dynamicMax) {
      console.log(`今日公开动态额度已用完（${usedDynamic}/${dynamicMax}）—— 留到明天再发。`)
      process.exit(2)
    }
    console.log(`通过：公开动态额度内（${usedDynamic}/${dynamicMax}）`)
    process.exit(0)
  }

  if (opt.type === 'comment' && auto) {
    const chat = chatConfig(cfg.chat)
    if (chat.autoComment !== true) {
      console.error('自主评论已关闭（chat.autoComment = false）')
      process.exit(2)
    }
    const autoCommentMax = chat.autoCommentDailyMax
    const usedAutoComment = q.log.filter((x) => dayOf(x.at) === today() && x.type === 'comment' && x.auto && !x.share).length
    if (usedAutoComment >= autoCommentMax) {
      console.log(`✗ 今日自主评论额度已用完（${usedAutoComment}/${autoCommentMax}）—— 留到明天再发。`)
      process.exit(2)
    }
    if (target) {
      const dup = q.log.find((x) => x.type === 'comment' && x.auto && !x.share && String(x.target ?? '') === target && Date.now() - new Date(x.at).getTime() < SEVEN)
      if (dup) {
        console.log(`✗ 这个视频 7 天内已经自主评论过了：${dup.at}（${dup.target}）`)
        process.exit(2)
      }
    }
    console.log(`自主评论额度内（${usedAutoComment}/${autoCommentMax}）${target ? `，target=${target}` : ''}`)
    process.exit(0)
  }

  if (!auto) {
    console.log('（回复互动：不受主动分享/自主评论限额拦截，仍需走安全审核与 --dry/--go）')
    process.exit(0)
  }
  console.log(`通过${target ? `，target=${target}` : ''}`)
  process.exit(0)
}

if (cmd === 'record') {
  const type = typeof opt.type === 'string' ? opt.type : 'unknown'
  q.log = await appendQuotaRows([{ operationId: typeof opt.operation === 'string' ? opt.operation : crypto.randomUUID(),
    at: new Date().toISOString(), type, auto: !!opt.auto || !!opt.share, share: !!opt.share, target: opt.target ?? null, note: opt.note ?? null }])
  const usedAutoComment = q.log.filter((x) => dayOf(x.at) === today() && x.type === 'comment' && x.auto && !x.share).length
  const usedShare = q.log.filter((x) => dayOf(x.at) === today() && x.share).length
  const usedDynamic = q.log.filter((x) => dayOf(x.at) === today() && x.type === 'dynamic').length
  const chat = chatConfig(config().chat)
  console.log(`已记账：${type}${opt.share ? '（主动分享）' : opt.auto ? '（自主）' : '（回复）'}${opt.target ? ' → ' + opt.target : ''}   今日分享 ${usedShare}/${q.shareDaily ?? 3}，自主评论 ${usedAutoComment}/${chat.autoCommentDailyMax}，公开动态 ${usedDynamic}/${chat.dynamicDailyMax}`)
  process.exit(0)
}

console.log('用法:')
console.log('  node quota.mjs status [--summary-only]')
console.log('  node quota.mjs check --type comment|dm|dynamic [--target "BV:..."] [--share|--auto]')
console.log('  node quota.mjs record --type comment|dm|dynamic --target "BV:..." [--note "…"] [--share|--auto]')
