# 批量选片与深读流水线

本目录提供只读找片、有限并发深读、标签统计与相关推荐能力，不直接执行评论、私信或动态发送；所有对外互动仍统一走主流程的表达评估与两段式发送闸门。

## 常用入口（推荐使用插件 MCP 工具 `bili_browse` / `bili_inspect` / `bili_ops`）

命令行等价示例：

```powershell
node tools/bili.mjs round --n 6 --dry
node tools/bili.mjs round --n 6 --no-frames --json
node tools/bili.mjs discover --n 6 --kw 猫咪 --json
node tools/bili.mjs batch-debrief BV1234567890 BVabcdefghij --no-frames --concurrency 2
node tools/bili.mjs debrief BV1234567890 --sample-pages 2 --no-frames --json
node tools/bili.mjs config show
node tools/bili.mjs config set deepReadMax 3
```

## 数据与配置位置

- 流水线参数位于独立配置文件 `%USERPROFILE%\.antigravity-bili-whale\config.json`（可通过 `BILI_WHALE_CONFIG` 覆写）下的 `pipeline` 对象。
- 完整 `round` 结果保存在 `%USERPROFILE%\.antigravity-bili-whale\whale-work\rounds\`。
- 自定义渲染器（可选）可放在 `%USERPROFILE%\.antigravity-bili-whale\whale-work\profiles\<name>.mjs`，配合 `BW_DEBRIEF_PROFILE=<name>` 启用。

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
