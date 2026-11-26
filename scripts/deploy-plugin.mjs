/** Deploy the runtime payload to the Windows Antigravity plugin directory. */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { configPath, HOME, WHALE_HOME } from '../tools/lib/paths.mjs'
import { installPluginPayload } from '../lib/plugin-install.js'

const source = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const destination = path.join(HOME, '.gemini', 'config', 'plugins', 'antigravity-bili-whale')

try {
  await installPluginPayload({ source, destination, dataPaths: [WHALE_HOME, configPath] })
  console.log(`Deployed zero-dep plugin -> ${destination}`)
} catch (error) {
  console.error(`部署失败：${error.message}`)
  process.exitCode = 1
}
