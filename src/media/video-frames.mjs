/**
 * 基于 ffmpeg 的视频分段抽帧与多张固定格数拼图生成器。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)

export async function segmentFrames({ ffmpeg, url, times, directory, duration, run = execute }) {
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
        fs.rmSync(prefix + '-1.jpg', { force: true })
        try {
          const seekAt = attempt > 0 ? Math.max(0, start - 1.5) : start
          await run(ffmpeg, [
            '-y', '-loglevel', 'error',
            '-headers', 'Referer: https://www.bilibili.com/\r\nUser-Agent: Mozilla/5.0\r\n',
            '-ss', seekAt.toFixed(2), '-t', '1', '-i', url, '-an',
            '-vf', 'format=yuvj420p', '-frames:v', '1', '-q:v', '2', prefix + '-%d.jpg',
          ], { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 })
          const frame = prefix + '-1.jpg'
          if (!fs.existsSync(frame) || fs.statSync(frame).size === 0) throw Error('没有生成帧')
          fs.renameSync(frame, path.join(directory, 'f' + String(index).padStart(2, '0') + '.jpg'))
          success = true
        } catch { /* 分段抽帧失败时重试一次，仍失败则回退至完整下载后抽帧。 */ }
      }
      if (!success) errors.push(index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, times.length) }, worker))
  if (errors.length) throw Error('分段抽帧失败 ' + errors.length + '/' + times.length)
}
