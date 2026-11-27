/**
 * 脱敏轻量诊断输出器：仅输出事件分类与错误类型，严禁泄露 Cookie 或消息正文。
 */
// 严禁在此记录任意异常原文，以免泄露 Cookie 或消息正文。
export function createDiagnostics({emit=message=>console.warn(message),now=Date.now,intervalMs=300000}={}){
  const seen=new Map()
  return (category,error)=>{
    const code=String(error?.code??error?.name??'error').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,60)
    const key=category+':'+code,previous=seen.get(key)
    if(previous!==undefined&&now()-previous<intervalMs)return false
    if(seen.size>=200)seen.delete(seen.keys().next().value)
    seen.set(key,now());try{emit(`[bili-whale] ${category} (${code})`)}catch{/* 诊断输出异常不得中断清理流程。 */}
    return true
  }
}
export const diagnose=createDiagnostics()
