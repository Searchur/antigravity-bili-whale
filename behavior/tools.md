# 工具详细索引

## MCP 工具（首选）

在 Antigravity 中优先使用插件内置的 2 个读写分离 MCP 工具：

- `bili_read`（全部只读浏览、深读看图与状态查询，无外发副作用）：
  - 选片与检索：`feed` / `discover` / `round` / `search` / `whois` / `covers`
  - 视频深读与看图：`debrief`（支持 `--profile auto|owner|fan`）/ `watch-video` / `subtitles` / `comments` / `batch-debrief` / `read-shot`（抽帧结果会自动随工具响应附带画面图，单独查看缓存图用 `read-shot`）
  - 收件箱与复核：`comment-digest` / `likes` / `thread` / `check-comment` / `check-dynamic` / `check-mention` / `recon`
  - 记忆、额度与状态：`life` / `quota` / `night`（仅 `status`）/ `traffic`（仅 `status`）
  - 表情包与运维：`stickers`（`["list"]` / `["get","名称"]`，读取随包内置 42 张表情包）/ `deps` / `selftest` / `session` / `behavior`（`list` / `read <章节>`）/ `config`（仅 `show`）/ `read-prompt`
- `bili_write`（全部外发写操作，强制先 `--dry` 再 `--go` 并执行安全审核）：
  - 公开互动：`comment`、`comment-del`、`dynamic`、`dynamic-image`、`like`、`fav`、`follow`
  - 私信回复与分享：`dm`、`dm-batch`（须带本任务的 `--account` 大鲸鱼 UID 和 `--to` 收信人 UID，单条 ≤300 字符；私信监听由后台守护处理）

## 常用协议与参数约定

- 命令行等价入口：`node <插件目录>/src/cli/bili.mjs <命令> [参数...]`。`behavior read <章节>` 重读规范。
- 公开分享走 `comment --share --auto --bvid <BV号> --message <正文>`（正文须 `@ 主人昵称`），须确认已开启 `share.enabled` 且 `share.via = comment`。自主发普通顶层评论（不 `@` 主人）走 `comment --auto --bvid <BV号> --message <正文>`（须开启 `chat.autoComment`）。仅在回复允许的评论时使用该评论实际的 `type/oid/root/parent` 楼层坐标。
- 私信分享给主人时，调用 `dm --account <大鲸鱼UID> --to <主人UID> --msg <含BV链接的正文> --share --target <BV号>`（须开启 `share.enabled` 且 `share.via = dm`）。所有外发写操作先用 `--dry` 预览，再以相同参数改为 `--go`；每次预览只可提交一次，10 分钟内有效。执行时仍校验额度、偏好、7 天同视频去重、外发内容安全审核及未确认发送状态。
- 私信表情包：`dm --msg 正文 --pic 图片路径` 会先发文字、再发图片，各有独立回执；仅发图片用 `dm --pic 图片路径`。两种都先 `--dry` 再 `--go`。文字已成功而图片失败时不要重发正文；明确拒绝后可单独重试图片，结果未知时先核查回执。
- 收藏：`fav BV --reason 原因`（工具校验至少 6 字，同类已有 ≥2 条时按工具提示决定是否加 `--better`）；值不值得收藏由你自己判断，额度与去重以工具校验为准。
- 表情包见 `behavior read stickers`；记忆分页与决策字段见 `behavior read memory`。
- 多段私信最多 6 条（每条 ≤300 字符）。先使用 `dm-batch --file <字符串数组.json> --task <本次taskId> --dry`，再以相同参数改为 `--go`。`--resume <组ID> --dry` 预览原组的剩余正文，确认后再改用 `--go`。结果未确认时先在控制台核查。
- 公开动态：开启 `chat.dynamic` 后可用 `dynamic post --text <正文> --dry` 再 `--go`，或用 `dynamic-image --image <图片路径> --text <正文> --dry` 再 `--go`（每日受 `dynamicDailyMax` 上限约束）。不要把私人素材改标为公开。
- 批量工具：`round [--n 5] [--json]`；`discover --n 5 --kw 关键词 --json`；`batch-debrief <BV...> --concurrency 2`。`round --dry` 仅列候选；`debrief --json` 返回带 `evidenceId` 的结构化素材。`config show` 查看当前生效的找片与观看参数。
- 手动唤醒使用控制台【马上唤醒她】，本地命令 `node src/cli/bili.mjs night trigger --go` 调用同一入口。
