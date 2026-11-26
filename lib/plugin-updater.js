import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { PLUGIN_ROOT, WHALE_HOME } from '../tools/lib/paths.mjs'

export const PLUGIN_REPO = 'Searchur/antigravity-bili-whale'
export const PLUGIN_REPO_URL = `https://github.com/${PLUGIN_REPO}`
const MAX_ZIP_BYTES = 50 * 1024 * 1024

const RUNTIME_PAYLOAD = [
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

export function compareSemver(a, b) {
  const parse = (v) => String(v ?? '').replace(/^v/i, '').split('.').map(n => Number.parseInt(n, 10) || 0)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

function updateStatePath(whaleHome = WHALE_HOME) {
  return path.join(whaleHome, 'plugin-update-state.json')
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

export function readLocalPluginMeta({ pluginRoot = PLUGIN_ROOT, whaleHome = WHALE_HOME } = {}) {
  const manifest = readJsonSafe(path.join(pluginRoot, 'plugin.json')) ?? {}
  const state = readJsonSafe(updateStatePath(whaleHome)) ?? {}
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

  let remoteManifest = manifestRes && !manifestRes.__error ? manifestRes : null
  if (!remoteManifest && !mainCommit && !release) {
    const errMsg = manifestRes?.__error?.message || '无法连接 GitHub，请检查网络或代理设置后重试。'
    throw new Error(errMsg)
  }

  const mainVersion = remoteManifest?.version || local.version
  const latestVersion = release && compareSemver(release.version, mainVersion) >= 0 ? release.version : mainVersion
  const targetRef = release && compareSemver(release.version, mainVersion) >= 0 ? release.tag : 'main'

  let status = 'up_to_date'
  let summary = `当前已是最新版本（v${local.version}）`
  if (compareSemver(latestVersion, local.version) > 0) {
    status = 'update_available'
    summary = `发现新版本 v${latestVersion}（当前 v${local.version}）`
  } else if (mainCommit?.sha && local.installedCommit && local.installedCommit !== mainCommit.sha) {
    status = 'commit_available'
    summary = `main 分支有新提交（${mainCommit.shortSha}：${mainCommit.message || '代码更新'}）`
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
    hasUpdate: status !== 'up_to_date',
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
 * 校验完整性后仅原地更新插件程序文件，绝不触碰独立数据目录中的任何用户数据。
 */
export async function applyPluginUpdate({
  pluginRoot = PLUGIN_ROOT,
  whaleHome = WHALE_HOME,
  fetchImpl = globalThis.fetch,
  extractZip = defaultExtractZipWindows,
  repo = PLUGIN_REPO,
  ref = 'main',
} = {}) {
  const local = readLocalPluginMeta({ pluginRoot, whaleHome })
  if (local.isGitCheckout) {
    throw new Error('当前插件目录属于 Git 开发仓库，请直接使用 git pull 更新，避免覆盖本地开发改动。')
  }

  const safeRef = /^[a-zA-Z0-9._/-]{1,80}$/.test(String(ref || 'main')) ? String(ref || 'main') : 'main'
  const latestCommit = await fetchCommitAtom(fetchImpl, repo, local.version).catch(() => null)
  const commitSha = safeRef === 'main' ? (latestCommit?.sha ?? null) : null

  const zipUrls = safeRef === 'main'
    ? [
        `https://codeload.github.com/${repo}/zip/refs/heads/main`,
        `https://github.com/${repo}/archive/refs/heads/main.zip`,
      ]
    : [
        `https://codeload.github.com/${repo}/zip/refs/tags/${encodeURIComponent(safeRef)}`,
        `https://codeload.github.com/${repo}/zip/refs/heads/${encodeURIComponent(safeRef)}`,
      ]

  const workDir = path.join(whaleHome, 'tmp', `update-${crypto.randomUUID()}`)
  const zipFile = path.join(workDir, 'update.zip')
  const extractDir = path.join(workDir, 'extracted')

  fs.mkdirSync(extractDir, { recursive: true })
  try {
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
        buf = Buffer.from(await res.arrayBuffer())
        break
      }
      lastStatus = res.status
    }
    if (!buf) throw new Error(friendlyHttpError(lastStatus || 502))
    if (buf.length < 1024) throw new Error('下载的更新包异常过小，已中止更新。')
    if (buf.length > MAX_ZIP_BYTES) throw new Error('下载的更新包超出 50MB 安全限制，已中止更新。')
    fs.writeFileSync(zipFile, buf)

    await extractZip(zipFile, extractDir)

    const srcRoot = findExtractedRoot(extractDir)
    if (!srcRoot) throw new Error('更新包中未找到 plugin.json，已中止覆盖。')

    const newManifest = readJsonSafe(path.join(srcRoot, 'plugin.json'))
    if (!newManifest || newManifest.name !== 'antigravity-bili-whale' || !newManifest.version) {
      throw new Error('更新包 plugin.json 校验失败（插件标识不匹配），已中止覆盖。')
    }
    const required = ['mcp/server.mjs', 'sidecars/whale/main.mjs', 'mcp/dist/app.html']
    for (const rel of required) {
      const p = path.join(srcRoot, rel)
      if (!fs.existsSync(p) || fs.statSync(p).size === 0) {
        throw new Error(`更新包缺少关键运行文件（${rel}），已中止覆盖。`)
      }
    }

    let updatedEntries = 0
    for (const entry of RUNTIME_PAYLOAD) {
      const from = path.join(srcRoot, entry)
      const to = path.join(pluginRoot, entry)
      if (!fs.existsSync(from)) continue
      fs.cpSync(from, to, { recursive: true, force: true })
      updatedEntries++
    }

    const updatedAt = new Date().toISOString()
    fs.mkdirSync(whaleHome, { recursive: true })
    fs.writeFileSync(updateStatePath(whaleHome), JSON.stringify({
      installedVersion: newManifest.version,
      installedCommit: commitSha,
      installedTag: safeRef === 'main' ? null : safeRef,
      updatedAt,
      source: usedUrl,
    }, null, 2) + '\n', 'utf8')

    return {
      ok: true,
      previousVersion: local.version,
      newVersion: newManifest.version,
      commitSha,
      shortSha: commitSha ? commitSha.slice(0, 7) : null,
      targetRef: safeRef,
      updatedEntries,
      updatedAt,
      requiresRestart: true,
      message: `已更新至 v${newManifest.version}${commitSha ? `（${commitSha.slice(0, 7)}）` : ''}！你的登录态、人设与记忆均保存在独立目录不受影响；请重启 Antigravity App（或在插件页停用再重新启用）以加载新版。`,
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}
