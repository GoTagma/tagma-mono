# Tagma Editor 桌面化评估

日期：2026-04-18（2026-04-19 校对：与当前实现对齐）

## 实现状态

这份文档最初定位是方案评估，但桌面化主体已经落地到可打包阶段。校对时保留"评估 + 现状"双轨，具体已存在的实现如下：

- `packages/electron/` Electron 主进程、preload、`runtime-paths`、`electron-builder` 配置
- `packages/electron/release/win-unpacked/resources/editor-sidecar/tagma-editor-server.exe` — `bun build --compile` 产物
- `packages/editor/scripts/build-desktop-sidecar.ts` — 调用 `Bun.build({ target: 'bun', compile })` 生成单文件可执行 sidecar
- `packages/editor/server/allowed-origins.ts`、`packages/editor/server/static-assets.ts` — 桌面态下 CORS 和静态资源定位的拆分
- `packages/editor/src/desktop.ts` + `src/desktop.d.ts` — renderer 侧的 IPC 桥和 `window.electronAPI` 类型声明
- 启动握手协议：sidecar 在 `server.listen` 回调里向 stdout 输出 `TAGMA_READY port=<actualPort>`，Electron 主进程据此获取 OS 分配的动态端口

后文"推荐方案"一节保留原有论证结构以便回顾，但涉及"是否编译 sidecar""allowed origins 何时算真实端口""单实例行为"等具体工程细节时，以"与实现对齐"小节为准。

## 结论

这个工程可以转成桌面应用，而且从当前结构看，适合做成：

- Windows 可用
- Linux 可用
- macOS 可用

对当前代码库来说，**最稳的方案是：Electron + 每窗口一个 Bun sidecar + electron-builder**。

不是因为 Electron 本身一定“更先进”，而是因为它和当前 `packages/editor` 的运行模型最贴合，尤其是在下面这几个方面：

- 编辑器不是纯前端应用，而是 React + Vite 前端，加一个 Bun/Express 后端
- 后端持有大量进程级状态
- 多窗口时更适合采用“一窗口一后端进程”的隔离模型
- 工作区唯一性需要由桌面主进程统一调度

如果后续非常在意包体，可以把 Tauri 作为第二阶段优化方向；但从“先稳妥落地”的角度，不建议把 Tauri 作为第一步。

## 当前工程现状

`packages/editor` 目前不是一个可以直接塞进 WebView 的纯前端项目，而是明显的前后端组合：

- 前端：React + Vite
- 后端：Express，运行在 Bun 上
- 通信方式：前端通过 `/api` 调后端

当前代码里有几个对桌面化影响很大的事实：

### 1. 后端明确依赖 Bun

`packages/editor/package.json` 中：

- `dev:server` 是 `bun --watch server/index.ts`
- `start` 是 `bun server/index.ts`
- `engines.bun` 要求 `>=1.3`

`packages/editor/README.md` 也明确写了：

- 整个 editor server / SDK / CLI / sandbox 都运行在 Bun 上
- 不要用 `npm` 或 `node` 来跑当前栈

这意味着：

- 不能把这套 server 简单理解为“普通 Node/Express 服务”
- 如果走 Electron，不能直接假设“主进程里改一下就用 Node 跑 server”
- 如果走 Tauri，也不是“纯前端直接套壳”这么简单

### 2. 后端存在大量进程级单例状态

`packages/editor/server/state.ts` 中的 `S` 保存了：

- `config`
- `yamlPath`
- `workDir`
- `layout`
- `stateRevision`

这说明当前后端模型本质上是：

- 一个 server 进程
- 对应一个当前工作区上下文
- 对应一个当前打开的 YAML / 编辑态

这对桌面化其实不是坏事，但它直接指向一个设计结论：

**桌面版应该按“一窗口一后端进程”去设计，而不是多个窗口共享一个 editor server 进程。**

### 3. 插件和运行态也是进程级的

`packages/editor/server/routes/workspace.ts` 中，切换 workspace 时会清理和重载插件注册状态。

`packages/editor/server/routes/run.ts` 中，注释明确写了：

- server 在同一时间只拥有一个 `RunSession`

这再次说明：

- 当前 server 不适合天然承载多个独立窗口的编辑会话
- 多窗口共享一个后端会增加状态串扰风险
- 每窗口独立后端是更自然的做法

### 4. 前端现在默认假设开发态代理

`packages/editor/src/api/client.ts` 中前端请求基地址是：

