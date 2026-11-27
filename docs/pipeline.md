# 批量选片与深读流水线

本目录提供只读找片、有限并发深读、标签统计与相关推荐能力，不直接执行评论、私信或动态发送；所有对外互动仍统一走主流程的两段式发送闸门与外发内容安全审核。

## 常用入口（推荐使用插件 MCP 工具 `bili_read`）

命令行等价示例：

```powershell
node src/cli/bili.mjs round --n 5 --dry
node src/cli/bili.mjs round --n 5 --json
node src/cli/bili.mjs discover --n 5 --kw 猫咪 --json
node src/cli/bili.mjs batch-debrief BV1234567890 BVabcdefghij --concurrency 2
node src/cli/bili.mjs debrief BV1234567890 --sample-pages 2 --json
node src/cli/bili.mjs config show
```

## 数据与配置位置

- 流水线生效参数由独立配置文件 `%USERPROFILE%\.antigravity-bili-whale\config.json`（可通过 `BILI_WHALE_CONFIG` 覆写）派生；其中控制台「视频观看设置」的 `watch.auto` 与「人设与作息」的 `night.deepWatchMax` 优先覆盖历史 `pipeline` 里的时长与深读上限。
- 完整 `round` 结果保存在 `%USERPROFILE%\.antigravity-bili-whale\runtime\workspace\rounds\`。
- 自定义渲染器（可选）可放在 `%USERPROFILE%\.antigravity-bili-whale\runtime\workspace\profiles\<name>.mjs`，配合 `BW_DEBRIEF_PROFILE=<name>` 启用。

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `windows` | `[3,7,30,365,730,1095]` | 递增搜索时间窗（天） |
| `perKeywordPool` | `12` | 每个兴趣词候选池上限 |
| `minDuration` / `maxDuration` | `0` / `7200` | 视频时长范围（秒） |
| `multiPartThreshold` / `multiPartPerRound` | `3` / `1` | 合集分 P 判定阈值 / 每轮合集上限 |
| `deepReadMax` | `3` | 单轮深读条数上限 |
| `concurrency` | `2` | 批量深读并发度（1–3） |
| `explorationMax` | `1` | 未命中兴趣的探索候选上限（0–3） |
| `maxMetadata` | `40` | 单次选题最多核验的元信息数 |
