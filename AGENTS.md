# Repository Development Rules (`antigravity-bili-whale`)

本文件仅用于本仓库开发与 AI 协作，不随插件发布 ZIP 下发。改动代码或目录前必须遵守以下约定：

## 1. 不可破坏的平台契约路径

Antigravity 宿主按固定路径发现插件组件，以下顶层位置不可随意改名或移动：

- `plugin.json`（插件清单）
- `mcp_config.json`（指向 `${PLUGIN_ROOT}/src/mcp/server.mjs`）
- `assets/logo.png`
- `skills/antigravity-bili-whale/SKILL.md`
- `sidecars/whale/sidecar.json` 与 `sidecars/whale/main.mjs`

## 2. 目录、命名、ES2026 与文档规范（由 `scripts/check-structure.mjs` 自动强制）

- **扩展名与命名**：`src/`、`web/`、`scripts/`、`sidecars/`、`test/` 下所有模块统一使用 **`.mjs`** 与小写 **`kebab-case`**，禁止 `.js` / `.cjs`、目录内冗余前缀与遗留的 `DSH_HOME` / `dshPath` / `dshHome` 命名。
- **顶层白名单**：禁止在仓库根目录随意新增未登记的文件或目录；文档放 `docs/`，开发脚本放 `scripts/`，前端源码放 `web/`（视图放 `web/views/`），运行源码放 `src/<domain>/`。
- **单向无环分层**：严格遵守 [`docs/architecture.md`](docs/architecture.md) 定义的 16 层依赖白名单（`ALLOWED_LAYER_DEPS`），禁止任何文件级或领域层循环依赖。
  - `src/shared/` 与 `src/vendor/` 严禁引入 `node:*` 模块。
  - `web/` 仅允许引用同目录、`@modelcontextprotocol/ext-apps` 与 `src/shared/`，严禁引用 `node:*` 或后端业务模块。
  - `src/` 与 `sidecars/` 保持零外部 npm 运行时依赖。
- **ES2026 / Node 24+ 规范**：最低运行环境为 Node 24+，`web/` 打包目标为 `esnext`；禁止 `var`、CommonJS 与无 `node:` 前缀的内置导入；禁止调用 Node 24（V8 13.6）尚未实现的 ES2026 API（`Math.sumPrecise`、`Uint8Array` Base64/Hex、`Map.prototype.getOrInsert*`、`Iterator.concat`）。
- **用户数据目录单一真理源**：所有 `%USERPROFILE%\.antigravity-bili-whale\` 路径统一通过 `src/core/data-paths.mjs`（`dataPathsFor` / `DATA_PATHS`）访问，规范见 [`docs/user-data.md`](docs/user-data.md)，禁止硬编码旧版平铺文件名。
- **Markdown 规范**：除根目录惯例文件与 `SKILL.md` 外均用小写 `kebab-case`，统一 LF、唯一 H1、不跳级标题、零断链。
- **测试分层**：新增测试按领域放入 `test/{host,plugin,runtime,structure}/*.test.mjs`，公共夹具放入 `test/fixtures/*.mjs`。

## 3. 改动后的必跑验证命令

- 修改 `web/` 前端后：运行 `npm run build:ui` 更新 `dist/app.html`。
- 增删改运行态文件后：运行 `npm run sync:manifest` 自动同步 `package.json` 的 `whaleRuntimeFiles`。
- 新增目录或子域后：同步更新 `docs/architecture.md`（否则结构守卫会拦截）。
- 提交前必须全部通过：`npm run verify`（等价于 `build:ui` + `check:structure` + `test`）。
