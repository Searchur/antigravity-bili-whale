/**
 * CLI 诊断工具 `whois`：按 UID 查询 B 站账号基础资料（只读）。
 */
import { biliJson } from '../../bili/api.mjs'
import { biliHeaders, loadCred } from '../../bili/cookie.mjs'

const headers = biliHeaders(loadCred())
const nav = await biliJson('nav', { headers, noCache: true })
const keys = nav.data?.wbi_img ?? null
for (const mid of process.argv.slice(2)) {
  const d = await biliJson('profile', { headers, keys, noCache: true, query: { mid } })
  if (d.code !== 0) { console.log(`mid ${mid}: code=${d.code} ${d.message}`); continue }
  console.log(`mid ${mid}  →  昵称【${d.data.name}】  签名: ${String(d.data.sign ?? '').slice(0, 60)}`)
}
