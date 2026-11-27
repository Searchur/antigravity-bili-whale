#!/usr/bin/env node
/**
 * B 站统一 CLI 命令分发入口：解析子命令并路由至对应命令脚本、管线、核验或诊断模块。
 */
// 统一入口：node bili.mjs <命令> [参数...]
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NODE_EXE } from '../core/node-binary.mjs'
import { translateNamed } from '../core/cli-args.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const map = {
  behavior: ['commands/behavior.mjs', '场景规范 list / read <章节>'],
  stickers: ['commands/stickers.mjs', '表情包目录 list [offset] / get <ID或情绪名>'],
  life: ['commands/life.mjs', '长期记忆、上下文检索、决策记录与状态管理'],
  traffic: ['commands/traffic.mjs', '请求保护状态 / 人工核查后恢复'],
  // —— 读（只读安全操作） ——
  session: ['verify/session.mjs', '确认凭据属于哪个号'],
  thread: ['verify/thread.mjs', '导出一条评论的完整楼中楼结构'],
  'check-comment': ['verify/check-comment.mjs', '按 rpid 复核评论是否存在'],
  'check-dynamic': ['verify/check-dynamic.mjs', '看动态的结构化内容（类型/图片/节点）'],
  'check-mention': ['verify/check-mention.mjs', '确认动态里的 @ 是不是真提及（查 opus 页）'],
  'comment-digest': ['commands/comment-digest.mjs', '回复+@ 收件箱汇总（只读）：--hours 24 --pages 2 [--only-unread]'],
  recon: ['verify/recon.mjs', '发评论前的侦查：BV→aid + 评论区状态 + WBI 材料'],
  subtitles: ['commands/subtitles.mjs', '拉官方字幕辅助查看（WBI 签名，带时间戳）：<BV> [--lan ai-zh] [--print N]'],
  'watch-video': ['commands/watch-video.mjs', '抽帧看视频：取直链 → 抽帧拼图 → 返回画面：<BV> [2x2|3x3|4x4] [--every N] [--max-frames N] [--profile auto|owner|fan]'],
  debrief: ['commands/debrief.mjs', '看懂一条视频（一条龙）：封面+简介+官方字幕+弹幕热区+热评+画面抽帧：<BV> [--profile auto|owner|fan] [--confirmed] [--bucket 30] [--top 5]'],
  comments: ['commands/comments.mjs', '热评 / 最新评论（只读）：<BV> [--ps 20] [--pn 1] [--sort hot|time] [--json]'],
  round: ['pipeline/round.mjs', '一轮找片与深读汇总（不发送）：--n 6 --dry|--json'],
  discover: ['pipeline/discover.mjs', '按新鲜度与排除偏好选片：--n 6 --kw 关键词 --json'],
  'batch-debrief': ['pipeline/batch-debrief.mjs', '有限并发深读：<BV...> [--concurrency 2]'],
  config: ['commands/config.mjs', '选片流程配置只读查看：show'],
  feed: ['commands/feed.mjs', '选题器（只读）：按偏好捞候选，排除已看/已评视频：[--n 6] [--per 2]'],
  quota: ['commands/quota.mjs', '限额闸：status / check --auto|--share / record'],
  likes: ['commands/likes.mjs', '收到的赞通知流（含点赞者 mid/昵称）：--hours 24 [--owner] [--json]'],
  selftest: ['commands/selftest.mjs', '启动自检：配置、登录态与核心脚本'],
  deps: ['commands/deps.mjs', '依赖体检：Node / ffmpeg / 登录态 / 限流与风控；--json'],
  night: ['commands/night.mjs', '生物钟：status / plan / trigger --dry|--go'],
  search: ['commands/search.mjs', '按关键词搜视频（WBI 签名）：标题/UP/播放/简介/标签'],
  covers: ['diagnostics/covers.mjs', '抓视频元信息 + 封面图存到 cache/shots/covers/'],
  whois: ['diagnostics/whois.mjs', '按 mid 查昵称（@ 人前先核准名字）'],
  // —— 写（都必须显式 --dry 或 --go） ——
  'dm-await': ['commands/dm-await.mjs', '私信监听（主人 + 可选已关注粉丝；由后台守护调用）'],
  like: ['commands/like.mjs', '单条视频点赞 <BV> --dry|--go|--check，核对账号并回读'],
  follow: ['commands/follow.mjs', '关注一个 UP <mid> --dry|--go|--check，核对账号并回读'],
  fav: ['commands/favorites.mjs', '收藏视频：--list / --check / <BV> --reason … --dry|--go'],
  dm: ['commands/dm.mjs', '私信：主人私信或持有效来信回执回复已关注粉丝，强制 --dry/--go'],
  'dm-batch': ['commands/dm-batch.mjs', '主人多段私信：--file 字符串数组.json --task <taskId> --dry|--go；--resume 组ID --dry|--go'],
  comment: ['commands/comment.mjs', '发视频评论或二级回复（支持 --share / --auto / --pic），强制 --dry/--go'],
  'comment-del': ['commands/comment-delete.mjs', '删除自己发的一条评论（x/v2/reply/del，只能删自己的）'],
  dynamic: ['commands/dynamic.mjs', '动态：post / rm / check（受 chat.dynamic 与每日上限保护）'],
  'dynamic-image': ['commands/dynamic-image.mjs', '发图文动态（受 chat.dynamic 与每日上限保护）'],
}

const [cmd, ...rest] = process.argv.slice(2)
if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
  console.log('用法: node bili.mjs <命令> [参数...]\n')
  console.log('命令:')
  for (const [name, [, desc]] of Object.entries(map)) console.log(`  ${name.padEnd(16)} ${desc}`)
  console.log('\n安全约定（脚本里也强制）:')
  console.log('  · 写操作必须显式给 --dry（只打印预览）或 --go（实际执行）')
  console.log('  · 先确认登录账号；写操作后按需用 check-*/thread 回读复核')
  process.exit(cmd ? 0 : 2)
}

const entry = map[cmd]
if (!entry) {
  console.error(`未知命令: ${cmd}\n跑 "node bili.mjs help" 看清单。`)
  process.exit(2)
}
const r = spawnSync(NODE_EXE, [path.join(here, entry[0]), ...translateNamed(cmd, rest)], { stdio: 'inherit', windowsHide: true })
process.exit(r.status ?? 1)
