/**
 * CLI 命令 `subtitles`：拉取并筛选指定 B 站视频的分 P 字幕文本。
 */
import fs from 'node:fs'
import path from 'node:path'
import { shotsPath } from '../../core/paths.mjs'
import { parseJsonExact } from '../../core/json-exact.mjs'
import { selectSubtitlePages, pickSubtitle } from '../../media/subtitle-pages.mjs'
import { biliJson } from '../../bili/api.mjs'
import { biliHeaders, loadCred } from '../../bili/cookie.mjs'
import { fetchBiliMedia } from '../../bili/media.mjs'
import { config } from '../../config/index.mjs'
import { resolveWatchProfile, checkWatchDuration } from '../../media/watch-options.mjs'

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
    if (name.length >= 2) s = s.split(name).join('【主人昵称已打码】')
    if (mid.length >= 4) s = s.split(mid).join('【主人 UID 已打码】')
    return s
  }))
}

const referer = `https://www.bilibili.com/video/${bvid}/`
const headers = biliHeaders(loadCred(), { referer })
const mediaHeaders = biliHeaders(undefined, { referer })

const view = await biliJson('view', { headers, query: { bvid } })
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

const outDir = path.join(shotsPath, 'subs')
fs.mkdirSync(outDir, { recursive: true })

for (const page of pages) {
  const cid = page.cid
  if (view.data.pages?.length > 1) console.log(`\n分 P ${page.page}: ${page.part ?? ''}（本次采样 ${pages.length}/${view.data.pages.length} 集）`)
  const p1 = await biliJson('subtitleTracks', { headers, query: { bvid, cid } })
  let subs = p1?.data?.subtitle?.subtitles ?? []
  let src = 'x/player/wbi/v2'
  const aiStatus = p1?.data?.subtitle?.ai_status

  if (!subs.length && page.page === 1) {
    const p2 = await biliJson('subtitleFallback', { headers, query: {
      oid: aid, pid: aid, context_ext: JSON.stringify({ video_type: 1 }), type: 1,
      cur_production_type: 0, preferred_language: 'ai-zh', playlist_switch: 0,
    } })
    const s2 = p2?.data?.subtitle?.subtitles ?? []
    if (s2.length) { subs = s2; src = 'x/v2/subtitle/web/view' }
    else console.log(`两个端点都没字幕：wbi/v2 code=${p1?.code} ai_status=${aiStatus ?? '-'}；web/view code=${p2?.code}`)
  }
  console.log(`字幕来源: ${src}   轨道数=${subs.length}   ai_status=${aiStatus ?? '-'}（0=无AI字幕 1=有 2=生成中）`)

  const pick = pickSubtitle(subs, typeof opt.lan === 'string' ? opt.lan : undefined)
  if (!pick) { console.log('\n没有可用字幕轨道——建议结合 debrief / watch-video 抽帧查看画面字幕'); continue }
  console.log(`选定: ${pick.lan} (${pick.lan_doc ?? ''})`)

  const r = await fetchBiliMedia(pick.subtitle_url, { kind: 'subtitle', headers: mediaHeaders })
  if (!r.ok) { console.error(`下载字幕失败 HTTP ${r.status}——auth_key 分钟级过期，重跑一次即可`); process.exit(4) }
  const rawText = await r.text()
  let body = []
  try { body = parseJsonExact(rawText).body ?? [] } catch { console.error('字幕不是有效的 JSON。'); process.exit(5) }
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
