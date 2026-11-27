import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { PLUGIN_ROOT, WHALE_HOME, configPath } from '../core/paths.mjs'
import { INSTALL_INFO, assertIndependentInstall, compareSemver, installPluginPayload } from './install.mjs'

export { compareSemver } from './install.mjs'

export const PLUGIN_REPO = 'Searchur/antigravity-bili-whale'
export const PLUGIN_REPO_URL = `https://github.com/${PLUGIN_REPO}`
const MAX_ZIP_BYTES = 50 * 1024 * 1024

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

export function readLocalPluginMeta({ pluginRoot = PLUGIN_ROOT, whaleHome = WHALE_HOME } = {}) {
  const manifest = readJsonSafe(path.join(pluginRoot, 'plugin.json')) ?? {}
  // New installation receipts are switched with the runtime payload. Accept a
  // matching legacy receipt for installs made by older plugin versions.
  const receipt = readJsonSafe(path.join(pluginRoot, INSTALL_INFO))
  const state = receipt?.installedVersion === manifest.version ? receipt : {}
  const isGitCheckout = fs.existsSync(path.join(pluginRoot, '.git'))
  return {
    name: manifest.name || 'antigravity-bili-whale',
    displayName: manifest.displayName || '哔哩哔哩大鲸鱼',
    version: manifest.version || '1.0.0',
    repository: manifest.repository || PLUGIN_REPO_URL,
    author: typeof manifest.author === 'string' ? manifest.author : (manifest.author?.name || 'Searchur'),
    pluginRoot,
    dataDir: whaleHome,
    isGitCheckout,
    installedCommit: state.installedCommit || null,
    installedTag: state.installedTag || null,
    updatedAt: state.updatedAt || null,
  }
}

function decodeXmlEntities(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

/**
 * 解析 GitHub commits/main.atom（公开 Atom 订阅源，不消耗 api.github.com 60 次/小时 IP 配额）。
 */
export function parseLatestCommitAtom(xml, repo = PLUGIN_REPO) {
  const entry = String(xml ?? '').match(/<entry>([\s\S]*?)<\/entry>/i)?.[1]
  if (!entry) return null
  const sha = entry.match(/Commit\/([0-9a-f]{40})/i)?.[1]
    || entry.match(/\/commit\/([0-9a-f]{40})/i)?.[1]
  if (!sha) return null
  const titleRaw = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ''
  const updated = entry.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i)?.[1]?.trim() || null
  const message = decodeXmlEntities(titleRaw).split(/\r?\n/)[0].slice(0, 140)
  return {
    sha,
    shortSha: sha.slice(0, 7),
    message,
    date: updated,
    url: `https://github.com/${repo}/commit/${sha}`,
  }
}

function friendlyHttpError(status, rawText = '') {
  const txt = String(rawText ?? '')
  if (status === 403 && /rate limit/i.test(txt)) {
    return 'GitHub 接口对当前出口 IP 触发了匿名限流（HTTP 403），可直接点击「本地一键更新」或稍后再试。'
  }
  if (status === 404) return '未找到对应的 GitHub 仓库或分支文件（HTTP 404）。'
  if (status >= 500) return `GitHub 服务暂时不可用（HTTP ${status}），请稍后重试。`
  return `连接 GitHub 失败（HTTP ${status}），请检查网络或代理设置后重试。`
}

async function fetchRawManifest(fetchImpl, repo, version) {
  const url = `https://raw.githubusercontent.com/${repo}/main/plugin.json`
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': `antigravity-bili-whale/${version}` },
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok) throw new Error(friendlyHttpError(res.status, await res.text().catch(() => '')))
  return res.json()
}

async function fetchCommitAtom(fetchImpl, repo, version) {
  const url = `https://github.com/${repo}/commits/main.atom`
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/atom+xml,text/xml', 'User-Agent': `antigravity-bili-whale/${version}` },
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok) return null
  return parseLatestCommitAtom(await res.text(), repo)
}

