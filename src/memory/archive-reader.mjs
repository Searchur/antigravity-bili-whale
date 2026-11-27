/**
 * 长期记忆冷归档文件的纯只读加载与 SHA-256 摘要校验器。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const archiveDigest = raw => crypto.createHash('sha256').update(raw).digest('hex')

export function readLifeArchive(dir, entry, maxBytes = Infinity) {
  const name = entry?.name
  if (typeof name !== 'string' || name !== path.basename(name) || !name.endsWith('.json')) throw Error('归档名称无效')
  const file = path.join(dir, 'archive', name)
  if (fs.statSync(file).size > maxBytes) throw Error('归档超过单次读取上限')
  const raw = fs.readFileSync(file)
  if (raw.length > maxBytes) throw Error('归档超过单次读取上限')
  if (archiveDigest(raw) !== entry.digest) throw Error('归档校验失败')
  const data = JSON.parse(raw.toString('utf8'))
  if (!Array.isArray(data?.events)) throw Error('归档格式无效')
  return { data, size: raw.length }
}
