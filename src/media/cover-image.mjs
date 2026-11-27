/**
 * 视频封面安全下载与像素校验器：校验 HTTP 响应与图像解码有效性后再更新本地缓存。
 */
import fs from 'node:fs'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { ffmpegPath } from './ffmpeg.mjs'
import { renameWithRetry } from '../core/atomic-json.mjs'

// 即使未安装可选视频工具，Windows 也内置 WIC 图像解码能力。
// 分条带解码校验像素，避免额外分配整张大图内存。
const decodeWindowsImage = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore
$stream = [IO.File]::OpenRead($env:WHALE_COVER_INPUT)
try {
  $decoder = [Windows.Media.Imaging.BitmapDecoder]::Create($stream, 'PreservePixelFormat', 'OnLoad')
  $frame = $decoder.Frames[0]
  if ($frame.PixelWidth * [long]$frame.PixelHeight -gt 64000000) { throw 'cover dimensions too large' }
  $stride = [int][Math]::Ceiling($frame.PixelWidth * $frame.Format.BitsPerPixel / 8.0)
  $rows = [Math]::Min(32, $frame.PixelHeight)
  $pixels = New-Object byte[] ($stride * $rows)
  for ($y = 0; $y -lt $frame.PixelHeight; $y += $rows) {
    $rect = New-Object Windows.Int32Rect(0, $y, $frame.PixelWidth, [Math]::Min($rows, $frame.PixelHeight - $y))
    $frame.CopyPixels($rect, $pixels, $stride, 0)
  }
} finally { $stream.Dispose() }`

export async function saveCoverImage(response, target) {
  if (!response.ok) throw Error('封面下载失败，HTTP ' + response.status)
  const temp = target + '.' + crypto.randomUUID() + '.tmp'
  const limit = 16 * 1024 * 1024
  const chunks = []
  let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > limit) throw Error('封面超过16MiB')
    chunks.push(chunk)
  }
  const data = Buffer.concat(chunks, bytes)
  const type = data.toString('latin1', 0, 12)
  if (!(data[0] === 0xff && data[1] === 0xd8 || type.startsWith('\x89PNG\r\n\x1a\n') ||
        type.startsWith('GIF87a') || type.startsWith('GIF89a') || type.startsWith('RIFF') && type.endsWith('WEBP'))) {
    throw Error('封面不是支持的图片')
  }
  const options = { timeout: 15000, windowsHide: true, stdio: ['ignore','ignore','pipe'] }
  try {
    fs.writeFileSync(temp, data, { flag: 'wx' })
    const ffmpeg = ffmpegPath()
    if (ffmpeg || process.platform !== 'win32') {
      execFileSync(ffmpeg || 'ffmpeg', ['-v','error','-xerror','-protocol_whitelist','file','-i',temp,'-frames:v','1','-f','null','-'], options)
    } else {
      execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',decodeWindowsImage],
        { ...options, env: { ...process.env, WHALE_COVER_INPUT: temp } })
    }
    renameWithRetry(temp, target)
  } finally { fs.rmSync(temp, { force: true }) }
}

