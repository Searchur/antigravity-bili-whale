/**
 * 基于 AsyncLocalStorage 的操作取消信号上下文传播与中止检查。
 */
import {AsyncLocalStorage} from 'node:async_hooks'
const operations=new AsyncLocalStorage()
export const withOperationSignal=(signal,fn)=>operations.run(signal,fn)
export function checkOperation(){operations.getStore()?.throwIfAborted()}
