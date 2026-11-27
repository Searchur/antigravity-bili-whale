# 用户独立数据目录规范（`.antigravity-bili-whale`）

`antigravity-bili-whale` 将所有运行时数据完全隔离存放在 **`%USERPROFILE%\.antigravity-bili-whale\`**（可通过环境变量 `BILI_WHALE_HOME` 覆写），与插件程序目录完全解耦，更新或重装插件均不会覆盖用户数据。

所有路径在代码中统一由 [`src/core/data-paths.mjs`](../src/core/data-paths.mjs) 的 `dataPathsFor(whaleHome)` 生成，严禁在业务模块中硬编码散落路径。

---

## 1. 六类目录结构总览

```text
%USERPROFILE%\.antigravity-bili-whale\
├── config.json                      # [用户直管] 主配置文件（支持 BILI_WHALE_CONFIG 覆写）
├── credentials.json                 # [用户直管] B 站登录凭据（Windows icacls 仅当前用户可读）
├── persona.md                       # [用户直管] 大鲸鱼专属人设正文（硬上限 4000 字）
├── stickers/                        # [用户扩展] 自定义表情包目录（覆盖插件内置 42 张）
├── bin/                             # [用户扩展] 自备本地可执行文件（如 ffmpeg.exe）
├── exports/                         # [用户产出] 带时间戳的脱敏诊断日志与长期记忆备份
├── memory/                          # [长期记忆] 按 <fingerprint>/ 隔离 checkpoint.json、state.json、archive/、search.sqlite
├── state/                           # [持久化状态] 机器管理的作息计划、监听游标、会话、限额与收藏账本
│   ├── schedule.json                # 今日作息与唤醒计划
│   ├── listen-cursor.json           # 评论与 @ 监听游标
│   ├── scheduler-health.json        # 后台守护健康心跳与最近诊断
│   ├── deliveries.json              # 会话投递状态账本
│   ├── sessions/                    # 按作用域隔离的会话状态文件（<scope>.json）
│   ├── dm-listeners/<hash>/         # 按账号+主人隔离的私信监听游标与回执
│   ├── traffic.json                 # 全局限流与风控熔断状态（含 .lock）
│   ├── quota.json                   # 每日分享/动态/自主评论额度账本
│   ├── quota-recovery/              # 异常中断时的额度补偿定位器
│   ├── fan-quota.json               # 粉丝每日私信/评论/@总结限额
│   ├── dm-quota.json                # 私信发送限额账本
│   ├── favorites.json               # 收藏记录账本
│   ├── device-id.txt                # B 站私信客户端设备 UUID
│   └── selftest.json                # 启动自检通过记录
├── runtime/                         # [临时运行控制] 可随重启重建的运行控制文件与隔离工作区
│   ├── sidecar-ipc.json             # Sidecar 本机回环鉴权 IPC 端点描述
│   ├── locks/                       # 跨进程锁文件（quota-send、wake-mark 等）
│   ├── write-previews/              # 10 分钟一次性写前预览令牌
│   └── workspace/                   # 隔离工作区（.prompts/、rounds/、profiles/）
├── cache/                           # [可安全清空缓存] 网络缓存与视频/封面/字幕抽帧缓存
│   ├── api-cache.json               # B 站只读 API / WBI 密钥缓存
│   ├── api-ban.json                 # B 站接口退避冷却记录
│   ├── feed-search.json             # 选题搜索候选缓存
│   ├── picture-uploads.json         # 图床已上传图片映射缓存
│   └── shots/                       # 视频封面（covers/）、字幕（subs/）、抽帧拼图（video/）
└── logs/                            # [审计与运行日志]
    ├── safety-blocked.jsonl         # 外发内容安全审核拦截审计日志
    ├── api-requests.log             # B 站 API 请求记录日志
    └── dm-listener-errors.log       # 私信监听异常日志
```

---

## 2. 自定义表情包（`stickers/`）

插件默认随包自带 42 张内置表情包（480×480 PNG），开箱即用，无需手动复制。如需替换为自己的表情包，在数据目录下新建：

```text
%USERPROFILE%\.antigravity-bili-whale\stickers\
├── index.json
└── small\*.png
```

只要该目录下存在合法的 `index.json`，插件会自动优先使用自定义表情包；删除该目录即可恢复使用插件内置表情包。

| `index.json` 字段 | 含义 |
| --- | --- |
| `file` / `path` | 文件名 / 相对 `stickers/` 的路径（运行时以 `path` 为准，带越界与符号链接校验） |
| `cn` | 中文名，`stickers get` 可直接按名称匹配 |
| `mood` | 情绪分类 |
| `tags` | 同义词标签 |
| `desc` | 画面描述，供模型判断是否契合语境 |

命令行等价调用：

```powershell
node src/cli/bili.mjs stickers list        # 分页查看目录（编号 / 名称 / 情绪）
node src/cli/bili.mjs stickers list 20     # 从第 20 条继续
node src/cli/bili.mjs stickers get 开心     # 获取准确本地图片路径
```

> 内置表情包图片素材来自公开网络，仅用于本地私信/评论表达，不随代码 MIT 协议再授权。

---

## 3. 从 `v1.6.x` 手动迁移到 `v2.0.0` 对照表

`v2.0.0` 起采用上述六类全新布局，不再内置旧路径自动迁移代码。根目录下的 `config.json`、`credentials.json`、`persona.md`、`stickers/`、`bin/`、`exports/` **位置不变，无需移动**。

如果你希望保留 `v1.6.x` 积累的长期记忆与账本，在关闭 Antigravity App 后按以下对照表移动对应文件即可（缓存与临时运行文件可不迁移，重启后自动重建）：

| `v1.6.x` 旧路径 | `v2.0.0` 新路径 | 建议操作 |
| --- | --- | --- |
| `whale-life\` | `memory\` | **强烈建议移动**（保留全部长期记忆与检查点） |
| `whale-night.json` | `state\schedule.json` | 按需移动（保留当日作息计划） |
| `whale-listen.json` | `state\listen-cursor.json` | 按需移动（避免评论监听重复扫旧消息） |
| `dm-listeners\` | `state\dm-listeners\` | 按需移动（避免私信监听重复扫旧消息） |
| `favorites.json` | `state\favorites.json` | 按需移动（保留收藏品味记录） |
| `quota.json` / `fan-quota.json` / `dm-quota.json` | `state\quota.json` / `state\fan-quota.json` / `state\dm-quota.json` | 按需移动（保留当日已用限额与历史统计） |
| `safety-blocked.jsonl` | `logs\safety-blocked.jsonl` | 按需移动（保留安全拦截审计记录） |
| `shots\` / `whale-work\` / `api-cache.json` 等 | `cache\` / `runtime\` | 无需迁移，可直接清理，新版自动生成 |
