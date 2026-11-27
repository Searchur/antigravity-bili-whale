import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { bundledStickerRoot, userStickerRoot } from './paths.mjs'

/**
 * 优先使用用户独立数据目录下的自定义 stickers/（若存在 index.json），
 * 否则开箱直接读取插件随包自带的 42 张表情包，无需手动复制。
 */
export function resolveStickerRoot() {
  try {
    if (fs.statSync(path.join(userStickerRoot, 'index.json')).isFile()) return userStickerRoot
  } catch {}
  return bundledStickerRoot
}

export const STICKER_ROOT = resolveStickerRoot()

function catalog(root) {
  try {
    const file = path.join(root, 'index.json')
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262144) throw Error('表情包目录无效')
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)))
    if (!Array.isArray(data.stickers) || data.stickers.length > 256) throw Error('表情包目录超限或无效')
    return data.stickers
      .filter(s => typeof s.path === 'string' && s.path)
      .map(s => ({
        id: crypto.createHash('sha256').update(s.path).digest('hex').slice(0, 16),
        name: String(s.cn ?? s.file ?? s.mood ?? '').slice(0, 80),
        mood: String(s.mood ?? '').slice(0, 40),
        description: String(s.desc ?? '').slice(0, 200),
        file: s.path,
      }))
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
}

export function listStickers({ root = resolveStickerRoot(), offset = 0 } = {}) {
  if (!Number.isInteger(offset) || offset < 0 || offset > 256) throw Error('表情包分页无效')
  const rows = catalog(root)
  const end = offset + 20
  return { total: rows.length, items: rows.slice(offset, end).map(({ file, ...row }) => row), nextOffset: end < rows.length ? end : null }
}

export function getSticker(id, { root = resolveStickerRoot() } = {}) {
  const matches = catalog(root).filter(x => x.id === id || x.name === id || x.mood === id)
  if (matches.length !== 1) throw Error(matches.length ? '表情名称有歧义，请使用ID' : '表情包不存在')
  const row = matches[0]
  const file = path.resolve(root, row.file)
  const relative = path.relative(path.resolve(root), file)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !/\.(png|jpg|jpeg|gif|webp)$/i.test(path.extname(file))) {
    throw Error('表情包路径无效')
  }
  const stat = fs.lstatSync(file)
  const realRoot = fs.realpathSync(root)
  const resolved = path.relative(realRoot, fs.realpathSync(file))
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10485760 || resolved.startsWith('..') || path.isAbsolute(resolved)) {
    throw Error('表情包文件无效或越界')
  }
  const { file: _ignored, ...metadata } = row
  return { ...metadata, path: file }
}

export function stickerHint(options) {
  const data = listStickers(options)
  if (!data.total) return ''
  return '表情包 ' + data.total + ' 张：' + JSON.stringify(data.items.slice(0, 8).map(x => x.name || x.mood)) + '。需要时用 bili_read（stickers list / stickers get）取准确路径；可配图，也可不配。'
}
