/**
 * 零依赖插件入口与传递本地依赖静态可达性校验器（不执行目标业务代码）。
 */
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// 仅通过 V8 解析导入与重导出声明，绝不执行候选模块代码。
function checkHostImports(root, loadBuiltin) {
  const fs = loadBuiltin('node:fs')
  const path = loadBuiltin('node:path')
  const vm = loadBuiltin('node:vm')
  const { isBuiltin } = loadBuiltin('node:module')
  const { fileURLToPath, pathToFileURL } = loadBuiltin('node:url')
  const seen = new Set()
  function visit(file) {
    if (seen.has(file)) return
    seen.add(file)
    const source = fs.readFileSync(file, 'utf8')
    const module = new vm.SourceTextModule(source, { identifier: file })
    // Node 24+ V8 SourceTextModule 暴露 moduleRequests（保留旧版字段回退）。
    const dependencies = module.moduleRequests?.map(request => request.specifier) ?? module.dependencySpecifiers
    for (const specifier of dependencies) {
      if (isBuiltin(specifier)) continue
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        throw Error('零依赖插件含未打包的模块引用：' + specifier)
      }
      const dependency = fileURLToPath(new URL(specifier, pathToFileURL(file)))
      const relative = path.relative(root, dependency)
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw Error('运行模块不在插件目录内：' + specifier)
      }
      if (!fs.statSync(dependency, { throwIfNoEntry: false })?.isFile()) {
        throw Error('插件缺少依赖 ' + relative + '（' + path.relative(root, file) + '）')
      }
      if (path.extname(dependency) !== '.json') visit(dependency)
    }
  }
  visit(path.join(root, 'src', 'mcp', 'server.mjs'))
  visit(path.join(root, 'sidecars', 'whale', 'main.mjs'))
  visit(path.join(root, 'src', 'cli', 'bili.mjs'))
}

// 在 Windows 原地更新替换文件时保留当前运行版本的校验器。
const checker = `try { (${checkHostImports.toString()})(process.argv[2], require) }
catch (error) { console.error(error.message); process.exitCode = 1 }`

export function validateHostImports(root) {
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=commonjs', '-', path.resolve(root)], {
    input: checker, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw Error('插件入口依赖校验失败：' + (result.stderr.trim() || result.signal))
}
