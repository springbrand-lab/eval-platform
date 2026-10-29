# @eval-platform/eval-runtime

For new SP runs the evidence store persists the first page's `throughSeq` even
when the Chat is empty, before reading any record. It streams each complete
`{ingestSeq,record}` JSONL line unchanged, without buffering a trajectory part
or re-serializing referenced native bytes. It requires a terminal page and
checks every declared line length; the SP HTTP adapter verifies the entire
authenticated source byte stream before closing the line.
New manifests
use schema 2 and `sp-pi-trajectory/v1`; an unfinished version 1 event export must not
append to a native bundle. Individual records above the unchanged evidence-file
limit fail explicitly, never get truncated or silently omitted. Artifacts/Subject inputs remain primary. Old manifest
bytes, refs and evaluation scores are not rewritten; version 1 reading is intentionally
unsupported after the approved breaking cutover.
Focused Harness/Runtime tests use the same `fixtures/pi-native-public-v1.json`
generated through the published UA public trajectory export, rebinding only
test Chat/Submission IDs and perturbing records for negative/error cases.

For new resources the Harness returns an ephemeral `AgentResourceSnapshotDownload`
with a validated `summary`, not a Chat-sized `AgentResourceSnapshot` array.
Runtime saves the counted download, checks its scope, passes its bounded
`readPages()` to the Store for one atomic CAS+snapshot write and always
`dispose()`s it after success or failure. Existing historical object snapshots
keep their old validation/persistence path. Before the wait deadline, a
nonfinalized header cannot serve native/billing pages. Afterward Runtime
explicitly opts into partial paging of frozen known facts, retaining their
real counts with `coverage.partial`; a broken page or unsupported older SP
fails without fabricating a zero or exhausting the budget on guaranteed
unpageable requests.
Usage and billing authority remains SP's independent API facts and settled
Action/Tool IDs, never Pi-derived charges.

评估运行时的控制面和执行编排。它只依赖 SP 的公开 Harness 边界，不复制 SP Runtime，也不直接读取 Durable Object 存储。

固定幂等重试的次数与退避只从 contracts 的 `IDEMPOTENT_RETRY_POLICY` / `idempotentRetryBackoffMs()` 取得，与 Web 删除确认共享同一份配置和计算。Runtime 仍为首次操作加 10 次重试，默认 `maxRestarts: 4` 的 Agent 重启预算不变。

目标部署中的 SP 是 Eval 独立发布的 API/数据库、Agent Worker 和 Space Worker；登录、Agent Config 及 Agent 生命周期全部由这套 SP 提供。Harness 使用该部署的普通 Inbox/Chat 生命周期，具体 HTTP/WebSocket 客户端由 `apps/eval-api` 组合。部署分支绑定 Project；Runtime 从当前发布信息取得 commit 并写入新 Run，恢复时只读 Run 已保存的 commit。见[部署方案](../../docs/eval-sp-deployment.md)与[Project、Runtime 与 Metrics 设计](../../docs/eval-project-redesign.md)。

## 对外边界

- `plan`：`normalizeExecutionPlan` / `normalizeEvaluationPlan` 是计划校验与归一化的唯一入口（`retryPolicy` 缺省时使用 Runtime 默认重启策略，幂等瞬态操作固定重试 10 次并使用 250ms 初始退避和 10s 上限；Evaluator 必须 `framework: "sp"`）；`digestExecutionPlan` 覆盖执行计划、Dataset 绑定和全部 ProjectSample 快照，与 ProjectSample 输入顺序无关；评估计划摘要和评估输出 Schema 摘要直接使用 `digestJson`（canonical JSON 的 sha256，与对象键顺序无关）；`planProjectSampleIds(plan)` 按 Dataset 绑定顺序再按成员顺序列出全部 ProjectSample；`phasesOf(operation)` 推导 Run 阶段。
- `ProjectPlanReader`：Runtime 唯一的 Project 输入，提供 `getProjectPlan`（固定执行计划及其摘要；`evaluation` 为 `ProjectEvaluation | null`，评估计划 `plan`、摘要 `digest` 和锁定时间 `lockedAt` 只能一起存在）、`getProjectSamples`（按输入顺序返回完整 Data 快照）和 `getEvaluationOutputSchema`。Runtime 不读取实时 Dataset/Data、可编辑 Agent Config 或任何配置表。
- `createEvalRunAdmission({ sourceCommit, plans, store, idFactory? })`：API 进程的准入入口，不持有 Harness 凭证。
  - `preview({ projectId, operation, selector })` 在 Project 快照内展开选择：`all`/`datasetIds` 按 Dataset 绑定顺序再按成员顺序展开为 ProjectSample，与显式 `projectSampleIds` 合并去重；execution/pipeline 的显式 Sampling 若其 ProjectSample 已被整条选中则被吸收；evaluation 把 ProjectSample 展开为当前执行成功的 Sampling（静默过滤失败/未完成），显式 Sampling 必须执行成功。返回固定 `targets`、替换/新建 Sampling 数、评估数和计划摘要。
  - `submit({ idempotencyKey, projectId, operation, selector, targets })` 以 `targets` 为准校验（不重新展开），构造新 Sampling（每个目标 ProjectSample 按 `samplingCount` 新建，每个目标 Sampling 一对一新建）、EvaluationRecord（pipeline 每个新 Sampling 一条，evaluation 每个目标 Sampling 一条）和 Run，并调用一次 `RuntimeStore.admitRun()`。请求指纹为 `digestJson({ projectId, operation, selector, targets, planDigests })`，`planDigests` 含执行计划摘要，pipeline/evaluation 另含评估计划摘要；同 key 先按已存 Run 的摘要比对，事实相同即重放原 Run，不再读取计划。
