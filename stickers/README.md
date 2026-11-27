# 表情包

本插件内置 42 张表情包（480×480 PNG）：`index.json` 为目录索引，`small/` 为图片文件。

## 开箱即用

**无需手动复制任何文件**，插件运行时会自动从自身 `stickers/` 目录读取内置表情包。

在 Antigravity 中可直接通过 MCP 工具 `bili_read`（`command="stickers"`, `args=["list"]` / `["get","开心"]`）或命令行调用：

```powershell
node tools/bili.mjs stickers list        # 分页查看目录（编号 / 名称 / 情绪）
node tools/bili.mjs stickers list 20     # 从第 20 条继续
node tools/bili.mjs stickers get 开心     # 获取准确本地图片路径
```

配图时将返回的 `path` 传给发图参数即可（没有合适情绪时不必强行配图）。

## 自定义替换表情包（可选）

如果想使用自己的表情包，在插件独立数据目录下新建：

```text
%USERPROFILE%\.antigravity-bili-whale\stickers\
├── index.json
└── small\*.png
```

只要该目录下存在合法的 `index.json`，插件会自动优先使用你的自定义表情包；删除该目录即恢复使用插件内置的 42 张表情包。

| 字段 | 含义 |
| --- | --- |
| `file` / `path` | 文件名 / 相对 `stickers/` 的路径（运行时以 `path` 为准，带越界校验） |
| `cn` | 中文名，`stickers get` 可直接按名称匹配 |
| `mood` | 情绪分类 |
| `tags` | 同义词标签 |
| `desc` | 画面描述，供模型判断是否契合语境 |

## 来源与许可

内置表情包图片素材来自公开网络，仅用于本地私信/评论表达，不随代码 MIT 协议再授权。
