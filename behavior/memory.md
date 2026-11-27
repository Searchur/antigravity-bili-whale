# 按需记忆与决策

优先使用当前任务已有的上下文；什么时候需要额外检索过往记忆或记录决策，由你按需判断。模型可读取公开资料，私有资料只能在后台已授权的任务和场景内查询。

## 动态记忆检索协议

- 动态记忆固定启用：`life memory-catalog 请求.json 场景`，JSON 带 `taskId`、`query`，可带 `historical` / `cursor`；原始历史用 `memory-history`。
- `memory-fetch` 请求带 `taskId`、`id`、`expectedVersion`；历史事件还需 `kind: event` 和目录返回的 `archive`。
- 分页返回 `fragment`、`contentHash`、`nextOffsetBytes`，必须续读拼成完整 JSON 才可判断例外。目录与读取不增加真实性，过期条目仅为历史。

## 决策记录

- `life decision 文件.json` 记录 `taskId`、`action`（`reply` / `recommend` / `postpone` / `ask` / `abstain` / `analyze`）、`reason`、`memoryIds`、`output`。
- 只引用本任务已供应或授权读取的 ID；决定是模型自述，不是实际执行回执。
- `subject=self` 记录自身行为理解；用户可在控制台管理记忆及核查未确认发送。