- `createEvalRunResumer({ plans, harness, store, evidence, evidenceLimits?, onError, ... })`：Worker 入口，`evidence` 是证据包存储 `EvidenceStore`，`evidenceLimits` 缺省为 `DEFAULT_EVIDENCE_LIMITS`；提供 `resume(runId, stopSignal?)`、`interrupt(runId)` 和 `stop(runId)`。每次先读取 Run，再读取 Project 计划并核对 `run.planDigests`；摘要不一致直接拒绝，绝不用另一份计划运行。执行使用执行计划的 Harness、`executionConcurrency` 和 `retryPolicy`，评估使用评估计划的对应字段；ProjectSample 按不同 ID 批量读取并校验身份。
- 结果读取实现 `EvalRunQueries`（`getRun`、`getSampling`、`getEvaluation`、`listEvaluations`），由宿主基于自身存储提供；`toRunSnapshot` 投影 `operation`、`selector`、`targets` 与派生的 `phase/status`。
- `ProjectView` 是 API 与 Web 共用的 Project 读取投影：固定计划、全部 `ProjectSample` 和 `ProjectRunState`。后者只包含既有 Run 序号和 `CurrentRun | null`，`CurrentRun` 从公开 `RunSnapshot` 选取身份与停止意图；这些是查询契约，不增加持久化状态。

