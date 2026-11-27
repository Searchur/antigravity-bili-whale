/**
 * 跨平台安全子进程执行封装：规避 Windows 沙箱匿名管道限制并强制输出字节上限。
 */
// 当 Windows 沙箱禁用匿名管道时，使用文件承载子进程输出采集。
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
  delete workerEnv.NODE_OPTIONS // 目标专属的预加载选项仅应用于被调用的子进程本身。
  const input = serialize({ file, args, options: {
    cwd: cwd instanceof URL ? fileURLToPath(cwd) : cwd, env: { ...env }, maxBuffer, timeout, killSignal,
    uid, gid, shell, windowsVerbatimArguments,
  } })
  // worker 内的 execFile 对每个实时流单独施加 maxBuffer 上限，
  // 单次二进制返回仅包含受限输出与轻量状态记录。
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
  // 文件描述符会绕过 Node 的 maxBuffer 限制，受限调用需使用
  // 受管管道以便在子进程持续输出超限时及时中止。
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