```ts
const BASE = '/api';
```

`packages/editor/vite.config.ts` 中开发代理是：

```ts
server: {
  proxy: {
    '/api': 'http://localhost:3001',
  },
}
```

这说明现在的 `/api` 访问方式对开发环境很友好，但桌面化时需要重新定义“谁来提供这个 `/api`”。

## 推荐方案

## 方案 A：Electron + Bun sidecar

这是当前最推荐的方案。

### 核心结构

- Electron 主进程负责应用生命周期、单实例锁、窗口管理
- 每个编辑器窗口启动一个独立 Bun server 进程
- 该 Bun server 同时负责：
  - `/api`
  - 静态前端资源服务
- `BrowserWindow` 直接加载对应窗口自己的本地 `http://127.0.0.1:<port>/`

### 为什么这是当前最稳的

原因很直接：

- 你已经有一个可运行的 Bun server
- 你已经有一个基于 `/api` 的前后端契约
- 你已经有明显的进程级编辑状态
- 多窗口天然需要隔离运行态

Electron 只需要接住这些既有事实，而不是强行改造它们。

### 多窗口模型

推荐按下面的方式设计：

- 一个窗口对应一个工作区
- 一个窗口对应一个 Bun sidecar
- 一个窗口对应一个独立端口

行为规则：

1. 打开工作区 A，如果未打开，则新建窗口 A，并启动它自己的 sidecar
2. 再次尝试打开工作区 A，不创建新窗口，而是聚焦到已有窗口 A
3. 打开工作区 B，则创建新窗口 B，并启动另一个独立 sidecar

这正是 VS Code 那类“工作区唯一”的桌面行为。

### 工作区唯一性

Electron 主进程维护一张表：

```ts
Map<absoluteWorkspacePath, WindowSession>
```

其中 `WindowSession` 至少包含：

- `BrowserWindow`
- `workspacePath`
- `serverProcess`
- `port`

当用户请求打开某个工作区时：

1. 先把路径规范化为绝对路径
2. 检查这张表里是否已存在
3. 如果已存在：
   - 还原最小化
   - 聚焦窗口
   - 不再新建
4. 如果不存在：
   - 新建窗口
   - 启动 sidecar
   - 注册到映射表

## 端口问题

你担心的端口问题，本质上不是障碍。

问题不在于“Electron 会不会有端口冲突”，而在于：

- 不能继续把桌面版固定写死在 `3001`

当前 server 代码已经支持 `PORT` 环境变量覆盖，默认值才是 `3001`。因此桌面版完全可以在主进程里为每个窗口分配独立端口。

### 推荐做法

不要手工约定 `3101`、`3102` 这种半固定端口。

更稳的做法是：

- 启动 sidecar 时传 `PORT=0`
- 让操作系统分配一个空闲本地端口
- 拿到真实监听端口后，再让窗口加载对应地址

推荐目标地址：

```text
http://127.0.0.1:<dynamic-port>/
```

### 为什么动态端口更稳

- 不会出现窗口之间的端口冲突
- 不会因为别的本机程序占用端口而失败
- 更符合“一窗口一后端”的隔离模型

### 与实现对齐：真实端口已经被正确回灌

这一块是文档第一版留下的遗留担忧，与当前实现不符，保留下来便于回顾：

- 早期担心是：”启动日志用的是 `process.env.PORT` 解析出的配置值；allowed origins 基于配置值构建；传 `PORT=0` 后真实监听端口不会自然反映”。
- 当前实现（`server/index.ts:291-297`）在 `app.listen(PORT, HOST, () => { ... })` 回调里：
  - 读 `server.address().port` 拿到 `actualPort`
  - 调 `addLoopbackAllowedOrigins(ALLOWED_ORIGINS, actualPort)` 把真实端口写入 CORS 白名单
  - `console.log` 打印 `actualPort`
  - `process.stdout.write('TAGMA_READY port=<actualPort>\n')` 作为主进程的握手信号

所以”真实端口”已经在三处都被正确回灌，桌面版不需要再为此额外处理。

## 桌面版前后端接法建议

不建议桌面版采用下面这种方式：

- `BrowserWindow` 用 `file://` 加载前端静态资源
- 前端再跨域请求一个本地 Bun server

原因是这样会把这些问题都引进来：

- `file://` 或 `null` origin 兼容问题
- CORS 例外处理
- 安全边界变复杂

更稳的接法是：

