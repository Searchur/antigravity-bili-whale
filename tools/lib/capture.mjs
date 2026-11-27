// File-backed capture works where Windows sandbox disallows anonymous pipes.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export function execFileSync(file, args = [], options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-capture-'))
  const out = path.join(dir, 'stdout'), err = path.join(dir, 'stderr')
  const fds = []
  try {
    fds.push(fs.openSync(out, 'wx', 0o600), fs.openSync(err, 'wx', 0o600))
    const result = spawnSync(file, args, {
      ...options,
      timeout: options.timeout ?? 120000,
      windowsHide: true,
      stdio: ['ignore', ...fds],
    })
    for (const fd of fds.splice(0)) fs.closeSync(fd)
    const stdoutBuf = fs.readFileSync(out), stderrBuf = fs.readFileSync(err)
    const stdout = options.encoding ? stdoutBuf.toString(options.encoding) : stdoutBuf
    const stderr = options.encoding ? stderrBuf.toString(options.encoding) : stderrBuf
    if (result.error || result.status !== 0) {
      const e = result.error ?? new Error(`子进程失败 (${result.status}): ${stderrBuf.toString('utf8').slice(0, 1000)}`)
      Object.assign(e, { status: result.status, stdout, stderr })
      throw e
    }
    return stdout
  } finally {
    for (const fd of fds) { try { fs.closeSync(fd) } catch {} }
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}
