/**
 * 基于 ffmpeg 的视频分段抽帧，通过短时环回连接让网络读取受同一媒体边界保护。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { biliMediaUrl, fetchBiliMedia, isBiliMediaRange, limitMediaBytes, parseBiliMediaContentRange } from '../bili/media.mjs'

const execute = promisify(execFile)
const LOOPBACK = '127.0.0.1'
const DEFAULT_HEADERS = { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' }
const FRAME_TIMEOUT_MS = 20_000
export const VIDEO_DEMUXERS = 'flv,mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,mpegts,mpeg,avi'

function sendStatus(response, status) {
  response.statusCode = status
  response.end()
}

function coversRequestedRange(range, requestRange) {
  if (!requestRange) return range.start === 0
  const [start, end] = requestRange.slice('bytes='.length).split('-')
  if (!start) return range.start === Math.max(0, range.total - Number(end))
  return range.start === Number(start) && (!end || range.end <= Number(end))
}

async function relayVideo(request, response, { target, transport, range }) {
  const disconnected = new AbortController()
  const onClose = () => { if (!response.writableFinished) disconnected.abort() }
  response.once('close', onClose)
  const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(FRAME_TIMEOUT_MS)])
  const headers = new Headers(DEFAULT_HEADERS)
  if (range) headers.set('range', range)
  let upstream
  try {
    upstream = await fetchBiliMedia(target, { kind: 'video', method: request.method, headers, signal, transport })
    if (upstream.status >= 400 && upstream.status <= 599) return sendStatus(response, upstream.status)
    if (upstream.status !== 200 && upstream.status !== 206) throw Error()
    const contentType = upstream.headers.get('content-type')
    const contentLength = upstream.headers.get('content-length')
    const contentEncoding = upstream.headers.get('content-encoding')
    if (contentEncoding && contentEncoding.toLowerCase() !== 'identity') throw Error()
    let length = contentLength === null ? null : Number(contentLength)
    if (length !== null && (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(length))) throw Error()
    const outputHeaders = {}
    if (contentType) outputHeaders['content-type'] = contentType
    if (upstream.headers.get('accept-ranges') === 'bytes') outputHeaders['accept-ranges'] = 'bytes'
    if (upstream.status === 206) {
      const contentRange = upstream.headers.get('content-range')
      const parsed = parseBiliMediaContentRange(contentRange)
      if (!parsed || !coversRequestedRange(parsed, range) || (length !== null && length !== parsed.length)) throw Error()
      length = parsed.length
      outputHeaders['content-range'] = contentRange
      outputHeaders['accept-ranges'] = 'bytes'
    }
    if (length !== null) outputHeaders['content-length'] = length
    if (request.method === 'GET' && !upstream.body) throw Error()
    response.writeHead(upstream.status, outputHeaders)
    if (request.method === 'HEAD') return response.end()
    const stream = limitMediaBytes(Readable.fromWeb(upstream.body), length ?? Infinity, length !== null)
    await pipeline(stream, response, { signal })
  } catch {
    if (!response.destroyed) {
      if (response.headersSent) response.destroy()
      else sendStatus(response, 502)
    }
  } finally {
    response.removeListener('close', onClose)
    if (upstream?.body && !upstream.body.locked) await upstream.body.cancel().catch(() => {})
  }
}

async function startVideoRelay(url, transport) {
  const target = biliMediaUrl(url, 'video')
  const route = '/' + randomUUID()
  const server = createServer({ headersTimeout: 5_000, requestTimeout: FRAME_TIMEOUT_MS }, (request, response) => {
    if (request.url !== route || request.headers.host !== LOOPBACK + ':' + server.address()?.port) {
      return sendStatus(response, 404)
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return sendStatus(response, 405)
    const range = request.headers.range
    if (range !== undefined && !isBiliMediaRange(range)) return sendStatus(response, 416)
    void relayVideo(request, response, { target, transport, range })
  })
  server.listen(0, LOOPBACK)
  await once(server, 'listening')
  return {
    url: `http://${LOOPBACK}:${server.address().port}${route}`,
    close: () => new Promise(resolve => {
      server.close(resolve)
      server.closeAllConnections()
    }),
  }
}

export async function segmentFrames({ ffmpeg, url, times, directory, duration, run = execute, transport }) {
  if (!times.length) return
  const relay = await startVideoRelay(url, transport)
  const env = { ...process.env, HTTP_PROXY: '', http_proxy: '' }
  let next = 0
  const errors = []
  const concurrency = duration < 300 ? 1 : 3
  async function worker() {
    while (next < times.length) {
      const index = next++
      const prefix = path.join(directory, 'segment-' + index)
      const start = Math.max(0, Number(times[index]) || 0)
      let success = false
      for (let attempt = 0; attempt < 2 && !success; attempt++) {
        try {
          fs.rmSync(prefix + '-1.jpg', { force: true })
          const seekAt = attempt > 0 ? Math.max(0, start - 1.5) : start
          await run(ffmpeg, [
            '-y', '-loglevel', 'error',
            '-protocol_whitelist', 'http,tcp', '-format_whitelist', VIDEO_DEMUXERS,
            '-ss', seekAt.toFixed(2), '-t', '1', '-i', relay.url, '-an',
            '-vf', 'format=yuvj420p', '-frames:v', '1', '-q:v', '2', prefix + '-%d.jpg',
          ], { windowsHide: true, timeout: FRAME_TIMEOUT_MS, maxBuffer: 1024 * 1024, env })
          const frame = prefix + '-1.jpg'
          if (!fs.existsSync(frame) || fs.statSync(frame).size === 0) throw Error('没有生成帧')
          fs.renameSync(frame, path.join(directory, 'f' + String(index).padStart(2, '0') + '.jpg'))
          success = true
        } catch { /* 分段抽帧失败时重试一次，仍失败则回退至完整下载后抽帧。 */ }
      }
      if (!success) errors.push(index)
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, times.length) }, worker))
    if (errors.length) throw Error('分段抽帧失败 ' + errors.length + '/' + times.length)
  } finally { await relay.close() }
}
