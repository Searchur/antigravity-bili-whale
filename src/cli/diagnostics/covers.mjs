/**
 * CLI 诊断工具 `covers`：批量拉取并验证视频封面图片缓存。
 */
import fs from 'node:fs'
import { saveCoverImage } from '../../media/cover-image.mjs'
import path from 'node:path'
import { shotsPath } from '../../core/paths.mjs'
import { requestBili } from '../../bili/api.mjs'
import { biliHeaders, loadCred } from '../../bili/cookie.mjs'
import { fetchBiliMedia } from '../../bili/media.mjs'

const headers = biliHeaders(loadCred())
const mediaHeaders = biliHeaders()
const outDir = path.join(shotsPath, 'covers')
fs.mkdirSync(outDir, { recursive: true })

for (const bv of process.argv.slice(2)) {
  if (!/^BV[0-9A-Za-z]{10}$/.test(bv)) { console.log(`${bv}: 无效 BV 号`); continue }
  try {
    const d = await requestBili('viewLegacy', { headers, query: { bvid: bv } })
    if (!d.payload) throw Error(d.message)
    if (!d.ok) { console.log(`${bv}: code=${d.code} ${d.message}`); continue }
    const v = d.data
    const cover = path.join(outDir, `${bv}.jpg`)
    const img = await fetchBiliMedia(v.pic, { kind: 'image', headers: mediaHeaders })
    await saveCoverImage(img, cover)
    console.log(`\n===== ${bv} =====`)
    console.log(`标题: ${v.title}`)
    console.log(`UP: ${v.owner?.name} (mid ${v.owner?.mid})   播放=${v.stat?.view} 点赞=${v.stat?.like} 弹幕=${v.stat?.danmaku} 回复=${v.stat?.reply}`)
    console.log(`分区: ${v.tname}   时长=${v.duration}s   发布=${new Date(v.pubdate * 1000).toLocaleString('zh-CN')}`)
    console.log(`封面: ${cover}  (${(fs.statSync(cover).size / 1024).toFixed(0)} KiB)`)
    console.log(`简介: ${String(v.desc ?? '').slice(0, 400)}`)
  } catch (e) {
    console.log(`${bv}: 失败 ${e.message}`)
    process.exitCode = 1
  }
}