- 让每个 Bun sidecar 自己同时提供静态页面和 `/api`
- Electron 窗口直接访问该 sidecar 的本地地址

也就是：

```text
BrowserWindow -> http://127.0.0.1:<window-port>/
```

这样有几个明显好处：

- 前后端天然同源
- 不需要额外对 `file://` 做兼容
- CORS 压力最小
- 每个窗口完整自洽
- 更容易做调试和故障定位

## 为什么不建议”Electron 主进程直接跑 Node 版 server”

这条路理论上可行，但不适合当前仓库。原因不是 Electron 不支持，而是 editor server 明显依赖 Bun 运行时（`Bun.spawn`、`Bun.build` 等），要走 Node 模式必须做一轮 Bun → Node 兼容改造。

### 与实现对齐：实际走的是 compiled sidecar，而非”shipping Bun runtime”

文档第一版在这里主张”保留 server 继续运行在 Bun”，容易被读成”打包时把 Bun 运行时和 ts 源码一起装进去”。实际选择的是另一条路：

- **开发模式**（`app.isPackaged === false`）：Electron 子进程直接 `spawn('bun', ['server/index.ts'])`，依赖开发机 PATH 里的 bun
- **打包模式**（`app.isPackaged === true`）：Electron 子进程启动 `resources/editor-sidecar/tagma-editor-server.exe` —— 这是 `bun build --compile` 产物（见 `packages/editor/scripts/build-desktop-sidecar.ts`）

这两条分支共享同一个启动协议（`PORT=0`、`TAGMA_EDITOR_DIST_DIR` 环境变量、`TAGMA_READY port=<n>` stdout 握手），主进程对底层是 bun 还是 compiled exe 无感。

换句话说：”Electron 只负责壳”是成立的，但承担 server 的那一端在 packaged 模式下不是 Bun 运行时，而是 Bun 编译产物。这和下一节对 Tauri 的评估在同一条风险曲线上。

## Tauri 方案评估

## 方案 B：Tauri + Bun sidecar

这个方案也能做，而且 Tauri 官方明确支持 sidecar 机制：

- 可以把外部可执行文件作为 sidecar 打包
- 可以在应用启动后由宿主去拉起 sidecar

官方文档：

- Tauri Sidecar: <https://tauri.app/develop/sidecar/>

### Tauri 的优点

- 包体通常更小
- 原生感更强
- 对 Vite + React 组合支持很好

### 但它为什么不适合作为第一步

原因不是 Tauri 不行，而是当前仓库不够“轻壳化”。

你现在不是：

- 一个前端 SPA
- 外加几个很薄的本地命令

而是：

- 一个完整 Bun 后端
- 带文件系统能力
- 带插件安装能力
- 带运行态状态机

这会让 Tauri 的接入难点集中在 sidecar 生命周期和 Bun 可执行文件适配上。

### Tauri 路线的实际风险（更新）

因为当前 Electron 方案在打包模式下也走了 `bun build --compile`（见上一节），这里列出的”Tauri 特有”风险里，有几项其实对两条路线是对称的。分清楚哪些是 Tauri 独有、哪些是 compile 路径本身带来的，能让后续决策更干净。

**compile 路径共有的问题（Electron 现在也要面对）**：

- `process.execPath` 在 compiled executable 里指向”编译后的应用本身”，不再等同于 bun CLI
- `packages/editor/server/plugins/install.ts` 里调用 `Bun.spawn([process.execPath, 'install'], { env: { ...process.env, BUN_BE_BUN: '1' } })`：`BUN_BE_BUN=1` 是 Bun 官方方案（见 <https://bun.sh/docs/bundler/executables>），让 compiled executable 切回 bun CLI 行为。这块代码已经这么做了，所以不是 Tauri 独有障碍
- compiled executable 运行时 `import()` 磁盘上任意 ESM（例如 workspace 里用户安装的插件包）能不能稳定工作，是两条路线共同的验证点。目前 `plugins/loader.ts:303` 用 `pathToFileURL(stagedModulePath)` + `import(fileUrl)` 的方式动态加载插件，这需要随 Bun 版本验证

**Tauri 独有的多出成本**：

