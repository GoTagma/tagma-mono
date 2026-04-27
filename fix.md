下面这份是基于公开 `GoTagma/tagma-mono` 当前 `main` 分支做的**静态梳理**，没有跑完整 CI/测试；所以我把问题分成“确定问题”和“高风险设计问题”。优先级里，**P0/P1 建议先修**。

## 总体判断

这个工程最大的问题不是单点 bug，而是：**工程已经从 `sdk` 单包演进成 `core + runtime-bun + sdk` 分层，但 README、类型、旧源码、脚本、插件机制没有完全同步**。同时，pipeline YAML 本质上可以触发 shell 命令、hooks、completion command、npm 插件加载和 AI CLI 调用，所以如果它要运行“不完全可信”的项目配置，目前安全边界是不够清楚的。SDK README 明确说 `command`/`prompt` 里的 `{{inputs.*}}` 是原样替换且“不做 shell escape”，`output_check` 也会执行 shell 命令；hook 实现同样通过 shell 执行命令。([GitHub][1])

---

## P0 / 高风险安全问题

### 1. `runId` 可控时有日志路径逃逸风险

`runPipeline` 支持外部传入 `runId`，runtime 的 log store 直接把它拼到 `workDir/.tagma/logs/<runId>` 下面；我没有看到对 `runId` 做正则限制或路径片段清洗。如果上层把用户可控字符串传进来，可能写出 `.tagma/logs` 之外，或者覆盖不该覆盖的路径。([GitHub][2])

建议：`runId` 只能允许 `[A-Za-z0-9_-]`，并且在 `openRunLog` 内部二次校验 `resolve(base, runId)` 必须仍在 base 下。

### 2. YAML 的执行能力过大，缺少“可信配置”边界

当前 YAML 可以触发 `command` shell、hooks shell、`output_check` shell、外部 npm 插件 import、AI CLI 执行。插件名虽然拒绝相对/绝对路径，但最终还是 `import()` 一个 npm 包；这仍然是代码执行。Registry 注释也说明 `loadPlugins` 会动态解析并导入插件包。([GitHub][3])

建议：把 pipeline 分成“trusted mode”和“safe mode”。safe mode 禁用 `command`、hooks、`output_check`、自动 plugin loading，或者要求显式 allowlist。UI/CLI 也应在运行来自仓库的 pipeline 前提示“这会执行本机命令”。

### 3. 子进程默认继承全部环境变量，AI/命令进程可能拿到密钥

`runSpawn` 把 `process.env` 与 `spec.env` 合并后传给子进程。这意味着 OpenAI/Anthropic token、GitHub token、npm token、数据库连接串等环境变量都会默认暴露给 driver CLI、shell command 和插件启动的进程。([GitHub][4])

建议：默认只传 PATH、HOME、USER、SHELL、TMP 等必要环境变量；需要凭证时通过显式 `env` 或 host allowlist 注入。

### 4. 日志会记录最终 prompt，可能泄露源码、上下文、密钥或用户输入

AI task 会把 middleware 之后的最终 prompt 写入日志；stdout/stderr 也会写入日志。对于 RAG、static_context、用户输入、上游输出中含有敏感信息的场景，这会把敏感内容落到 `.tagma/logs`。([GitHub][5])

建议：加 `logPrompt: false` 默认值，或只在 debug 模式记录；同时提供敏感字段 redaction。

---

## P1 / 运行逻辑错误、功能会误判的问题

### 5. `parseResult` 抛错时，任务可能被错误判为成功

runtime 里注释写着：当 driver 的 `parseResult` 抛错且底层进程 exit code 为 0 时，返回 `failureKind: null`，并声称 UI/engine 会因为结果不完整而标失败；但 engine 的终态判断是：`failureKind` 不是 timeout/spawn_error、`exitCode === 0`、没有 completion，就判 `success`。这会导致“driver 解析失败但任务成功”的误判。([GitHub][4])

建议：`parseResult` 抛错一律返回 `failureKind: 'spawn_error'` 或新增 `'parse_error'`，engine 也明确处理。

### 6. `loadPipeline()` 文档说会 validate，但实现没有跑完整校验

SDK README 说 `loadPipeline(yaml, workDir)` 会“parses YAML, resolves inheritance, and validates the configuration”；但源码里的 `loadPipeline` 只是 `parseYaml` + `resolveConfig`。`validateRaw` 里才有空 prompt、空 command、duration、permissions、plugin 类型、refs、ports 等更完整的检查。([GitHub][1])

结果是：无效配置可能顺利 load，直到运行时才炸。建议：`loadPipeline` 调用 `validateRaw`，有错误直接 throw；或者文档改名为 `loadPipelineUnchecked` / `parseAndResolvePipeline`。

### 7. 插件解析路径与 public SDK 使用方式不一致

`PluginRegistry.loadPlugins(pluginNames, resolveFrom?)` 的注释明确说：如果不传 `resolveFrom`，会从 SDK 自身的 `node_modules` 解析，用户 workspace 安装的插件可能找不到。可 engine 调用 `registry.loadPlugins(config.plugins)` 时没传 `workDir`；`createTagma().run(config, { cwd })` 也只是把 cwd 传给 `runPipeline`，没有用于 plugin resolution。([GitHub][3])

