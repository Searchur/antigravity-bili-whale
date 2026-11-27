/**
 * 单轮唤醒生命周期与超时强释放运行器：保证同时最多仅有一轮唤醒任务在途。
 */
import crypto from 'node:crypto'
import {setTimeout,clearTimeout} from 'node:timers'

// 本地租约独立于宿主取消能力自动过期。
// 每次异步续接产生副作用前都必须先校验租约有效性。
export function createWakeRunner({now=Date.now,timeoutMs=300_000,signal,onChange=()=>{},onForced=()=>{}}={}){
  let active=null
  const emit=(lease,status,error)=>{try{onChange(lease,status,error)}catch{}}
  function cancel(lease,reason){
    if(active!==lease||!lease.valid)return
    lease.valid=false;lease.error=reason;active=null
    clearTimeout(lease.timer)
    // 先释放所有权，避免观察者或中止回调长期占用租约。
    try{lease.controller?.abort(reason)}catch{}
    try{onForced(lease,reason)}catch{}
    lease.reject?.(reason)
    emit(lease,'released',reason)
  }
  return {
    get current(){return active},
    expire(){
      if(active&&now()-active.startedAt>=timeoutMs)cancel(active,Object.assign(Error('整轮唤醒超过本地等待上限，已强制释放'),{code:'WAKE_FORCED_RELEASE'}))
    },
    stop(){if(active)cancel(active,Object.assign(Error('调度器已停止'),{code:'WAKE_STOPPED'}))},
    async run(body){
      if(active)return
      const lease={id:crypto.randomUUID(),startedAt:now(),stage:'initializing',valid:true}
      active=lease
      let parentAbort
      try{
        const cancelled=new Promise((_,reject)=>{lease.reject=reject})
        lease.check=()=>{if(active!==lease||!lease.valid)throw lease.error??Error('唤醒任务已失效')}
        lease.phase=(stage,details={})=>{lease.check();Object.assign(lease,details,{stage});emit(lease,'running')}
        // 获取所有权之后的全部逻辑（含运行时 API 初始化）
        // 均放入 try/finally 中管理，不依赖 AbortSignal.any。
        lease.controller=new AbortController();lease.signal=lease.controller.signal
        parentAbort=()=>cancel(lease,Object.assign(Error('调度器已停止'),{code:'WAKE_STOPPED'}))
        signal?.addEventListener('abort',parentAbort,{once:true})
        lease.timer=setTimeout(()=>cancel(lease,Object.assign(Error('整轮唤醒超过本地等待上限，已强制释放'),{code:'WAKE_FORCED_RELEASE'})),timeoutMs)
        emit(lease,'running')
        if(signal?.aborted)parentAbort()
        return await Promise.race([cancelled,Promise.resolve().then(()=>{lease.check();return body(lease)})])
      }catch(error){
        if(active===lease)emit(lease,'failed',error)
        throw error
      }finally{
        clearTimeout(lease.timer)
        try{signal?.removeEventListener('abort',parentAbort)}catch{}
        if(active===lease){active=null;lease.valid=false;emit(lease,'idle')}
      }
    },
  }
}