- 需要把 compiled sidecar 注册进 Tauri 的 `tauri.conf.json → bundle.externalBin` / sidecar 机制，并处理 per-platform 后缀约定
- WebView 内核（WebView2/WKWebView/WebKitGTK）与 Chromium 差异会反弹到前端（渲染、调试、Motion 库表现等）
- 单实例 + 多窗口 + 工作区唯一性在 Tauri 里需要用 plugin-single-instance + 自行广播工作区意图，比 Electron 的 `requestSingleInstanceLock + second-instance` 多一层拼接

“为什么不优先选 Tauri”的真正理由因此应当是 **WebView 差异和多窗口工程成本**，而不是 `process.execPath` / `BUN_BE_BUN` —— 后者在两条路线上都已经用官方方案解决。

## Electron 相对 Tauri 的优势

对这个项目来说，Electron 的实际优势主要不是“能不能做”，而是“更少改当前代码和运行模型”。

具体体现在：

- 多窗口管理成熟
- 单实例唤醒成熟
- 窗口聚焦和窗口间调度成熟
- 和现有本地 HTTP + sidecar 方案更贴近
- 更适合先把架构跑通，再逐步优化

Electron 官方的单实例机制：

- `app.requestSingleInstanceLock()`
- `second-instance` 事件

官方文档：

- Electron app API: <https://www.electronjs.org/docs/latest/api/app/>

### 与实现对齐：当前单实例语义还没到”VS Code 式”

这套机制**可以**实现”第二次打开携带工作区意图，首实例据此聚焦或开新窗口”，但 `packages/electron/src/main.ts:131-140` 当前做的事情要弱一些：

- `app.requestSingleInstanceLock()` 拿不到锁 → 直接 `app.quit()` ✓
- `second-instance` 事件触发时，只把最近一个窗口 `focus` 一下，**没有解析 `argv`**，**没有按工作区路径做去重路由**
- 工作区唯一性是在 renderer 侧触发的：renderer 调 `window.electronAPI.requestSetWorkDir(path)`，主进程在 `request-set-work-dir` IPC handler（`main.ts:168-189`）里查 `byWorkspace` 表；如果该工作区已经在另一个窗口里打开，返回 `{ action: 'focus-other' }` 并让该窗口获得焦点；否则把当前窗口登记到该工作区

所以”打开工作区 A 已被另一个窗口占用 → 跳到那个窗口”在**工作区切换**场景下是成立的；但”从文件管理器双击 .tagma 文件夹直接路由到已有窗口”这类 VS Code 式入口目前没有实现（需要解析 argv + deep-link 之后再做）。文档前面”行为规则 1-4”描述的应视为**目标状态**，不是**当前状态**。

## 是否能“一次编出 Win / Linux / macOS”

从产品结果上说，可以产出这三端应用。

但从工程现实上说，不建议理解成：

- 在一台机器上
- 一个命令
- 稳定地产出三平台正式安装包

更现实的做法是：

- 用 CI 按平台矩阵分别打包
- Windows 产 Windows 包
- Linux 产 Linux 包
- macOS 产 macOS 包

尤其是 macOS，签名和 notarization 通常需要单独处理。

所以更准确的说法是：

- 这个工程适合做成 Win / Linux / macOS 桌面应用
- 但正式分发通常应走分平台构建流程

## 最终建议

如果目标是：

- 尽快落地
- 多窗口行为正确
- 工作区唯一性正确
- 后端状态不串
- 后续可持续演进

那么推荐顺序是：

1. **先做 Electron + 每窗口一个 Bun sidecar**
2. 跑通工作区唯一性、动态端口、窗口生命周期
3. 再看是否值得继续压缩包体
4. 如果值得，再评估 Tauri 化或进一步收敛 server 运行时

## 建议的第一阶段设计

如果后面要正式开始做桌面化，第一阶段建议先只定义这几个核心点：

### 1. 主进程职责

- 单实例锁
- 工作区路径规范化
- 已开窗口查重
- 新窗口创建
- sidecar 启停
- 退出时清理子进程

### 2. 窗口会话模型

每个窗口会话至少维护：

- `workspacePath`
- `port`
- `serverProcess`
- `browserWindow`

### 3. 后端启动模型

- 每窗口一个 Bun sidecar
- 监听 `127.0.0.1`
- 端口动态分配
- UI 和 API 同源提供

### 4. 打开工作区逻辑

- 已打开：聚焦已有窗口
- 未打开：新建窗口并启动对应 sidecar

### 5. 构建与分发

- 开发环境先跑通桌面壳
- 再接 `electron-builder`
- 最后接 CI 分平台打包

## 参考资料

### 官方资料

