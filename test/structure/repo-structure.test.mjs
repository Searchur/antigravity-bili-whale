/**
 * 仓库目录结构、命名、分层依赖、ES2026、Markdown、注释与 UI 文案守卫自动化测试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkStructure } from '../../scripts/check-structure.mjs'
import { dataPathsFor } from '../../src/core/data-paths.mjs'

function makeFixtureRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-structure-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'src', 'shared'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'src', 'core'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'src', 'config'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'web', 'views'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'shared', 'util.mjs'), '/**\n * 共享纯计算测试夹具。\n */\nexport const x = 1\n')
  fs.writeFileSync(path.join(dir, 'src', 'core', 'base.mjs'), '/**\n * 核心基础测试夹具。\n */\nexport const y = 2\n')
  fs.writeFileSync(path.join(dir, 'src', 'config', 'cfg.mjs'), "/**\n * 配置层测试夹具。\n */\nimport { y } from '../core/base.mjs'\nexport const z = y\n")
  fs.writeFileSync(path.join(dir, 'web', 'main.mjs'), "/**\n * 控制台前端入口测试夹具。\n */\nimport { x } from '../src/shared/util.mjs'\nconsole.log(x)\n")
  fs.writeFileSync(path.join(dir, 'docs', 'guide.md'), '# Guide\n\nSee [util](../src/shared/util.mjs).\n')
  return dir
}

test('repository passes complete structure, naming, ES2026, Markdown, layer dependency, cycle, manifest and docs guard', () => {
  const res = checkStructure()
  assert.equal(res.ok, true, res.errors.join('\n'))
})

test('structure guard rejects .js files, non-kebab filenames, and unlisted root entries', t => {
  const dir = makeFixtureRepo(t)
  fs.writeFileSync(path.join(dir, 'src', 'core', 'legacy.js'), 'export const a = 1\n')
  fs.writeFileSync(path.join(dir, 'src', 'core', 'BadName.mjs'), 'export const b = 2\n')
  fs.writeFileSync(path.join(dir, 'stray.txt'), 'oops\n')

  const res = checkStructure({ rootDir: dir, checkManifest: false, checkDocs: false, checkVersions: false, checkMarkdown: false })
  assert.equal(res.ok, false)
  assert.ok(res.errors.some(e => e.includes('legacy.js')))
  assert.ok(res.errors.some(e => e.includes('BadName.mjs')))
  assert.ok(res.errors.some(e => e.includes('stray.txt')))
})

test('structure guard rejects reverse layer dependencies, file cycles, and web importing node/backend', t => {
  const dir = makeFixtureRepo(t)
  fs.writeFileSync(path.join(dir, 'src', 'core', 'base.mjs'), "import { z } from '../config/cfg.mjs'\nexport const y = z\n")
  fs.writeFileSync(path.join(dir, 'web', 'main.mjs'), "import fs from 'node:fs'\nimport { y } from '../src/core/base.mjs'\nconsole.log(fs, y)\n")
  fs.writeFileSync(path.join(dir, 'src', 'shared', 'util.mjs'), "import path from 'node:path'\nexport const x = path.sep\n")

  const res = checkStructure({ rootDir: dir, checkManifest: false, checkDocs: false, checkVersions: false, checkMarkdown: false })
  assert.equal(res.ok, false)
  assert.ok(res.errors.some(e => e.includes('src/core 不允许依赖 src/config')))
  assert.ok(res.errors.some(e => e.includes('循环依赖')))
  assert.ok(res.errors.some(e => e.includes('web/ 禁止引入 Node 内置模块')))
  assert.ok(res.errors.some(e => e.includes('禁止引用后端模块')))
  assert.ok(res.errors.some(e => e.includes('src/shared/ 禁止引入 Node 内置模块')))
})

test('structure guard enforces ES2026 syntax rules, bare builtin rejection, legacy names, and Markdown links', t => {
  const dir = makeFixtureRepo(t)
  fs.writeFileSync(
    path.join(dir, 'src', 'core', 'base.mjs'),
    "import fs from 'fs'\nvar oldVar = Math.sumPrecise([1, 2])\nconst legacy = 'whale-night.json'\nexport const y = { fs, oldVar, legacy, dshHome: '' }\n",
  )
  fs.writeFileSync(path.join(dir, 'docs', 'guide.md'), '# Guide\n\n### Skipped\n\n[broken](./missing.md)')

  const res = checkStructure({ rootDir: dir, checkManifest: false, checkDocs: false, checkVersions: false, checkMarkdown: true })
  assert.equal(res.ok, false)
  assert.ok(res.errors.some(e => e.includes('禁止使用 var')))
  assert.ok(res.errors.some(e => e.includes('Math.sumPrecise')))
  assert.ok(res.errors.some(e => e.includes('node: 协议前缀')))
  assert.ok(res.errors.some(e => e.includes('DSH 遗留标识')))
  assert.ok(res.errors.some(e => e.includes('旧版平铺数据文件名')))
  assert.ok(res.errors.some(e => e.includes('Markdown 标题跳级')))
  assert.ok(res.errors.some(e => e.includes('Markdown 存在断链')))
  assert.ok(res.errors.some(e => e.includes('Markdown 文件缺少末尾换行')))
})

