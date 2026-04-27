我按当前 `main` 做了静态复核。结论是：**核心 P0/P1 里真正完全闭环的不多；有几项做了局部修补或文档尝试，但又引入了新的 README merge conflict / 编码乱码问题。** 我没有本地跑 `bun run check/test`，下面只基于当前仓库文件判断。

## 先说最明显的新问题

### 新增 P0：根 README 现在有未解决的 merge conflict 和乱码

当前根 `README.md` 里直接出现了 `<<<<<<< HEAD`、`=======`、`>>>>>>> e0adb...`，并且另一边内容有大量 `閳?` 乱码。也就是说，现在公开仓库首页就是冲突状态。这会直接影响项目可信度，也说明当前提交链里缺少 conflict-marker 检查。([GitHub][1])

这还会让你之前“修 README 包结构”的工作失效：HEAD 版本里确实补了 `core`、`runtime-bun`，但因为冲突没解决，README 现在不能算已修。([GitHub][1])

### 新增 P1：README 说“发布包只包含 dist”，但 package.json 仍包含 src

根 README 的 HEAD 分支内容写了“Published tarballs include `dist/` only”，但 `@tagma/core`、`@tagma/runtime-bun`、`@tagma/sdk` 的 `package.json` 仍然是 `"files": ["dist", "src"]`。这属于发布策略和实际包清单不一致。([GitHub][1])

### 新增 P1：`validate-raw.ts` 里也出现用户可见乱码

`packages/sdk/src/validate-raw.ts` 的注释和部分错误消息里有 `鈥?`、`鈹€`、`鈫?` 这类 mojibake。这个文件的错误消息会用于编辑器/校验反馈，所以不是单纯注释美观问题。([GitHub][2])

---

## 之前 25 个问题的当前状态

