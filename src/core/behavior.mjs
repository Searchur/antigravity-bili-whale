/**
 * 内置行为规范章节加载器：列出与读取 `behavior/` 目录下的规范文档。
 */
import fs from 'node:fs'
import path from 'node:path'
import { behaviorRoot } from './paths.mjs'
export const BEHAVIOR_ROOT = behaviorRoot
export const BEHAVIOR_IDS=['common','private-reply','private-recommendation','public-comment','public-reply','browse','formation','memory','stickers','tools']
export function loadBehavior(ids,{root=BEHAVIOR_ROOT}={}){
 return [...new Set(ids)].map(id=>{
  if(!BEHAVIOR_IDS.includes(id))throw Error('未知规范章节')
  const file=path.join(root,id+'.md')
  return {id,text:fs.readFileSync(file,'utf8'),path:file}
 })
}
export function behaviorSections(scene,role,taskKind){
 if(taskKind==='fan-dm')return ['common']
 if(role==='browse-main')return ['common','browse','public-comment']
 const section=({'private-reply':'private-reply','private-recommendation':'private-recommendation','public-comment':'public-comment','reply':'public-reply','public-recommendation':'public-comment'}[scene])
 if(!section)throw Error('未知规范场景')
 return ['common',section]
}
