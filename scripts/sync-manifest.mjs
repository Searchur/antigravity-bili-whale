/**
 * 自动扫描 RUNTIME_PAYLOAD 并同步（或校验）package.json 中的 whaleRuntimeFiles 清单。
 * 用法：
 *   node scripts/sync-manifest.mjs          # 自动更新 package.json
 *   node scripts/sync-manifest.mjs --check  # 只读校验，有差异则非零退出
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { RUNTIME_DIRS, RUNTIME_FILES } from '../src/plugin/install.mjs'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

function walkDir(dir, rootDir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isSymbolicLink()) continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) walkDir(full, rootDir, out)
    else if (ent.isFile()) out.push(path.relative(rootDir, full).split(path.sep).join('/'))
  }
}

export function collectRuntimeFiles(rootDir = REPO_ROOT) {
  const files = []
  for (const entry of RUNTIME_FILES) {
    const full = path.join(rootDir, entry)
    if (fs.existsSync(full) && fs.lstatSync(full).isFile()) {
      files.push(entry.split(path.sep).join('/'))
    }
  }
  for (const dir of RUNTIME_DIRS) {
    const full = path.join(rootDir, dir)
    if (fs.existsSync(full) && fs.lstatSync(full).isDirectory()) {
      walkDir(full, rootDir, files)
    }
  }
  return [...new Set(files)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

export function syncManifest({ rootDir = REPO_ROOT, checkOnly = false } = {}) {
  const pkgPath = path.join(rootDir, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const expected = collectRuntimeFiles(rootDir)
  const current = Array.isArray(pkg.whaleRuntimeFiles) ? pkg.whaleRuntimeFiles : []
  const expectedSet = new Set(expected)
  const currentSet = new Set(current)

  const missing = expected.filter(f => !currentSet.has(f))
  const extra = current.filter(f => !expectedSet.has(f))
  const orderMismatch = missing.length === 0 && extra.length === 0
    && (current.length !== expected.length || current.some((v, i) => v !== expected[i]))
  const ok = missing.length === 0 && extra.length === 0 && !orderMismatch

  if (!checkOnly && !ok) {
    pkg.whaleRuntimeFiles = expected
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  }

  return { ok, updated: !checkOnly && !ok, count: expected.length, missing, extra, orderMismatch }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const checkOnly = process.argv.includes('--check')
  const res = syncManifest({ checkOnly })
  if (checkOnly) {
    if (!res.ok) {
      console.error('package.json 的 whaleRuntimeFiles 与实际运行态文件不一致：')
      if (res.missing.length) console.error('  未登记文件：', res.missing.join(', '))
      if (res.extra.length) console.error('  多余/已删除文件：', res.extra.join(', '))
      if (res.orderMismatch) console.error('  顺序未按字典序排列或存在重复项')
      console.error('请运行 npm run sync:manifest 自动同步。')
      process.exit(1)
    }
    console.log(`whaleRuntimeFiles 校验通过（共 ${res.count} 个运行态文件）`)
  } else {
    console.log(res.updated
      ? `已同步 package.json 的 whaleRuntimeFiles（共 ${res.count} 个运行态文件）`
      : `whaleRuntimeFiles 已是最新（共 ${res.count} 个运行态文件）`)
  }
}