| 原编号 | 当前状态                | 复核结论                                                                                                                                                                                                                                 |
| --: | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
|   1 | **未覆盖**             | `runId` 仍由外部 options 传入，`Logger` 仍把 `runId` 交给 runtime logStore；Bun logStore 直接 `resolve(workDir, '.tagma', 'logs', runId)`，没看到 runId 正则或“必须留在 logs 根目录下”的二次校验。([GitHub][3])                                                         |
|   2 | **未覆盖**             | 仍没有看到 trusted/safe mode。YAML 仍可跑 `command`、hooks、completion command、插件动态加载等。插件名正则限制了路径，但 `loadPlugins` 仍会 `import()` npm 包，本质仍是代码执行。([GitHub][4])                                                                                    |
|   3 | **未覆盖**             | 子进程环境变量仍是 `{ ...process.env, ...(spec.env ?? {}) }`，也就是默认继承全部宿主环境变量。([GitHub][5])                                                                                                                                                    |
|   4 | **未覆盖 / 略有缓解但风险仍在** | AI 最终 prompt 仍通过 `log.quiet('--- prompt (final) --- ...')` 写入日志。虽然有 `clip()` 截断，但不是脱敏，也不是默认关闭。([GitHub][6])                                                                                                                          |
|   5 | **未覆盖，而且注释仍自洽性错误**  | `parseResult` 抛错且 exitCode 为 0 时，runtime 仍返回 `failureKind: null`；engine/task-executor 的终态判断里 `failureKind === null` 且 `exitCode === 0` 会继续走成功路径。这还是“解析失败被判成功”的核心 bug。([GitHub][5])                                                   |
|   6 | **未覆盖**             | `loadPipeline()` 仍然只是 `parseYaml()` + `resolveConfig()`，没有调用 `validateRaw()` 或更完整校验；`validateRaw()` 虽然存在，但不是 `loadPipeline` 路径的一部分。([GitHub][7])                                                                                     |
|   7 | **未覆盖**             | `PluginRegistry.loadPlugins(pluginNames, resolveFrom?)` 仍然支持 `resolveFrom`，但 engine 调用 `registry.loadPlugins(config.plugins)` 时没有传 `workDir/cwd`；`createTagma().run(config, { cwd })` 也只是把 cwd 传给 runPipeline，没有用于插件解析。([GitHub][3]) |
|   8 | **未覆盖**             | `pipeline_start` hook 阻止时 summary 仍返回 `blocked: 0`，没有表达“pipeline 被 gate block”。([GitHub][3])                                                                                                                                         |
|   9 | **未覆盖**             | Windows 使用 `taskkill /T` 杀进程树；非 Windows 仍只是 `proc.kill('SIGTERM')` 后对同一 proc `SIGKILL`，没有 kill process group。([GitHub][5])                                                                                                           |
|  10 | **部分覆盖，但仍有泄漏口**     | trigger watch 现在会传 `signal`，并且和 abort/timeout race；但源码注释也承认如果第三方 trigger 不处理 signal，孤儿 watcher promise 仍可能泄漏。([GitHub][6])                                                                                                           |
|  11 | **未覆盖**             | `TagmaPlugin.setup()` 仍在类型里，但 `registerTagmaPlugin` 只遍历 capabilities，没有调用 setup。([GitHub][8])                                                                                                                                        |
|  12 | **未覆盖**             | `PluginCapabilities` 仍声明 `policies/storage/telemetry`，但 registry 仍只支持 `drivers/triggers/completions/middlewares` 四类。([GitHub][8])                                                                                                    |
|  13 | **未覆盖**             | gate hook 仍然只有 exit code `1` 会 block，其他非 0 只是 warn 后继续。([GitHub][9])                                                                                                                                                                 |
|  14 | **未覆盖**             | hook stdout/stderr 仍走 `console.warn/error`，没有进入统一 Logger/pipeline log 体系。([GitHub][9])                                                                                                                                               |
|  15 | **未覆盖**             | trigger error 分类仍有 message substring fallback：`rejected/denied/timeout`。typed error 有了，但非 typed 仍按字符串猜。([GitHub][6])                                                                                                                 |
|  16 | **部分覆盖但被新冲突破坏**     | README 的 HEAD 侧已补 `core`、`runtime-bun`，但文件现在有 conflict markers 和乱码，所以不能算修好。([GitHub][1])                                                                                                                                             |
|  17 | **未覆盖**             | README 仍写“五个 plugin categories”，但 registry 实际只有四类能力：drivers、triggers、completions、middlewares。([GitHub][1])                                                                                                                           |
|  18 | **部分覆盖但未闭环**        | `types/src/index.ts` 顶部注释已改成“runtime code kept to minimum”，但 `packages/types/package.json` 仍写 “types only, no runtime code”，同时源码仍导出 `RUN_PROTOCOL_VERSION`、`TASK_LOG_CAP` 等运行时常量。([GitHub][8])                                       |
|  19 | **未覆盖**             | SDK README 仍写 task `id` 是 “unique within the pipeline”；但当前 validator 仍按“同一 track 内重复 task id”检查，跨 track 同名仍是 qualified ref 体系。([GitHub][10])                                                                                         |
|  20 | **未覆盖**             | README 仍在 Quick Start 里用 `permissions.execute: false`，后面又跑 `command: bun test`；权限说明仍是“Allow the agent to execute commands”，没有清楚区分 agent 工具权限和 YAML command 的 host 执行。([GitHub][10])                                                  |
|  21 | **大部分覆盖，但文档没同步**    | `packages/sdk/scripts/preinstall.js` 现在会在非 Bun 安装时退出 1，这覆盖了“npm/yarn/pnpm 能装但运行才 crash”的安装层问题；但 SDK README 仍写“npm/yarn/pnpm 会无错误安装，Node 上首次 spawn crash”，这已经和 preinstall 行为矛盾。([GitHub][11])                                         |
|  22 | **部分覆盖，但仍残留维护风险**   | `sdk/src/engine.ts`、`registry.ts`、`runner.ts`、`types.ts` 现在多是 wrapper/re-export，说明你确实在向分包迁移；但 `packages/sdk/src` 仍保留大量旧结构文件和目录，且 package.json 仍发布 `src`。风险从“核心重复实现”变成“兼容层 + 残留源文件 + 发布策略不一致”。([GitHub][12])                          |
|  23 | **未覆盖**             | `MAX_NORMALIZED_BYTES` 仍在 `engine.ts` 和 `task-executor.ts` 各定义一份；engine 里的那份看起来仍像迁移残留。([GitHub][3])                                                                                                                                  |
|  24 | **未覆盖**             | plugin type 冲突仍只是 `console.warn`，后注册者覆盖旧 handler，默认没有 hard fail。([GitHub][4])                                                                                                                                                        |
|  25 | **部分覆盖，但核心建议未采纳**   | desktop/bundled opencode 路径做了说明和优化；但 SDK direct use 找不到 `opencode` 时仍会执行 `bun install -g opencode-ai`，全局安装副作用仍存在，没有变成 opt-in。([GitHub][13])                                                                                          |

