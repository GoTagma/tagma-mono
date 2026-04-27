我重新按当前 `main` 做了静态复核。结论：**清单有变动，但主要是“发布包/分包/安装体验”有改善；真正影响安全边界和运行正确性的核心问题，大部分还在。** 另外，根 README 的 merge conflict 和乱码问题仍然是当前最显眼的新/未修问题。

我没有跑 CI 或完整测试，这份是基于当前远端源码的静态审查。

---

## 一、这次相对上次的变化

### 已经明显覆盖或改善的点

1. **发布包包含 `src` 的问题基本修了。**
   `@tagma/core` 的 `files` 现在只有 `dist`，`@tagma/sdk` 的 `files` 现在是 `dist` 加 `scripts/preinstall.js`，不再把整个 `src` 发布出去；构建脚本也会先清理当前包的 `dist` 再跑 `tsc`。这覆盖了上次“README 说 dist-only，但 package.json 还发布 src”的矛盾。([GitHub][1])

2. **`@tagma/types` 的包描述已经更准确。**
   `packages/types/package.json` 现在写的是 “Shared contracts and small runtime helpers”，不再是之前那种 “types only, no runtime code” 的强误导；源码注释也承认有极少运行时代码。这个点基本算修了。([GitHub][2])

3. **非 Bun 安装现在有 preinstall guard。**
   `packages/sdk/scripts/preinstall.js` 会拒绝 npm/yarn/pnpm 这类非 Bun 安装路径，并提示 `bun add @tagma/sdk`。这覆盖了“npm 安装成功，运行时第一次 spawn 才崩”的一半问题。([GitHub][3])
   但 SDK README 仍然写“npm/yarn/pnpm 会无错误安装，但 Node 运行时崩”，所以**文档还没同步**。([GitHub][4])

4. **OpenCode driver 的自动全局安装副作用已经改掉。**
   当前 `opencode.ts` 明确写了：driver 只探测 CLI 并给 setup guidance，**不会在 pipeline run 里修改全局工具链**；找不到 OpenCode CLI 时只抛错并提示手动安装。这个覆盖了上次“自动 `bun install -g opencode-ai` 副作用过大”的问题。([GitHub][5])

5. **trigger/watch 的 abort 支持比之前更好。**
   当前 task executor 会把 `signal` 传给 trigger watch；runtime-bun 的 `watchPath` 也会监听 abort，并在 finally 里关闭 watcher。这个点有改善。([GitHub][6])
   但源码注释仍承认：如果第三方 trigger 忽略 `signal`，孤儿 promise / watcher 仍可能泄漏，所以只能算“部分覆盖”。([GitHub][6])

6. **插件 contract validation 有增强。**
   registry 现在会对 driver/trigger/completion/middleware 的基本 contract 做注册期检查，例如 driver 必须有 `buildCommand()`、`capabilities` 字段必须是 boolean 等。这是正向变化。([GitHub][7])
   但 `setup()` 未调用、重复插件只 warn 后替换、未实现 capabilities 仍暴露等问题还在。

---

## 二、新的完整问题清单

## P0 / 先修：会直接影响项目可信度、安全边界或核心正确性

### 1. 根 README 仍有未解决的 merge conflict 和乱码

当前 raw README 里还能看到 `<<<<<<< HEAD`、`=======`、`>>>>>>>`，并且另一分支内容出现大量 `閳?` 乱码。这是最显眼的问题：公开仓库首页源文件处于冲突状态，也说明缺少 conflict-marker / mojibake 检查。([GitHub][8])

建议：马上清理 README，然后 CI 加两类检查：

```bash
grep -R "<<<<<<<\|=======\|>>>>>>>" README.md packages apps docs
grep -R "閳\|鈥\|鈹\|闂" README.md packages apps docs
```

### 2. `runId` 仍然可能造成日志路径逃逸

