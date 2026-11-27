export const CHAT_DEFAULTS=Object.freeze({multi:true,maxParts:6,followup:false,dailyMax:3,dynamic:false,dynamicDailyMax:1,autoComment:true,autoCommentDailyMax:3})
export function chatConfig(input={}) {
  const out={...CHAT_DEFAULTS}
  for(const key of ['multi','followup','dynamic','autoComment'])if(typeof input?.[key]==='boolean')out[key]=input[key]
  for(const [key,min,max] of [['maxParts',1,6],['dailyMax',0,3],['dynamicDailyMax',1,2],['autoCommentDailyMax',1,10]]){
    const n=Number(input?.[key]);if(input?.[key]!=null&&Number.isFinite(n))out[key]=Math.max(min,Math.min(max,Math.floor(n)))
  }
  return out
}
