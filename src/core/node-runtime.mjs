import { resolveRuntime } from './runtime-probe.mjs'
const cache = new Map()
export function nodeRuntime(whaleHome) {
  if (!cache.has(whaleHome)) cache.set(whaleHome, resolveRuntime(whaleHome))
  return cache.get(whaleHome)
}
export const resolveNodeRuntime = whaleHome => nodeRuntime(whaleHome).file
export const nodeEnv = whaleHome => nodeRuntime(whaleHome).env
