/**
 * 将插件纯净部署到 Windows Antigravity 插件目录：
 *   %USERPROFILE%\.gemini\config\plugins\antigravity-bili-whale\
 *
 * 注意：Antigravity 扫描器会跳过 Windows 目录联接（Junction），必须部署为真实目录；
 * 自动排除 .git / node_modules / ui-src / test，保证下载即用、零运行时依赖。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const srcRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const pluginsRoot = path.join(process.env.USERPROFILE, '.gemini', 'config', 'plugins')
const dstRoot = path.join(pluginsRoot, 'antigravity-bili-whale')
const legacyDir = path.join(pluginsRoot, 'bili-whale')

const INCLUDE = [
  'plugin.json',
  'mcp_config.json',
  'package.json',
  'README.md',
  'VISION.md',
  'LIFE-STATE-CONTRACT.md',
  'LICENSE',
  'NOTICE.md',
  'assets',
  'skills',
  'sidecars',
  'mcp',
  'lib',
  'tools',
  'behavior',
  'stickers',
  'vendor',
]

function removeDirOrLink(target, { ignoreBusy = false } = {}) {
  if (!fs.existsSync(target)) return true
  try {
    const st = fs.lstatSync(target)
    if (st.isSymbolicLink()) {
      try { fs.rmdirSync(target) } catch { fs.unlinkSync(target) }
    } else {
      fs.rmSync(target, { recursive: true, force: true })
    }
    return true
  } catch (err) {
    if (ignoreBusy && (err?.code === 'EPERM' || err?.code === 'EBUSY')) return false
    throw err
  }
}

if (!removeDirOrLink(legacyDir, { ignoreBusy: true })) {
  console.warn(`[warn] 旧目录 ${legacyDir} 正被运行中的进程占用；请在 Antigravity 插件页停用旧版 bili-whale 后手动删除该目录。`)
}
if (!removeDirOrLink(dstRoot, { ignoreBusy: true })) {
  console.warn(`[warn] 目标目录 ${dstRoot} 正被运行中的进程占用，将直接覆盖更新文件。`)
}
fs.mkdirSync(dstRoot, { recursive: true })

for (const item of INCLUDE) {
  const from = path.join(srcRoot, item)
  const to = path.join(dstRoot, item)
  if (!fs.existsSync(from)) continue
  fs.cpSync(from, to, { recursive: true, force: true })
}

console.log(`Deployed clean zero-dep plugin -> ${dstRoot}`)