建议：`runPipeline` 调用 `registry.loadPlugins(config.plugins, workDir)`；或者让 `createTagma().run` 自动 preload，再设置 `skipPluginLoading`。

### 8. pipeline 被 `pipeline_start` hook 阻止时，summary 的 blocked 数是 0

engine 注释说明 `pipeline_start` hook 在 `run_start` 前执行；如果 hook 拦截，返回 `success:false`，但 summary 里 `blocked: 0`。这和“被 gate 阻止”的事实不一致，也不利于 UI/统计。([GitHub][2])

建议：要么引入 pipeline-level blocked 状态，要么 summary.blocked 计入全部未启动任务，或者单独返回 `abortReason: 'pipeline_blocked'`。

### 9. Unix/macOS 下超时终止只杀直接子进程，不杀进程树

Windows 下用了 `taskkill /T` 杀进程树；非 Windows 下只 `proc.kill('SIGTERM')`，再对同一个 proc `SIGKILL`。如果 shell 命令或 CLI 又拉起子进程，孙进程可能继续跑。([GitHub][4])

建议：Unix 下用 process group / detached spawn，然后 `kill(-pid)`；或者 runtime 抽象里加入 `killTree` 能力。

### 10. trigger watcher 被 timeout/abort race 掉后，插件 promise 可能泄漏

`task-executor` 源码注释已经承认：trigger 的 `watch()` 和 abort/timeout race 后，孤儿 plugin promise 的 finally 不会跑，watcher 可以泄漏。这个对于 file watcher、webhook trigger、approval trigger 都可能变成资源泄漏。([GitHub][5])

建议：TriggerPlugin contract 必须支持 AbortSignal，engine 在超时后也要等待插件清理，或者 registry 包一层强制关闭资源的 API。

---

## P1 / API 设计不自洽、功能缺失

### 11. `TagmaPlugin.setup()` 暴露在类型里，但 registry 没有调用

类型层允许 `TagmaPlugin` 声明 `setup(ctx)`，也暴露 `PluginSetupContext`；但 registry 的 `registerTagmaPlugin` 只遍历 `capabilities` 的四类 map，没有调用 `setup`。这会让插件作者以为 setup 生效，实际不会执行。([GitHub][6])

建议：要么实现 setup，要么从 public type 移除，避免死 API。

### 12. `policies / storage / telemetry` 出现在类型里，但 registry 不支持

`PluginCapabilities` 里声明了 `policies`、`storage`、`telemetry`，但 registry 的支持分类只有 `drivers / triggers / completions / middlewares`。这属于“类型承诺了扩展点，运行时不支持”。([GitHub][6])

建议：暂时删掉未实现的能力，或者实现对应 registry/preflight/执行生命周期。

### 13. hooks 的 gate 语义过于隐蔽：只有 exit code 1 阻止

`pipeline_start` 和 `task_start` 是 gate hook，但实现里只有 exit code `1` 会 block，其他非 0 只是 warn 后继续。这对脚本作者不直观，因为大多数 CLI 约定“非 0 就失败”。([GitHub][7])

建议：默认“任何非 0 都 block”，如果需要兼容，提供 `allow_nonzero_hook_errors` 配置。

### 14. hook stdout/stderr 走 `console.warn/error`，没有统一进 pipeline log

hook 输出目前直接打到 console，不进入 Logger 的结构化 `task_log` / `pipeline.log` 体系。出了 hook 问题时，UI 和日志文件可能看不到完整上下文。([GitHub][7])

建议：`executeHook` 接收 Logger，hook 输出统一写 pipeline log。

### 15. trigger 错误分类靠 message substring 兜底

trigger catch 里如果不是 typed error，就用 message 里是否包含 `rejected/denied/timeout` 来判断 blocked/timeout。这对多语言、大小写、插件自定义错误都脆弱。([GitHub][5])

建议：强制插件抛 typed error，旧插件兜底只作为 warning，不参与核心状态判断。

---

## P2 / 文档、包结构和行为不自洽

### 16. 根 README 的包结构已经过期

根 README 仍把 `@tagma/sdk` 描述成 core engine，包列表也没有 `@tagma/core` 和 `@tagma/runtime-bun`；但实际 `packages/` 里已经有 `core`、`runtime-bun`，SDK README 也承认现在是 split packages：`core + runtime-bun + sdk`。([GitHub][8])

建议：根 README 的结构、build order、publish order 全部按 split package 更新。

### 17. README 说 “five plugin categories” 不准确

根 README 说五个 plugin packages 是“五个 plugin categories”的参考实现，但实际 registry 支持的类别只有四类：drivers、triggers、completions、middlewares；两个 driver 包只是同一类 driver 的不同实现。([GitHub][8])

建议：改成“四类插件能力，五个参考插件包”。

### 18. `@tagma/types` 声称 “types only, no runtime code”，但实际导出运行时常量/函数

