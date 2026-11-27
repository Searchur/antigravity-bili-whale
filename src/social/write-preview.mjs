import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { config } from '../config/index.mjs'
import { credentialsPath, dataPath } from '../core/paths.mjs'
import { atomicWriteJson } from '../core/atomic-json.mjs'

const MAX_AGE_MS = 10 * 60_000
const CLOCK_SKEW_MS = 5_000
const digest = value => createHash('sha256').update(value).digest('hex')
const cleanCred = v => String(v ?? '').replace(/^["'\s]+|["'\s]+$/g, '')

function pruneExpired(dir, now, keepName = '') {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^[a-f0-9-]{64,101}\.json$/.test(name) || name === keepName) continue
      const entry = path.join(dir, name)
      try { if (now - fs.lstatSync(entry).mtimeMs > MAX_AGE_MS) fs.rmSync(entry, { force: true }) } catch {}
    }
  } catch {}
}

/** Record a validated preview or claim it once before making a remote write. */
export function requireWritePreview(command, payload, { dry, credentials, attachment } = {}) {
  const current = config({ fresh: true })
  const rawLogin = JSON.parse(fs.readFileSync(credentialsPath, 'utf8').replace(/^\uFEFF/, ''))
  const login = { sessdata: cleanCred(rawLogin?.sessdata), bili_jct: cleanCred(rawLogin?.bili_jct) }
  const expected = credentials ? { sessdata: cleanCred(credentials.sessdata), bili_jct: cleanCred(credentials.bili_jct) } : null
  if (!login.sessdata || (expected && (expected.sessdata !== login.sessdata || expected.bili_jct !== login.bili_jct))) {
    throw Error('登录态已变化，请重新预览后再执行')
  }
  const attachmentHash = attachment ? digest(Buffer.isBuffer(attachment) ? attachment : fs.readFileSync(attachment)) : null
  const key = digest(JSON.stringify([command, login.sessdata, login.bili_jct, current.self?.mid, current.owner?.mid, payload, attachmentHash]))
  const dir = dataPath('write-previews')
  const file = path.join(dir, `${key}.json`)
  const now = Date.now()
  if (dry) {
    atomicWriteJson(file, { at: now })
    pruneExpired(dir, now, `${key}.json`)
    return
  }

  const claimed = path.join(dir, `${key}-${randomUUID()}.json`)
  try { fs.renameSync(file, claimed) }
  catch (err) {
    if (err.code !== 'ENOENT') throw err
    throw Error('缺少匹配的预览。请用相同的账号、目标和内容先执行 --dry')
  }
  try {
    const { at } = JSON.parse(fs.readFileSync(claimed, 'utf8'))
    if (!Number.isFinite(at) || at > now + CLOCK_SKEW_MS || now - at > MAX_AGE_MS) throw Error('预览已过期，请重新执行 --dry')
  } finally {
    fs.rmSync(claimed, { force: true })
    pruneExpired(dir, now)
  }
}