test('structure guard enforces Chinese JSDoc headers, rejects placeholder/stale comments and web copy violations', t => {
  const dir = makeFixtureRepo(t)
  fs.writeFileSync(path.join(dir, 'src', 'core', 'base.mjs'), '/**\n * 核心模块（base.mjs）。\n */\n// lib/msgfeed.mjs\nexport const y = 2\n')
  fs.writeFileSync(path.join(dir, 'src', 'shared', 'util.mjs'), 'export const x = 1\n')
  fs.writeFileSync(
    path.join(dir, 'web', 'main.mjs'),
    "/**\n * 前端测试。\n */\nconst label = '前往B站 -> 设置'\nconst props = { title: 'hover' }\nconsole.log(label, props)\n",
  )

  const res = checkStructure({ rootDir: dir, checkManifest: false, checkDocs: false, checkVersions: false, checkMarkdown: false })
  assert.equal(res.ok, false)
  assert.ok(res.errors.some(e => e.includes('模块顶部缺少中文')))
  assert.ok(res.errors.some(e => e.includes('机械占位模板')))
  assert.ok(res.errors.some(e => e.includes('旧目录/旧文件名')))
  assert.ok(res.errors.some(e => e.includes('B 站')))
  assert.ok(res.errors.some(e => e.includes('→')))
  assert.ok(res.errors.some(e => e.includes('原生 title')))
})

test('dataPathsFor organizes user data cleanly into 6 canonical categories', () => {
  const dp = dataPathsFor('C:\\Users\\demo\\.antigravity-bili-whale')
  assert.equal(path.basename(dp.config), 'config.json')
  assert.equal(path.basename(dp.credentials), 'credentials.json')
  assert.equal(path.basename(dp.persona), 'persona.md')
  assert.ok(dp.memoryDir.endsWith(path.join('memory')))
  assert.ok(dp.schedule.endsWith(path.join('state', 'schedule.json')))
  assert.ok(dp.sidecarIpc.endsWith(path.join('runtime', 'sidecar-ipc.json')))
  assert.ok(dp.workspaceDir.endsWith(path.join('runtime', 'workspace')))
  assert.ok(dp.shotsDir.endsWith(path.join('cache', 'shots')))
  assert.ok(dp.safetyLog.endsWith(path.join('logs', 'safety-blocked.jsonl')))
})

test('Bili business sources reject direct transport, ad hoc signatures and credential headers', t => {
  const dir = makeFixtureRepo(t)
  const cli = path.join(dir, 'src', 'cli')
  fs.mkdirSync(cli)
  fs.writeFileSync(path.join(cli, 'direct.mjs'), [
    '/** 平台接口边界测试。 */',
    'const url = "https://api.bilibili.com/x/web-interface/nav"',
    'const cred = { sessdata: "fixture" }',
    'const headers = { cookie: `SESSDATA=${cred.sessdata}` }',
    'const w_rid = createHash("md5").update("fixture").digest("hex")',
    'await globalThis.fetch(url, { headers })',
  ].join('\n') + '\n')
  fs.writeFileSync(path.join(dir, 'src', 'config', 'direct.mjs'), [
    '/** 配置层不能绕过平台接口边界。 */',
    'export const endpoint = "https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs"',
  ].join('\n') + '\n')
  const res = checkStructure({ rootDir: dir, checkManifest: false, checkDocs: false, checkVersions: false, checkMarkdown: false })
  assert.match(res.errors.join('\n'), /B 站接口必须通过.*src\/bili/)
  assert.match(res.errors.join('\n'), /B 站接口必须通过.*src\/config\/direct\.mjs/)
  assert.match(res.errors.join('\n'), /禁止自行生成 WBI/)
  assert.match(res.errors.join('\n'), /禁止自行拼接 B 站登录凭据/)
})

test('structure guard rejects legacy punctuation in console source and static titles', t => {
  const dir = makeFixtureRepo(t)
  const examples = [
    ['web/main.mjs', "/**\n * 控制台文案测试夹具。\n */\nconst label = '\\u300c示例\\u300d'\n"],
    ['web/index.html', '<title>大鲸鱼&middot;控制台</title>\n'],
    ['web/index.html', '<title>大鲸鱼&CenterDot;控制台</title>\n'],
    ['web/index.html', '<title>大鲸鱼&#183 控制台</title>\n'],
    ['web/styles.css', '.hint::after { content: "·"; }\n'],
    ['web/styles.css', '.hint::after { content: "\\B7"; }\n'],
  ]
  const missed = []
  for (const [file, source] of examples) {
    fs.writeFileSync(path.join(dir, file), source)
    const res = checkStructure({ rootDir: dir, checkManifest: false, checkDocs: false, checkVersions: false, checkMarkdown: false })
    if (!res.errors.some(e => e.includes('旧标点') && e.endsWith(file))) missed.push(source)
  }
  assert.deepEqual(missed, [])
})
