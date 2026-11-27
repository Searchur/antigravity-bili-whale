/**
 * B 站登录凭据原子存储：校验 Cookie 格式、防请求头注入、写盘收紧权限并保障失败回滚。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { protectPrivateFile } from '../core/file-acl.mjs'

export class AuthError extends Error {}

/** 保持既有凭据 JSON 格式；在发起任何网络请求前先拦截请求头注入字符。 */
export function parseManualCookie(input = {}) {
  const pick = (raw, key) => {
    const value = String(raw ?? '').trim()
    const match = value.match(new RegExp('(?:^|;)\\s*' + key + '=([^;]+)', 'i'))
    return (match ? match[1] : value.replace(new RegExp('^' + key + '\\s*=', 'i'), ''))
      .replace(/^["'\s]+|["';\s]+$/g, '').trim()
  }
  const credentials = {
    sessdata: pick(input.sessdata, 'SESSDATA'),
    bili_jct: pick(input.bili_jct, 'bili_jct'),
    buvid3: pick(input.buvid3, 'buvid3'),
  }
  if (credentials.sessdata.length < 20 || credentials.sessdata.length > 8192
    || !/^[0-9a-fA-F]{32}$/.test(credentials.bili_jct)
    || Object.values(credentials).some(value => /[\r\n;\x00-\x1f\x7f]/.test(value) || value.length > 8192))
    throw new AuthError('凭据不完整或格式无效，请重新扫码登录。')
  return credentials
}

export function protectCredentials(file) {
  return protectPrivateFile(file, { ErrorClass: AuthError })
}

function read(file) {
  try { return fs.readFileSync(file, 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

/** 扫码与导入共用同一写入入口；提交前的任何失败均保留原有凭据不受影响。 */
export function createCredentialStore({ file, verify, protect = protectCredentials }) {
  let tail = Promise.resolve()
  const save = (input, { signal, check = () => {} } = {}) => {
    const task = tail.then(async () => {
      check()
      const credentials = parseManualCookie(input)
      const oldText = read(file)
      const account = await verify(credentials, { signal })
      check()
      if (signal?.aborted) throw new AuthError('登录已取消，未保存。')
      if (read(file) !== oldText) throw new AuthError('登录态已在别处变化，请重新扫码。')
      const temp = `${file}.${randomUUID()}.tmp`
      try {
        if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw Error()
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const fd = fs.openSync(temp, 'wx', 0o600)
        try {
          // 在写入凭据前先收紧空文件的访问权限。
          protect(temp)
          check()
          fs.writeFileSync(fd, JSON.stringify(credentials, null, 2) + '\n')
          fs.fsyncSync(fd)
        } finally { fs.closeSync(fd) }
        fs.renameSync(temp, file)
      } catch (error) {
        if (error instanceof AuthError) throw error
        throw new AuthError('凭据保存失败，旧登录态未替换；请检查文件权限。')
      } finally {
        if (fs.existsSync(temp)) fs.unlinkSync(temp)
      }
      return account
    })
    tail = task.catch(() => {})
    return task
  }
  return { save }
}
