/**
 * B 站视频流下载器：按时长与清晰度上限将视频下载至本地临时目录供抽帧使用。
 */
import fs from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { fetchBiliMedia, limitMediaBytes, parseBiliMediaContentRange } from '../bili/media.mjs'

export async function downloadVideo(source, file, { headers, fetch: transport, timeoutMs = 60_000 } = {}) {
  const candidates = [...new Set([source.url, ...(source.backup_url ?? [])].filter(Boolean))]
  const expected = Number(source.size) || 0
  const requestHeaders = new Headers(headers)
  let attempts = 0
  for (const url of candidates) {
    fs.rmSync(file, {force:true})
    let total = expected
    for (let retry=0; retry<3; retry++) {
      attempts++
      const have = fs.existsSync(file) ? fs.statSync(file).size : 0
      let response
      try {
        const signal = AbortSignal.timeout(timeoutMs)
        requestHeaders.set('range', 'bytes=' + have + '-')
        response = await fetchBiliMedia(url, {
          kind: 'video', headers: requestHeaders, signal, transport,
        })
        if (!response.ok || !response.body) throw Error('下载响应无效')
        const encoding = response.headers.get('content-encoding')
        if (encoding && encoding.toLowerCase() !== 'identity') throw Error('视频响应使用了不支持的内容编码')
        let chunkLimit
        if (response.status === 206) {
          const range = parseBiliMediaContentRange(response.headers.get('content-range'))
          if (!range || range.start !== have) throw Error('续传范围不一致')
          if (total && range.total !== total) {
            fs.rmSync(file, { force: true })
            total = expected
            throw Error('续传总长度发生变化')
          }
          total = range.total
          chunkLimit = range.length
        } else if (response.status !== 200) throw Error('不支持的下载响应')
        else total = expected || Number(response.headers.get('content-length')) || 0
        const body = limitMediaBytes(Readable.fromWeb(response.body), chunkLimit ?? (total || Infinity))
        const flags = response.status === 206 && have > 0 ? 'a' : 'w'
        await pipeline(body, fs.createWriteStream(file, { flags }), { signal })
        const size = fs.statSync(file).size
        if (size > 0 && (!total || size === total)) return {size, attempts}
      } catch {
        // 断点续传仅在后续响应确认 Range 合法后才允许继续。
      } finally {
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {})
      }
    }
  }
  fs.rmSync(file, {force:true})
  throw Error('视频下载失败，已尝试 ' + candidates.length + ' 个接口提供的地址；未获得完整文件')
}
