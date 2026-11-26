import { WHALE_HOME } from './paths.mjs'
import { resolveRuntime } from './runtime.mjs'
const runtime = resolveRuntime(WHALE_HOME, { allowCurrent: true })
export const NODE_EXE = runtime.file
export const NODE_ENV = runtime.env
export const isRealNode = (p = NODE_EXE) => Boolean(p) && p === NODE_EXE