---

## 这次改动里确实有价值的覆盖点

比较明确的正向变化有三块。

第一，**分包迁移更清晰了**。`@tagma/core` 和 `@tagma/runtime-bun` 已在 root scripts、package 结构、SDK wrapper 中出现，SDK 的一些旧入口已经变成 re-export/wrapper。这降低了“修错旧代码”的概率，但还没完全清理。([GitHub][14])

第二，**非 Bun 安装现在有 preinstall guard**。这基本覆盖了之前“npm 能装但 Node 运行才炸”的一半问题；剩下就是把 README 的旧说法改掉。([GitHub][11])

第三，**validateRaw 变强了**。现在它检查空 prompt/command、duration、permissions、插件类型 warning、refs、typed inputs/outputs、ports 迁移等内容；只是 `loadPipeline()` 没调用它，所以这个增强还没覆盖 SDK 常规加载路径。([GitHub][2])

---

## 当前最该先修的顺序

1. **先修 README conflict 和编码乱码**：这是马上可见的发布质量问题，建议加 CI：`grep -R "<<<<<<<\\|=======\\|>>>>>>>" README.md packages apps docs`，同时检查 mojibake 字符。
2. **修 `parseResult` 误判成功**：`parseResult` catch 应该返回 `failureKind: 'spawn_error'` 或新增 `'parse_error'`，不要在 exit 0 时返回 `null`。
3. **修 `runId` 路径安全**：`runId` 只允许 `run_[A-Za-z0-9_-]+` 或类似白名单，并且 logStore 内部二次确认 resolved path 没逃出 `.tagma/logs`。
4. **修 plugin resolveFrom**：`runPipeline` 加 `registry.loadPlugins(config.plugins, workDir)`，或者 SDK `createTagma().run` preload 后传 `skipPluginLoading: true`。
5. **改子进程 env 默认策略**：不要默认继承全部 `process.env`，至少提供 `envPolicy: 'inherit' | 'minimal' | 'allowlist'`，默认建议 minimal。
6. **让 `loadPipeline()` 真正 validate**：要么调用 `validateRaw` 并 throw，要么把 README/函数名明确改成 unchecked。

一句话总结：**你已经覆盖了一些“分包结构”和“安装体验”的问题，但我上次列的高风险执行边界、日志安全、插件解析、parseResult 误判、hook 语义，大多数仍然存在；这次还额外出现了 README merge conflict/乱码和发布文件策略不一致。**

[1]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/README.md "raw.githubusercontent.com"
[2]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/packages/sdk/src/validate-raw.ts "raw.githubusercontent.com"
[3]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/packages/core/src/engine.ts "raw.githubusercontent.com"
[4]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/packages/core/src/registry.ts "raw.githubusercontent.com"
[5]: https://github.com/GoTagma/tagma-mono/blob/main/packages/runtime-bun/src/bun-process-runner.ts "tagma-mono/packages/runtime-bun/src/bun-process-runner.ts at main · GoTagma/tagma-mono · GitHub"
[6]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/packages/core/src/core/task-executor.ts "raw.githubusercontent.com"
[7]: https://github.com/GoTagma/tagma-mono/blob/main/packages/sdk/src/schema.ts "tagma-mono/packages/sdk/src/schema.ts at main · GoTagma/tagma-mono · GitHub"
[8]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/packages/types/src/index.ts "raw.githubusercontent.com"
[9]: https://github.com/GoTagma/tagma-mono/blob/main/packages/core/src/hooks.ts "tagma-mono/packages/core/src/hooks.ts at main · GoTagma/tagma-mono · GitHub"
[10]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/packages/sdk/README.md "raw.githubusercontent.com"
[11]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/packages/sdk/scripts/preinstall.js "raw.githubusercontent.com"
[12]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/packages/sdk/src/engine.ts "raw.githubusercontent.com"
[13]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/packages/sdk/src/drivers/opencode.ts "raw.githubusercontent.com"
[14]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/package.json "raw.githubusercontent.com"
