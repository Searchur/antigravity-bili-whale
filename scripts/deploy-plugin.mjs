/**
 * 开发态本地部署脚本：将当前运行态文件同步部署至 Windows Antigravity 插件目录。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { configPath, HOME, WHALE_HOME } from '../src/core/paths.mjs'
import { installPluginPayload } from '../src/plugin/install.mjs'

const source = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const destination = path.join(HOME, '.gemini', 'config', 'plugins', 'antigravity-bili-whale')

try {
  await installPluginPayload({ source, destination, dataPaths: [WHALE_HOME, configPath] })
  console.log(`Deployed zero-dep plugin -> ${destination}`)
} catch (error) {
  console.error(`部署失败：${error.message}`)
  process.exitCode = 1
}