async function fetchLatestReleaseTag(fetchImpl, repo, version) {
  // 通过 GitHub 网页端 302 重定向获取最新 Release tag，完全不消耗 api.github.com 限流配额
  const url = `https://github.com/${repo}/releases/latest`
  try {
    const res = await fetchImpl(url, {
      redirect: 'manual',
      headers: { 'User-Agent': `antigravity-bili-whale/${version}` },
      signal: AbortSignal.timeout(10_000),
    })
    const loc = res.headers?.get?.('location') || ''
    const m = loc.match(/\/releases\/tag\/([^/?#]+)/)
    if (!m) return null
    const tag = decodeURIComponent(m[1])
    if (!/^v?\d+\.\d+\.\d+$/i.test(tag)) return null
    return {
      tag,
      version: tag.replace(/^v/i, ''),
      name: tag,
      url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`,
      publishedAt: null,
      notes: '',
    }
  } catch {
    return null
  }
}

async function readLimitedBody(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('GitHub 响应超出大小限制。')
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks = []
  let bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return Buffer.concat(chunks, bytes)
      bytes += value.byteLength
      if (bytes > maxBytes) throw new Error('GitHub 响应超出大小限制。')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

async function resolveTagCommit(fetchImpl, repo, tag) {
  try {
    const response = await fetchImpl(`https://github.com/${repo}.git/info/refs?service=git-upload-pack`, {
      headers: { 'Git-Protocol': 'version=1' },
      signal: AbortSignal.timeout(12_000),
    })
    if (!response.ok) return null
    const refs = await readLimitedBody(response, 5 * 1024 * 1024)
    let direct = null, peeled = null
    for (let offset = 0; offset < refs.length;) {
      const header = refs.toString('ascii', offset, offset + 4)
      if (!/^[0-9a-f]{4}$/i.test(header)) return null
      const length = Number.parseInt(header, 16)
      if (length === 0) { offset += 4; continue }
      if (length < 4 || offset + length > refs.length) return null
      const line = refs.toString('utf8', offset + 4, offset + length).trimEnd()
      if (offset === 0 && line !== '# service=git-upload-pack') return null
      const match = /^([0-9a-f]{40}) refs\/tags\/([^\x00]+)$/i.exec(line)
      if (match?.[2] === tag) direct = match[1].toLowerCase()
      if (match?.[2] === `${tag}^{}`) peeled = match[1].toLowerCase()
      offset += length
    }
    return peeled ?? direct
  } catch {
    return null
  }
}

/**
 * 检查 GitHub 最新版本与最新提交状态：
 * 全程优先走 raw.githubusercontent.com + commits/main.atom + releases/latest 重定向，
 * 零消耗 api.github.com 匿名 IP 配额，彻底避免共享代理/VPN 触发 HTTP 403 Rate Limit。
 */
export async function checkForUpdate({
  pluginRoot = PLUGIN_ROOT,
  whaleHome = WHALE_HOME,
  fetchImpl = globalThis.fetch,
  repo = PLUGIN_REPO,
} = {}) {
  const local = readLocalPluginMeta({ pluginRoot, whaleHome })

  const [manifestRes, mainCommit, release] = await Promise.all([
    fetchRawManifest(fetchImpl, repo, local.version).catch(err => ({ __error: err })),
    fetchCommitAtom(fetchImpl, repo, local.version).catch(() => null),
    fetchLatestReleaseTag(fetchImpl, repo, local.version).catch(() => null),
  ])

  const remoteManifest = manifestRes?.name === local.name && /^\d+\.\d+\.\d+$/.test(manifestRes.version)
    ? manifestRes : null
  if (!remoteManifest && !mainCommit && !release) {
    const errMsg = manifestRes?.__error?.message || '无法连接 GitHub，请检查网络或代理设置后重试。'
    throw new Error(errMsg)
  }

  const mainVersion = remoteManifest?.version ?? null
  const latestVersion = release && compareSemver(release.version, mainVersion) >= 0 ? release.version : mainVersion
  let targetRef = release && compareSemver(release.version, mainVersion) >= 0 ? release.tag : 'main'

  let status = 'incomplete'
  let summary = '缺少可比较的版本或提交信息，暂时无法确认是否已是最新。'
  if (compareSemver(latestVersion, local.version) > 0) {
    status = 'update_available'
    summary = `发现新版本 v${latestVersion}（当前 v${local.version}）`
  } else if (mainVersion && compareSemver(mainVersion, local.version) < 0) {
    status = release ? 'up_to_date' : 'incomplete'
    summary = `当前安装版本 v${local.version} 高于 main 分支版本 v${mainVersion}。`
      + (release ? '' : '未取得 Release 信息，暂时无法确认最新发布版本。')
  } else if (mainCommit?.sha) {
    const baselineTag = local.installedTag || (release?.version === local.version ? release.tag : null)
    const baseline = local.installedCommit || (baselineTag && await resolveTagCommit(fetchImpl, repo, baselineTag))
    if (baseline && baseline !== mainCommit.sha) {
      status = 'commit_available'
      targetRef = 'main'
      summary = `main 分支有新提交（${mainCommit.shortSha}：${mainCommit.message || '代码更新'}）`
    } else if (baseline === mainCommit.sha) {
      status = 'up_to_date'
      summary = '当前安装与远端 main 提交一致。'
    }
  }

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    local,
    remote: {
      latestVersion,
      mainVersion,
      targetRef,
      release,
      mainCommit,
      repository: `https://github.com/${repo}`,
    },
    status,
    hasUpdate: status === 'update_available' || status === 'commit_available',
    summary,
  }
}

function defaultExtractZipWindows(zipFile, destDir) {
  return new Promise((resolve, reject) => {
    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const escapedZip = zipFile.replace(/'/g, "''")
    const escapedDest = destDir.replace(/'/g, "''")
    execFile(psExe, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${escapedZip}' -DestinationPath '${escapedDest}' -Force`,
    ], { windowsHide: true, timeout: 90_000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`解压更新包失败：${String(stderr || err.message).trim().slice(0, 240)}`))
      else resolve()
    })
  })
}

