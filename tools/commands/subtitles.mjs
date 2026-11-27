import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { dataPath, dshPath } from '../lib/paths.mjs'
import { selectSubtitlePages, pickSubtitle } from '../lib/subtitle-pages.mjs'
import { guardedFetch as fetch } from '../lib/traffic.mjs'
import { apiGet } from '../lib/bili-api.mjs'
import { config } from '../lib/config.mjs'
import { resolveWatchProfile, checkWatchDuration } from '../lib/watch-options.mjs'

const VALUE_FLAGS = new Set(['lan', 'print', 'sample-pages', 'page', 'profile'])
const argv = process.argv.slice(2)
const opt = {}
const positional = []
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const eq = a.indexOf('=')
    if (eq > 2) opt[a.slice(2, eq)] = a.slice(eq + 1)
    else {
      const k = a.slice(2)
      const next = argv[i + 1]
      if (VALUE_FLAGS.has(k) && next !== undefined && !next.startsWith('--')) { opt[k] = next; i += 1 }
      else opt[k] = true
    }
  } else positional.push(a)
}
const bvid = positional.find(a => /^BV[0-9A-Za-z]{10}$/.test(a))
if (!bvid) { console.error('用法: node subtitles.mjs <BV> [--lan ai-zh] [--print 12] [--profile auto|owner|fan] [--confirmed]'); process.exit(2) }
const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`

{
  const ow = (() => { try { return config().owner ?? {} } catch { return {} } })()
  const name = String(ow.name ?? '')
  const mid = String(ow.mid ?? '')
  const _log = console.log
  console.log = (...args) => _log(...args.map((a) => {
    let s = String(a)
    if (name.length >= 2) s = s.split(name).join('「主人昵称·已打码」')
    if (mid.length >= 4) s = s.split(mid).join('「主人mid·已打码」')
    return s
  }))
}

const cred = JSON.parse(fs.readFileSync(dataPath('credentials.json'), 'utf8'))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`
const H = { 'user-agent': UA, referer: `https://www.bilibili.com/video/${bvid}/`, cookie }
const jget = u => apiGet(u, H)

const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const keyOf = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'))
const nav = await jget('https://api.bilibili.com/x/web-interface/nav')
const raw = keyOf(nav.data?.wbi_img?.img_url ?? '') + keyOf(nav.data?.wbi_img?.sub_url ?? '')
const mixin = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32)
const clean = (v) => String(v).replace(/[!'()*]/g, '')
function wbi(params) {
  const wts = Math.round(Date.now() / 1000)
  const q = Object.keys({ ...params, wts }).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean(k === 'wts' ? wts : params[k]))}`).join('&')
  return `${q}&w_rid=${crypto.createHash('md5').update(q + mixin).digest('hex')}`
}

const view = await jget(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`)
if (view.code !== 0) { console.error(`view 失败 code=${view.code} ${view.message}`); process.exit(3) }
const { aid, title, duration } = view.data
const watchResolved = resolveWatchProfile(config(), opt.profile ?? 'auto')
const durCheck = checkWatchDuration(Number(duration ?? view.data.pages?.[0]?.duration), {
  profile: watchResolved.profile,
  settings: watchResolved.settings,
  confirmed: Boolean(opt.confirmed),
})
if (!durCheck.ok) {
  console.error(`✗ [时长限制] ${durCheck.reason}`)
  process.exit(4)
}

let pages
try { pages = selectSubtitlePages(view.data, opt) } catch (error) { console.error(error.message); process.exit(2) }
console.log(`标题: ${title}`)
console.log(`UP: ${view.data.owner.name}   时长: ${duration}s   aid=${aid} cid=${view.data.cid}`)

const outDir = dshPath('shots', 'subs')
fs.mkdirSync(outDir, { recursive: true })

for (const page of pages) {
  const cid = page.cid
  if (view.data.pages?.length > 1) console.log(`\n分 P ${page.page}: ${page.part ?? ''}（本次采样 ${pages.length}/${view.data.pages.length} 集）`)
  const p1 = await jget(`https://api.bilibili.com/x/player/wbi/v2?${wbi({ bvid, cid })}`)
  let subs = p1?.data?.subtitle?.subtitles ?? []
  let src = 'x/player/wbi/v2'
  const aiStatus = p1?.data?.subtitle?.ai_status

  if (!subs.length && page.page === 1) {
    const ext = encodeURIComponent(JSON.stringify({ video_type: 1 }))
    const p2 = await jget(`https://api.bilibili.com/x/v2/subtitle/web/view?oid=${aid}&pid=${aid}&context_ext=${ext}&type=1&cur_production_type=0&preferred_language=ai-zh&playlist_switch=0`)
    const s2 = p2?.data?.subtitle?.subtitles ?? []
    if (s2.length) { subs = s2; src = 'x/v2/subtitle/web/view' }
    else console.log(`两个端点都没字幕：wbi/v2 code=${p1?.code} ai_status=${aiStatus ?? '-'}；web/view code=${p2?.code}`)
  }
  console.log(`字幕来源: ${src}   轨道数=${subs.length}   ai_status=${aiStatus ?? '-'}（0=无AI字幕 1=有 2=生成中）`)

  const pick = pickSubtitle(subs, typeof opt.lan === 'string' ? opt.lan : undefined)
  if (!pick) { console.log('\n没有可用字幕轨道——建议结合 debrief / watch-video 抽帧查看画面字幕'); continue }
  console.log(`选定: ${pick.lan} (${pick.lan_doc ?? ''})`)

  const url = String(pick.subtitle_url).startsWith('http') ? pick.subtitle_url : 'https:' + pick.subtitle_url
  const r = await fetch(url, { headers: { 'user-agent': UA, referer: `https://www.bilibili.com/video/${bvid}/` } })
  if (!r.ok) { console.error(`下载字幕失败 HTTP ${r.status}——auth_key 分钟级过期，重跑一次即可`); process.exit(4) }
  const rawText = await r.text()
  let body = []
  try { body = JSON.parse(rawText).body ?? [] } catch { console.error('字幕不是 JSON: ' + rawText.slice(0, 120)); process.exit(5) }
  if (!body.length) { console.error('字幕 JSON 里 body 是空的'); process.exit(5) }
  console.log(`字幕行数: ${body.length}   覆盖 ${fmt(body[0].from)} → ${fmt(body.at(-1).to ?? body.at(-1).from)}`)

  const safeLan = String(pick.lan || 'zh').replace(/[^a-zA-Z0-9._-]/g, '_')
  const base = path.join(outDir, `${bvid}${view.data.pages?.length > 1 ? '-P' + page.page : ''}-${safeLan}`)
  fs.writeFileSync(base + '.json', rawText)
  fs.writeFileSync(base + '.txt', `${title}${view.data.pages?.length > 1 ? ' P' + page.page + ' ' + (page.part ?? '') : ''}\n${view.data.owner.name}  ${bvid}  ${duration}s\n\n` +
    body.map((l) => `[${fmt(l.from)}] ${l.content}`).join('\n'))
  fs.writeFileSync(base + '-plain.txt', body.map((l) => l.content).join('\n'))
  console.log(`\nTXT  : ${base}.txt`)

  const n = Number(opt.print ?? 12)
  console.log(`\n--- 前 ${n} 行 ---`)
  for (const l of body.slice(0, n)) console.log(`[${fmt(l.from)}] ${l.content}`)
}
