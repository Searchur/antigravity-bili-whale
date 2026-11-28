/**
 * 单轮自主浏览编排器：串联候选发现、优选深看与结构化结果汇总。
 */
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import { workDirPath } from '../../core/paths.mjs'
import {config} from '../../config/index.mjs'
import {atomicWriteJson} from '../../core/atomic-json.mjs'
import {pipelineConfig} from './config.mjs'
import {discover,batchDebrief,collectTags,relatedCollect} from './pipeline.mjs'
export async function runRound(argv=process.argv.slice(2)){
 if(argv.includes('--no-frames'))throw Error('已移除 --no-frames 纯文字看片模式；深看视频统一按设置抽帧看画面')
 const start=Date.now(),cfg=config(),p=pipelineConfig(cfg),arg=name=>{const i=argv.indexOf(name);return i<0?undefined:argv[i+1]}
 const defaultN=Math.min(20,Math.max(1,Number(cfg.night?.maxVideos??5)||5))
 const n=Number(arg('--n')??defaultN)
 if(!Number.isInteger(n)||n<1||n>20)throw Error('--n 必须为 1–20')
 const args=['--n',String(n),'--per',String(Math.max(2,Math.ceil(n/Math.max(1,cfg.preferences?.like?.length??1))))]
 for(let i=0;i<argv.length;i++)if(argv[i]==='--kw'){if(!argv[i+1]||argv[i+1].startsWith('--'))throw Error('--kw 缺少关键词');args.push('--kw',argv[++i])}
 const explicitCount=args.filter(x=>x==='--kw').length;if(explicitCount)args[3]=String(Math.max(2,Math.ceil(n/explicitCount)))
 const selection=await discover(args),result={schema:'whale.round/1',at:new Date().toISOString(),dry:argv.includes('--dry'),selection,warnings:[],timings:{discoveryMs:Date.now()-start}}
 if(!result.dry&&selection.items.length){
  const take=p.deepReadMax==='all'?selection.items.length:p.deepReadMax
  const deepStart=Date.now()
  result.batch=await batchDebrief(selection.items.slice(0,take).map(x=>x.bv),{samplePages:Number(arg('--sample-pages')??1)})
  result.timings.debriefMs=Date.now()-deepStart
  if(result.batch.ok.length){
   const tagsStart=Date.now()
   try{result.tags=await collectTags(result.batch.ok)}catch(e){result.warnings.push('标签统计未完成：'+e.message)}
   result.timings.tagsMs=Date.now()-tagsStart
   const relatedStart=Date.now()
   if(!argv.includes('--no-related'))try{result.related=await relatedCollect(result.batch.ok);if(result.related.length)result.relatedTags=await collectTags(result.related.map(x=>x.bv),{kind:'related'})}catch(e){result.warnings.push('相关推荐未完成：'+e.message)}
   result.timings.relatedMs=Date.now()-relatedStart
  }
 }
 result.elapsedMs=Date.now()-start
 if(!result.dry){const file=path.join(workDirPath, 'rounds', Date.now() + '-' + process.pid + '.json');atomicWriteJson(file,result);result.file=file}
 return result
}
function roundFallback(r){
 const picked=r.selection?.items??[],read=r.batch?.ok??[]
 const lines=[`本轮 ${picked.length} 条，深读 ${read.length} 条，用时 ${(r.elapsedMs/1000).toFixed(1)}s`]
 for(const it of picked)lines.push(`  ${it.bv}  ${it.t}`)
 if(r.batch?.failed?.length)lines.push(`  深读失败: ${r.batch.failed.map(x=>x.bv??x).join(', ')}`)
 if(r.file)lines.push(`存档 ${r.file}`)
 return lines.join('\n')
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{
  const r=await runRound()
  if(process.argv.includes('--json'))console.log(JSON.stringify(r))
  else console.log(roundFallback(r))
  if(r.batch?.failed.length)process.exitCode=1
 }catch(e){console.error(e.message);process.exitCode=1}
}
