export function watchOptions(args, defaultDir) {
  const positional = []
  let tile = 720
  let everySec = null
  let maxFrames = null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--tile' || arg.startsWith('--tile=')) {
      const value = arg === '--tile' ? args[++i] : arg.slice(7)
      tile = Number(value)
      if (!Number.isInteger(tile) || tile < 240 || tile > 1280) throw Error('--tile 必须是 240–1280 的整数')
    } else if (arg === '--every' || arg.startsWith('--every=')) {
      const value = arg === '--every' ? args[++i] : arg.slice(8)
      everySec = Number(value)
      if (!Number.isFinite(everySec) || everySec < 3 || everySec > 120) throw Error('--every 必须是 3–120 的秒数')
    } else if (arg === '--max-frames' || arg.startsWith('--max-frames=')) {
      const value = arg === '--max-frames' ? args[++i] : arg.slice(13)
      maxFrames = Number(value)
      if (!Number.isInteger(maxFrames) || maxFrames < 4 || maxFrames > 36) throw Error('--max-frames 必须是 4–36 的整数')
    } else if (!arg.startsWith('--')) {
      positional.push(arg)
    } else if (!['--uniform', '--full-download'].includes(arg)) {
      throw Error('未知抽帧选项：' + arg)
    }
  }
  return {
    bvid: positional[0],
    grid: (positional[1] ?? '3x3').toLowerCase(),
    outDir: positional[2] ?? defaultDir,
    tile,
    ...(everySec !== null ? { everySec } : {}),
    ...(maxFrames !== null ? { maxFrames } : {}),
    ...(args.includes('--full-download') ? { fullDownload: true } : {}),
  }
}

export function gridForFrameCount(count) {
  const n = Math.min(36, Math.max(4, Math.floor(Number(count) || 9)))
  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  return { cols, rows, count: n }
}
