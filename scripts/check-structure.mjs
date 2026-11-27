/**
 * 仓库目录结构、命名与扩展名、分层依赖方向、零循环依赖、ES2026 语法边界、
 * Markdown 格式与断链、用户数据路径规范、版本与运行清单一致性自动化守卫。
 * 用法：node scripts/check-structure.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isBuiltin } from 'node:module'
import { validatePluginPayload } from '../src/plugin/install.mjs'
import { syncManifest } from './sync-manifest.mjs'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

export const ALLOWED_ROOT_DIRS = new Set([
  '.git', '.github', 'node_modules',
  'assets', 'behavior', 'dist', 'docs', 'scripts', 'sidecars', 'skills', 'src', 'stickers', 'test', 'web',
])

export const ALLOWED_ROOT_FILES = new Set([
  '.gitattributes', '.gitignore', 'AGENTS.md', 'LICENSE', 'NOTICE.md', 'README.md',
  'mcp_config.json', 'package-lock.json', 'package.json', 'plugin.json',
])

export const ALLOWED_SRC_DOMAINS = new Set([
  'shared', 'vendor', 'core', 'config',
  'host', 'plugin', 'bili',
  'media', 'memory', 'affect',
  'life', 'social', 'daemon', 'console', 'mcp', 'cli',
])

export const ALLOWED_WEB_DIRS = new Set(['views'])

export const ALLOWED_TEST_DIRS = new Set([
  'fixtures', 'host', 'plugin', 'runtime', 'structure',
])

/**
 * 严格单向分层依赖白名单（src/<from> 仅允许依赖列表中声明的其他 src/<to> 领域）。
 */
export const ALLOWED_LAYER_DEPS = Object.freeze({
  shared: [],
  vendor: [],
  core: [],
  config: ['core'],
  host: ['shared', 'core', 'config'],
  plugin: ['core'],
  bili: ['vendor', 'core', 'config'],
  media: ['core', 'config', 'bili'],
  memory: ['core', 'config'],
  affect: ['core', 'config'],
  life: ['core', 'config', 'memory', 'affect'],
  social: ['core', 'config', 'host', 'bili', 'life'],
  daemon: ['core', 'config', 'host', 'bili', 'memory', 'affect', 'life', 'social'],
  console: ['core', 'config', 'host', 'plugin', 'bili', 'media', 'life', 'social', 'daemon'],
  mcp: ['core', 'memory', 'console'],
  cli: ['core', 'config', 'host', 'bili', 'media', 'affect', 'life', 'social', 'daemon'],
})

const KEBAB_FILE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.(?:test|example))?\.(?:mjs|json|md|html|css)$/
const ALLOWED_UPPER_MD = new Set(['README.md', 'NOTICE.md', 'AGENTS.md', 'skills/antigravity-bili-whale/SKILL.md'])
const ALLOWED_WEB_PACKAGES = new Set(['@modelcontextprotocol/ext-apps'])
const ALLOWED_SCRIPT_PACKAGES = new Set(['esbuild'])

/** Node 24 (V8 13.6) 尚未实装的 ES2026 API 静态防误用清单 */
const UNSUPPORTED_ES2026_PATTERNS = [
  { name: 'Math.sumPrecise', re: /\bMath\.sumPrecise\s*\(/ },
  { name: 'Uint8Array.fromBase64/fromHex', re: /\bUint8Array\.(?:fromBase64|fromHex)\s*\(/ },
  { name: 'Uint8Array.prototype.toBase64/toHex', re: /\.(?:toBase64|toHex)\s*\(/ },
  { name: 'Map.prototype.getOrInsert/getOrInsertComputed', re: /\.(?:getOrInsert|getOrInsertComputed)\s*\(/ },
  { name: 'Iterator.concat', re: /\bIterator\.concat\s*\(/ },
]

const LEGACY_DSH_RE = /\b(?:DSH_HOME|dshPath|dshHome)\b/
const LEGACY_DATA_NAMES_RE = /[\x27\x22](?:whale-night\.json|whale-listen\.json|whale-scheduler\.json|whale-delivery\.json|whale-life|whale-work|traffic-state\.json|dm-tick-err\.log|feed-search-cache\.json|selftest-passed\.json|dm-await-state\.json|dev_id)[\x27\x22]/

function walkFiles(dir, rootDir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) walkFiles(full, rootDir, out)
    else if (ent.isFile()) out.push(path.relative(rootDir, full).split(path.sep).join('/'))
  }
  return out
}

/** 剥离注释（保留字符串字面量） */
function stripComments(source) {
  let clean = ''
  let i = 0
  const n = source.length
  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      i += 2
      while (i < n && source[i] !== '\n') i++
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++
      i += 2
      clean += ' '
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      clean += ch
      i++
      while (i < n) {
        const c = source[i]
        clean += c
        i++
        if (c === '\\' && i < n) {
          clean += source[i]
          i++
          continue
        }
        if (c === quote) break
      }
      continue
    }
    clean += ch
    i++
  }
  return clean
}

/** 剥离注释与字符串字面量（仅保留代码标识符，用于 var / CJS / API 静态守卫） */
function stripCommentsAndStrings(source) {
  let clean = ''
  let i = 0
  const n = source.length
  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      i += 2
      while (i < n && source[i] !== '\n') i++
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++
      i += 2
      clean += ' '
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      clean += ' '
      i++
      while (i < n) {
        const c = source[i]
        i++
        if (c === '\\' && i < n) { i++; continue }
        if (c === quote) break
      }
      continue
    }
    clean += ch
    i++
  }
  return clean
}

