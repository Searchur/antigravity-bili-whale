/**
 * 定位 Windows 上已安装的 ffmpeg 可执行文件。
 *
 * 查找顺序：
 *   1. 环境变量 FFMPEG
 *   2. PATH 中的 ffmpeg.exe
 *   3. <PLUGIN_ROOT>\bin\ffmpeg.exe
 *   4. %USERPROFILE%\.antigravity-bili-whale\bin\ffmpeg.exe
 *   5. 本机 WinGet Packages 目录（防止安装后尚未重开进程导致 PATH 未刷新）
 *   6. 本机剪映自带 ffmpeg.exe（便利兜底）
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from '../core/capture.mjs'
import { PLUGIN_ROOT, binPath } from '../core/paths.mjs'

const EXE = 'ffmpeg.exe'

const exists = (f) => {
  if (!f) return false
  try { return fs.statSync(f).isFile() } catch { return false }
}

function onPath() {
  for (const d of (process.env.PATH || '').split(';')) {
    if (!d) continue
    const f = path.join(d.replace(/^"|"$/g, ''), EXE)
    if (exists(f)) return f
  }
  return null
}

function wingetCopies() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages')
  const hits = []
  try {
    for (const pkg of fs.readdirSync(base)) {
      if (!/ffmpeg/i.test(pkg)) continue
      const pkgDir = path.join(base, pkg)
      const direct = path.join(pkgDir, 'bin', EXE)
      if (exists(direct)) hits.push(direct)
      try {
        for (const sub of fs.readdirSync(pkgDir)) {
          const nested = path.join(pkgDir, sub, 'bin', EXE)
          if (exists(nested)) hits.push(nested)
        }
      } catch {}
    }
  } catch {}
  return hits
}

function jianyingCopies() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'JianyingPro', 'Apps')
  try {
    return fs.readdirSync(base)
      .map((v) => path.join(base, v, EXE))
      .filter(exists)
  } catch { return [] }
}

export function ffmpegPath() {
  const cands = [
    process.env.FFMPEG,
    onPath(),
    path.join(PLUGIN_ROOT, 'bin', EXE),
    path.join(binPath, EXE),
    ...wingetCopies(),
    ...jianyingCopies(),
  ]
  return cands.find(exists) ?? null
}

export function requireFfmpeg() {
  const p = ffmpegPath()
  if (p) return p
  throw new Error([
    '找不到 ffmpeg。视频抽帧看画面需要 ffmpeg（未安装时仅能读取字幕/弹幕/热评，无法查看画面）。',
    '可在终端运行 winget install -e --id Gyan.FFmpeg 自行安装。',
    `也可把 ffmpeg.exe 放到 ${path.join(binPath, EXE)}，或用环境变量 FFMPEG 指定可执行文件。`,
  ].join('\n'))
}

export function ffmpegInfo() {
  const p = ffmpegPath()
  if (!p) return { ok: false, path: null, version: null }
  try {
    const out = execFileSync(p, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 15000 })
    return { ok: true, path: p, version: (out.split('\n')[0] || '').trim() }
  } catch (e) {
    return { ok: false, path: p, version: null, error: String(e.message).slice(0, 120) }
  }
}
