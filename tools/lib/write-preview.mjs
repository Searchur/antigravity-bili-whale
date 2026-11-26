import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { config } from './config.mjs'
import { credentialsPath, dataPath } from './paths.mjs'
import { atomicWriteJson } from './life-persistence.mjs'

const MAX_AGE_MS = 10 * 60_000
const digest = value => createHash('sha256').update(value).digest('hex')

/** Record a validated preview or claim it once before making a remote write. */
export function requireWritePreview(command, payload, { dry, credentials, attachment } = {}) {
  const current = config({ fresh: true })
  const login = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))
  if (!login?.sessdata || (credentials && (credentials.sessdata !== login.sessdata || credentials.bili_jct !== login.bili_jct))) {
    throw Error('登录态已变化，请重新预览后再执行')
  }
  const attachmentHash = attachment ? digest(Buffer.isBuffer(attachment) ? attachment : fs.readFileSync(attachment)) : null
  const key = digest(JSON.stringify([command, login.sessdata, login.bili_jct, current.self?.mid, current.owner?.mid, payload, attachmentHash]))
  const dir = dataPath('write-previews')
  const file = path.join(dir, `${key}.json`)
  const now = Date.now()
  if (dry) {
    atomicWriteJson(file, { at: now })
    for (const name of fs.readdirSync(dir)) {
      if (!/^[a-f0-9-]{64,101}\.json$/.test(name) || name === `${key}.json`) continue
      const entry = path.join(dir, name)
      try { if (now - fs.lstatSync(entry).mtimeMs > MAX_AGE_MS) fs.rmSync(entry, { force: true }) } catch {}
    }
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
    if (!Number.isFinite(at) || at > now || now - at > MAX_AGE_MS) throw Error('预览已过期，请重新执行 --dry')
  } finally {
    fs.rmSync(claimed, { force: true })
  }
}
