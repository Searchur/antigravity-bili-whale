/**
 * CLI 命令 `config`：只读输出当前归一化后的运行与管线配置摘要。
 */
import { pipelineConfig } from '../pipeline/config.mjs'

const [action = 'show'] = process.argv.slice(2)
try {
  if (action === 'show') {
    console.log(JSON.stringify(pipelineConfig(), null, 2))
  } else {
    throw Error('config 仅支持只读查看（config show）；修改设置请前往 Antigravity 控制台界面。')
  }
} catch (e) {
  console.error(e.message)
  process.exitCode = 2
}