`runPipeline` 仍允许外部传 `options.runId`，然后 Logger 会把这个 runId 交给 runtime logStore；runtime-bun 的 `openRunLog` 直接把 `runId` 拼到 `resolve(workDir, '.tagma', 'logs', runId)`，`taskOutputPath` 也直接用 runId 拼路径，没有看到 runId 白名单或 path containment 校验。([GitHub][9])

建议：
`runId` 只允许类似 `/^[A-Za-z0-9_-]+$/`，并且 `openRunLog()` 内部二次校验：

```ts
const base = resolve(workDir, '.tagma', 'logs');
const dir = resolve(base, runId);
if (!dir.startsWith(base + sep)) throw new Error('Invalid runId');
```

### 3. pipeline 配置仍然缺少 trusted / safe mode 边界

当前 YAML 仍然可以触发 shell command、hooks、completion command、插件动态 import、AI CLI 调用等。registry 虽然限制插件名必须是 scoped npm 包或 tagma-prefixed 包，但最终仍是 `import()` 外部包，本质还是代码执行。([GitHub][7])

这对“运行本地可信 pipeline”可以接受，但对“打开别人仓库里的 pipeline”风险很高。

建议：加入：

```ts
mode: 'trusted' | 'safe'
```

safe mode 下默认禁用：

* `command`
* lifecycle hooks
* `output_check` / shell completion
* 自动 `plugins` 动态加载
* 未显式 allowlist 的 driver / trigger / middleware

### 4. 子进程默认继承全部环境变量，密钥泄露风险仍在

runtime-bun 的 `runSpawn` 仍然把 `process.env` 和 `spec.env` 合并后传给子进程，也就是默认把宿主环境变量全部暴露给 AI CLI、shell command、hook、completion 等。([GitHub][10])

建议默认改成 minimal env，只传必要变量：

```ts
PATH, HOME, USER, SHELL, TMPDIR, TEMP, TMP
```

需要 token 或特殊变量时，通过 allowlist 显式注入，例如：

```ts
envPolicy: {
  mode: 'allowlist',
  keys: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']
}
```

### 5. `parseResult` 抛错时仍可能被误判为成功

runtime-bun 的 `parseResult` catch 里，如果底层进程 `exitCode === 0`，仍会返回 `failureKind: null`。但 task executor 的终态逻辑里，`failureKind === null` 且 `exitCode === 0` 会继续走成功路径，所以“driver 解析失败但任务成功”的误判仍存在。([GitHub][10])

更糟的是，runtime 注释还写“engine/UI 会因为结果不完整而标失败”，但当前 task executor 的成功判断并不会这样处理。([GitHub][10])

建议：新增 failure kind：

```ts
type TaskFailureKind =
  | 'timeout'
  | 'spawn_error'
  | 'exit_nonzero'
  | 'parse_error'
  | null;
```

`parseResult` catch 一律返回 `parse_error`，不要在 exit 0 时返回 `null`。

---

## P1 / 运行逻辑、API 自洽和资源管理问题

### 6. `loadPipeline()` 文档说会 validate，但实现仍没有跑完整校验

SDK README 仍说 `loadPipeline(yaml, workDir)` 会 parse、resolve、validate；但 `schema.ts` 里的 `loadPipeline` 仍只是 `parseYaml(content)` 加 `resolveConfig(raw, workDir)`，没有调用 `validateRaw()`。([GitHub][4])

这会导致一些配置错误不能在 load 阶段被发现，而是拖到运行时或 UI 层才暴露。

建议：

```ts
export async function loadPipeline(content: string, workDir: string) {
  const raw = parseYaml(content);
  const diagnostics = validateRaw(raw);
  if (diagnostics.some(d => d.severity === 'error')) {
    throw new PipelineValidationError(diagnostics);
  }
  return resolveConfig(raw, workDir);
}
```

或者把当前函数改名为 `loadPipelineUnchecked()`。

### 7. plugin resolveFrom 仍未接入 engine

