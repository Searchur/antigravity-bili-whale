import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNTIME_PAYLOAD } from '../../lib/plugin-install.js'

const source = fileURLToPath(new URL('../..', import.meta.url))

export function copyRuntimeFixture(root, version) {
  fs.mkdirSync(root, { recursive: true })
  for (const entry of RUNTIME_PAYLOAD) {
    fs.cpSync(path.join(source, entry), path.join(root, entry), { recursive: true })
  }
  for (const name of ['plugin.json', 'package.json']) {
    const file = path.join(root, name)
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...manifest, version }))
  }
}
