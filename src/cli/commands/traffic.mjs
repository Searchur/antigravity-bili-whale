/**
 * CLI 命令 `traffic`：只读查询 B 站接口防风控与限流熔断状态。
 */
import { trafficGuard, riskSettings } from '../../bili/traffic.mjs'
import { biliHeaders, loadCred } from '../../bili/cookie.mjs'
import { biliOperationLabel } from '../../bili/endpoints.mjs'
const [command='status', ...args] = process.argv.slice(2)
const value = flag => args[args.indexOf(flag)+1]
try {
  const guard=trafficGuard()
  if(command==='status') {
    const s=guard.status()
    const { cooldown } = guard.pauseStatus({})
    const last = s.last ? { ...s.last, label: biliOperationLabel(s.last.operation, s.last.method, s.last.endpoint) } : null
    console.log(JSON.stringify({settings:riskSettings(),pausedUntil:cooldown?.until??null,reason:cooldown?.reason??null,manualAccounts:Object.keys(s.manual??{}).length,accounts:s.accounts??{},pending:Object.entries(s.operations??{}).filter(([,v])=>['unknown','pending'].includes(v.status)).map(([id,v])=>({id,...v})),last},null,2))
  } else if(command==='resume' && args.includes('--go')) {
    await guard.resume(biliHeaders(loadCred()))
    console.log('已解除当前账号的人工处理暂停；平台等待时间和发送记录仍保留。')
  } else if(command==='resolve' && args.includes('--go') && args.includes('--id') && args.includes('--outcome')) {
    await guard.resolve(value('--id'),value('--outcome'))
    console.log('已记录人工核查结果。')
  } else { console.error('用法：traffic status | resume --go（人工处理登录/验证码后）| resolve --id ID --outcome confirmed|not-sent --go（回读核查后）');process.exitCode=2 }
} catch(e) {console.error(e.message);process.exitCode=1}