registry 的 `loadPlugins(pluginNames, resolveFrom?)` 支持从指定目录解析插件；SDK README 也提示 workspace-local plugin 应该传 `resolveFrom`。但 core engine 仍调用 `registry.loadPlugins(config.plugins)`，没有传 `workDir` / `cwd`。([GitHub][9])

结果是：用户在项目 workspace 安装的插件，可能因为解析基准不对而找不到。

建议：

```ts
await registry.loadPlugins(config.plugins, workDir);
```

或者 SDK `createTagma().run(config, { cwd })` 先 preload 插件，再设置 `skipPluginLoading: true`。

### 8. `pipeline_start` hook 阻止时，summary 仍然写 `blocked: 0`

engine 里 `pipeline_start` hook 不允许继续时，会返回 `success: false`，但 summary 里的 `blocked` 仍是 0。这个统计和实际语义不一致。([GitHub][9])

建议改成：

```ts
summary: {
  total,
  success: 0,
  failed: 0,
  skipped: 0,
  timeout: 0,
  blocked: total
}
```

或者新增 pipeline-level 字段：

```ts
abortReason: 'pipeline_blocked'
```

### 9. Unix/macOS 超时终止仍只杀直接子进程，不杀进程树

Windows 下有 `killProcessTree`；非 Windows 下仍是对直接进程 `SIGTERM`，再 `SIGKILL`。如果 shell command 或 AI CLI 再拉起子进程，孙进程可能继续跑。([GitHub][10])

建议 Unix/macOS 用 process group：

```ts
Bun.spawn(args, { ...spec, detached: true });
process.kill(-pid, 'SIGTERM');
```

### 10. trigger cleanup 只“部分改善”，第三方 trigger 仍可能泄漏

当前 task executor 会把 `signal` 传给 trigger watch，并且 runtime-bun 的 built-in watcher 会在 finally 里 close watcher；这是改善。([GitHub][6])
但源码注释仍明确写：如果 plugin 不处理 signal，race 后孤儿 promise 的 finally 不会跑，watcher 仍可能泄漏。([GitHub][6])

建议把 trigger 插件 contract 改成强约束：必须响应 AbortSignal；registry 注册期可检查 `supportsAbort: true` 或由包装层强制管理资源。

### 11. `TagmaPlugin.setup()` 还在类型里，但 registry 仍不调用

types 里 `TagmaPlugin` 仍声明了 `setup(ctx)`；但 registry 的 `registerTagmaPlugin()` 只遍历 capabilities 注册 handler，没有执行 `plugin.setup`。([GitHub][11])

这会误导插件作者：他们以为 setup 会跑，实际不会。

建议二选一：

* 实现 setup lifecycle；
* 或从 public type 移除 `setup`。

### 12. `policies / storage / telemetry` 仍暴露在类型里，但 registry 不支持

`PluginCapabilities` 仍有 `policies`、`storage`、`telemetry`，但 registry 当前支持的 capability categories 只有 `drivers`、`triggers`、`completions`、`middlewares`。([GitHub][11])

建议：暂时从 public capabilities 删除未实现项，或者完整实现对应 registry 和运行生命周期。

### 13. hook gate 语义仍然不直观：只有 exit code 1 会 block

当前 `pipeline_start` 和 `task_start` 是 gate hooks，但只有 `exitCode === 1` 会阻止执行；其他非 0 只 warn 后继续。大多数 CLI/脚本约定是“任何非 0 都代表失败”，所以这个行为很容易踩坑。([GitHub][12])

建议默认改成：

```ts
if (isGate && exitCode !== 0) block
```

如果要兼容旧行为，提供：

```yaml
hooks:
  gate_nonzero_policy: exit_1_only
```

### 14. hook 输出仍然没有进入统一 pipeline log

hook 的 stdout/stderr 仍然直接 `console.warn` / `console.error`，没有走 Logger，也没有进入 `.tagma/logs/<runId>/pipeline.log` 的结构化体系。([GitHub][12])

建议 `executeHook()` 接收 Logger 或 `HookLogSink`，把 hook stdout/stderr 写进 run log。