`packages/types/package.json` 描述是 “types only, no runtime code”；根 README 也写 `types/ Type-only package`。但 `types/src/index.ts` 导出 `RUN_PROTOCOL_VERSION`、`TASK_LOG_CAP`、`parseDurationSafe` 等运行时代码。([GitHub][8])

建议：改描述为“shared protocol types and small runtime constants”，否则发布包定位误导。

### 19. “task id unique within pipeline” 与实际实现不一致

SDK README 的 Task 字段表写 `id` 是 “unique within the pipeline”；但 validateRaw 只检查同一 track 内重复 task id，DAG 也通过 `trackId.taskId` 做 qualified id，跨 track 同名 task 是允许的，只是在 bare ref 时可能 ambiguous。([GitHub][1])

建议：文档改成“unique within track；跨 track 引用用 `trackId.taskId`”。

### 20. `permissions.execute: false` 容易误导

Quick Start 里 track 设置 `execute:false`，下一步却有 `command: bun test`。文档权限表说 execute 是“Allow the agent to execute commands”，实际它主要约束 AI driver 的工具权限，不阻止 YAML command task 执行 shell。([GitHub][1])

建议：把权限命名/文档改成 `agent_permissions`，并明确 command task 永远是 host 执行，除非 safe mode 禁止。

### 21. SDK README 承认 npm/yarn/pnpm 能安装但 Node 运行会 crash

README 明确说包可被 npm/yarn/pnpm 安装，但在 Node 上第一次 spawn task 会 crash；这对 npm 用户体验不好，也容易形成运行时问题。([GitHub][1])

建议：入口处做 runtime guard，非 Bun 直接抛清晰错误；或者在 `preinstall` 强提示/阻止非 Bun 安装。

---

## P2 / 功能重复、遗留代码和维护风险

### 22. `sdk/src` 里仍保留大量 core 旧代码，和新分包重复

`packages/sdk/src` 目录里仍能看到 `engine.ts`、`dag.ts`、`registry.ts`、`hooks.ts`、`runtime.ts` 等旧核心文件；但当前 `sdk/src/index.ts` 已经主要从 `@tagma/core`、`@tagma/runtime-bun` re-export。([GitHub][9])

这会造成维护风险：修 bug 时可能修到旧文件，测试也可能误覆盖旧路径。建议：删除旧实现，只保留兼容 re-export；确实要保留的文件标注 deprecated，并在 CI 中防止被 import。

### 23. `MAX_NORMALIZED_BYTES` 在 engine 和 task-executor 重复定义

engine 文件里有 normalized output cap 常量，task-executor 里也有同名/同值逻辑。实际 clipping 在 task-executor 做，engine 里的常量看起来像死代码或迁移残留。([GitHub][2])

建议：统一放到 `types` 或 `core/constants.ts`，只保留一份。

### 24. plugin 类型冲突只 `console.warn`，没有结构化诊断

registry 允许后来注册的 handler 覆盖同 category/type 的旧 handler，只打 `console.warn`。在多插件/热加载场景，真实运行的是哪个插件可能不透明。([GitHub][3])

建议：默认禁止重复注册；热加载需要显式 `replace: true`。

### 25. opencode driver 会尝试全局安装 CLI，副作用偏大

内置 opencode driver 找不到 `opencode` 时，会探测 Bun 并执行 `bun install -g opencode-ai`。这对 SDK 直接使用者可能方便，但作为默认 driver，自动全局安装工具属于比较重的副作用。([GitHub][10])

建议：默认只报错并给安装提示；桌面端可由设置页显式安装，SDK 端需要 opt-in。

---

## 建议修复顺序

第一批先修：`runId` 校验、safe mode/可信边界、`parseResult` 误判、`loadPipeline` 校验、plugin resolveFrom、环境变量 allowlist。
第二批修：Unix process tree kill、trigger cleanup、hook gate 语义、hook 日志统一。
第三批清理：README/package 描述、task id 文档、permissions 命名、`sdk/src` 旧实现、未实现 plugin API。

[1]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/packages/sdk/README.md "raw.githubusercontent.com"
[2]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/packages/core/src/engine.ts "raw.githubusercontent.com"
[3]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/packages/core/src/registry.ts "raw.githubusercontent.com"
[4]: https://github.com/GoTagma/tagma-mono/blob/main/packages/runtime-bun/src/bun-process-runner.ts "tagma-mono/packages/runtime-bun/src/bun-process-runner.ts at main · GoTagma/tagma-mono · GitHub"
[5]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/packages/core/src/core/task-executor.ts "raw.githubusercontent.com"
[6]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/packages/types/src/index.ts "raw.githubusercontent.com"
[7]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/packages/core/src/hooks.ts "raw.githubusercontent.com"
[8]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/README.md "raw.githubusercontent.com"
[9]: https://github.com/GoTagma/tagma-mono/tree/main/packages/sdk/src "tagma-mono/packages/sdk/src at main · GoTagma/tagma-mono · GitHub"
[10]: https://github.com/GoTagma/tagma-mono/raw/refs/heads/main/packages/sdk/src/drivers/opencode.ts "raw.githubusercontent.com"
