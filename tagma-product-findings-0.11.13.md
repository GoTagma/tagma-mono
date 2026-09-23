# Tagma 编辑器 0.11.13 — 产品问题分类报告

| 项 | 值 |
|---|---|
| 日期 | 2026-09-18 |
| 被测版本 | Tagma editor 0.11.13（Electron + React renderer + Node sidecar），内置 OpenCode 1.18.18 |
| 工作区 | `e:\tagma-ws-65` |
| 启动方式 | 非 Electron 开发启动（`sidecarSource: "dev"`，renderer on localhost:5173） |
| 驱动模型 | `deepseek/deepseek-flash` |
| 测试集 | `Tagma Test Sets: Fact Checker` |
| 手段 | 诊断 API（协议 1，loopback :3001，只读）+ Chat Control API（协议 1，`/api/agent-chat/v1`） |
| 改动 | 除经用户授权的 `operation.retry`（状态推进，非破坏性）外，未修改任何文件、设置、进程或编辑器状态 |

> **敏感性**：本文件含诊断视图内容，属敏感信息，未经审查请勿分享。

---

## 分类总表

| ID | 标题 | 分类 | 严重度 |
|---|---|---|---|
| P8 | blocked trial 无出口：唯一可用命令确定性空转，repair 路径不可达 | 产品问题 | 高 |
| P9 | 设置文案将"硬门禁"描述为"可选加固"，与实际执行语义矛盾 | 产品问题 | 中 |
| P10 | 创作 agent 被禁止考虑可试运行性，导致必然无法验证的产物 | 产品问题 | 中 |
| P11 | clarify 零候选死锁（必填参数渲染为空串 → `parameters_required`） | 产品问题 | 中 |
| — | 权限摩擦：agent 无法枚举自身沙箱，逐路径提示 | 产品观察（次要） | 低 |
| — | P7（repair 以 compile 判定） | 判定变更：0.11.13 未复现 | — |
| — | 日志/会话投影缺失、`permissionChoices` 无 `always`、`sess={}` 等 | 外部因素（已排除） | — |
| — | 权限在无人值守下自动解决（36 s / 1.4 s，无命令、无日志行） | 待定 | — |

P1–P6 沿用既有问题清单，本文不重复。

---

## 产品问题

### P8 — blocked trial 无出口　【高】

**现象**：trial 在预检阶段被拦，操作停在与上一轮**完全相同的** `trial-running / wait=user_retry`，而 chat 给出的唯一可用命令在代码上不可能改变结果。

**根因链**（逐环已验）：

1. 任务声明 `network: read`（`apps/editor/server/chat-pipeline-trialability.ts:178-182` → `needsLiveSmoke = true`）
2. `trialMode` 只由设置决定（`apps/editor/server/chat-pipeline-trial-run.ts:4264-4266`）
3. 设置中 `LiveSmokeTestEnabled: false`、`ConsentVersion: 0`，而门禁要求 `true` 且 `2`（`apps/editor/shared/chat-pipeline-trial-consent.ts:2,11-20`）
4. → 非 `sandbox-with-live-smoke` → 推入 blocker → `live-smoke-only`（`chat-pipeline-trialability.ts:193-195`）
5. → `trial_blocked`。因 `failedTaskIds: []`，无任何东西授权改管线，`repairAuthorization !== 'pipeline-change-allowed'` → 判成 `unverified` 而非 `repair_required`（`apps/editor/server/chat-operations/authoring-runtime.ts:2939`），**自动修复不启动**
6. → `wait=user_retry`。唯一可用命令 `operation.retry` 不碰设置，因此结果不变

**实测证据**（本次会话最硬的一条）：

```
POST /commands -> HTTP 202 in 12ms
  #41 operation_state_changed  wait=null
  #42 trial_status_changed     {"errorCode":"trial_blocked"}   ← details 逐字节同 #36/#39
  #43 operation_state_changed  wait=user_retry
```

POST `createdAt=1789711746314` → `#43≈1789711746577`，**263 ms**。预检早于任何 driver 调用，**零 token 消耗**。

草稿在重试后完好：YAML 4405 B、mtime 未变，仅 `layout.json` 被触碰。