### 15. trigger 错误分类仍靠 message substring 兜底

trigger catch 里有 typed error 判断，但非 typed error 仍会根据 message 里是否包含 `rejected`、`denied`、`timeout` 来分类。这对多语言、自定义错误、大小写、误匹配都很脆弱。([GitHub][6])

建议：核心状态只能由 typed error 决定；字符串 fallback 最多作为 warning，不参与最终状态判断。

### 16. 最终 prompt 仍默认写日志，敏感信息落盘风险还在

AI task 会把 middleware 之后的 final prompt 写进日志；虽然有 `clip()` 截断，但这不是脱敏，也不是默认关闭。prompt 里可能包含源码、用户输入、RAG 内容、上游输出，甚至 secret。([GitHub][6])

建议：

```ts
logPrompt: false
```

作为默认值；需要调试时显式打开，并支持 redaction。

### 17. `validate-raw.ts` 仍有 mojibake，且可能影响用户可见诊断

`packages/sdk/src/validate-raw.ts` 里仍出现 `鈥`、`鈹`、`鈫` 等乱码，这些不只是注释问题，因为 validator 的错误信息/诊断文本会影响编辑器和用户反馈。([GitHub][13])

建议全仓做 UTF-8 清洗，并在 CI 里加 mojibake 扫描。

---

## P2 / 文档不自洽、设计不合理、维护风险

### 18. 根 README 的包结构修了一半，但被 conflict 状态抵消

README 的 HEAD 分支内容里已经出现 `@tagma/core`、`@tagma/runtime-bun` 等新结构，说明你确实在修分包文档；但因为 README 仍处于 conflict marker 状态，所以不能算真正修好。([GitHub][8])

建议先解决 conflict，再重新整理包结构为：

```text
packages/
  types/
  core/
  runtime-bun/
  sdk/
  driver-codex/
  driver-claude-code/
  ...
```

### 19. README 仍把“五个插件包”说成“五个 plugin categories”

registry 实际支持四类 capability：drivers、triggers、completions、middlewares；但 README 冲突内容中仍保留“五个 plugin categories”的说法。五个插件包不是五个类别，因为 codex driver 和 claude-code driver 都属于 driver 类。([GitHub][8])

建议改成：

> Four plugin capability categories, with several reference plugin packages.

### 20. SDK README 的 Bun-only 说明和 preinstall 行为矛盾

SDK README 仍写：npm/yarn/pnpm 会无错误安装，但 Node 运行时第一次 spawn 才 crash。实际上当前 `preinstall.js` 会在非 Bun 环境直接 exit 1。([GitHub][4])

建议 README 改成：

> Installing with npm/yarn/pnpm is blocked by preinstall. Use `bun add @tagma/sdk`.

### 21. task id 文档仍写 “unique within pipeline”，但实现更像 “unique within track”

SDK README 的 Task 字段表仍说 `id` 是 “unique within the pipeline”；但 schema 里明确用 `trackId.taskId` 作为 qualified separator，并且禁止 id 里出现 dot，以避免 qualified ID 歧义。([GitHub][4])

建议文档改成：

> Task id must be unique within its track. Cross-track references should use `trackId.taskId`.

### 22. `permissions.execute: false` 仍然容易误导

Quick Start 里 track 写了：

```yaml
permissions: { read: true, write: true, execute: false }
```

但后面的 task 又有：

```yaml
command: 'bun test'
```

这容易让用户误以为 `execute: false` 会禁止 YAML command 执行。README 的权限表仍把 `execute` 描述为 “Allow the agent to execute commands”，但没有清楚区分“AI agent 工具权限”和“host 执行 YAML command”。([GitHub][4])

建议改名或补充说明：

```yaml
agent_permissions:
  execute: false
```

并明确：

> `command` tasks are host shell execution and are controlled by safe/trusted mode, not by agent permissions.

### 23. `sdk/src` 仍保留大量旧结构，虽然不再发布但仍有维护风险

