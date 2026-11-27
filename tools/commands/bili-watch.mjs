import fs from 'node:fs'
import path from 'node:path'
import { dataPath, dshPath } from '../lib/paths.mjs'
import { config } from '../lib/config.mjs'
import { downloadVideo } from '../lib/video-download.mjs'
import { segmentFrames } from '../lib/video-frames.mjs'
import { watchOptions, resolveWatchProfile, checkWatchDuration, planIntervalFrames } from '../lib/watch-options.mjs'
import { apiGet } from '../lib/bili-api.mjs'
import { execFileSync } from '../lib/capture.mjs'
import { requireFfmpeg } from '../lib/ffmpeg.mjs'

let FFMPEG
try { FFMPEG = requireFfmpeg() } catch (e) { console.error(String(e.message)); process.exit(2) }
const defaultOutDir = dshPath('shots', 'video')
let parsed
try { parsed = watchOptions(process.argv.slice(2), defaultOutDir) } catch (e) { console.error(e.message); process.exit(2) }
const { bvid, tile: TILE } = parsed
if (!bvid) { console.error('用法: node bili-watch.mjs <BV号> [列x行] [--every 秒] [--max-frames 帧数] [--profile auto|owner|fan] [--confirmed]'); process.exit(2) }

const shotsBase = path.resolve(dshPath('shots'))
const resolvedOutDir = path.resolve(parsed.outDir || defaultOutDir)
if (resolvedOutDir !== shotsBase && !resolvedOutDir.startsWith(shotsBase + path.sep)) {
  console.error('✗ 输出目录必须位于独立数据目录 shots/ 内，已拒绝越界路径。')
  process.exit(2)
}
const outDir = resolvedOutDir

const watchResolved = resolveWatchProfile(config(), parsed.profile ?? 'auto')
const everySec = parsed.everySec ?? Number(watchResolved.settings.frameEverySec ?? 15)
const maxFrames = parsed.maxFrames ?? Number(watchResolved.settings.maxFrames ?? 36)
const grid = parsed.grid ?? String(watchResolved.settings.frameGrid ?? '3x3')

const cred = JSON.parse(fs.readFileSync(dataPath('credentials.json'), 'utf8'))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const H = { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}` }

const view = await apiGet(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, H)
if (view.code !== 0) { console.error(`view 失败 code=${view.code} ${view.message}`); process.exit(3) }
const { title, owner } = { ...view.data, owner: view.data.owner?.name }
const cid = view.data.pages?.[0]?.cid ?? view.data.cid
const totalDuration = Number(view.data.duration ?? view.data.pages?.[0]?.duration)
const duration = Number(view.data.pages?.[0]?.duration ?? view.data.duration)
if (!Number.isFinite(duration) || duration <= 0) { console.error('视频时长无效'); process.exit(3) }

const durCheck = checkWatchDuration(totalDuration, {
  profile: watchResolved.profile,
  settings: watchResolved.settings,
  confirmed: parsed.confirmed,
})
if (!durCheck.ok) {
  console.error(durCheck.reason)
  process.exit(4)
}

let plan
try {
  plan = planIntervalFrames({ durationSec: duration, everySec, maxFrames, grid })
} catch (e) {
  console.error(e.message)
  process.exit(2)
}
const { cols, rows, perSheet, frameCount: N, sheetCount, times } = plan
const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`

console.log(`标题: ${title}`)
console.log(`UP: ${owner}   时长: ${duration}s   cid=${cid}   按每 ${everySec}s 抽帧（共 ${N} 帧${plan.capped ? `，受上限 ${maxFrames} 帧封顶` : ''}，固定拼图 ${cols}x${rows}，共 ${sheetCount} 张图）`)

