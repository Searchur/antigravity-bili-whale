import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkStructure } from '../../scripts/check-structure.mjs'

function makeFixtureRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-structure-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'src', 'shared'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'src', 'core'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'src', 'config'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'web'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'shared', 'util.mjs'), 'export const x = 1\n')
  fs.writeFileSync(path.join(dir, 'src', 'core', 'base.mjs'), 'export const y = 2\n')
  fs.writeFileSync(path.join(dir, 'src', 'config', 'cfg.mjs'), "import { y } from '../core/base.mjs'\nexport const z = y\n")
  fs.writeFileSync(path.join(dir, 'web', 'main.mjs'), "import { x } from '../src/shared/util.mjs'\nconsole.log(x)\n")
  return dir
}

test('repository passes complete structure, naming, layer dependency, cycle, manifest and docs guard', () => {
  const res = checkStructure()
  assert.equal(res.ok, true, res.errors.join('\n'))
})

test('structure guard rejects .js files, non-kebab filenames, and unlisted root entries', t => {
  const dir = makeFixtureRepo(t)
  fs.writeFileSync(path.join(dir, 'src', 'core', 'legacy.js'), 'export const a = 1\n')
  fs.writeFileSync(path.join(dir, 'src', 'core', 'BadName.mjs'), 'export const b = 2\n')
  fs.writeFileSync(path.join(dir, 'stray.txt'), 'oops\n')

  const res = checkStructure({ rootDir: dir, checkManifest: false, checkDocs: false, checkVersions: false })
  assert.equal(res.ok, false)
  assert.ok(res.errors.some(e => e.includes('legacy.js')))
  assert.ok(res.errors.some(e => e.includes('BadName.mjs')))
  assert.ok(res.errors.some(e => e.includes('stray.txt')))
})

test('structure guard rejects reverse layer dependencies, file cycles, and web importing node/backend', t => {
  const dir = makeFixtureRepo(t)
  // Reverse layer dependency: core -> config
  fs.writeFileSync(path.join(dir, 'src', 'core', 'base.mjs'), "import { z } from '../config/cfg.mjs'\nexport const y = z\n")
  // Web importing node:fs and backend core
  fs.writeFileSync(path.join(dir, 'web', 'main.mjs'), "import fs from 'node:fs'\nimport { y } from '../src/core/base.mjs'\nconsole.log(fs, y)\n")
  // Shared importing node:path
  fs.writeFileSync(path.join(dir, 'src', 'shared', 'util.mjs'), "import path from 'node:path'\nexport const x = path.sep\n")

  const res = checkStructure({ rootDir: dir, checkManifest: false, checkDocs: false, checkVersions: false })
  assert.equal(res.ok, false)
  assert.ok(res.errors.some(e => e.includes('src/core 不允许依赖 src/config')))
  assert.ok(res.errors.some(e => e.includes('循环依赖')))
  assert.ok(res.errors.some(e => e.includes('web/ 禁止引入 Node 内置模块')))
  assert.ok(res.errors.some(e => e.includes('禁止引用后端模块')))
  assert.ok(res.errors.some(e => e.includes('src/shared/ 禁止引入 Node 内置模块')))
})