`packages/sdk/src` 里仍有 `core`、`runtime`、`drivers`、`triggers`、`engine.ts`、`hooks.ts`、`registry.ts`、`runtime.ts` 等大量文件/目录。由于 `@tagma/sdk` 现在 package files 只发布 `dist` 和 preinstall script，这个问题从“发布包污染”降级为“仓库维护风险”。([GitHub][14])

风险是：后续修 bug 时容易误修旧兼容层或残留文件。

建议：
能删就删；必须保留的文件加 `deprecated` 注释，并在测试/CI 中确保 public exports 不引用旧实现。

### 24. `MAX_NORMALIZED_BYTES` 仍重复定义

`core/src/engine.ts` 里仍有 `MAX_NORMALIZED_BYTES`，task executor 里也有 normalized output cap 相关逻辑。engine 那份看起来像迁移残留。([GitHub][9])

建议统一到：

```ts
packages/core/src/constants.ts
```

或者直接复用 `@tagma/types` 里的协议常量体系。

### 25. 插件重复注册仍只是 warn 后替换

registry 注册 capability 时，如果同 category/type 已存在，仍是 `console.warn` 然后替换。多插件场景下，这会让最终生效的插件不透明。([GitHub][7])

建议默认 hard fail：

```ts
throw new Error(`Duplicate plugin capability: ${category}:${type}`);
```

需要热替换时显式：

```ts
register(plugin, { replace: true })
```

### 26. 插件名限制降低了路径注入风险，但动态 import 本身仍需要权限模型

当前 `PLUGIN_NAME_RE` 限制插件名必须是 scoped npm package 或 `tagma-plugin-*`，这比允许任意相对/绝对路径安全很多；但 registry 最终仍会动态 `import()` 插件包。([GitHub][7])

所以这个点不是“bug”，而是需要产品层明确：插件加载等同执行代码。建议在 safe mode 禁用自动 plugin loading，trusted mode 才允许。

### 27. OpenCode driver 里仍有源码乱码注释

OpenCode driver 不再自动全局安装，这是好变化；但文件里仍出现 `闂?` 这类乱码注释。这个不会直接影响运行逻辑，但会影响维护质量，也说明仓库里还有编码清理没完成。([GitHub][5])

建议和 README / validate-raw 一起做全仓编码清理。

### 28. root README 与 SDK README 对包边界的表达还没有完全统一

SDK README 已经写“SDK composes `@tagma/core` with `@tagma/runtime-bun`”，这比旧文档准确；但根 README 仍处于 conflict 状态，且一边内容还残留旧包结构/旧表述。([GitHub][4])

建议根 README、SDK README、package description 三处统一术语：

* `@tagma/types`: shared contracts + small runtime helpers
* `@tagma/core`: engine, DAG, registry, hooks contracts
* `@tagma/runtime-bun`: Bun runtime adapter
* `@tagma/sdk`: ergonomic facade / compatibility package

---

## 三、上次 25 项的当前状态汇总

