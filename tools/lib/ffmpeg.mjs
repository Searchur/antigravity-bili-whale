/**
 * Windows ffmpeg 定位与插件内一键安装助手。
 *
 * 查找顺序：
 *   1. 环境变量 FFMPEG
 *   2. PATH 中的 ffmpeg.exe
 *   3. <PLUGIN_ROOT>\bin\ffmpeg.exe
 *   4. %USERPROFILE%\.antigravity-bili-whale\bin\ffmpeg.exe（插件一键安装落点）
 *   5. 本机 WinGet Packages 目录（防止安装后尚未重开进程导致 PATH 未刷新）
 *   6. 本机剪映自带 ffmpeg.exe（便利兜底）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from './capture.mjs'
import { PLUGIN_ROOT, binPath } from './paths.mjs'

const EXE = 'ffmpeg.exe'
const PORTABLE_ZIP_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'

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
    '找不到 ffmpeg（抽帧看画面需要它；纯文字浏览不需要）。任选一种解决：',
    '  ① 在左侧栏「哔哩哔哩大鲸鱼」→「运行与体检」点「一键安装 ffmpeg」',
    '  ② 在终端执行：winget install -e --id Gyan.FFmpeg',
    `  ③ 手动把 ffmpeg.exe 放到 ${path.join(binPath, EXE)} 或设置环境变量 FFMPEG`,
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

/**
 * 插件内一键安装 ffmpeg（优先便携下载到 %USERPROFILE%\.antigravity-bili-whale\bin\ffmpeg.exe，
 * 不修改系统 PATH、不需管理员权限、立即可用；若已存在则直接返回）。
 */
export async function installFfmpeg({ force = false, url = PORTABLE_ZIP_URL } = {}) {
  if (!force) {
    const existing = ffmpegInfo()
    if (existing.ok) return { ok: true, alreadyInstalled: true, ...existing }
  }
  fs.mkdirSync(binPath, { recursive: true })
  const targetExe = path.join(binPath, EXE)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-ffmpeg-'))
  const zipFile = path.join(tmpDir, 'ffmpeg.zip')
  const extractDir = path.join(tmpDir, 'out')

  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) })
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 1024 * 1024) throw new Error('下载文件体积异常，已中止安装')
    fs.writeFileSync(zipFile, buf)

    execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Expand-Archive -LiteralPath '${zipFile.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
    ], { encoding: 'utf8', timeout: 180_000 })

    // Recursively find ffmpeg.exe in extracted archive
    const stack = [extractDir]
    let found = null
    while (stack.length && !found) {
      const dir = stack.pop()
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name)
        if (ent.isDirectory()) stack.push(full)
        else if (ent.name.toLowerCase() === EXE) { found = full; break }
      }
    }
    if (!found) throw new Error('压缩包内未找到 ffmpeg.exe')
    const tmpExe = `${targetExe}.${process.pid}.tmp`
    fs.copyFileSync(found, tmpExe)
    fs.renameSync(tmpExe, targetExe)
    const info = ffmpegInfo()
    if (!info.ok) throw new Error('ffmpeg.exe 已解压但校验运行失败：' + (info.error ?? ''))
    return { ok: true, alreadyInstalled: false, ...info }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
}
