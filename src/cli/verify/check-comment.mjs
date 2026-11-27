/**
 * CLI 核验命令 `check-comment`：回读校验指定评论是否已公开可见。
 */
import fs from 'node:fs'
import {credentialsPath} from '../../core/paths.mjs'
import {verifyCommentVisibility} from '../../social/comment-visibility.mjs'
const [rpid,oid,...args]=process.argv.slice(2)
if(!rpid||!oid){console.error('用法: check-comment <rpid> <oid> [bvid] [--root <root>] [--type <1|11|17>]');process.exit(2)}
const bvid=args[0]?.startsWith('BV')?args.shift():''
const option=name=>{const i=args.indexOf('--'+name);return i<0?'':args[i+1]??''}
const headers={'user-agent':'Mozilla/5.0','referer':bvid?'https://www.bilibili.com/video/'+bvid+'/':'https://www.bilibili.com/'}
try{const c=JSON.parse(fs.readFileSync(credentialsPath,'utf8'));headers.cookie=`SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct}`}catch{}
const result=await verifyCommentVisibility({rpid,oid,root:option('root'),type:option('type')||'1',headers})
console.log(JSON.stringify(result,null,2))
// 有限抽样未见不代表未送达，绝不引导重复发送。