`RuntimeStore.admitRun()` 的准入事务合同只由 [`runtime/store.ts`](src/runtime/store.ts) 定义，调度与持久化见[架构方案](../../docs/architecture.md#run-准入与独立评估)。

## 文件职责

```text
src/
├── plan/
│   └── index.ts             # 执行/评估计划校验、归一化、摘要与阶段推导
├── harness/
│   ├── model.ts             # SP 公开 Chat / Submission / Workspace 边界，证据导出/导入与 EvidenceStore 端口
│   ├── evidence.ts          # 证据包格式：createEvidenceStore（可续传 resume/save）、applyEvidenceLimits、manifest 校验
│   └── index.ts             # Harness 子模块入口与 Harness 错误
├── runtime/
│   ├── model.ts             # ProjectSample、ProjectPlanReader、准入/恢复端口和临时 Context
│   ├── index.ts             # createEvalRunAdmission / createEvalRunResumer 入口
│   ├── admission.ts         # 目标展开、目标校验、请求指纹与同实例并发合并
│   ├── resume.ts            # 断点续跑和阶段编排
│   ├── stop.ts              # 中断与停止收尾
│   ├── records.ts           # 计划摘要核对与按序、校验身份的批量读取
│   ├── input.ts             # 请求输入校验辅助
│   ├── errors.ts            # 类型化错误
│   ├── agent-lifecycle.ts   # Agent ensure、提交、终态校准、重试和 Attempt 恢复
│   ├── execution.ts         # Subject 执行、初始数据、产物、完整轨迹和证据导出
│   ├── evaluation.ts        # Evaluation Agent、证据导入、评委提示词和结果收集
│   ├── store.ts             # 原子持久化端口、同一记录写入校准与重试
│   ├── projection.ts        # Sampling / Run 原始事实到公开快照的唯一投影
│   ├── resources.ts         # 原始资源快照的归属与无损 JSON 校验
│   ├── scheduler.ts         # 执行 / 评估两套 Agent 并发限制契约
│   └── retry.ts             # 阶段化重试决策和 Agent 重启策略
└── index.ts                 # 包统一导出
```

包入口为根 `.` 与 `./harness`。计划摘要、Schema 摘要和请求指纹统一由 `plan/` 的 `digestJson`（基于 `@eval-platform/eval-contracts` 的 `canonicalJsonBytes`/`sha256Hex`）计算；指纹或摘要算法变化后本地开发库需清库重建。

计划、Harness 和 Runtime 是本包内的子模块，不是额外 workspace package。运行时只负责启动 Agent、完整收集产物和轨迹、分别控制执行/评估阶段的最大 DO 启动数量与重试，并把结果交给评估结果层；它不实现指标算法。根入口导出的 `retryIdempotentOperation` 供应用适配器复用同一套固定幂等重试预算和退避，不另设次数或配置。Run 不保存配置正文，只保存 `operation`、`phases`、`selector`、`targets`、`samplingIds`、`evaluationIds`、`planDigests`、request identity 和停止标记。调度与停止流程见[架构方案](../../docs/architecture.md#run-调度与停止)。

恢复跳过已完成的阶段，并按 Attempt 原 `submissionId`、操作类型和幂等键向 SP 校准。已完成 Agent 的资源或产物保存失败只补收尾，不重新提交或重启。已保存的失败 Attempt 若 SP 校准暂不可用，仍保持待恢复，不能代替重启决策进入证据收尾。只有确认失败且重试决策拒绝后，Subject 证据保存完才写为 `failed`。`RuntimeRecoveryStore` 只提供 `isRunActive`、`isRunStopPending`、`requestRunStop`、`markRunStopFinalized`，Run 当前状态仍只从子记录推导；`isRunStopPending(run)` 是“停止已请求且未收尾”的唯一定义。`stop(runId, reporter?)` 经 `RunStopReporter` 报告收尾前各阶段状态计数和每个被终结阶段的 ID、状态与原因。Pipeline 使用独立的执行和评估并发队列：每条 Sampling 的执行及证据保存成功后立即提交对应评估，其他 Sampling 可以继续执行；执行失败的 Sampling 不提交 Evaluator，其 EvaluationRecord 取消。仅评估 Run 不改动 Subject 的 Attempt、资源、产物、轨迹和状态。

Runtime 将计划中 Harness 的 `runtime` 选项传给 Harness；SP Harness 在创建 Chat 和提交 Prompt 时将其发送给 SP，在等待终态时使用其中的超时设置。素材准备的 SP 接口不接收 `runtime`，校准和产物收集也不使用这些选项。证据导入按 `evidence:<evidenceId>:<evaluationId>` 幂等。`HarnessConfig` 只有 `kind: "sp"` 一种。

资源编排的包内入口是 `collectResources({source, current, save, exclusively, readinessDelays, allowUnfinalized, prepare?})`，返回可选的 `pending` 原因。它先按已存 `downloads` 检查同一个资源重试预算；耗尽时保存 `exhausted`、结束等待并报告一次，不执行 `prepare` 或任何 SP 读取。预算准入后，可选的 `prepare` 只执行一次：结束后刷新在这里校准未确认的已接受 Evaluator receipt，把确认的终态和固定完成时间通过既有 CAS 重试可靠保存，再检查 readiness、下载或清除等待；生命周期的终态已经保存，不需要此步骤。终态保存失败保留原持久化等待，下一进程恢复；同一轮的持久化重试只保存同一份事实，不重新校准 receipt 或采集资源，已有 finalized 快照不重新下载。两条入口不分别实现预算或放弃策略。

`CollectAgentResourcesInput.signal?: AbortSignal` 同时用于 readiness 和快照读取，是本地传输选项，不写入计划或发送给 SP。Harness 必须真实取消请求及正文读取，Promise 只在这些工作结束后结算。资源读取不使用提前拒绝的观察包装。串行器允许排队任务立即取消，开始前再检查取消；取得槽后才保存下载计数，持续持槽直到真实下载与快照保存结束。计数保存的既有 CAS 重试也在槽内；readiness 等待及下载重试退避在槽外。Run 停止取消这些等待，取消不触发资源重试或放弃报告。

`ProjectSample.data.userPrompt` 只作为 Subject 的提交消息；`evalPrompt` 是 Evaluator 的提交消息。pipeline 和 evaluation 在准入时要求所有涉及的 ProjectSample 都有 `evalPrompt`（否则 `evaluation-prompt`）。Evaluator 初始化数据以 `evalPrompt` 作为自己的 `userPrompt`，只带全部 `evalInitialMaterials`（作为自己的初始化素材），不加载 Subject 的初始 Session；Subject 初始化数据带全部 `initialMaterials` 和唯一的 `initialSession`，不包含 `evalPrompt`。评估输出 JSON Schema 由 `getEvaluationOutputSchema` 解析后随同一次初始化交给 SP，写入每个 Evaluator Workspace 的固定路径（见 [SP Harness 协议](../../docs/eval-sp-harness-protocol.md#initialization)）；Evaluator 输出（含 `structuredOutput`）原样保存。

类型化错误由 `runtime/errors.ts` 统一定义：找不到实体（`project`、`run`、`dataset`、`project-sample`、`sampling`、`evaluation`）抛出 `RuntimeEntityNotFoundError(entity, id)`；输入或计划校验失败抛出 `RuntimeInputError(message, field?)`；准入前提不满足抛出带 `reason` 的 `RuntimeAdmissionConflictError`（全部原因见 [`runtime/errors.ts`](src/runtime/errors.ts)）；另有 `RuntimeProjectBusyError`、`RuntimeRunIdentityConflictError`、`RuntimeRunStoppedError`、`RuntimeRecordConflictError`、`RuntimeRecordPersistenceError`。控制面只按错误类映射 HTTP 响应。

SP 宿主与 Agent 框架分别配置：`kind: "sp"` 表示统一的云端 Harness，`framework` 必须显式选择 `sp`、`codex` 或 `cc`（Claude Code）。三者使用同一套生命周期，由 `ensureAgent` 将所选框架和 Agent Config 交给 SP 创建；返回的 Handle 必须对应请求的框架，后续提交、重启、等待和收集沿用该 Handle。评估 Agent 固定 `kind: "sp", framework: "sp"`。框架属于执行计划并进入执行计划摘要，没有默认框架或静默降级。当前只完成评估侧契约和接线，SP 云端启动 Codex/CC 的实现仍由 SP 提供。

## 重要约束

1. 一个 `Sampling` 必须对应一个独立的 Subject Chat / Workspace。
2. SP Chat 就是持久 Session，其中每次提交都有独立的 Submission ID。`AgentHandle.ownerUserId` 固定 Chat 所属 Inbox 的路由归属。Subject 与 Evaluation Agent 都通过 Eval SP 自己的普通 Inbox 确保 Chat；Evaluation Agent 是普通 Agent，拥有独立 Chat / Session 和自己的 Space，不绑定 Subject；证据导入 `/evidence/`，结果写入 `/output/result.json`。Runtime 在 `ensureAgent` 前预分配并保存 Subject `subjectChatId` 或 Evaluator `chatId`；SP 的真实 Submission ID 只保存在对应 Attempt。
   Harness 必须按 Chat ID 获取或创建，重复或并发请求返回同一个 Agent；同一 ID 的归属、角色、框架、Agent Config 或 `evaluationId` 不一致时返回不可重试的 `AgentIdentityConflictError`，不得静默重绑定。Eval Web 只通过 Run/Sampling/EvaluationRecord 展示这些 Chat，不提供普通 Inbox 管理或聊天驱动操作。
3. 重试不能把一次采样变成新的采样，只能增加该采样的执行或评估 attempt。
   `RetryController` 按 `creation`、`initialization`、`submission`、`status`、`collection`、`resources`、`persistence`、`stop` 和 `restart` 区分决策；`restart` 使用计划的 `maxRestarts`，其余幂等瞬态操作统一使用 Runtime 固定的 10 次预算和退避。评估 Agent 已完成但未提交评分时，直接进入现有 `restart` 决策，不检查错误文本或最终回复；和失败 Submission 共用持久化 Attempt 次数、上限与退避（默认 4 次重启，共 5 次 Attempt），不叠加独立预算。原 Attempt 保留 `completed` 终态和资源，并记录 `evaluation result not submitted`；仍用同一 Chat 和新的幂等键，不重新初始化、导入证据或运行执行 Agent。已接受或格式无效的结果、手动补收和停止后的 Run 不触发恢复；恢复决策前重新确认 MCP 接受状态。Agent ensure 和初始化重试保留同一 Agent，各自独立计数，不新增执行/评估 attempt、不消耗 Agent 重启次数；其他收集或保存失败不得重启已经完成的 Submission。
   MCP 评分补交只发送英文 `Please complete the evaluation, then use the MCP tool to submit the evaluation result.`，不重发完整评估消息。该模式由已持久化的 completed Attempt 及 `evaluation result not submitted` 推导，Worker 恢复及之后提醒消息自身的失败重试仍只发送补交提示。首次评估、尚未进入补交阶段的普通失败重启及旧的非 MCP 流程保留原提示词。
4. Submission 终态以 Harness 推送通知为主；自动重试前仍必须按本次操作的幂等键查询原 `Submission`，不得因为响应丢失就盲目再次投递。
5. 已确认失败的 Subject Submission 也收集并保存可用产物及完整轨迹，保留原失败原因，但不导出证据包。执行整体成功后，Runtime 调用 `Harness.exportEvidence({handle, submissionId, limits})`（`submissionId` 为最后 Attempt 的真实 Submission）并经 `EvidenceStore.resume()` 固化不可变、按内容寻址的证据包，`Sampling.evidence` 保存 `EvidenceBundleRef`，`Sampling.trajectory` 指向包内 `evidence:<evidenceId>/trajectory/`。导出可断点续传：首轮冻结清单与 `exportedAt`，此后每存好一个文件或一个轨迹分片，就把进度以条件写入 `Sampling.evidenceExport`（`submissionId`、`passes`、`lastError`、`progress`），本轮内的重试和后续轮次只读取缺失的文件，轨迹从已保存的 `afterSeq` 续读（新进度首存即记录源格式 `format` 与可选截止点 `cursor.throughSeq`，续传时以 `evidenceTrajectoryPinOf(progress.trajectory)` 经 `ExportEvidenceInput.trajectory` 交回 Harness，不一致报 `EvidenceIntegrityError`；旧进度无截止点照旧续读。新截止点在首次进度持久化后才生效，此前不读取、不存储任何文件或分片，失败的轮次下次重新固定），manifest 由同一进度确定性生成，写入响应丢失后重放得到同一 `evidenceId`；只复用同一 Submission 的进度。一轮内导出与收集共用 Runtime 固定的 10 次幂等重试；本轮瞬态失败耗尽时 `passes + 1`，保留产物与进度并置为 `execution.evidencePending`，不把已经完成的 Agent 记为失败。满 `EVIDENCE_EXPORT_MAX_PASSES`（5）轮或遇到不可重试错误（如单个轨迹事件超过 `limits.maxFileBytes`，既不能切分也无法导入）时，执行置为 `failed`（`evidence export failed after 5 passes: …` 或 `evidence export failed: …`），仍保留产物、输出与进度，人工补收在同一进度上重新给 5 轮预算。收集或导出未完成时保持非终态，对应评估保持排队；恢复只补收证据，不提交或重启 Agent。证据引用与最终执行状态同时保存，`evidenceExport` 随之删除。证据导入确认后，评估 Agent 才能提交任务。
   **Pi-native 截止点更新（覆盖上一段中旧事件分页的描述）：**
   新导出先持久化 `format:"sp-pi-trajectory/v1"`；若源已提供固定
   `trajectoryCursor`，首次进度在文件读取前同时保存截止点，否则首次完整 native 页
   验证后（包括空页的零截止点）在写任何轨迹分片前保存 `throughSeq` 和 `cursor`。
   Runtime 续传时经 `evidenceTrajectoryPinOf` 传回该固定点；原有 native
   `throughSeq` 进度也不会重置。旧 `sp-trajectory/v1` 进度拒绝续为 Pi，
   大于单文件上限的单条 native 记录明确失败，不可切分或静默丢弃。
6. 推送丢失、连接断开或运行时恢复时，`inspectAgentOperation` 只做一次或有限次状态校准，不作为主流程的持续轮询。
7. 评估平台只消费 SP 的公开契约，不依赖 SP 的 DO SQLite、内部类或 Web 投影。
8. 使用新 `idempotencyKey` 提交 evaluation 会为每个目标 Sampling 新建评估记录并替换其当前评估；被评估 Subject 的 ID 和全部执行事实保持不变。
   已选 Sampling 缺失或不属于请求 Project 时抛出 `RuntimeEntityNotFoundError("sampling", id)`，执行未成功时抛出 `RuntimeAdmissionConflictError`（`reason: "sampling-unavailable"`）。`getRun()` 查不到 Run 时抛出 `RuntimeEntityNotFoundError("run", runId)`。
9. `submit()` 不分别写 Run、Sampling 和 EvaluationRecord，只调用一次 `admitRun()` 原子提交；命令失败时不能留下半批状态或清掉旧结果。
10. `submit()` 必须带调用方 `idempotencyKey`。同实例内相同 Project 与 key 的并发请求合并；同一 Project 仅一个未结束 Run（`RuntimeProjectBusyError`）。
   停止请求写在当前 Run。`RuntimeStore.withRunDispatchGate()` 让 SP Chat 创建、初始化和 Submission 提交的启动动作与停止请求按 Run 行锁排序，远程响应不占用行锁；停止收尾中缺失 Chat 通过 `AgentHandleNotFoundError` 表示。Worker 如何中断、收尾并写入 `stopFinalized`，以及 Project 何时解锁，只在[架构方案](../../docs/architecture.md#run-调度与停止)中完整描述。
11. `RuntimeRunRecord` 只保存不可变的阶段范围 `phases`，不保存当前阶段或 Run 状态；`RunSnapshot.phase/status` 由 `getRun()` 根据关联 Sampling 即时推导，是查询投影而不是第二份权威状态。单独执行范围为 `["execution"]`，单独评估为 `["evaluation"]`，联跑为 `["execution", "evaluation"]`；没有 `pipeline` 阶段或 Run kind。
12. 联跑刚创建且所有 Execution Sampling 仍为 `queued` 时，Run 也必须是 `queued`。执行尚未结束时当前阶段为 `execution`；执行结束且存在成功 Sampling 后当前阶段为 `evaluation`，交接等待不能提前显示成功，成功 Sampling 的评估全部结束前 Run 仍是运行态。执行失败的 Sampling 不启动评估 Agent，其 EvaluationRecord 标记为 `cancelled`。
13. `SamplingState` 只保存单次执行状态和 `projectSampleId`，不保存评估结果、ProjectSample 快照、JSON、初始 Session 引用、初始素材引用或 metadata；评估由独立 `EvaluationRecord` 通过 `samplingId` 关联。
14. 执行使用临时 `RuntimeSamplingContext`，评估使用临时 `RuntimeEvaluationContext`，二者都不能整体交给 Store。准入与恢复先通过 `RuntimeStore.getSamplings()` 按请求顺序读取 Sampling，再通过 `ProjectPlanReader.getProjectSamples()` 按不同 ProjectSample ID 批量关联输入。批量读取按输入顺序返回记录或 `null`，输入缺失或返回的 ID 不匹配时，不清除已有结果，也不启动新 Agent。
15. `getSampling()` 返回扁平的 `SamplingSnapshot`，只复制公开的 Sampling 字段，不暴露 Store 包装结构、ProjectSample 或 Runtime 临时对象。
16. 除共同的 `idempotencyKey` 外，`submit()` 只接收 `projectId`、`operation`、`selector` 和 preview 返回的 `targets`。Sampling 次数、Subject/Evaluator Agent、并发与重试全部来自 Project 计划。
17. `ProjectSample` 的结构见[包边界](../../docs/package-boundaries.md#eval-runtime)，平台身份与完整业务 Data 分开。`ProjectSample.data.userPrompt` 必填且不能为空白，作为 Subject 当前任务原样发送；其他 JSON 业务字段通过 `materializeInitialData().data` 交给 SP，Subject 输入去除平台 `dataId` 和评估专用 `evalPrompt`、`evalInitialMaterials`，业务 `data.sampleId` 不覆盖、不删除。Evaluator 输入将 `evalPrompt` 映射成自己的 `userPrompt`，将整个 `evalInitialMaterials` 数组映射为自己的初始化素材，去除 Subject 的 `userPrompt`、`initialMaterials` 和初始 Session。`initialSession` 和两个素材数组都可省略；`initialSession` 是一个外部 `bundleId + sessionId` 引用，素材数组的每项是外部 `bundleId + materialId` 引用（数组规则见[包边界](../../docs/package-boundaries.md#eval-dataset)），Runtime 不生成资源 ID，也不改变素材顺序。Session 正文不进入 Dataset、ProjectSample、Sampling 或执行 prompt。SP 公开能力将素材与 Session 副本落入目标 DO 的存储，由所选框架加载并重建 Context；Runtime 等准备完成后发送 Subject 原始 userPrompt，或 evalPrompt 加 evaluatorPrompt() 的固定证据说明，不自己解析 Session、拼接消息或把扩展数据包成新 prompt。
18. 初始数据准备使用 `initial-data:<chatId>` 的稳定幂等键；重复准备相同事实返回原结果，不能覆盖已经运行过的 Session。初始化发生可重试错误或响应丢失时，由 `RetryController` 的 `initialization` 决策决定是否重试完整准备流程，沿用同一目标 Agent、输入和幂等键，不重新创建或重启 Agent、不查询尚未提交的 Submission。不可重试错误立即失败，重试耗尽也不提交任务。不同 Sampling 使用不同目标 Agent 和幂等键；同一 Agent 自动重启沿用当前 Session，不重新加载初始 Session。SP 负责持久化初始化幂等，不增加 Runtime 准备状态表。
19. 评估 Agent 使用独立 Session 和自己的 Space，不把 Subject 的 `initialSession` 当作自己的初始会话。评估要求 `sampling.evidence`，缺失时评估失败（`sampling has no evidence bundle`）；`ensureAgent()` 只接收 `evaluationId`（仅且必须用于 Evaluator，回填到 `AgentHandle.evaluationId`）。准备时先 `materializeInitialData()`，再以 `evidence:<evidenceId>:<evaluationId>` 为幂等键调用 `importEvidence({handle, evidence, root: "/evidence"})`，把打开的证据包写成 `/evidence/artifacts/<原路径>`、`/evidence/trajectory/events-000001.jsonl` 等有序分片，最后写 `/evidence/manifest.json`。同一 Sampling 的历次评估复用同一证据包，Subject 只导出一次。响应丢失后的重试沿用相同输入和幂等键；所有准备步骤确认前不得提交评估任务。提交内容是 `evalPrompt` 加 `evaluatorPrompt()` 生成的固定说明（证据位置；配置了 `results.submission` 时要求直接调用 `submit_evaluation` MCP 工具并带上本评估的 `evaluationId` 和提交凭证，工具接受后只需简短总结；未配置时写 `/output/result.json`，并在最终回复以 ```` ```json ```` 代码块重复结果）。`EvaluationResultPort` 决定结果来源：已提交结果优先，其次 SP 结果文件，最后 `Harness.readFinalReply` 读出的最终回复；`structuredOutput.source` 记录来源。只有按锁定 Schema 合法的结果才记为 `succeeded`，缺失记为 `failed`（`evaluation result not submitted`），不合法记为 `failed`（`evaluation result invalid ...`）并保留原文，都不重新运行 Evaluator。见[评估结果提交](../../docs/eval-evaluation-result-submission.md)。`#guardedHarness` 把 `importEvidence` 作为 SP 写操作纳入停止闸门，`exportEvidence` 只读，按观察操作处理。
20. 每次实际提交的 Attempt 在投递前持久化 `resources: pending`，其中包含目标 `chatId` 和本次提交/重启的准确幂等键；SP 返回或恢复真实 Submission ID 后写到 Attempt，采集到的资源快照须包含三者。终态或投递/等待失败后通过公开 `collectAgentResources()` 收集资源，并先保存到对应 Attempt，再收集产物、决定是否重启或发布阶段终态。失败、取消和重启前的费用/Token/工具/Turn 都保留；未提交任务的创建/初始化失败不假装产生资源事实。
21. 资源快照只包含本次操作及其子 Agent 的新工作，不包含导入历史或 Subject 证据。`usageEvents` 和 `billingSettlements` 保留 SP 独立权威来源事实，新的 `nativeRecords` 由 Harness 对完整 SAFE Pi 字节完成核验后只保留来源身份与无正文 Metrics facts，原始大正文只进入 Subject 证据而不重复存数据库。历史原始快照不迁移；旧 `telemetryEvents` 不解释为新历史。Runtime 只校验归属与可序列化性，不解析费用/Token、不抽取工具/Turn、不归一化、不去重、不计算统计；`coverage/readiness/finalized` 保持原样，由 Metrics 判断缺失和完整性。新 SP 公共源码已有分页 header/native/billing 契约，Eval 通过本地结构性验证消费有界页面；其 `alpha.7` 包仍私有未发布，不能声称跨部署或全局 OOM 安全。
22. 资源读取由两个入口共用的 `collectResources()` 编排：预算准入后，轻量的 `Harness.inspectAgentResources()` 检查 `finalized/readiness`，finalized 或已到期限才下载完整快照，不反复下载来轮询。readiness 和下载错误沿用固定 10 次幂等重试，下载按 Attempt 已存 `downloads` 决策（`decide({operation: "resources", attemptNumber: downloads})`）；耗尽时不再读取 readiness。`RunResumer` 的一个 `resourceDownloads` 串行器覆盖所有 Run 和阶段：排队可取消，获槽后保存下载计数，再读取正文和保存快照，期间持槽（包括计数保存的 CAS 重试），readiness 与下载退避在槽外。崩溃中断的下载计入原预算，快照保存成功后计数清零。资源以原地校验的快照作为 `updateSampling`/`updateEvaluation` 的 `resources` 参数，与 `collected` 摘要在同一 CAS 事务提交，两者都成功或都不保存，阶段事实不含事件正文。`collected` 不承诺来源完整；采集状态仍只有 `pending | collected | failed`。不可重试或预算耗尽时，无快照记为 `failed`，已有快照原样保留，两者保留计数并标记 `exhausted`，成功保存后经 `onError` 报告一次，不再欠资源；不改变 Agent 终态、阶段状态和产物。已 `failed` 的资源在每次重试计数时更新上次错误；停止收尾的失败同样保留计数。只有手动资源补采通过 `withFreshResourceBudget` 清除 `downloads/exhausted`。Metrics 仍只从应用持久化的投影读取并负责全部解析和统计；完整轨迹和大产物继续存引用。
23. 后续 Attempt 状态补丁基于当前执行上下文的最新 Attempt，而不是调用方的旧副本；原始快照写入已提交但响应丢失时，失败处理不能用旧 `pending` 覆盖它。运行时收尾异常先读取 Store 的最新事实，不以启动时的 `queued` 副本重写整个记录，也不把未确认的 Agent 操作误判为失败。查询只读取持久化结果，不从执行上下文的内存副本返回数据。
24. 一旦观察到 Agent 终态，立即固定 Attempt 的状态和完成时间，并先保存终态再收集资源，避免资源保存异常抹掉已确认事实。Agent 错误属于 Attempt，Runtime 收尾失败属于执行/评估阶段的 `lastError`，不得把已完成 Agent 记为失败。记录写入使用 Runtime 固定的 10 次幂等重试，与生命周期共用本阶段的 RetryController：同一份记录固定后，保存失败先读取最新持久化事实确认提交；未确认且策略允许时只重写同一份记录，不能重新采集已有快照/产物、创建 Attempt、提交或重启 Agent。确认不依赖 JSON 对象键顺序，但不忽略数组顺序、重复记录或 null。
25. Pipeline 中失败执行的评估取消独立收尾，不占用评估 Agent 并发槽、不成为成功样本评估的门槛。取消保存失败只校准/重试对应 EvaluationRecord；仍失败时把收尾错误写入该记录，已经保存的取消事实不降级。无法连错误记录也保存时，经 `EvalRunResumerDependencies.onError(error)` 上报带 Evaluation/Sampling 身份的错误；未注入回调时默认使用 `console.error`。不吞错、不把错误记在其他样本上，也不因取消收尾异常调用整批失败处理。

26. Store 读出的 Sampling/Evaluation 带 `revision`（`SamplingState`/`EvaluationState`）；每次更新携带预期旧记录，Store 只在 `revision` 未变时原子写入，并以下一个 `revision` 保存，`persistRuntimeRecord` 返回已保存的记录，不复制也不比较整份事实。记录已变化时只读回校准，不用旧的整条记录覆盖。保存响应和读回都失败直到重试耗尽时，提交结果未知，Lifecycle 不写失败状态或补丁；上报异常并保留可恢复进度。确认写入未发生时，失败收尾仍须先读最新记录再更新。
27. 已有 `resources: collected` 的 Attempt 再次下载失败时保留原始快照及其 `coverage/finalized`；下载在预算内重试，预算用尽按第 22 条放弃。已 `finalized` 或已放弃的快照不再读取。
28. Agent 结束（Attempt 已有终态，或 Evaluator 的 MCP 结果已被接受）后，生命周期内在 0、5、10、20、40 秒检查 readiness（约 75 秒），finalized 即下载一次；否则不下载、不再占用并发槽，阶段照常推进，并带上 `resourcesPending: {deadline, nextAttemptAt, lastError?}`，`deadline` 为 Agent 结束时间加 `RESOURCE_WAIT_MS`（10 分钟），首次检查在 `RESOURCE_CHECK_INTERVAL_MS`（60 秒）后。该标记由每次生命周期写入根据 Attempt 推导，与 Attempt 事实原子提交；停止已收尾的 Run 补收输出时不读取资源、不开始等待。终态未确认的 Attempt 只检查一次 readiness。阶段结束后，每个到期轮次对每个仍欠资源的 Attempt 按原 Chat、幂等键和 Submission ID 检查一次 readiness，不 ensure、不初始化、不提交或重启 Agent，不改阶段状态、产物、证据或已接受结果；未确认终态的已接受 Evaluator Attempt 在资源预算准入后先按原键校准，确认的终态和固定完成时间须可靠保存后才读取资源或清除等待，保存失败保留原等待供下轮恢复；已有 finalized 快照只补 receipt 事实，不重新下载，预算已耗尽则不再校准。finalized 则下载一次并清除标记；未到期限则 `nextAttemptAt = min(now + 60s, deadline)`；期限已过则在公共 Harness 下载输入中显式设置 `allowPartial:true`，只读取同一冻结 cutoff/完整账单指纹的已知页并原样保存 `finalized:false`、`coverage.partial` 与真实计数，清除标记并经 `onError` 只上报一次；来源改变或页面中断不能保存半个快照，账单未知绝不填零。刷新轮次本身在期限后出错也清除标记，持久化失败除外。放弃的 Attempt 经共享资源流程报告一次，不重复作为期限错误报告，也不再让阶段等待。后续手动资源补采可用新预算等待/下载已 finalized 的快照，之前的 partial 永不冒充 finalized。已结束 Attempt 是否仍欠资源的唯一定义是导出的 `stageOwesResources()`（配合 `executionAgentEnded` / `evaluationAgentEnded`），API 的资源补采也用它判断。Run 是否仍欠工作的唯一定义是 contracts 的 `isStageRecoveryPending()`（阶段状态待处理，或带 `resourcesPending`），持久化查询按 Run 类型和停止请求把它应用到成员；Run 状态仍只由阶段状态推导。
29. 终态状态无法确认（`SubmissionStatusError`，如 Submission WebSocket 断开且按键校准为 `null`/出错）不是 Agent 失败：阶段保持 `retrying`，`observationPending: {passes, lastError}` 跨 Worker 轮次累计；下一轮按同一 Attempt、同一幂等键重新观察已保存的 Submission（已知 Submission ID 时不再 POST），不新建 Attempt。只有明确的 `failed/interrupted/cancelled` 终态才进入 `maxRestarts` 重启决策。观察与证据导出共用按轮计数的 `RecoveryPasses`，分别以 `OBSERVATION_MAX_PASSES`、`EVIDENCE_EXPORT_MAX_PASSES`（均为 5）为上限；观察耗尽时阶段写为 `failed`（`... could not be confirmed after N observation passes; last: ...`）。校准错误附带 `inspect: null`、`inspect: <status>` 或 `inspect error: <message>`，校准异常另经 `onError` 上报。Evaluator 的 MCP 结果已被接受时，观察丢失不使评估停在 `retrying`：保持 `succeeded`，未读完的资源转为 `resourcesPending`。
30. 停止收尾（`finalizingStop`）和停止已收尾后的输出补收（`runStopped`）从不读取 SP 资源（不检查 readiness、不下载）：每个仍欠资源（按 `attemptOwesResources` 判定）且没有已采集快照的已结束 Attempt 写为 `resources: {status: "failed", scope: <原 scope>, collectedAt, error: "Run stopped before resources were collected"}`（`STOPPED_RESOURCES_ERROR`），已采集（含未 finalized）的快照原样保留；清除 `resourcesPending`，阶段状态仍按停止收尾规则写入。之后仍可手动「重新采集资源」：按第 28 条的刷新轮次读取。
31. 诊断日志：可选的 `EvalRunResumerDependencies.log(event)`（`RuntimeLog`，异常被吞掉）只记录 ID、计数、状态、时长和错误信息，从不记录提示词、native 轨迹、文件字节、Token 或凭据。阶段内事件自动带 `runId`、`stage`、`samplingId`、`evaluationId?`；`onError(error, context)` 带同样的上下文。事件：`run_pass_summary`（每轮 `resume` 结束：`operation`、阶段状态计数、待恢复标记、`nextDueAt?`、`durationMs`）；`stage_attempt`（Attempt 身份与状态）；`operation_retry`/`retry_exhausted`（操作、次数、错误、退避）；`resource_wait`（readiness 的作用域、次数和结果）；`resources_collected`（快照保存后：作用域、`finalized`、`coverage`、usage/nativeRecords/billing 数量、`creditsTotal`；放弃时为 `downloads` 与 `error`）；`evidence_export`（每轮导出：`submissionId`、`passes`、`outcome`、`filesStored`/`filesTotal`、`bytes`、`trajectoryParts`/`trajectoryRecords`/`trajectoryDone`、`omitted` 和 `durationMs`）。`creditsTotal` 仅为诊断（模型 `debitedUnits` 加 Action `chargedCredits` 的原始数值和），不持久化；计费统计仍只由 Metrics 计算。

Sampling 的三个边界固定如下：

- `SamplingState`：Store 长期持久化的 Sampling 事实；
- `RuntimeSamplingContext`：执行时临时拼接 `{ state, sample }`，不能持久化；
- `SamplingSnapshot`：`getSampling()` 对 API、Web 和 CLI 的稳定查询 DTO，与 Store 和运行时 Context 解耦。

轨迹通过 SP 正式接口完整获取，以完整原始事件按顺序分片存入证据包，再导入 Evaluator 自己的 Space；本包不引入独立的轨迹树或线上流量评估子包。

## 暂不纳入本包

- 数据集持久化实现；
- 评估指标聚合实现；
- API、Web、CLI 应用；
- CC、Codex 等进程启动器；
- 第二套 SP Adapter 包。

后续非 SP Harness 接入若确有需要，再增加独立 Harness 实现，而不是改变本包的运行时控制面。

可选评分集成通过 `EvaluationScorePort.read(schema, record)` 注入，由 Metrics 的公共 `createEvaluationScoreReader()` 实现。Runtime 不解析、校验或复制分数；只保存原始输出并投递派生分数。补同步同样从原始记录与 Project 锁定 Schema 读取。无 numeric score、输出校验失败或外部同步失败都不改写 Agent 的执行结果。


手动重新收集结果：POST /api/projects/{projectId}/samplings/{samplingId}/collect 与 /evaluations/{evaluationId}/collect 返回 202 {runId, queued}。仅接受归属匹配、最后 Attempt 为 completed 且有 Chat/Submission 的失败阶段；已成功为幂等无操作，重复待收集请求不重复入队，项目忙或 Run 停止尚未收尾时拒绝；停止已收尾的 Run 可补收输出，也可补采停止时记为失败的资源（均不重开停止）。API 在 Project 行锁内设置 retrying + collectionPending，并原子提交原 Run 队列任务。Worker 只读取已有输出，不创建或重启 Agent/Attempt；执行侧必须归档产物和完整轨迹，并从同一 Submission 已保存的 `evidenceExport` 进度续传证据，重新给 5 轮导出预算；Submission 不同则从头导出。评估侧保存原始结果并沿用校验和同步。失败清除待收集标记并保留错误，支持再次补收。补收执行不自动启动之前已取消的评估。当前运行查询允许旧 Run 因补收重新活跃，runSequence 仍是最大创建序号。

Run 状态按当前归属的评估记录投影。重新评估移走旧记录后，旧 Run 不把缺失的评估当成 queued；没有剩余阶段记录时沿用空 Run 的终态 failed，不再被视为活动任务。

`toRunSnapshot` only requires Sampling execution states and Evaluation sampling IDs/statuses; applications must not load resource snapshots solely to compute Run progress.

MCP-enabled Evaluations complete on validated result acceptance, atomically with the result and its revision. Status-socket loss is recoverable observation failure, not an Evaluation terminal fact; after acceptance it leaves the Evaluation `succeeded` with `resourcesPending` instead of `retrying`. Late submissions cannot bypass Project deletion, Run stop/cancellation or replacement. Runtime preserves accepted results when subsequent observation or collection fails. See [evaluation result submission](../../docs/eval-evaluation-result-submission.md).

Recovery of a succeeded Evaluation awaiting resources delivers any scored result not yet synced before resource collection. It reuses the persisted output, locked Schema and idempotent score publisher without rerunning the Agent. Score-only writes preserve pending receipt/resource recovery; delivery failure records `scoreSync: failed` without blocking resource recovery or changing the accepted result.
