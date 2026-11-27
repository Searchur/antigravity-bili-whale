import { config } from './config.mjs'
import { createLifeStore } from './life-store.mjs'
import { trackQuotaOperation } from './quota-ledger.mjs'
export function lifeStore(cfg=config(),extra={}) {
  return createLifeStore({account:String(cfg.self?.mid??''),owner:String(cfg.owner?.mid??''),ownerName:String(cfg.owner?.name??''),config:cfg.life,fullConfig:()=>config({fresh:true}),...extra})
}
export const threadKey=(type,oid,root)=>[String(type??1),String(oid),String(root||'top')].join(':')
export async function guardSend(request,{dry=false}={}) {
  const cfg = config()
  const store=lifeStore(cfg)
  // Preferences are evaluated inside reserve as well; a concurrent approval
  // must not leave a check-to-send bypass window.
  request.ownerName=String(config().owner?.name??'')
  const result=store.check(request)
  if(!result.allow)throw Error(result.reason)
  if(dry)return {store,token:null}
  const token = await store.reserve(request)
  if (request.quotaTarget) {
    try { trackQuotaOperation(token, String(cfg.self.mid), String(cfg.owner.mid)) }
    catch (error) {
      await store.settle(token, { status: 'not-sent', verified: true })
      throw error
    }
  }
  return { store, token }
}
