/**
 * 基于文件 stat 校验的只读 JSON 缓存：自动剥离 UTF-8 BOM，文件变动即时失效。
 */
import fs from 'node:fs'
// 每次读取均校验文件 stat；原子替换或编辑立即失效，异常绝不返回旧缓存。
export function createJsonCache(){
  const entries=new Map()
  const read=file=>{
    try{
      const st=fs.statSync(file,{bigint:true}),stamp=[st.dev,st.ino,st.size,st.mtimeNs,st.ctimeNs].join(':')
      if(entries.get(file)?.stamp===stamp)return structuredClone(entries.get(file).value)
      const raw=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')
      const value=JSON.parse(raw)
      if(entries.size>=32)entries.delete(entries.keys().next().value)
      entries.set(file,{stamp,value});return structuredClone(value)
    }catch(e){entries.delete(file);throw e}
  }
  return {read,clear:()=>entries.clear()}
}