| 原问题                                       | 当前状态                                 |
| ----------------------------------------- | ------------------------------------ |
| 1. `runId` 路径逃逸                           | **未修**                               |
| 2. 缺少 safe/trusted mode                   | **未修**                               |
| 3. 子进程继承全部 env                            | **未修**                               |
| 4. prompt 默认写日志                           | **未修**                               |
| 5. `parseResult` 抛错被判成功                   | **未修**                               |
| 6. `loadPipeline` 不跑完整 validate           | **未修**                               |
| 7. plugin `resolveFrom` 没接入 engine        | **未修**                               |
| 8. pipeline_start blocked 统计不对            | **未修**                               |
| 9. Unix/macOS 不杀进程树                       | **未修**                               |
| 10. trigger watcher 泄漏                    | **部分改善，未闭环**                         |
| 11. `TagmaPlugin.setup()` 不调用             | **未修**                               |
| 12. `policies/storage/telemetry` 类型暴露但未实现 | **未修**                               |
| 13. gate hook 只有 exit 1 block             | **未修**                               |
| 14. hook 输出不进统一日志                         | **未修**                               |
| 15. trigger 错误分类靠字符串                      | **未修**                               |
| 16. 根 README 包结构过期                        | **部分修，但被 conflict 破坏**               |
| 17. “five plugin categories” 不准确          | **未修**                               |
| 18. `@tagma/types` types-only 描述          | **基本修了，但 README conflict 里仍可能残留旧文案** |
| 19. task id 文档 unique within pipeline     | **未修**                               |
| 20. `permissions.execute` 误导              | **未修**                               |
| 21. npm 安装后 Node runtime crash            | **实现已修，README 未同步**                  |
| 22. `sdk/src` 旧结构重复                       | **降级为维护风险，未完全清理**                    |
| 23. `MAX_NORMALIZED_BYTES` 重复             | **未修**                               |
| 24. 插件冲突只 warn                            | **未修**                               |
| 25. OpenCode 自动全局安装                       | **已修**                               |

---

## 四、当前建议修复顺序

1. **立刻修 README conflict + 全仓乱码。** 这是当前最影响可信度的问题。
2. **修 `parseResult` false success。** 这是实际运行正确性 bug。
3. **修 `runId` 路径安全。** 这是日志写入边界问题。
4. **加 safe/trusted mode。** 这是整个项目作为 pipeline runner 的安全边界核心。
5. **改子进程 env 默认策略。** 防止 token/secret 默认泄露给子进程。
6. **让 `loadPipeline()` 真正 validate。** 否则 SDK README 和实际行为继续不一致。
7. **接入 plugin `resolveFrom = workDir`。** 修 workspace plugin 解析问题。
8. **清理 hook / trigger / plugin lifecycle 的不自洽点。**

一句话版：**这次比上次确实修了发布包、Bun install guard、types 描述、OpenCode 自动安装这几类问题；但安全边界、parseResult 误判、runId 路径、env 泄露、loadPipeline 校验、hook/plugin 生命周期这些核心问题仍然大多没动。**

[1]: https://github.com/GoTagma/tagma-mono/blob/main/packages/sdk/package.json "tagma-mono/packages/sdk/package.json at main · GoTagma/tagma-mono · GitHub"
[2]: https://github.com/GoTagma/tagma-mono/blob/main/packages/types/package.json "tagma-mono/packages/types/package.json at main · GoTagma/tagma-mono · GitHub"
[3]: https://github.com/GoTagma/tagma-mono/blob/main/packages/sdk/scripts/preinstall.js "tagma-mono/packages/sdk/scripts/preinstall.js at main · GoTagma/tagma-mono · GitHub"
[4]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/packages/sdk/README.md "raw.githubusercontent.com"
[5]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/packages/sdk/src/drivers/opencode.ts "raw.githubusercontent.com"
[6]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/packages/core/src/core/task-executor.ts "raw.githubusercontent.com"
[7]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/packages/core/src/registry.ts "raw.githubusercontent.com"
[8]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/README.md "raw.githubusercontent.com"
[9]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/packages/core/src/engine.ts "raw.githubusercontent.com"
[10]: https://github.com/GoTagma/tagma-mono/blob/main/packages/runtime-bun/src/bun-process-runner.ts "tagma-mono/packages/runtime-bun/src/bun-process-runner.ts at main · GoTagma/tagma-mono · GitHub"
[11]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/packages/types/src/index.ts "raw.githubusercontent.com"
[12]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/packages/core/src/hooks.ts "raw.githubusercontent.com"
[13]: https://raw.githubusercontent.com/GoTagma/tagma-mono/refs/heads/main/packages/sdk/src/validate-raw.ts "raw.githubusercontent.com"
[14]: https://github.com/GoTagma/tagma-mono/tree/main/packages/sdk/src "tagma-mono/packages/sdk/src at main · GoTagma/tagma-mono · GitHub"
