export const HARD_RULE_IDS=['form:too-long','form:long']
export function hardPolicyPrompt(scene,options={}){
 const mode=options.hardMode??'off'
 if(mode==='off'||!(options.hardScenes??['public-comment']).includes(scene))return ''
 return `长度设置：超过 ${options.hardWarnAt??0} 字提醒，超过 ${options.hardMaxChars??1000} 字${mode==='enforce'?'拒绝':'提醒'}；不要求固定字数。`
}
export function checkHard(text,scene,options={}){
 const characters=Array.from(String(text)).length,mode=options.hardMode??'off'
 const result={ok:true,level:null,code:null,hint:null,errors:[],warnings:[],characters,displayCharacters:Array.from(String(text).replace(/\[[^\[\]\r\n]{1,120}\]/gu,'□')).length,applied:mode!=='off'&&(options.hardScenes??['public-comment']).includes(scene)}
 if(!result.applied)return result
 const maxChars=options.hardMaxChars??1000,warnAt=options.hardWarnAt??0
 const code=characters>maxChars?'form:too-long':(warnAt>0&&characters>warnAt)?'form:long':null
 if(code&&!(options.hardDisabledRules??[]).includes(code)){
  const item={code,level:'L3',match:String(characters),hint:'检查是否有重复铺垫，保留真正想说的反应。'}
  result[code==='form:too-long'&&mode==='enforce'?'errors':'warnings'].push(item);Object.assign(result,item)
 }
 result.ok=!result.errors.length;return result
}
export const hardMessage=r=>[...r.errors.map(e=>'[拒绝 '+e.code+'] '+e.hint),...r.warnings.map(e=>'[提醒 '+e.code+'] '+e.hint)].join('\n')
export function assertHard(text,scene,options={},warn=()=>{}){
 const result=checkHard(text,scene,options)
 if(!result.ok)throw Object.assign(Error(hardMessage(result)),{code:'EXPRESSION_HARD_REJECTED',result})
 if(result.warnings.length)warn(hardMessage(result));return result
}