- Electron App API: <https://www.electronjs.org/docs/latest/api/app/>
- Tauri Sidecar: <https://tauri.app/develop/sidecar/>
- Bun Single-file Executables: <https://bun.sh/docs/bundler/executables>

### 仓库内相关位置

- `packages/editor/package.json`
- `packages/editor/README.md`
- `packages/editor/vite.config.ts`
- `packages/editor/src/api/client.ts`
- `packages/editor/src/store/pipeline-store.ts`
- `packages/editor/server/index.ts`
- `packages/editor/server/state.ts`
- `packages/editor/server/routes/workspace.ts`
- `packages/editor/server/routes/run.ts`
- `packages/editor/server/plugins/install.ts`

## 一句话判断

**这套工程适合做桌面应用；如果目标是求稳、先落地、多窗口行为正确，优先选 Electron；但实现方式应是 Electron 负责桌面壳，Bun server 继续作为每窗口独立 sidecar 运行（开发态用 bun 运行时，打包态用 `bun build --compile` 产物）。**

## 当前实现的关键契约速查

给后续维护者快速抓重点的清单，都是已经在代码里落地的约定：

| 契约 | 位置 | 作用 |
| --- | --- | --- |
| `PORT=0` + `TAGMA_READY port=<n>` | `runtime-paths.ts` → `server/index.ts:297` | OS 动态分配端口，主进程解析 stdout 学习端口 |
| `TAGMA_EDITOR_DIST_DIR` | `runtime-paths.ts:33` → `server/static-assets.ts` | 打包态把前端 dist 指向 `resources/editor-dist`，dev 态指向 `packages/editor/dist` |
| `BUN_BE_BUN=1` | `server/plugins/install.ts:250` | 让 compiled sidecar 在插件安装子进程里切回 bun CLI 行为 |
| `addLoopbackAllowedOrigins(ALLOWED_ORIGINS, actualPort)` | `server/index.ts:294` | 真实端口写入 CORS 白名单 |
| `request-set-work-dir` / `open-new-window` IPC | `electron/src/main.ts:168-193` + `editor/src/desktop.ts` | 工作区唯一性 + 多窗口入口的 renderer↔main 桥 |
| `app.requestSingleInstanceLock()` | `electron/src/main.ts:127` | 单进程，第二实例只聚焦最近窗口（未按 argv 路由） |
| `extraResources: editor-dist, editor-sidecar` | `electron/package.json:34-45` | 打包时把前端 dist 和 compiled sidecar 作为外置资源复制到 `resources/` |

## 已知的打包与启动风险（2026-04-19 调查）

这些是从当前代码+打包输出里推断出的、会影响"编出来能不能启动"的隐患，**不是文档里原方案的问题，而是实现阶段落下的缺口**：

1. **`packages/electron/package.json` 的 `dist:*` 脚本没有 prebuild 链**：`electron-builder --win` 之前没有任何步骤保证 `packages/editor/dist` 和 `packages/editor/desktop-dist/tagma-editor-server.exe` 是最新产物。一旦这两个目录过期或缺文件，打出来的包里 sidecar 无法启动。
2. **sidecar 启动失败时没有用户可见反馈**：`electron/src/main.ts:46` 在 20 秒超时后 `reject(...)`，但 `createEditorWindow()` 没有 `.catch`，Windows GUI 模式也不附 terminal——用户只看到窗口闪一下就消失。需要接 `dialog.showErrorBox(...)` 或写 log 文件。
3. **packaged 模式下 sidecar 的 `cwd` 指向只读目录**：`runtime-paths.ts:29` 把 cwd 设成 `resources/editor-sidecar/`。用户把应用装到 `C:\Program Files\` 时该目录只读，sidecar 启动本身不写文件，但后续任何相对路径写操作都会 EACCES。建议改用 `app.getPath('userData')`。
4. **compiled sidecar 动态 `import()` 磁盘 ESM 的稳定性**：`plugins/loader.ts:303` 在运行时 `import(pathToFileURL(stagedModulePath).href)` 加载 workspace 中的插件；`bun build --compile` 产物对这条路径的支持需要按当前 Bun 版本回归。
5. **`.gitignore` 缺 packaging 产物**：已在 2026-04-19 补上 `packages/editor/desktop-dist/` 和 `packages/electron/release/`（`packages/electron/dist/` 由根级 `dist/` 覆盖）。

这些缺口的代码修复单独列在后续提交里，不写进文档正文。