**影响**：用户面对一个按钮点不动、错误信息点不开的死局。`interaction.recover`（携带 `repair_new_invocation`）虽在 manifest 中声明，但本状态下 `available: false / parameters_required / requestId=""`，**不可达**。可行出口只剩放弃草稿（`fail_operation` / `discard_operation`）或离开 chat 去设置里改——而消息本身**没有任何指向设置的线索**。

---

### P9 — 设置文案与执行语义矛盾　【中】

**现象**：Live Smoke 开关在 UI 上被描述成"附加的一条基线"，实际是承重门禁。

**证据**：`apps/editor/src/components/settings/EditorSettingsSections.tsx:260-261` 原文——

> "Runs one **additional** baseline… **Missing required environment values skip this baseline while Sandbox continues.**"

按此表述，关掉它只是少跑一条额外基线，Sandbox 照常继续。但 `chat-pipeline-trialability.ts:178-195` 的实际行为是：任务一经声明 `network: read`，关掉它即判 `live-smoke-only` → **整个 trial 一个 case 都不跑**。

**影响**：用户有充分理由认为关掉该开关是安全降级，实际得到全量阻塞。文案与执行语义脱节，且默认值为关。

---

### P10 — 创作 agent 被禁止考虑可试运行性　【中】

**证据**：

- `e:\tagma-ws-65\.tagma\.opencode\agents\tagma-pipeline.md`：`tools.tagma_trial_plan: false` 且 `permission.tagma_trial_plan: deny`
- 可试运行性检查只发生在 trial 阶段（`chat-pipeline-trialability.ts`），创作阶段无对应前置检查

**影响**：agent 在写 YAML 时**无从知道自己正在写一个必然无法验证的流水线**。本次它是照用户要求使用 native websearch 才触发 `network: read`——**正确执行指令反而导致产物被判阻塞**。

P8 与 P10 是同一问题的两端：写的时候看不见约束，验的时候没有出路。

---

### P11 — clarify 零候选死锁　【中】

> 编号待与既有 P1–P7 清单对齐。

**现象**：分类器提出澄清问题时，若候选集为空，用户无法通过任何途径作答。

**根因链**：

1. 分类器提示词中唯一的规范 `clarify` 形态即 `candidateIds: []`（`apps/editor/shared/chat-pipeline-intent-classifier.ts:140-213`）
2. 主机接受它，无非空守卫
3. `apps/editor/src/agent-chat-control/observations.ts:115` 的 `pending.candidates[0]?.candidateId ?? ''` 产出 `candidateId: ""`
4. `parseAgentChatCommand` 在 `minBytes:1` 上抛错 → 可用性 `parameters_required`
5. `apps/editor/src/chat-actions/operation.ts:120-127` 的 `pending.candidates.some(...)` 在 `[]` 上**恒为 false**，故手动填入任何值也无效

**已验证的逃生路径**：`composer.edit` + `composer.submit` 直接发散文（本会话用过，`stage.json` 中确认 `requestedAction: "create-new-pipeline"`）。

**与 P8 的关系**：**同一个 bug 类在两个 feature 上各犯一次**——必填参数被渲染成空串 `""`，可用性报 `parameters_required`，且无替代路径。建议作为同一修复主题（"必填参数预览不得为空串，且必须有可达替代"）统一处理。

---

## 产品观察（次要）

### 权限摩擦：agent 无法枚举自身沙箱　【低】

`tagma-pipeline.md` 以 `read: ask` 搭配 `glob: deny` / `grep: deny` / `list: deny` 启动 authoring agent。后果：

- agent 无法枚举自己的暂存区，只能逐条读取特定路径，**每条都触发一次人工批准**；对 `edit` 自己草稿同样触发 `ask`
- 与此同时 `webfetch https://opencode.ai/docs/cli/`、`websearch`、skill 加载**全部自动放行**

即：**读取自己的沙箱需要人类批准，抓取任意公网 URL 不需要。** 在 agent 写出第一个字节之前已请求 3 次以上批准。

非缺陷（策略如此设计），但摩擦与风险方向相反，值得复核。

