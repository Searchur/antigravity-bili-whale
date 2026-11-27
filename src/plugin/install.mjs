import fs from 'node:fs'
import path from 'node:path'
import { acquireProcessLock } from '../core/process-lock.mjs'
import { validateHostImports } from './module-check.mjs'

export const INSTALL_INFO = '.whale-install.json'

export const RUNTIME_FILES = [
  'plugin.json', 'mcp_config.json', 'package.json', 'README.md', 'LICENSE', 'NOTICE.md',
]
export const RUNTIME_DIRS = ['assets', 'behavior', 'dist', 'docs', 'sidecars', 'skills', 'src', 'stickers']
export const RUNTIME_PAYLOAD = [...RUNTIME_FILES, ...RUNTIME_DIRS]

export const ENTRY_POINTS = [
  'assets/logo.png', 'skills/antigravity-bili-whale/SKILL.md',
  'src/mcp/server.mjs', 'src/mcp/app-tools.mjs', 'src/mcp/model-tools.mjs', 'dist/app.html',
  'sidecars/whale/sidecar.json', 'sidecars/whale/main.mjs',
  'src/console/api-handlers.mjs', 'src/daemon/scheduler.mjs', 'src/cli/bili.mjs',
  'behavior/index.md', 'stickers/index.json', 'src/vendor/qrcode/qrcode.mjs',
]

