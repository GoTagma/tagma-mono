# 2026-09-13 真实会话发现复核与修复

复核基于本地 HEAD `0fcd374098ce43d9d7a5716196c1284d1d731cbc` 及本次未提交修改。已读取 `/tmp/tagma-live-test-report.md`、`/tmp/tagma-live-test-state.json`、第 7 组的 plan/snapshot/outcomes，以及相关现存管线。使用 CodeGraph 定位后检查源码。原有 `PI_CHAT_AGENT_BACKEND_DESIGN.md` 与 CodeGraph 运行状态不属于本次修改。

历史测试工作区和失败草稿保持原样。所有新执行均使用临时隔离目录和本地命令/计数 driver；没有真实模型调用、计费修改、现有产品进程重启、发布或部署。

## 第 11 组：成立；历史提交冲突的具体文件归因仍有限制

### 首次失败

命令路径检查将命令文本中的管线内字面路径作为候选依赖，并检查真实工作区与 staged 文件是否一致。这包括赋值、生成数据和重定向的输出路径。Trial 将 Live Smoke readiness 纳入验证依据，并在执行后重新计算。Live Smoke 重写这些文件后，原先可执行的命令被重新分类为依赖不一致，于是成功运行使自己的依据失效。

先添加的隔离回归在修改前复现了两个 Sandbox 轮次加一个 Live Smoke 轮次、六个任务全部成功后验证失败的行为。修改后，同一个测试的首次验证与再次验证均通过，真实目标文件和 YAML 的 before-image 保持不变。

修复没有从命令检查中删除路径或按示例文件名豁免。根据文件型 completion 和 Trial 非 fixture 文件断言，保守识别可能产生目标管线产物的任务闭包，将其排除在发布前 Live Smoke 之外，并要求真实 Sandbox 终端覆盖。断言没有生产者身份时排除整个用例闭包。排除依据进入签名 readiness/cache，结果明确报告 Live Smoke 的缺失范围。脚本、hook、completion 和 static_context 的实际依赖检查保持有效。

### 后续提交冲突

当前代码在准备提交前比较不可变 staging baseline 与真实目标文件。Live Smoke 写入这些受管文件能够触发同一冲突机制；不能把它的写入接纳为新基线，也不能在执行后覆盖回旧文件，否则会破坏第三方修改保护。

历史 operation `operation-b586d199-1887-4c63-a47d-b43524b0293f` 的相关 stage 已删除，缺少可独立核对的原始 before-image 清单。事件顺序、最终文件和现存源码支持这一机制，但不足以证明当次冲突的每个具体文件都只由 Smoke 改动。本次没有将相邻事件当成唯一因果证据。

新增 Host 集成回归使用实际 Trial：同一认证会话先发布 JSON，再增加 CSV（含逗号、双引号城市名与整数分金额），成功复用拥有的目标并发布。随后注入真实第三方 YAML 改动，验证仍可通过，但提交正确拒绝且保留第三方字节。另一个隔离回归覆盖产物重写后的再次验证。

### 草稿和证据保留

当前自动验证失败、repair_no_change 等会保留草稿；这是已有正确行为。`target_changed_before_commit` 按仓库的不可变基线规定终止并丢弃 stage，因此不能将这一清理直接归为“验证失败错误删除草稿”。真正缺口是成功验证摘要只随 pending result/stage 存在，后续冲突清理会使 UI 缺少验证详情。本次将已有有界、脱敏的验证反馈一并写入 Host Trial 事件；集成回归确认 stage 清理和 Host 重建后反馈仍可读取。不会恢复已删除的历史详细数据。

`commit_decided`、WAL、取消、提交恢复与冲突判定没有改动。

主要文件：`server/chat-pipeline-trial-readiness.ts`、`server/chat-pipeline-trial-run.ts`、`server/chat-yaml-staging.ts`、`server/chat-pipeline-trial-cache.ts`、`server/chat-operations/authoring-runtime.ts`。

限制：输出判断依赖结构化文件完成检查/断言，不是通用 shell 或脚本写集合分析。动态且没有声明/断言的写入仍可能触发既有完整性保护；本次没有声称支持任意隐藏副作用。被排除的任务具有 Sandbox 证据，不具有实际生产环境 Smoke 证据。

## 第 7 组：fixture 能力缺口成立；static_context 忽略缺失文件不成立

历史 `negative-missing-rules` 使用 `fixtures: []`。执行器先复制完整 staged 管线，因此没有构造缺失。正例 fixture 与 staged 文件还有一个换行字节差异，不能仅通过“两个输入完全相同”的判断覆盖这一错误计划。

Trial Plan v10 增加最小表达：`{ "path": "<pipeline>/rules.md", "content": null }` 从隔离副本删除一个普通文件；`content: ""` 写空文件；省略 fixture 保留复制内容。同步了类型、Host 解析器、生成工具 schema/校验、预算、执行器和计划提示。删除操作不会计作已提供的输入或空内容覆盖；路径越界、符号链接、目录和管线控制文件仍拒绝。

对于相同目标且期望相反任务结果的用例，Host 要求负例显式描述正例控制的文件输入；相同有效文件输入的矛盾结果也会要求修正计划。它在执行和授权业务修复前返回计划问题，提示省略不能构造缺失。该检查不是从自然语言猜测缺失语义，也不解释任意 JSON pointer 或业务断言。将历史计划仅在内存升级协议后只读检查，新校验准确指出 `negative-missing-rules` 遗漏文件控制，未改历史文件。

