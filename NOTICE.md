# NOTICE · 第三方组件与免责声明

本项目（`antigravity-bili-whale`）移植并重构自 [dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)（MIT License），专为 Windows 版 Antigravity App 适配。自身代码以 **MIT** 许可发布（见 [LICENSE](LICENSE)）。

## 第三方组件与参考来源

| 名称 | 用途 | 许可 / 说明 |
| --- | --- | --- |
| **dsh-bili-whale** | 上游原始 B 站鲸鱼核心、状态机、行为规范与工具链 | MIT |
| **@modelcontextprotocol/ext-apps** | MCP Apps前端SDK | MIT及Apache-2.0，详见随产品发布的许可文本 |
| **@modelcontextprotocol/sdk** | MCP协议基础能力 | MIT |
| **zod** | 前端协议数据校验 | MIT |
| **zod-to-json-schema** | 数据校验架构转换 | ISC |
| **qrcode (Kazuhiko Arase)** | `src/vendor/qrcode/qrcode.mjs` 内置零依赖二维码生成器 | MIT（见 `src/vendor/qrcode/LICENSE`） |
| **Bilibili API / bilibili-API-collect** | B 站公开接口调用参考 | 非官方；本项目不包含 B 站代码或数据 |
| **ffmpeg** | 本机视频画面抽帧依赖工具 | **LGPL v2.1+** 或 GPL（仓库不打包 ffmpeg） |
| **Node.js** | 本地运行环境 | MIT |

`dist/app.html`内的`third-party-licenses`数据块保留实际进入前端包的第三方组件的版本、版权与许可文本。

## 免责声明

- 本项目为个人自用工具的开源版本：所有 B 站评论、回复、私信、动态等操作均使用**你自己的账号**完成，后果由使用者自行承担。
- 严禁用于批量刷量、水军、骚扰或绕过平台风控；项目内置频率限制与退避保护，触发风控时应立即停止。
- 本项目与哔哩哔哩（Bilibili）、Google Antigravity 官方均无隶属关系。