const p = await apiGet(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=80&fnval=1&platform=pc&high_quality=1`, H)
const url = p.data?.durl?.[0]?.url
if (!url) { console.error(`没拿到直链（code=${p.code} ${p.message ?? ''}）——有些视频要登录或只有 dash 流`); process.exit(4) }
const QN = { 16: '360P', 32: '480P', 64: '720P', 80: '1080P' }
console.log(`实际画质: ${QN[p.data.quality] ?? p.data.quality}`)

fs.mkdirSync(outDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const mp4 = path.join(outDir, `${bvid}-${stamp}.mp4`)
const tmp = path.join(outDir, '.frames-' + stamp)
fs.mkdirSync(tmp, { recursive: true })

try {
  let segmented = false
  if (!parsed.fullDownload) {
    try {
      await segmentFrames({ ffmpeg: FFMPEG, url, times, directory: tmp, duration })
      segmented = true
      console.log(`取帧方式: 固定间隔分段直取（首帧 ${fmt(times[0])}，步长 ${plan.effectiveStep.toFixed(1)}s，共 ${N} 帧，${cols}x${rows} 共 ${sheetCount} 张）`)
    } catch {
      console.log('分段抽帧未完成，尝试完整下载后抽帧')
    }
  }
  if (!segmented) {
    const result = await downloadVideo(p.data.durl[0], mp4, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' } })
    console.log('已下载临时视频: ' + (result.size / 1024 / 1024).toFixed(2) + ' MB（抽帧后自动清理）')
    console.log(`取帧方式: 固定间隔抽帧（首帧 ${fmt(times[0])}，步长 ${plan.effectiveStep.toFixed(1)}s，共 ${N} 帧，${cols}x${rows} 共 ${sheetCount} 张）`)
    console.log(`时间点  : ${times.map((t, i) => `${i + 1}=${fmt(t)}`).join('  ')}`)
    times.forEach((t, i) => {
      execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', mp4,
        '-frames:v', '1', '-pix_fmt', 'yuvj420p', '-q:v', '2', path.join(tmp, `f${String(i).padStart(2, '0')}.jpg`)], { stdio: 'inherit' })
    })
  }

  const sheets = []
  for (let s = 0; s < sheetCount; s += 1) {
    const chunkDir = path.join(tmp, `chunk-${s}`)
    fs.mkdirSync(chunkDir, { recursive: true })
    const startIdx = s * perSheet
    const endIdx = Math.min(N, startIdx + perSheet)
    for (let idx = startIdx; idx < endIdx; idx += 1) {
      fs.copyFileSync(
        path.join(tmp, `f${String(idx).padStart(2, '0')}.jpg`),
        path.join(chunkDir, `c${String(idx - startIdx).padStart(2, '0')}.jpg`),
      )
    }
    const sheetFile = sheetCount === 1
      ? path.join(outDir, `${bvid}-${stamp}-${cols}x${rows}.jpg`)
      : path.join(outDir, `${bvid}-${stamp}-${cols}x${rows}-p${s + 1}.jpg`)
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', path.join(chunkDir, 'c%02d.jpg'), '-vf',
      `scale=${TILE}:-1,format=yuvj420p,tile=${cols}x${rows}:color=black`, '-frames:v', '1', sheetFile], { stdio: 'inherit' })
    if (!fs.existsSync(sheetFile)) throw new Error(`第 ${s + 1} 张拼图没生成`)
    sheets.push(sheetFile)
  }
  console.log('')
  for (const sheetFile of sheets) console.log(`SHEET: ${sheetFile}`)

  if (N <= 16) {
    const subs = path.join(outDir, `${bvid}-${stamp}-subs.jpg`)
    try {
      execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', path.join(tmp, 'f%02d.jpg'), '-vf',
        `crop=iw:ih*0.17:0:ih*0.83,scale=1280:-1,format=yuvj420p,tile=1x${N}`, '-frames:v', '1', subs], { stdio: 'inherit' })
      if (fs.existsSync(subs)) console.log(`SUBS:  ${subs}\n（同一批帧的底部字幕带，竖排 ${N} 条）`)
    } catch {
      console.log('（字幕条版生成失败，忽略——不影响 SHEET）')
    }
  }
} catch (e) {
  console.error('ffmpeg 抽帧失败：' + e.message)
  process.exitCode = 6
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(mp4, { force: true }) } catch {}
}
