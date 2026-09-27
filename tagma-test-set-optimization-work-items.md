# 测试集优化立项条目 — Fact Checker 验收后的产品改进

## 续做状态（2026-09-27）

- WI-1、WI-2 已落地：大文件分块写提示；仅 authoring/repair 的实时 `model_output_length` 有一次同会话续写机会，独立 invocation/input/outbox 身份，第二次截断回到显式 Retry。
- WI-3、WI-4、WI-5 已落地：Host 将失败用例与断言类型作为有界 `affectedCases` 交给 planner；仅能从同目标、通过的正向用例唯一推断缺失文件时附 `content: null`；提示词增加负向用例示例；提交后在 Trial 重跑前拒绝执行相关字段未变化的受影响用例。
- 本地 7 个相关测试文件（250 个测试）、`check:server`、`check:tests`、lint 与格式检查已通过。重启编辑器、新工作区的 12 级实时复测仍待执行；需要每个工作区新的 Diagnostics 与 Chat Control 说明，不能复用旧会话连接。

来源：2026-09-27 Fact Checker 测试集(4 场景 × 3 级)全量验收。12/12 通过,其中 2 级需要显式 Retry 才通过。本文件记录为消除这两次 Retry、提升"一轮通过率"的立项条目。

约束(用户明确要求):
- **回归红线**:测试集其他场景不得因这些修改失去一次通过能力。
- 环境能力受限项(schedule/cron 触发器,S3 全场景)由其他 agent 另行立项,本文件不涉及。

---

## WI-1(规避,零契约风险)— authoring 提示词引导分块写文件

- **对应症状**:S2L2 第 1 轮 `model_output_length`(deepseek-flash 单次生成超长被截断)。
- **思路**:截断风险与单次生成长度正相关。在 authoring 系统提示词和种子 agent 文档中要求:写大 YAML 时分块进行(先写骨架再多次小 `edit` 增补),而不是一次超长 `write`。
- **改动点**:
  - `apps/editor/server/chat-operations/authoring-runtime.ts` — `buildManagedChatOperationV2ExecutionPrompt`(约 1838-1865 行)
  - `apps/editor/server/opencode-seed.ts` — `buildTagmaPipelineAgent`(约 781 行起)
- **风险**:仅提示词文本;需跑种子/authoring 提示词相关快照测试。

## WI-2(自动修复,需修订契约)— `model_output_length` 的有界自动续写

- **对应症状**:S2L2 第 1 轮。当前行为:Host 将 invocation 记为 `failed_terminal`,操作转 `provider_unavailable` 等待显式 Retry(`apps/editor/server/chat-operations/authoring.ts` 约 1959-1976)。
- **思路**:对 finish reason `length`(含 provider `MessageOutputLengthError`)这一类"生成被截断"失败,在**同一 OpenCode session** 上自动发恰好一次续写 invocation(Host 撰写"从断点继续并简洁收尾"的提示词,全新 invocation/input/outbox 身份,沿用分类器 `malformed_text_result` 单次自动修复先例,`orchestrator.ts` 1743-1778)。判定口径不变:对操作 staging baseline 判 changed/no_change。两条 usage 记录都保留。
- **性质**:续写是 resume 不是 retry(阶段是累积的,前序字节保留),但它未经用户同意多花一次模型调用,故需修订契约。
- **改动点**:
  - `apps/editor/server/chat-operations/authoring-runtime.ts` — `runInvocation`(约 2678-2679)与 `buildManagedChatOperationV2ExecutionPrompt`(续写模式);`reconcileInvocation`(约 2758)维持现状,重启后仍等显式 Retry
  - `apps/editor/server/chat-operations/authoring.ts` — `runControlledInvocation` 结果处理
  - 契约修订:根 `AGENTS.md`"永不自动重试 model 类失败"一句开出 `model_output_length` 有界续写例外;`apps/editor/AGENTS.md`"Provider interruptions ... use explicit Host Retry"(89-93 行)同步修订
  - 测试:`apps/editor/tests/chat-operation-v2-authoring-runtime.test.ts`(512/541 行现断言失败行为,需更新)
