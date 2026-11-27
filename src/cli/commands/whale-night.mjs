// Shared planning engine: absolute timestamps and persistent per-window history.
import fs from 'node:fs'
import { dshPath } from '../../core/paths.mjs'
import { readNightConfig } from '../../config/night.mjs'
import { makePlan, completePlan, dayOf } from '../../config/night-plan.mjs'
import { atomicWriteJson } from '../../core/atomic-json.mjs'
import { callSidecarIpc } from '../../host/sidecar-ipc.mjs'
import { readSchedulerHealth } from '../../daemon/scheduler-health.mjs'
import { deliveryStatus } from '../../daemon/delivery-state.mjs'
const STATE = dshPath('whale-night.json')
const IPC_FILE = dshPath('sidecar-ipc.json')
const load = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return {} } }
const save = (file, value) => atomicWriteJson(file, value)
const [cmd, ...args] = process.argv.slice(2)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
if (cmd === 'trigger') {
  try{
    if(args.length!==1||!['--dry','--go'].includes(args[0]))throw Error('用法: night trigger --dry 或 night trigger --go；必须明确选择')
    const dry=args[0]==='--dry'
    const result=await callSidecarIpc(dry?'/status':'/wake-now',dry?{file:IPC_FILE}:{method:'POST',timeoutMs:90_000,file:IPC_FILE})
    if(!result.running||result.ok===false)throw Error(result.error||'后台守护未连接')
    if(dry&&!result.schedulerStatus?.rpcAvailable)throw Error('后台守护尚未连接 Antigravity 会话接口')
    console.log(JSON.stringify(dry?{ok:true,dry:true,note:'将请求控制台的立即唤醒服务；执行时由后台守护校验登录、作息状态和模型配额'}:result,null,2))
  }catch(e){console.error(e.message);process.exitCode=2}
} else if (cmd === 'plan') {
  const p = makePlan(readNightConfig(), load())
  save(STATE, p)
  console.log(JSON.stringify(p, null, 2))
} else if (cmd === 'mark') {
  save(dshPath('whale-wake'), { date: dayOf(), at: new Date().toISOString(), by: 'task' })
  console.log('已留唤醒标记')
} else if (cmd === 'status') {
  console.log(JSON.stringify({ config: readNightConfig(), state: load(), scheduler:readSchedulerHealth(dshPath()),delivery:deliveryStatus(dshPath()) }, null, 2))
} else if (cmd === 'clock') {
  if (args.includes('--test')) {
    await sleep(Math.max(0, Number(args[args.indexOf('--test') + 1] ?? 5)) * 1000)
    console.log('WHALE_WAKE (test; 不修改正式计划)')
  } else {
    const p = makePlan(readNightConfig(), load())
    save(STATE, p)
    if (p.action === 'done') console.log('WHALE_DONE ' + p.reason)
    else {
      while (Date.now() < p.atMs) {
        await sleep(Math.min(60000, p.atMs - Date.now()))
        const current = load()
        if (current.fired || current.atMs !== p.atMs || current.action !== p.action) {
          console.log('WHALE_DONE 计划已由宿主处理或更新'); process.exit(0)
        }
      }
      if (Date.now() >= p.endsAt) console.log('WHALE_DONE 窗口已结束，不补发过期唤醒')
      else {
        save(STATE, completePlan(p))
        console.log(p.action === 'skip' ? 'WHALE_SKIP ' + p.reason : 'WHALE_WAKE at=' + p.atText)
      }
    }
  }
} else { console.error('用法: night plan | clock [--test 秒] | mark | status | trigger --dry/--go'); process.exitCode = 2 }
