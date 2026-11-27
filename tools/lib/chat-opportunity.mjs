import {chatConfig} from './chat-config.mjs'
import {normalizeListen} from './config.mjs'

const lastReply=(s,full)=>s.events.findLast(e=>e.kind==='sent'&&e.channel==='dm'&&String(e.target)===String(full.owner?.mid)&&e.data?.contentKind!=='image')

export function followupTurn(s,full){
  const owner=s.events.findLast(e=>e.kind==='received'&&(e.verifiedRole==='owner'||e.channel==='bili-dm'&&String(e.actor)===String(full.owner?.mid)))
  const reply=lastReply(s,full)
  if(owner?.channel!=='bili-dm'||owner.verifiedRole!=='owner'||String(owner.actor)!==String(full.owner?.mid)||owner.at!==s.affect.lastOwnerAt||
    !owner.text?.trim()||!reply?.text?.trim()||!reply.receipt||reply.data?.initiative||reply.data?.share||
    reply.seq<=owner.seq||reply.at<owner.at||reply.at-owner.at>=15*60000)return null
  return {owner,reply}
}

export function chatOpportunity(s,full,at){
  const c=chatConfig(full.chat),L=normalizeListen(full.listen),a=s.affect
  if(!a||!c.followup||!L.dmOwner||!a.lastOwnerAt)return null
  const last=lastReply(s,full)
  const anchor=Math.max(a.lastOwnerAt,last?.at??0)
  if(!last||last.data?.initiative||last.at<a.lastOwnerAt||last.at-a.lastOwnerAt>=15*60000||at-last.at<30000||at-last.at>5*60000||!followupTurn(s,full))return null
  const key='followup:'+a.lastOwnerAt // each incoming conversation may trigger at most one followup
  if((a.chatAttempts??[]).includes(key))return null
  return {kind:'followup',key,ownerAt:a.lastOwnerAt,anchor}
}