- **边界**:每个 stage 尝试硬上限 1 次续写;续写再截断则落回现有 `provider_unavailable` 等待态。

## WI-3(证据结构化,低风险)— planRequest 增加结构化 `affectedCases`

- **对应症状**:S3L3 第 1 轮 `trial_plan_no_change`(planner 不知道该改哪个用例/fixture;`content: null` 负向用例规则散落在散文里)。
- **思路**:Host 校验器已精确知道失败的负向用例 id、正向 baseline、缺失 fixture 路径,但现在被拍平成散文。在 planRequest 中加有界结构化字段(如 `affectedCases: [{ caseId, requiredFixture: { path, content: null } }]`),让 planner 不用再猜。
- **改动点**:
  - `apps/editor/server/chat-pipeline-trial-run.ts` — plan-required 构造处(约 3801-3841)
  - `apps/editor/server/chat-pipeline-trial-plan.ts` — fixture-setup 校验器(1247-1334)、planRequest 构造(约 1118-1133 / 1439-1447)
  - `apps/editor/server/chat-operations/authoring.ts` — `validateTrialPlanRequest` 白名单(1083-1205)
  - `apps/editor/server/opencode-seed.ts` — planner 提示词同步说明该字段
- **风险**:`validateTrialPlanRequest` 是指定权威闸门,有界数组符合其现有模式(如 `requiredSandboxInputs`);需跑 trial-plan 相关测试。

## WI-4(提示词,低风险)— planner 提示词补 missing-file 负向用例 few-shot

- **对应症状**:同 WI-3。提示词现有三层指引(`opencode-seed.ts:284`、工具 schema、校验器报错)仍不足以阻止模型"报告限制并结束回合"。
- **思路**:补一个具体 before/after 用例片段(`fixtures: [{path, content: null}]` + `path-not-exists` 断言),并把 292 行"证据不明可报告限制"明确从属于 248 行"有未解决的 Host 校验拒绝时不得回答 no-change"。
- **改动点**:`apps/editor/server/opencode-seed.ts`(195-297 行 planner agent 定义)。
- **风险**:纯提示词;对忽视指引的模型无效,但与 WI-3 叠加后发生率应显著下降。

## WI-5(Host 校验,中等)— 提交的 plan 必须触及受影响用例

- **对应症状**:S3L3 第 1 轮第 1 次 planner 尝试"提交了但没改失败用例",浪费一轮完整 Trial 重跑。
- **思路**:plan-review 永远由具名失败期望触发。Host 在接受 `changed` 并重跑验证前,先 diff 新旧 plan:若 commit 的 plan 未触及 `affectedCases` 中的用例,直接以针对性证据拒绝该 plan(该次 commit 仍按现行设计消耗尝试预算),而不是重跑 Trial。
- **改动点**:`apps/editor/server/chat-pipeline-trial-plan.ts` — `readChatPipelineTrialPlan`(1336-1447)及失败消息构造。
- **风险**:新增 plan-diff 语义,必须待在现有"有界、hash 绑定"遥测契约内;不能误伤合法的"顺带重构"。

## 明确不做

- **同轮自动重提示 no_change 的 planner**(explore 方案 3):与 `apps/editor/AGENTS.md` 1012-1016 行"no_change 终止该链条、只有快照变化才能重验"正面冲突,且与显式 Retry 的所有权模型纠缠,收益不如 WI-3+WI-5。不立项。
- **提高模型 maxTokens 配置**(explore 方案 A):全仓库无 `maxTokens` 设置;deepseek-flash 的上限很可能是 provider 端强制,配置无效。不立项,留作后续观察到复发时再议。
- **schedule/cron 触发器插件**:环境能力项,已由其他 agent 立项。

## 验收标准

1. 相关单测全部通过,`check:server` / `check:tests` 类型检查通过。
2. 重启编辑器、新建工作区后全量复测 Fact Checker 12 级:
   - 原先一轮通过的 10 级必须仍然一轮通过(回归红线);
   - S2L2 / S3L3 目标为一轮通过(模型行为有随机性,若仍 Retry 需看失败码是否已从这两类消除)。
