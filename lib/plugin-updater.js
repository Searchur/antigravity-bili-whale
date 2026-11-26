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

async function fetchJson(fetchImpl, url, { version = '1.0.0', timeoutMs = 12_000 } = {}) {
  const res = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `antigravity-bili-whale/${version}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (res.status === 404) return { ok: false, status: 404, data: null }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`GitHub 请求失败（HTTP ${res.status}）：${text.slice(0, 160)}`)
  }
  return { ok: true, status: res.status, data: await res.json() }
}

/**
 * 检查 GitHub 最新 Release 与 main 分支版本/提交状态。
 */
export async function checkForUpdate({
  pluginRoot = PLUGIN_ROOT,
  whaleHome = WHALE_HOME,
  fetchImpl = globalThis.fetch,
  repo = PLUGIN_REPO,
} = {}) {
  const local = readLocalPluginMeta({ pluginRoot, whaleHome })
  const apiBase = `https://api.github.com/repos/${repo}`

  const [releaseRes, commitRes, manifestRes] = await Promise.all([
    fetchJson(fetchImpl, `${apiBase}/releases/latest`, { version: local.version }).catch(() => ({ ok: false, status: 0, data: null })),
    fetchJson(fetchImpl, `${apiBase}/commits/main`, { version: local.version }),
    fetchJson(fetchImpl, `${apiBase}/contents/plugin.json?ref=main`, { version: local.version }),
  ])

  let remoteManifest = null
  if (manifestRes.ok && manifestRes.data?.content) {
    try {
      const decoded = Buffer.from(String(manifestRes.data.content).replace(/\s+/g, ''), 'base64').toString('utf8')
      remoteManifest = JSON.parse(decoded)
    } catch {}
  }

  const release = releaseRes.ok && releaseRes.data?.tag_name
    ? {
        tag: String(releaseRes.data.tag_name),
        version: String(releaseRes.data.tag_name).replace(/^v/i, ''),
        name: String(releaseRes.data.name || releaseRes.data.tag_name),
        url: String(releaseRes.data.html_url || `${PLUGIN_REPO_URL}/releases`),
        publishedAt: releaseRes.data.published_at || null,
        notes: String(releaseRes.data.body || '').slice(0, 1200),
        zipUrl: String(releaseRes.data.zipball_url || ''),
      }
    : null

  const mainCommit = commitRes.ok && commitRes.data?.sha
    ? {
        sha: String(commitRes.data.sha),
        shortSha: String(commitRes.data.sha).slice(0, 7),
        message: String(commitRes.data.commit?.message || '').split(/\r?\n/)[0].slice(0, 140),
        date: commitRes.data.commit?.committer?.date || commitRes.data.commit?.author?.date || null,
        url: String(commitRes.data.html_url || `${PLUGIN_REPO_URL}/commits/main`),
      }
    : null

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
      repository: PLUGIN_REPO_URL,
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
 * 本地一键更新：从 GitHub 下载最新版压缩包，校验完整性后仅原地更新插件程序文件，
 * 绝不触碰 %USERPROFILE%\.antigravity-bili-whale\ 中的任何用户个人数据。
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
  let commitSha = null
  try {
    const cRes = await fetchJson(fetchImpl, `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(safeRef)}`, { version: local.version })
    if (cRes.ok && cRes.data?.sha) commitSha = String(cRes.data.sha)
  } catch {}

  const zipUrl = `https://api.github.com/repos/${repo}/zipball/${encodeURIComponent(safeRef)}`
  const workDir = path.join(whaleHome, 'tmp', `update-${crypto.randomUUID()}`)
  const zipFile = path.join(workDir, 'update.zip')
  const extractDir = path.join(workDir, 'extracted')

  fs.mkdirSync(extractDir, { recursive: true })
  try {
    const res = await fetchImpl(zipUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `antigravity-bili-whale/${local.version}`,
      },
      signal: AbortSignal.timeout(90_000),
    })
    if (!res.ok) throw new Error(`下载更新包失败（HTTP ${res.status}），请检查网络后重试。`)
    const buf = Buffer.from(await res.arrayBuffer())
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
      source: zipUrl,
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