**已排除的相关项**：`permissionChoices: ["once","reject"]` 无 `always` —— 这是用户配置（`ExternalAgentControlSection.tsx:48,175`，`allowAlways` 默认 `false`），且应用内气泡本身提供 "Always for this chat"。**不作为发现。**

---

## 判定变更

### P7 — repair 以 compile 判定，trial 失败后不收敛 → **0.11.13 上未复现**

两层原因：

1. V2 repair 提示词已反向写死（`apps/editor/server/chat-operations/authoring-runtime.ts:1802-1803`）：

   > "Compilation alone does not prove a Trial failure is fixed. If no supported repair exists, leave the draft unchanged and explain the remaining evidence gap."

   正是 P7 描述的病根。

2. blocked 的 trial 根本不进 repair（`authoring-runtime.ts:2939` → `unverified`，非 `repair_required`），因此连那 25 次上限循环（`opencodeChatPipelineRepairMaxAttempts: 25`）都不会启动（`apps/editor/server/chat-operations/authoring.ts:2618-2626`）。

**代价**：修复 P7 的路径顺带制造了 P8——blocked trial 现在连自动修复都没有，直接停在无出口的 `wait=user_retry`。

**注**：本次未能实跑 `repair_new_invocation`（不可达），故"未复现"是**代码层判定 + 该路径不可达**的推论，非实跑结论。若需实跑复现，需先构造一个 `repair_required`（有真实失败任务）的场景。

---

## 外部因素（已排除，不报）

| 现象 | 排除依据 |
|---|---|
| `desktopLogTailRead.status = "not-configured"` | `README.md:366-368` 明确记载：非 Electron 开发启动无启动器维护的日志，并**显式报告**该状态 |
| `/opencode/sessions/{id}/messages` 只回显用户提示，分类器文本不暴露 | `README.md:355-359` 明确记载为**有意的内容最小化**，绝不暴露内部分类器/修复/Trial Plan 文本 |
| `sess={}` / `toolCallCount: 0` 贯穿创作过程 | 创作运行于主机创建的无头会话；真实进度信号由 `surface.renderedText` 提供（"Writing the pipeline draft"、"Elapsed 10m58s"） |
| `/logs` 无论查询参数均只返回 1 条 | 该启动模式下无启动器日志源（同第一条） |

---

## 待定

### 权限在无人值守下自动解决

本会话只提交过两条 `permission.reply`：

| 命令 id | seq | choice |
|---|---|---|
| `c6d144f1-5926-4710-97d2-0ceed55c6cb1` | 8333 | `once` |
| `aca8101b-307b-4715-bbd1-9e7a4c589f67` | 8346 | `once` |

但：

- OP28（`permission:3a6babb9…`）→ 36,177 ms 后自行回到 `wait=null`，**无对应命令**
- OP30（`per_0b31df51f001…`）→ 1,448 ms 后自行回到 `wait=null`，**无对应命令**

日志中查无这两个 `per_` id 的解决行。

可能来源：OpenCode 侧会话级批准、轮询路径中的主机自动批准、或渲染器侧有人点击（窗口 `visibilityState` 在可见/隐藏间切换，且渲染器发起的动作**不进 Chat Control 事件流**，故无法从此侧证伪）。

**在确定机制前不作为发现上报。**

---

## 附：命令历史核对

经 Chat Control API 被接受的命令共 **7 条**：

1. `conversation.create`
2. `composer.edit` + `composer.submit`（op1）
3. `composer.edit` + `composer.submit`（op2）
4. `permission.reply` ×2（见上表）

**无 retry / 无 recover**。因此第二次 `trial_blocked`（事件 #39，06:05:57）**并非由任何 API 命令触发**。

---

## 验证边界

- P8 有实测（263 ms 原样复现，零 token）；P9 / P10 / P11 为代码层证据链，**未做端到端实跑**。
- P10 中"agent 无法预知不可验证"是从 agent 配置（`tagma_trial_plan: deny`）与检查时机推出的，**未做对照实验**（例如临时放开该工具看 agent 是否改判）。
- 测试集 S1 L2/L3、S2 `document_audit.yaml`、S3 `site_monitor.yaml`（cron `0 8 * * 1-5`）、S4 `stat_auditor.yaml` **尚未运行**，本报告未覆盖它们的失败模式。
