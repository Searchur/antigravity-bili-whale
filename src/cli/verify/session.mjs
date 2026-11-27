import { guardedFetch as fetch } from '../../bili/traffic.mjs'
import { loadCred, missingForWrite, CRED_PATH } from '../../bili/cookie.mjs'

let cred
try {
  cred = loadCred()
  const miss = missingForWrite(cred)
  if (miss.length) {
    console.error(`凭据文件缺少字段：${miss.join(', ')}（请在控制台「大鲸鱼与主人」重新扫码登录）`)
    process.exit(3)
  }
} catch (e) {
  console.error(e.message)
  process.exit(3)
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', {
  headers: {
    'user-agent': UA,
    referer: 'https://www.bilibili.com/',
    cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`,
  },
})).json()
if (nav.code !== 0) {
  console.error(`登录态无效: code=${nav.code} ${nav.message}（请在控制台「大鲸鱼与主人」重新扫码登录）`)
  process.exit(4)
}
console.log('凭据有效')
console.log(`  账号      : ${nav.data.uname}`)
console.log(`  UID       : ${nav.data.mid}`)
console.log(`  手机绑定  : ${nav.data.mobile_verified ? '是（发评论/动态需要）' : '否（可能无法发言）'}`)
console.log(`  硬币      : ${nav.data.money}   等级: ${nav.data.level_info?.current_level ?? '-'}`)
console.log(`  凭据文件  : ${CRED_PATH}`)
