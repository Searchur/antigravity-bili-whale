# 工具详细索引
在Antigravity中优先使用插件内置MCP工具。
- `bili_browse`: feed / discover / round / search / whois / covers
- `bili_inspect`: debrief / watch-video / subtitles / comments / video / batch-debrief / ai-share（生成的九宫格与封面图用 Antigravity 内置 `read_file` 查看）
- `bili_interact`: comment、comment-del、dynamic、dynamic-image、dynamic-edit、like、fav、follow
- `bili_dm`: dm、dm-batch。模型私信操作需带本任务的 `--account` 大鲸鱼UID和 `--to` 收信人UID。私信监听由后台守护处理。
- `bili_inbox`: comment-digest / likes / thread / check-comment / check-dynamic / check-mention / recon
- `bili_life`: life、expression、corpus、quota、night、traffic。模型按公开范围或当前任务授权读取记忆。
- `bili_stickers`: list / get（直接读取插件自带 42 张表情包）
- `bili_ops`: deps、selftest、session、behavior、config、read-prompt

命令行等价入口：`node <插件目录>/tools/bili.mjs <命令> [参数...]`。`behavior read <章节>` 重读规范；`behavior reload` 请求下次投递重载规范，不会重投旧任务。
表达：`expression prepare 候选.json`；字段 scene、target、text、taskId、sourceIds/claims，评论另填 thread=type:oid:root 和 parent。`expression revise ID 修改.txt` 最多一次；`expression finalize ID` 取得固定 delivery；`comment`/`dm --draft ID --dry`，再 `--go`；不合适 `expression discard ID`。requireDraft 由本次配置决定，direct 只是起草方式。
公开分享走`comment --share --auto --reason 原因 --score 分数 --rank 1`，先核对真实BV号或视频OID，并按配置在正文`@`主人。仅在回复允许的评论时使用该评论实际的楼层坐标。
私信分享给主人时，调用`dm --msg 含BV链接的正文 --share --target BV --reason 原因 --score 分数 --rank 1`。外发先用`--dry`预览，再以相同参数改为`--go`。每次预览只可提交一次，10分钟内有效。执行时仍校验额度、偏好和未确认发送状态。
私信表情包：`dm --msg 正文 --pic 图片路径` 会先发文字、再发图片，各有独立回执；仅发图片用 `dm --pic 图片路径`。两种都先 `--dry` 再 `--go`。文字已成功而图片失败时不要重发正文；明确拒绝后可单独重试图片，结果未知时先核查回执。
收藏：`fav BV --reason 原因`（至少 6 字），同类至少 2 条时按工具要求 `--better`；只留三个月后还想看且说得出原因的内容，额度以工具校验为准。
写法：`expression references 视频来源事件ID reaction|observation|question|technical-help|discussion`；只用适合当前目的的参考。风格 ID 填 styleRefIds，事实仍填 sourceIds/claims。
表情包见 `behavior read stickers`；记忆分页与决策字段见 `behavior read memory`。

多段私信最多6条。先使用`dm-batch --file <字符串数组.json> --task <本次taskId> --dry`，再以相同参数改为`--go`。`--resume <组ID> --dry`预览原组的剩余正文，确认后再改用`--go`。结果未确认时先在控制台核查。
公开动态草稿：`expression prepare` 输入 `channel:"dynamic",scene:"public-comment",target:"自己mid",share:false`，定稿后 `dynamic post --draft ID --auto --dry` 再 `--go`。不要把私人素材改标为公开；自动动态由独立设置开关控制。

批量工具：`round --n 6 --no-frames [--json]`；`discover --n 6 --kw 关键词 --json`；`batch-debrief <BV...> --no-frames --concurrency 2`。`round --dry` 仅列候选；`debrief --json` 返回带 evidenceId 的结构化素材。`config show` / `config set <pipeline字段> <JSON值>` 调整找片参数。

手动唤醒使用控制台「马上唤醒她」，本地命令`node tools/bili.mjs night trigger --go`调用同一入口。
