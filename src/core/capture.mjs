// File-backed capture works where Windows sandbox disallows anonymous pipes.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { deserialize, serialize } from 'node:v8'

function boundedCapture(file, args, options) {
  const { encoding, env = process.env, cwd, maxBuffer, timeout = 120000, killSignal = 'SIGKILL',
    uid, gid, shell, windowsVerbatimArguments } = options
  const worker = fileURLToPath(new URL('./capture-worker.mjs', import.meta.url))
  const workerEnv = { ...process.env }
  delete workerEnv.NODE_OPTIONS // Target-specific preloads belong to the requested child only.
  const input = serialize({ file, args, options: {
    cwd: cwd instanceof URL ? fileURLToPath(cwd) : cwd, env: { ...env }, maxBuffer, timeout, killSignal,
    uid, gid, shell, windowsVerbatimArguments,
  } })
  // execFile in the worker enforces maxBuffer separately on each live stream. Its
  // single binary reply contains only bounded output and a small status record.
  const workerResult = spawnSync(process.execPath, [worker], {
    input, env: workerEnv, windowsHide: true, maxBuffer: Infinity,
  })
  if (workerResult.error) throw workerResult.error
  if (workerResult.status !== 0) throw Error('输出采集进程异常：' + workerResult.stderr.toString('utf8').slice(0, 1000))
  const result = deserialize(workerResult.stdout)
  const decode = buffer => encoding && encoding !== 'buffer' ? buffer.toString(encoding) : buffer
  const stdout = decode(result.stdout), stderr = decode(result.stderr)
  if (result.error) {
    throw Object.assign(new Error(result.error.message), result.error, {
      stdout, stderr, output: [null, stdout, stderr],
    })
  }
  return stdout
}

export function execFileSync(file, args = [], options = {}) {
  // File descriptors bypass Node's maxBuffer handling. Bounded calls need
  // managed pipes so the child is stopped while it is still producing output.
  if (options.maxBuffer !== undefined) return boundedCapture(file, args, options)
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
