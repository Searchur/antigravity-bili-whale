/**
 * 构建纯净零依赖 GitHub Release 运行压缩包：
 * - 包名格式：antigravity-bili-whale-v<version>-<YYYYMMDD>.zip（日期按北京时间 Asia/Shanghai）
 * - 包内顶层文件夹统一固定为：antigravity-bili-whale/（不含版本号和日期，解压即用）
 * - 仅包含 RUNTIME_PAYLOAD 运行时文件与 .whale-install.json，不含 .git / node_modules / test / web / scripts / AGENTS.md。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { INSTALL_INFO, RUNTIME_PAYLOAD, validatePluginPayload } from '../src/plugin/install.mjs'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

export function formatBeijingDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now instanceof Date ? now : new Date(now))
  const get = (type) => parts.find(p => p.type === type)?.value || '00'
  return `${get('year')}${get('month')}${get('day')}`
}

function createZipFromFolder(stagingParent, folderName, zipFile) {
  fs.mkdirSync(path.dirname(zipFile), { recursive: true })
  fs.rmSync(zipFile, { force: true })
  if (process.platform === 'win32') {
    const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    execFileSync(fs.existsSync(tarExe) ? tarExe : 'tar.exe', [
      '-a',
      '-c',
      '-f',
      zipFile,
      '-C',
      stagingParent,
      folderName,
    ], { windowsHide: true, stdio: 'pipe', timeout: 120_000 })
  } else {
    execFileSync('zip', ['-r', '-q', zipFile, folderName], {
      cwd: stagingParent,
      stdio: 'pipe',
      timeout: 120_000,
    })
  }
}

export function packageRelease({
  rootDir = REPO_ROOT,
  outDir = path.join(os.tmpdir(), 'antigravity-bili-whale-release'),
  now = new Date(),
  tag = null,
  commitSha = null,
} = {}) {
  const manifest = validatePluginPayload(rootDir)
  const version = manifest.version
  const folderName = manifest.name // 固定为 antigravity-bili-whale
  const dateStr = formatBeijingDate(now)
  const zipName = `${folderName}-v${version}-${dateStr}.zip`
  const resolvedOut = path.resolve(outDir)
  const zipPath = path.join(resolvedOut, zipName)

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-whale-pkg-'))
  try {
    const stagedRoot = path.join(workDir, folderName)
    fs.mkdirSync(stagedRoot, { recursive: true })
    for (const entry of RUNTIME_PAYLOAD) {
      fs.cpSync(path.join(rootDir, entry), path.join(stagedRoot, entry), { recursive: true, verbatimSymlinks: true })
    }
    const installMeta = {
      installedVersion: version,
      installedTag: tag || `v${version}`,
      installedCommit: commitSha || null,
      updatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
      source: 'github-release',
    }
    fs.writeFileSync(path.join(stagedRoot, INSTALL_INFO), JSON.stringify(installMeta, null, 2) + '\n', 'utf8')
    validatePluginPayload(stagedRoot)
    createZipFromFolder(workDir, folderName, zipPath)
    const size = fs.statSync(zipPath).size
    if (size < 1024) throw new Error(`生成的压缩包异常过小（${size} 字节）`)
    return { zipPath, zipName, folderName, version, dateStr, size }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2)
  const getOpt = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
  }
  const outDir = getOpt('--out-dir') || path.join(os.tmpdir(), 'antigravity-bili-whale-release')
  const tag = getOpt('--tag')
  const commitSha = getOpt('--commit')
  const result = packageRelease({ outDir, tag, commitSha })
  if (argv.includes('--print-path')) console.log(result.zipPath)
  else console.log(JSON.stringify(result, null, 2))
}
