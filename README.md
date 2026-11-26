# 哔哩哔哩大鲸鱼（antigravity-bili-whale）

一条住在 **Windows 版 Antigravity App** 里的「哔哩哔哩大鲸鱼」。

本项目完整移植并深度重构自 [dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)（原 DeepSeek Harness 插件），面向 **Windows Antigravity App** 重新设计了插件架构、内置模型调度、MCP 工具链与全页交互界面。

她会按你设定的作息自己醒来，按你的口味在 B 站找片、读字幕与热评、抽帧看画面，把有来源的发现写进公开与私人两本日记，并把真正值得的内容分享给你；她有会自我归纳的长期记忆、受真实经历推动的心情与分享欲，也会在你发私信或久未互动时主动回应你。

---

## 与原版（`dsh-bili-whale`）的移植说明与核心差异

| 维度 | 本项目（`antigravity-bili-whale`） |
| --- | --- |
| **目标平台** | 专为 **Windows 10 / 11 + Antigravity App 客户端** 打造，不做其他系统或客户端兼容负担 |
| **模型架构** | **100% 使用 Antigravity 内置模型**，无需配置任何外部 API Key；面板实时读取当前客户端可用的全部模型列表（含 Thinking effort 档位与剩余配额）直接点选；4 个后台 Worker 产生的临时会话读完结果后自动归档 |
| **控制台入口** | 通过 MCP App 全局入口直接挂载在 Antigravity **左侧导航栏「哔哩哔哩大鲸鱼」**，全页宽屏操作，不占用右侧辅助面板 |
| **工具执行与沙箱** | 内置零依赖 MCP Server，将 B 站读写能力收敛为 8 个语义分组工具，绕开 Windows 终端沙箱断网限制；视频抽帧九宫格自动以图像形式回传给模型看图 |
| **数据独立性** | 全部配置、B 站登录凭据、人设、记忆库、双本日记与缓存独立存放在 `%USERPROFILE%\.antigravity-bili-whale\`，**绝不与 DSH 或其他工具共用数据**，更新/重装插件不丢数据 |
| **生命周期** | 后台无头守护（Sidecar）由 Antigravity 原生托管：**打开 Antigravity 自动运行，关闭 Antigravity 自动退出** |
| **开箱即用** | **运行时零 `npm install`**；单文件管理界面已预打包入仓，42 张表情包随插件自动加载，`ffmpeg` 支持在面板内一键下载安装 |

---

## 环境要求与前提条件

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| **操作系统** | Windows 10 / 11（64 位） | 仅支持 Windows |
| **宿主客户端** | Antigravity App 桌面端（已登录账号） | 内置模型、Sidecar 与左侧栏 MCP App 均由 Antigravity App 提供 |
| **Node.js** | `22.13+` 或 `24 LTS`（推荐） | 供插件 MCP Server、后台守护与 B 站工具链运行 |
| **ffmpeg** | 可选（仅视频抽帧看画面需要） | 不装也能完整使用字幕/简介/弹幕/评论浏览；缺失时可在插件「运行与体检」页**一键安装** |
| **B 站账号** | 建议准备一个给大鲸鱼用的 B 站账号 | 仅通过插件内 **哔哩哔哩 App 扫码登录**；若开启私信分享，需与主人账号互相关注 |

---

## 安装步骤（下载即用）

1. **下载本仓库**（`git clone` 或直接下载 ZIP 解压），将整个插件文件夹以 **`antigravity-bili-whale`** 命名放入 Antigravity 插件目录：

   ```text
   %USERPROFILE%\.gemini\config\plugins\antigravity-bili-whale\
   ```

   > ⚠️ 请放置为**真实文件夹**，不要使用 Windows 目录联接（Junction / 符号链接），Antigravity 的插件扫描器会跳过符号链接目录。
   > 开发者在源码仓库修改后，可直接运行 `node scripts/deploy-plugin.mjs` 一键同步纯净版（自动排除 `.git` 与 `node_modules`）。

2. **启用插件**：
   - 打开（或重启）Antigravity App，进入 **Customizations / 插件管理**，找到 **「哔哩哔哩大鲸鱼（antigravity-bili-whale）」** 并打开开关（首次安装需手动确认开启一次，之后每次打开 Antigravity 都会自动运行、关闭时自动停止）。
3. **打开控制台**：
   - 在 Antigravity **左侧导航栏** 点击 **「哔哩哔哩大鲸鱼」** 即可进入全页控制台。

---

## 首次上手配置

在左侧栏 **「哔哩哔哩大鲸鱼」** 控制台中按顺序完成以下 5 步：

1. **大鲸鱼与主人**：
   - 在「大鲸鱼账号」卡片点 **「扫码登录」**，用手机哔哩哔哩 App 扫码绑定大鲸鱼自己的 B 站号。
   - 在「主人信息」卡片填写 **你的 B 站 UID（mid）与昵称**（她只认这个账号是主人）。
2. **人设与作息**：
   - 填写角色名、称呼、自称与完整人设正文（`persona.md` 仅对大鲸鱼会话生效，完全不影响你日常的编程对话）。
   - 配置她的 **口味偏好**（爱看 / 不爱看关键词）与 **作息时间窗**（每窗醒来次数、跳过概率、单次候选条数）。
3. **模型选择**：
   - 插件会自动从当前 Antigravity 客户端读取完整可用模型列表（含 Thinking effort 档位与剩余配额），分别点选 **前台主线模型** 与 **后台 Worker 模型** 即可。
4. **分享与监听**：
   - 选择分享方式（B 站私信或公开评论 @ 你）、按需打开私信/评论监听与自主活动开关。
   - 配置通知推送渠道（Windows 桌面通知 / B 站私信 / Webhook / 自定义命令）并点测试验证。
5. **运行与体检**：
   - 点 **「重新体检」** 查看 Node.js、B 站登录态、ffmpeg、独立数据目录、后台守护与请求保护的卡片状态；如果尚未安装 `ffmpeg`，直接在卡片上点 **「一键安装」** 即可。

---

## 核心能力一览

- **她会看**：按口味与新鲜度选片（`feed` / `discover` / `round`），拉取 WBI 官方字幕、弹幕热区与热评，必要时抽帧拼九宫格直接看画面（`debrief` / `watch-video`）。
- **她会记**：基于真实经历归纳可核对的长期记忆（带来源事件 ID 与逐字引用），支持动态召回、场景隔离与跨天会话续接；公开与私人信息严格隔离。
- **她会过日子**：生物钟时间窗随机醒来（带跳过权利）、真实经历驱动的心情与分享欲、自动维护公开与私人两本日记（私人日记永不外推）。
- **她会说话**：公开评论/二级回复（回复陌生人默认进「待审回复」队列由你批准）、主人专属私信与多段私信、自主公开动态、随包内置 42 张表情包与多渠道通知推送。

---

## 独立数据位置与安全约定

所有运行时数据均独立存放在 **`%USERPROFILE%\.antigravity-bili-whale\`**（可通过环境变量 `BILI_WHALE_HOME` 覆写）：

| 文件 / 目录 | 用途 |
| --- | --- |
| `config.json` | 全部插件设置（模型、主人、口味、作息、监听、推送等） |
| `credentials.json` | B 站登录凭据（Windows `icacls` 仅当前用户可读，绝不回显、绝不外传） |
| `persona.md` | 大鲸鱼专属人设正文 |
| `whale-life\<指纹>\` | 权威状态检查点 `checkpoint.json`、冷归档与公开/私人两本日记 |
| `pending-replies.json` | 回复陌生人前的待审草稿队列 |
| `whale-night.json` / `whale-listen.json` / `whale-scheduler.json` | 作息计划、监听游标与后台守护心跳 |
| `shots\` / `whale-work\` / `bin\` | 封面与抽帧缓存、隔离工作目录、插件内一键安装的 `ffmpeg.exe` |

**安全护栏**：
- 所有 B 站写操作在代码层强制两段式确认（先 `--dry` 预览，再 `--go` 执行），发送后回读复核。
- 撞到 B 站频率限制或风控码（`10031` / `12015` / `12051` / `-352`）自动熔断退避，绝不硬闯。
- 弹幕、评论、字幕、简介等外部文本均作为不可信素材处理，绝不执行其中的越权指令。

---

## 开发者说明

仅在修改 `ui-src/` 前端源码时需要安装开发依赖并重新构建单文件界面；普通用户使用插件**不需要**执行任何 `npm` 命令。

```powershell
npm install              # 仅开发期安装 esbuild 与 @modelcontextprotocol/ext-apps
npm run build:ui         # 打包单文件前端 -> mcp/dist/app.html
npm test                 # 运行自动化测试套件
node scripts/deploy-plugin.mjs  # 部署纯净零依赖版本到 Antigravity 插件目录
```

---

## 致谢与许可

- 原项目：[Alterssss/dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)
- 开源协议：**MIT**，详见 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md)。