function findExtractedRoot(dir) {
  if (fs.existsSync(path.join(dir, 'plugin.json'))) return dir
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    const candidate = path.join(dir, ent.name)
    if (fs.existsSync(path.join(candidate, 'plugin.json'))) return candidate
  }
  return null
}

/**
 * 本地一键更新：直接从 codeload.github.com 下载最新版 ZIP（不消耗 GitHub API 限流配额），
 * 校验完整的运行目录后切换程序版本，失败时恢复旧版本。
 */
export async function applyPluginUpdate({
  pluginRoot = PLUGIN_ROOT,
  whaleHome = WHALE_HOME,
  cfgFile,
  fetchImpl = globalThis.fetch,
  extractZip = defaultExtractZipWindows,
  repo = PLUGIN_REPO,
  ref = 'main',
} = {}) {
  const local = readLocalPluginMeta({ pluginRoot, whaleHome })
  if (local.isGitCheckout) {
    throw new Error('当前插件目录属于 Git 开发仓库，请直接使用 git pull 更新，避免覆盖本地开发改动。')
  }
  const resolvedCfgFile = cfgFile ?? (whaleHome === WHALE_HOME ? configPath : path.join(whaleHome, 'config.json'))
  const dataPaths = [whaleHome, resolvedCfgFile]
  assertIndependentInstall(pluginRoot, dataPaths)

  const safeRef = String(ref || 'main')
  if (safeRef !== 'main' && !/^v?\d+\.\d+\.\d+$/i.test(safeRef)) throw new Error('更新目标必须是 main 或有效的版本标签。')
  const commitSha = safeRef === 'main'
    ? (await fetchCommitAtom(fetchImpl, repo, local.version).catch(() => null))?.sha ?? null
    : await resolveTagCommit(fetchImpl, repo, safeRef)

  const zipUrls = commitSha ? [`https://codeload.github.com/${repo}/zip/${commitSha}`] : safeRef === 'main'
    ? [
        `https://codeload.github.com/${repo}/zip/refs/heads/main`,
        `https://github.com/${repo}/archive/refs/heads/main.zip`,
      ]
    : [`https://codeload.github.com/${repo}/zip/refs/tags/${encodeURIComponent(safeRef)}`]

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-whale-update-'))
  const zipFile = path.join(workDir, 'update.zip')
  const extractDir = path.join(workDir, 'extracted')

  try {
    fs.mkdirSync(extractDir)
    let buf = null
    let usedUrl = zipUrls[0]
    let lastStatus = 0
    for (const url of zipUrls) {
      usedUrl = url
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': `antigravity-bili-whale/${local.version}` },
        signal: AbortSignal.timeout(90_000),
      })
      if (res.ok) {
        buf = await readLimitedBody(res, MAX_ZIP_BYTES)
        break
      }
      lastStatus = res.status
    }
    if (!buf) throw new Error(friendlyHttpError(lastStatus || 502))
    if (buf.length < 1024) throw new Error('下载的更新包异常过小，已中止更新。')
    fs.writeFileSync(zipFile, buf)

    await extractZip(zipFile, extractDir)

    const srcRoot = findExtractedRoot(extractDir)
    if (!srcRoot) throw new Error('更新包中未找到 plugin.json，已中止安装。')
    const newVersion = readJsonSafe(path.join(srcRoot, 'plugin.json'))?.version
    if (safeRef !== 'main' && newVersion !== safeRef.replace(/^v/i, '')) {
      throw new Error('更新包版本与选定的发布标签不一致。')
    }

    const updatedAt = new Date().toISOString()
    const { manifest, updatedEntries } = await installPluginPayload({
      source: srcRoot,
      destination: pluginRoot,
      dataPaths,
      allowDowngrade: false,
      metadata: { installedCommit: commitSha, installedTag: safeRef === 'main' ? null : safeRef, updatedAt, source: usedUrl },
    })

    return {
      ok: true,
      previousVersion: local.version,
      newVersion: manifest.version,
      commitSha,
      shortSha: commitSha ? commitSha.slice(0, 7) : null,
      targetRef: safeRef,
      updatedEntries,
      updatedAt,
      requiresRestart: true,
      message: `已更新至 v${manifest.version}${commitSha ? `（${commitSha.slice(0, 7)}）` : ''}。请重启 Antigravity App（或在插件页停用再重新启用）以加载新版。`,
    }
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }) }
    catch (error) { console.warn(`更新临时目录清理失败：${workDir}（${error.code}）`) }
  }
}