计数 driver 回归实际执行五种独立用例：

| 用例                        | 预期和实测                    | driver 调用 |
| --------------------------- | ----------------------------- | ----------- |
| 正常 rules                  | 文本实际注入 prompt，运行成功 | 1           |
| 缺失，带前置检查            | 前置检查失败，AI/下游 skipped | 0           |
| 空文件，带前置检查          | 前置检查失败，AI/下游 skipped | 0           |
| 缺失，直接运行 middleware   | 必需文件加载明确失败          | 0           |
| 空文件，直接运行 middleware | 空上下文可加载，运行成功      | 1           |

源和 staged 的 rules 字节均不变，五个预期均通过，预期失败不产生实现修复授权。空文件是否允许由业务前置规则决定，不能将“空”和“缺失”混为一谈。SDK 自身已有缺失文件拒绝逻辑，本次没有修改它；其六个静态上下文测试也通过。已有 repair_no_change 草稿保留行为继续通过回归。

主要文件：`server/chat-pipeline-trial-plan.ts`、`server/opencode-trial-plan-tool.ts`、`server/opencode-seed.ts`、`server/chat-pipeline-trial-run.ts`、`server/chat-pipeline-trial-readiness.ts`。缓存版本同步升为 30，旧验证缓存必须重新取得证据；其他测试中的计划版本同步为 10，控制存储 schema v9 没有改动。

## 第 12 组：当前开发浏览器连接拥塞机制成立；打包 Electron 未验证

复现使用独立 Chrome profile、临时 HTTP/1.1 服务、当前前端真实订阅函数和两个标签页。服务端记录请求到达/连接关闭，CDP 记录请求发出/响应时序。历史加载 GET 与权限回复 POST 使用无副作用探测端点；没有操作真实 Chat 权限。

修复前每页分别订阅 state、run、workflow、Chat。两个标签页发出普通请求后，等待 1.5 秒服务端仍收到 0 个探测请求，而浏览器事件流继续有数据；独立进程访问同一服务立即返回。释放 B 的订阅并导航后，A 已排队请求立即到达并完成。这个复现把阻塞定位在浏览器请求到达服务之前，排除了该复现中的服务端锁和 renderer 回复投影。无需预先假定固定连接上限。

修复将同一 renderer/workspace 的 state、run、workflow 合并到 `/api/workspace/events`，Chat 保留独立认证和游标。三个消费者独立注销；服务器按 workspace 分别登记并清理；run/workflow 使用独立重放游标，不能共用 SSE 单个 Last-Event-ID。最后注销取消重连，替换连接后的迟到回调被拒绝，pagehide 释放连接、pageshow 恢复。

相同 Chrome 测试修复后两个标签页的四个请求均在 4–5 ms 内完成，干预前服务端已收到全部四个请求，工作区事件持续到达。前后记录分别保留在 `/tmp/tagma-network-before.json` 和 `/tmp/tagma-network-after.json`，复现脚本为 `/tmp/tagma-multitab-network.ts`。单元/路由测试覆盖独立工作区、游标重连、注销、切换、迟到事件、非法订阅和页面生命周期。

这确认了当前代码存在足以解释历史干预效果的连接拥塞机制，不证明历史环境从未发生其他阻塞。没有证据需要修改会话身份、权限仲裁或写目标绑定；这些权威路径未修改。两个标签页仍可同时使用，更多标签页的无限扩展不在本次验收范围。

主要文件：`src/api/workspace-events.ts`、`src/api/client.ts`、`server/routes/pipeline.ts`、`server/routes/run.ts`、`server/index.ts`。

## 验证与交付范围

- 本地编辑器序列回归 38 个文件全部成功退出，覆盖 Trial/plan/cache/readiness、真实发布、第三方冲突、commit/WAL/取消/恢复、草稿保留、权限交互、客户端事件和 SSE 重放。文件清单为 `/tmp/tagma-regression-files.json`。其中四个新增测试文件针对本次缺口，另有生成计划工具与会话发布测试扩展。
- SDK static_context：6 项通过，0 失败。
- `check:server`、`check:client`、`check:tests`、`check:deps`、`check:imports`、`check:cycles`、`check:text` 通过；变更文件 ESLint 和 Prettier 检查、编辑器及 sidecar 构建通过。一次并行类型构建造成的临时产物缺失已通过串行重跑消除；检查所需缓存/只读子进程的沙箱限制也已在授权检查环境重跑解决。
- 自动化真实浏览器范围：Chrome + 当前前端订阅代码 + 隔离模拟服务的传输测试。真实产品完整 UI、真实模型续轮，以及打包 Electron 均未重新运行，不能据此标为通过。
- 查询当前 HEAD 的 CI 记录未获得可报告的检查结果；未提交修改没有远端 CI 验证。本次未创建 commit。

进一步验证应在单独启动的完整开发实例及打包 Electron 中执行双窗口历史加载、实际权限回复和事件展示。不得为此重启仍承载历史会话的实例。历史第 11 组的具体冲突归因需要当时原始 baseline/WAL 证据，无法用事后相邻事件补足。
