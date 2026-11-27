/**
 * Windows/POSIX 可用 Node.js 24+ 运行时探测与版本校验。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export function probeRuntime(file, env) {
  let dir
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-node-'))
    const proof = path.join(dir, 'proof')
    const r = spawnSync(file, ['-e', 'require("fs").writeFileSync(process.argv[1],process.versions.node)', proof],
      { env, stdio: 'ignore', windowsHide: true, timeout: 10000 })
    return !r.error && r.status === 0 && /^\d+\./.test(fs.readFileSync(proof, 'utf8'))
  } catch { return false }
  finally { if (dir) fs.rmSync(dir, { recursive: true, force: true }) }
}

/**
 * Windows Node.js 运行时解析。
 * Antigravity 插件的 Sidecar 与 MCP Server 均在独立 Node 进程中运行，
 * 优先复用当前真实 node.exe（避免反复探测开销）。
 */
export function resolveRuntime(_whaleHome, options = {}) {
  const env = options.env ?? process.env
  const current = options.execPath ?? process.execPath
  const electron = options.electron ?? Boolean(process.versions.electron)
  const probe = options.probe ?? probeRuntime
  const bin = 'node.exe'

  // 快速路径：当前已在独立 node.exe（非 Electron）下运行。
  if (!electron && current && /node(\.exe)?$/i.test(path.basename(current))) {
    try {
      if (fs.statSync(current).isFile()) return { file: current, env: { ...env } }
    } catch {}
  }

  const cands = [env.BILI_WHALE_NODE]
  if (!electron) cands.push(current)
  for (const dir of String(env.PATH ?? '').split(';')) {
    if (dir) cands.push(path.join(dir.replace(/^"|"$/g, ''), bin))
  }
  if (env.ProgramFiles) cands.push(path.join(env.ProgramFiles, 'nodejs', bin))
  if (env.LOCALAPPDATA) cands.push(path.join(env.LOCALAPPDATA, 'Programs', 'nodejs', bin))

  for (const file of new Set(cands.filter(Boolean))) {
    try {
      if (fs.statSync(file).isFile() && probe(file, env)) return { file, env: { ...env } }
    } catch {}
  }
  throw Error('[bili-whale] 找不到可用的 Windows Node.js 运行时，请安装 Node.js 24 LTS+ 或设置环境变量 BILI_WHALE_NODE')
}