/**
 * 剥离注释后提取静态 import/export ... from 与动态 import('...') 路径。
 */
export function extractModuleSpecifiers(source) {
  const clean = stripComments(source)
  const specs = []
  const staticRe = /(?:^|[\n;{}])\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?[\x27\x22]([^\x27\x22]+)[\x27\x22]/g
  for (const m of clean.matchAll(staticRe)) specs.push(m[1])
  const dynamicRe = /\bimport\s*\(\s*[\x27\x22]([^\x27\x22]+)[\x27\x22]\s*\)/g
  for (const m of clean.matchAll(dynamicRe)) specs.push(m[1])
  return [...new Set(specs)]
}

function findCycles(graph) {
  const visiting = new Set()
  const visited = new Set()
  const cycles = []
  function dfs(node, stack) {
    if (visiting.has(node)) {
      const idx = stack.indexOf(node)
      cycles.push(stack.slice(idx).concat(node).join(' -> '))
      return
    }
    if (visited.has(node)) return
    visiting.add(node)
    stack.push(node)
    for (const nxt of (graph.get(node) ?? [])) {
      if (graph.has(nxt)) dfs(nxt, stack)
    }
    stack.pop()
    visiting.delete(node)
    visited.add(node)
  }
  for (const node of graph.keys()) dfs(node, [])
  return cycles
}

