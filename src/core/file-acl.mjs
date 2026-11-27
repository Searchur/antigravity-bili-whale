/**
 * 敏感文件权限收紧工具（Windows icacls 仅当前用户可读，POSIX chmod 0600）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export function protectPrivateFile(file, { ErrorClass = Error } = {}) {
  if (process.platform !== 'win32') { fs.chmodSync(file, 0o600); return }
  const options = { encoding: 'utf8', windowsHide: true, timeout: 10000 }
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  const sid = execFileSync(path.join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], options).match(/S-1-\d+(?:-\d+)+/)?.[0]
  if (!sid) throw new ErrorClass('无法确认当前 Windows 用户，未保存凭据。')
  execFileSync(path.join(system, 'icacls.exe'), [file, '/reset', '/Q'], options)
  execFileSync(path.join(system, 'icacls.exe'), [file, '/inheritance:r', '/grant:r', `*${sid}:(F)`, '/Q'], options)
}