export function compareSemver(a, b) {
  const parts = value => String(value ?? '').replace(/^v/i, '').split('.').map(n => Number.parseInt(n, 10) || 0)
  const left = parts(a), right = parts(b)
  for (let i = 0; i < Math.max(left.length, right.length, 3); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

function statIfPresent(file) {
  try { return fs.lstatSync(file) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

function validateEntry(file, root, directory = false, files) {
  const stat = statIfPresent(file)
  if (stat && !stat.isSymbolicLink()) {
    if (!directory && stat.isFile() && stat.size > 0) {
      files?.add(path.relative(root, file).split(path.sep).join('/'))
      return
    }
    if (directory && stat.isDirectory()) {
      const entries = fs.readdirSync(file, { withFileTypes: true })
      if (entries.length) {
        for (const entry of entries) validateEntry(path.join(file, entry.name), root, entry.isDirectory(), files)
        return
      }
    }
  }
  throw new Error(`插件运行文件或目录缺失、为空或类型无效：${path.relative(root, file)}`)
}

export function validatePluginPayload(root) {
  const files = new Set()
  for (const entry of RUNTIME_FILES) validateEntry(path.join(root, entry), root, false, files)
  for (const entry of RUNTIME_DIRS) validateEntry(path.join(root, entry), root, true, files)
  for (const entry of ENTRY_POINTS) validateEntry(path.join(root, entry), root)

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'))
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  if (manifest.name !== 'antigravity-bili-whale' || pkg.name !== manifest.name
      || !/^\d+\.\d+\.\d+$/.test(manifest.version) || pkg.version !== manifest.version || pkg.type !== 'module') {
    throw new Error('插件清单与程序包的名称、版本或模块类型不一致')
  }
  if (pkg.whaleRuntimeFiles !== undefined) {
    if (!Array.isArray(pkg.whaleRuntimeFiles)) throw Error('插件运行文件清单格式无效')
    for (const name of pkg.whaleRuntimeFiles) {
      if (!files.delete(name)) throw Error('插件运行文件缺失或清单项目重复：' + name)
    }
    if (files.size) throw Error('插件运行文件没有列入版本清单：' + [...files].join('、'))
  }
  const mcp = JSON.parse(fs.readFileSync(path.join(root, 'mcp_config.json'), 'utf8'))
  const sidecar = JSON.parse(fs.readFileSync(path.join(root, 'sidecars/whale/sidecar.json'), 'utf8'))
  if (mcp.mcpServers?.whale?.args?.[0] !== '${PLUGIN_ROOT}/src/mcp/server.mjs' || sidecar.args?.[0] !== 'main.mjs') {
    throw new Error('插件清单的MCP或Sidecar入口无效')
  }
  validateHostImports(root)
  return manifest
}

function canonicalPath(file) {
  const resolved = path.resolve(file)
  const parent = path.dirname(resolved)
  if (statIfPresent(resolved) || parent === resolved) return fs.realpathSync(resolved)
  return path.join(canonicalPath(parent), path.basename(resolved))
}

function contains(root, file) {
  const relative = path.relative(root, file)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

export function assertIndependentInstall(destination, dataPaths) {
  const target = canonicalPath(destination)
  for (const item of dataPaths) {
    if (contains(target, canonicalPath(item))) throw new Error('插件安装目录包含用户数据，请将安装目录和用户数据目录分开后重试。')
  }
}

const LOCK_ERR_CODES = new Set(['EACCES', 'EBUSY', 'EPERM'])

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function syncDirectoryInPlace(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true })
  const srcEntries = fs.readdirSync(srcDir, { withFileTypes: true })
  const srcNames = new Set(srcEntries.map(e => e.name))
  for (const dstEnt of fs.readdirSync(dstDir, { withFileTypes: true })) {
    if (!srcNames.has(dstEnt.name)) {
      fs.rmSync(path.join(dstDir, dstEnt.name), { recursive: true, force: true })
    }
  }
  for (const srcEnt of srcEntries) {
    const from = path.join(srcDir, srcEnt.name)
    const to = path.join(dstDir, srcEnt.name)
    if (srcEnt.isDirectory()) {
      const existing = statIfPresent(to)
      if (existing && !existing.isDirectory()) fs.rmSync(to, { force: true })
      syncDirectoryInPlace(from, to)
    } else {
      const existing = statIfPresent(to)
      if (existing && existing.isDirectory()) fs.rmSync(to, { recursive: true, force: true })
      fs.copyFileSync(from, to)
    }
  }
}

function syncPayloadInPlace(srcRoot, dstRoot) {
  fs.mkdirSync(dstRoot, { recursive: true })
  const managed = [...RUNTIME_PAYLOAD, INSTALL_INFO]
  for (const name of managed) {
    const from = path.join(srcRoot, name)
    const to = path.join(dstRoot, name)
    const srcStat = statIfPresent(from)
    if (!srcStat) {
      if (statIfPresent(to)) fs.rmSync(to, { recursive: true, force: true })
      continue
    }
    if (srcStat.isDirectory()) {
      const existing = statIfPresent(to)
      if (existing && !existing.isDirectory()) fs.rmSync(to, { force: true })
      syncDirectoryInPlace(from, to)
    } else {
      const existing = statIfPresent(to)
      if (existing && existing.isDirectory()) fs.rmSync(to, { recursive: true, force: true })
      fs.copyFileSync(from, to)
    }
  }
}

async function renameWithRetry(from, to, attempts = 3) {
  let lastError
  for (let i = 0; i < attempts; i++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (error) {
      lastError = error
      if (!LOCK_ERR_CODES.has(error.code) || i === attempts - 1) throw error
      await sleep(150 * (i + 1))
    }
  }
  throw lastError
}

export async function installPluginPayload({ source, destination, dataPaths, metadata = {}, allowDowngrade = true }) {
  const target = path.resolve(destination)
  const parent = path.dirname(target)
  const canonicalParent = canonicalPath(parent)
  const canonicalTarget = path.join(canonicalParent, path.basename(target))
  if (contains(canonicalTarget, canonicalPath(source))) throw new Error('部署源文件位于目标安装目录中')
  assertIndependentInstall(target, dataPaths)

  const release = await acquireProcessLock(path.join(canonicalParent, `${path.basename(target)}.install`))
    .catch(() => { throw new Error('该插件安装正在进行，请稍后重试。') })
  let scratch, backup
  let keepBackup = false
  try {
    const current = statIfPresent(target)
    if (current && (!current.isDirectory() || current.isSymbolicLink())) throw new Error('插件目标必须是真实目录')
    if (statIfPresent(path.join(target, '.git'))) throw new Error('当前插件目录属于 Git 开发仓库，请直接使用 git pull 更新。')
    const manifest = validatePluginPayload(source)
    const currentManifestPath = path.join(target, 'plugin.json')
    if (!allowDowngrade && statIfPresent(currentManifestPath)) {
      const currentManifest = JSON.parse(fs.readFileSync(currentManifestPath, 'utf8'))
      if (compareSemver(manifest.version, currentManifest.version) < 0) throw new Error('更新包版本低于当前安装版本，已取消更新。')
    }
    fs.mkdirSync(parent, { recursive: true })
    scratch = fs.mkdtempSync(path.join(canonicalParent, '.whale-install-'))
    const staged = path.join(scratch, 'new')
    backup = path.join(scratch, 'previous')
    fs.mkdirSync(staged)

    const copy = (root, name) => fs.cpSync(path.join(root, name), path.join(staged, name), { recursive: true, verbatimSymlinks: true })
    for (const entry of RUNTIME_PAYLOAD) copy(source, entry)
    if (current) {
      for (const entry of fs.readdirSync(target)) {
        if (entry !== INSTALL_INFO && !RUNTIME_PAYLOAD.includes(entry)) copy(target, entry)
      }
    }
    fs.writeFileSync(path.join(staged, INSTALL_INFO), JSON.stringify({ ...metadata, installedVersion: manifest.version }, null, 2) + '\n')
    validatePluginPayload(staged)

    let swappedViaRename = false
    if (current) {
      try {
        await renameWithRetry(target, backup)
        swappedViaRename = true
      } catch (error) {
        if (!LOCK_ERR_CODES.has(error.code)) throw error
        // Windows 下宿主监听或资源管理器持有根目录句柄时会拒绝整目录 rename；
        // 改为先备份旧运行时文件，再原地覆写同步（不改名/删除根目录），失败自动回滚。
        fs.mkdirSync(backup, { recursive: true })
        for (const entry of [...RUNTIME_PAYLOAD, INSTALL_INFO]) {
          if (statIfPresent(path.join(target, entry))) {
            fs.cpSync(path.join(target, entry), path.join(backup, entry), { recursive: true, verbatimSymlinks: true })
          }
        }
        try {
          syncPayloadInPlace(staged, target)
          validatePluginPayload(target)
        } catch (syncError) {
          try {
            syncPayloadInPlace(backup, target)
          } catch (rollbackError) {
            keepBackup = true
            throw new Error(`原地更新与回滚均失败。旧版保存在 ${backup}。`, { cause: rollbackError })
          }
          if (LOCK_ERR_CODES.has(syncError.code)) {
            throw new Error('插件安装目录中的文件仍被进程占用，旧版已保留。请关闭占用该目录的进程后重试。', { cause: syncError })
          }
          throw syncError
        }
        return { manifest, updatedEntries: RUNTIME_PAYLOAD.length, mode: 'in_place' }
      }
    }
    try {
      fs.renameSync(staged, target)
    } catch (error) {
      if (current && swappedViaRename) {
        try { fs.renameSync(backup, target) }
        catch (rollbackError) {
          keepBackup = true
          throw new Error(`安装切换与回滚均失败。旧版保存在 ${backup}。`, { cause: rollbackError })
        }
      }
      throw error
    }
    return { manifest, updatedEntries: RUNTIME_PAYLOAD.length, mode: 'atomic_rename' }
  } finally {
    if (scratch && !keepBackup) {
      try { fs.rmSync(scratch, { recursive: true, force: true }) }
      catch (error) { console.warn(`安装临时目录清理失败：${scratch}（${error.code}）`) }
    }
    await release()
  }
}
