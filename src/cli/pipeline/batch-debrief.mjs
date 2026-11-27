import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {workDirPath} from '../../core/paths.mjs'
import {batchDebrief} from './pipeline.mjs'
function resolveAllowedListFile(raw){
 const resolved=path.resolve(String(raw||''))
 const roots=[path.resolve(workDirPath),path.resolve(os.tmpdir())]
 const inside=roots.some(root=>{const rel=path.relative(root,resolved);return rel!==''&&!rel.startsWith('..')&&!path.isAbsolute(rel)})
 if(!inside)throw Error('--from 文件仅允许位于数据工作目录（runtime/workspace）或系统临时目录内')
 return resolved
}
const argv=process.argv.slice(2),get=k=>{const i=argv.indexOf(k);return i>=0?argv[i+1]:undefined}
try{
 if(argv.includes('--no-frames'))throw Error('已移除 --no-frames 纯文字看片模式；深看视频统一按设置抽帧看画面')
 const bvs=argv.filter(x=>/^BV[0-9A-Za-z]{10}$/.test(x))
 if(get('--from'))bvs.push(...fs.readFileSync(resolveAllowedListFile(get('--from')),'utf8').split(/\s+/).filter(Boolean))
 const r=await batchDebrief(bvs,{concurrency:get('--concurrency'),samplePages:Number(get('--sample-pages')??1)})
 console.log(JSON.stringify(r))
 if(r.failed.length)process.exitCode=1
}catch(e){console.error(e.message);process.exitCode=1}