function checkMarkdownFile(rel, rootDir, errors) {
  const full = path.join(rootDir, rel)
  const raw = fs.readFileSync(full, 'utf8')
  if (!ALLOWED_UPPER_MD.has(rel)) {
    const base = path.posix.basename(rel)
    if (!KEBAB_FILE_RE.test(base)) {
      errors.push(`Markdown 文件名不符合 kebab-case 规范：${rel}`)
    }
  }
  if (raw.includes('\r')) {
    errors.push(`Markdown 文件包含 CRLF 换行（请统一为 LF）：${rel}`)
  }
  if (!raw.endsWith('\n')) {
    errors.push(`Markdown 文件缺少末尾换行：${rel}`)
  }

  let body = raw
  if (body.startsWith('---\n')) {
    const endIdx = body.indexOf('\n---\n', 4)
    if (endIdx > 0) body = body.slice(endIdx + 5)
  }

  const lines = body.split('\n')
  let inFence = false
  let h1Count = 0
  let prevLevel = 0
  const linkRe = /!?\[[^\]]*\]\(([^)]+)\)/g

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    const heading = line.match(/^(#{1,6})\s+\S/)
    if (heading) {
      const level = heading[1].length
      if (level === 1) h1Count++
      if (prevLevel > 0 && level > prevLevel + 1) {
        errors.push(`Markdown 标题跳级（H${prevLevel} -> H${level}）：${rel}:${idx + 1}`)
      }
      prevLevel = level
    }

    // 剥离行内代码后再检查相对链接，避免示例文本误报
    const withoutCode = line.replace(/`[^`]*`/g, '')
    for (const m of withoutCode.matchAll(linkRe)) {
      const target = m[1].trim().split(/\s+/)[0].replace(/^<|>$/g, '')
      if (!target || /^(?:https?:|mailto:|file:|#)/i.test(target)) continue
      const filePart = target.split('#')[0].split('?')[0]
      if (!filePart) continue
      const resolved = path.resolve(path.dirname(full), decodeURIComponent(filePart))
      if (!fs.existsSync(resolved)) {
        errors.push(`Markdown 存在断链：${rel}:${idx + 1} -> ${target}`)
      }
    }
  }

  if (h1Count !== 1) {
    errors.push(`Markdown 必须恰有 1 个一级标题（当前 ${h1Count} 个）：${rel}`)
  }
}

export function checkStructure({
  rootDir = REPO_ROOT,
  checkManifest = true,
  checkDocs = true,
  checkVersions = true,
  checkMarkdown = true,
} = {}) {
  const errors = []

  // 1. 顶层白名单检查
  for (const ent of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!ALLOWED_ROOT_DIRS.has(ent.name)) {
        errors.push(`根目录存在未登记目录：${ent.name}/`)
      }
    } else if (!ALLOWED_ROOT_FILES.has(ent.name)) {
      errors.push(`根目录存在未登记文件：${ent.name}`)
    }
  }

  // 2. src/ 与 web/ 子目录白名单
  const srcRoot = path.join(rootDir, 'src')
  if (fs.existsSync(srcRoot)) {
    for (const ent of fs.readdirSync(srcRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) {
        errors.push(`src/ 根目录禁止直接放置文件：src/${ent.name}`)
      } else if (!ALLOWED_SRC_DOMAINS.has(ent.name)) {
        errors.push(`src/ 下存在未登记领域目录：src/${ent.name}/`)
      }
    }
  }

  const webRoot = path.join(rootDir, 'web')
  if (fs.existsSync(webRoot)) {
    for (const ent of fs.readdirSync(webRoot, { withFileTypes: true })) {
      if (ent.isDirectory() && !ALLOWED_WEB_DIRS.has(ent.name)) {
        errors.push(`web/ 下存在未登记子目录：web/${ent.name}/`)
      }
    }
  }

  // 3. 命名与扩展名规范检查
  const codeRoots = ['src', 'web', 'scripts', 'sidecars', 'test']
  const allMjsFiles = []
  for (const dirName of codeRoots) {
    const files = walkFiles(path.join(rootDir, dirName), rootDir)
    for (const rel of files) {
      const base = path.posix.basename(rel)
      if (/\.(?:js|cjs)$/i.test(base)) {
        errors.push(`禁止使用 .js/.cjs 扩展名，请统一改用 .mjs：${rel}`)
        continue
      }
      if (base.endsWith('.mjs')) allMjsFiles.push(rel)
      if (rel === 'src/vendor/qrcode/LICENSE') continue
      if (!KEBAB_FILE_RE.test(base)) {
        errors.push(`文件名不符合 kebab-case 规范：${rel}`)
      }
    }
  }

  for (const rel of walkFiles(path.join(rootDir, 'docs'), rootDir)) {
    const base = path.posix.basename(rel)
    if (!KEBAB_FILE_RE.test(base)) {
      errors.push(`文档文件名不符合 kebab-case 规范：${rel}`)
    }
  }

  // test/ 分层检查
  const testRoot = path.join(rootDir, 'test')
  if (fs.existsSync(testRoot)) {
    for (const ent of fs.readdirSync(testRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) {
        errors.push(`test/ 根目录禁止直接放置文件（请归入 host/plugin/runtime/structure/fixtures）：test/${ent.name}`)
      } else if (!ALLOWED_TEST_DIRS.has(ent.name)) {
        errors.push(`test/ 下存在未登记子目录：test/${ent.name}/`)
      }
    }
    for (const rel of walkFiles(testRoot, rootDir)) {
      const sub = rel.split('/')[1]
      if (sub === 'fixtures') {
        if (rel.endsWith('.test.mjs')) errors.push(`test/fixtures/ 下不应放置测试文件：${rel}`)
      } else if (ALLOWED_TEST_DIRS.has(sub)) {
        if (!rel.endsWith('.test.mjs')) errors.push(`测试文件必须以 .test.mjs 结尾：${rel}`)
      }
    }
  }

  // 4. ES2026 / Node 24+ 语法守卫 & 遗留标识/数据路径防回归
  for (const rel of allMjsFiles) {
    if (rel.startsWith('src/vendor/') || rel === 'scripts/check-structure.mjs') continue
    const source = fs.readFileSync(path.join(rootDir, rel), 'utf8')
    const codeOnly = stripCommentsAndStrings(source)

    if (/\bvar\s+[a-zA-Z_$]/.test(codeOnly)) {
      errors.push(`违反 ES2026 规范，禁止使用 var 声明：${rel}`)
    }
    if (/\b(?:module\.exports|exports\.|__dirname|__filename)\b/.test(codeOnly)) {
      errors.push(`违反纯 ESM 规范，禁止使用 CommonJS 标识：${rel}`)
    }
    for (const { name, re } of UNSUPPORTED_ES2026_PATTERNS) {
      if (re.test(codeOnly)) {
        errors.push(`当前 Node 24 (V8 13.6) 尚未实装 ES2026 API（${name}）：${rel}`)
      }
    }
    if (!rel.startsWith('test/structure/')) {
      if (LEGACY_DSH_RE.test(codeOnly)) {
        errors.push(`存在已废弃的 DSH 遗留标识（请改用 WHALE_HOME / whaleHome / dataPathsFor）：${rel}`)
      }
      if (rel.startsWith('src/') && LEGACY_DATA_NAMES_RE.test(stripComments(source))) {
        errors.push(`src/ 中禁止硬编码旧版平铺数据文件名（请统一使用 src/core/data-paths.mjs）：${rel}`)
      }
    }
  }

  // 5. 依赖边界与零循环依赖检查
  const fileGraph = new Map()
  const layerGraph = new Map()
  for (const domain of ALLOWED_SRC_DOMAINS) layerGraph.set(domain, new Set())

  const graphCandidates = allMjsFiles.filter(f => !f.startsWith('test/'))
  for (const rel of graphCandidates) {
    const full = path.join(rootDir, rel)
    const source = fs.readFileSync(full, 'utf8')
    const specs = extractModuleSpecifiers(source)
    const deps = []
    const top = rel.split('/')[0]
    const fromDomain = top === 'src' ? rel.split('/')[1] : null

    for (const spec of specs) {
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec))
        if (target.startsWith('..')) {
          errors.push(`相对导入越出仓库根目录：${rel} -> ${spec}`)
          continue
        }
        if (!fs.existsSync(path.join(rootDir, target))) {
          errors.push(`导入目标文件不存在：${rel} -> ${spec}（解析为 ${target}）`)
          continue
        }
        deps.push(target)

        if (top === 'web') {
          if (!target.startsWith('web/') && !target.startsWith('src/shared/')) {
            errors.push(`前端目录 web/ 仅允许引用 web/ 或 src/shared/，禁止引用后端模块：${rel} -> ${target}`)
          }
        } else if (top === 'src') {
          if (!target.startsWith('src/')) {
            errors.push(`src/ 内部模块禁止反向引用非 src/ 路径：${rel} -> ${target}`)
          } else {
            const toDomain = target.split('/')[1]
            if (fromDomain !== toDomain) {
              layerGraph.get(fromDomain)?.add(toDomain)
              const allowed = ALLOWED_LAYER_DEPS[fromDomain] ?? []
              if (!allowed.includes(toDomain)) {
                errors.push(`违反单向分层依赖规则：src/${fromDomain} 不允许依赖 src/${toDomain}（${rel} -> ${target}）`)
              }
            }
          }
        }
      } else if (isBuiltin(spec)) {
        if (!spec.startsWith('node:')) {
          errors.push(`Node 内置模块必须使用 node: 协议前缀：${rel} -> ${spec}`)
        }
        if (top === 'web') {
          errors.push(`前端目录 web/ 禁止引入 Node 内置模块：${rel} -> ${spec}`)
        } else if (fromDomain === 'shared' || fromDomain === 'vendor') {
          errors.push(`纯共享/第三方层 src/${fromDomain}/ 禁止引入 Node 内置模块：${rel} -> ${spec}`)
        }
      } else {
        if (top === 'web') {
          if (!ALLOWED_WEB_PACKAGES.has(spec)) {
            errors.push(`前端目录 web/ 引入了未登记依赖包：${rel} -> ${spec}`)
          }
        } else if (top === 'scripts') {
          if (!ALLOWED_SCRIPT_PACKAGES.has(spec)) {
            errors.push(`构建脚本 scripts/ 引入了未登记依赖包：${rel} -> ${spec}`)
          }
        } else {
          errors.push(`零运行时依赖约束被破坏，禁止引入外部包：${rel} -> ${spec}`)
        }
      }
    }
    fileGraph.set(rel, deps)
  }

  for (const cycle of findCycles(fileGraph)) {
    errors.push(`检测到文件级循环依赖：${cycle}`)
  }
  for (const cycle of findCycles(layerGraph)) {
    errors.push(`检测到领域层循环依赖：${cycle}`)
  }

  // 6. Markdown 格式、命名、标题层级与断链校验
  if (checkMarkdown) {
    const mdFiles = []
    for (const ent of fs.readdirSync(rootDir, { withFileTypes: true })) {
      if (ent.isFile() && ent.name.endsWith('.md')) mdFiles.push(ent.name)
    }
    for (const dir of ['docs', 'behavior', 'skills', 'stickers']) {
      for (const rel of walkFiles(path.join(rootDir, dir), rootDir)) {
        if (rel.endsWith('.md')) mdFiles.push(rel)
      }
    }
    for (const rel of mdFiles) checkMarkdownFile(rel, rootDir, errors)
  }

  // 7. 版本一致性、Node 24+ 引擎声明与运行清单校验
  if (checkVersions) {
    const pluginVer = JSON.parse(fs.readFileSync(path.join(rootDir, 'plugin.json'), 'utf8')).version
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'))
    if (!String(pkg.engines?.node ?? '').includes('24')) {
      errors.push(`package.json engines.node 必须声明 Node 24+（当前：${pkg.engines?.node ?? '未设置'}）`)
    }
    const lock = JSON.parse(fs.readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'))
    const lockVer = lock.version
    const lockRootVer = lock.packages?.['']?.version
    const serverVer = fs.readFileSync(path.join(rootDir, 'src/mcp/server.mjs'), 'utf8').match(/version:\s*'(\d+\.\d+\.\d+)'/)?.[1]
    const bridgeVer = fs.readFileSync(path.join(rootDir, 'web/bridge.mjs'), 'utf8').match(/version:\s*'(\d+\.\d+\.\d+)'/)?.[1]
    const versions = { 'plugin.json': pluginVer, 'package.json': pkg.version, 'package-lock.json': lockVer, 'package-lock.json[root]': lockRootVer, 'src/mcp/server.mjs': serverVer, 'web/bridge.mjs': bridgeVer }
    for (const [label, ver] of Object.entries(versions)) {
      if (ver !== pluginVer) {
        errors.push(`版本号不一致：${label}=${ver}，预期与 plugin.json 一致（${pluginVer}）`)
      }
    }
  }

  if (checkManifest) {
    const manifestRes = syncManifest({ rootDir, checkOnly: true })
    if (!manifestRes.ok) {
      if (manifestRes.missing.length) errors.push(`whaleRuntimeFiles 缺少文件：${manifestRes.missing.join(', ')}`)
      if (manifestRes.extra.length) errors.push(`whaleRuntimeFiles 含多余文件：${manifestRes.extra.join(', ')}`)
      if (manifestRes.orderMismatch) errors.push('whaleRuntimeFiles 未按字典序排列或存在重复项（请运行 npm run sync:manifest）')
    }
    try {
      validatePluginPayload(rootDir)
    } catch (err) {
      errors.push(`插件运行包完整性校验失败：${err.message}`)
    }
  }

  // 8. 架构文档防漂移校验
  if (checkDocs) {
    const archFile = path.join(rootDir, 'docs', 'architecture.md')
    if (!fs.existsSync(archFile)) {
      errors.push('缺少统一目录架构文档：docs/architecture.md')
    } else {
      const arch = fs.readFileSync(archFile, 'utf8')
      for (const dir of ['assets/', 'behavior/', 'dist/', 'docs/', 'scripts/', 'sidecars/', 'skills/', 'src/', 'stickers/', 'test/', 'web/']) {
        if (!arch.includes(dir)) errors.push(`docs/architecture.md 未记录顶层目录：${dir}`)
      }
      for (const domain of ALLOWED_SRC_DOMAINS) {
        if (!arch.includes(`src/${domain}`)) errors.push(`docs/architecture.md 未记录领域目录：src/${domain}`)
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    stats: {
      mjsFiles: allMjsFiles.length,
      srcDomains: ALLOWED_SRC_DOMAINS.size,
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const res = checkStructure()
  if (!res.ok) {
    console.error(`目录与架构规范校验失败（共 ${res.errors.length} 项违规）：`)
    for (const err of res.errors) console.error('  -', err)
    process.exit(1)
  }
  console.log(`目录与架构规范校验通过（${res.stats.mjsFiles} 个 .mjs 模块 · ${res.stats.srcDomains} 个无环领域层 · ES2026 & Markdown 合规）`)
}
