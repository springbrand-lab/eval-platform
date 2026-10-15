# @eval-platform/eval-runtime

评估运行时的控制面和执行编排。它只依赖 SP 的公开 Harness 边界，不复制 SP Runtime，也不直接读取 Durable Object 存储。

目标部署中的 SP 是 Eval 独立发布的 API/数据库、Agent Worker 和 Space Worker；登录、Agent Config 及 Agent 生命周期全部由这套 SP 提供。Harness 使用该部署的普通 Inbox/Chat 生命周期，具体 HTTP/WebSocket 客户端由 `apps/eval-api` 组合。部署分支绑定 Project；Runtime 从当前发布信息取得 commit 并写入新 Run，恢复时只读 Run 已保存的 commit。见[部署方案](../../docs/eval-sp-deployment.md)与[Project 改造方向](../../docs/eval-project-redesign.md)。

## 对外边界

- `plan`：`normalizeExecutionPlan` / `normalizeEvaluationPlan` 是计划校验与归一化的唯一入口（`retryPolicy` 默认 `DEFAULT_RETRY_POLICY`，Evaluator 必须 `framework: "sp"`）；`digestExecutionPlan` 覆盖执行计划、Dataset 绑定和全部 ProjectSample 快照，`digestEvaluationPlan` 覆盖评估计划，两者与对象键顺序和 ProjectSample 输入顺序无关；`phasesOf(operation)` 推导 Run 阶段。
- `ProjectPlanReader`：Runtime 唯一的 Project 输入，提供 `getProjectPlan`（固定执行计划、可空评估计划、两个摘要和锁定时间）、`getProjectSamples`（按输入顺序返回完整 Data 快照）和 `getEvaluationOutputSchema`。Runtime 不读取实时 Dataset/Data、可编辑 Agent Config 或任何配置表。
- `createEvalRunAdmission({ sourceCommit, plans, store, idFactory? })`：API 进程的准入入口，不持有 Harness 凭证。
  - `preview({ projectId, operation, selector })` 在 Project 快照内展开选择：`all`/`datasetIds` 按 Dataset 绑定顺序再按成员顺序展开为 ProjectSample，与显式 `projectSampleIds` 合并去重；execution/pipeline 的显式 Sampling 若其 ProjectSample 已被整条选中则被吸收；evaluation 把 ProjectSample 展开为当前执行成功的 Sampling（静默过滤失败/未完成），显式 Sampling 必须执行成功。返回固定 `targets`、替换/新建 Sampling 数、评估数和计划摘要。
  - `submit({ idempotencyKey, projectId, operation, selector, targets })` 以 `targets` 为准校验（不重新展开），构造新 Sampling（每个目标 ProjectSample 按 `samplingCount` 新建，每个目标 Sampling 一对一新建）、EvaluationRecord（pipeline 每个新 Sampling 一条，evaluation 每个目标 Sampling 一条）和 Run，并调用一次 `RuntimeStore.admitRun()`。请求指纹为 `sha256Hex(canonicalJsonBytes({ projectId, operation, selector, targets, planDigests }))`，`planDigests` 含执行计划摘要，pipeline/evaluation 另含评估计划摘要；同 key 先按已存 Run 的摘要比对，事实相同即重放原 Run，不再读取计划。
- `createEvalRunResumer({ plans, harness, store, onError, ... })`：Worker 入口，提供 `resume(runId, stopSignal?)`、`interrupt(runId)` 和 `stop(runId)`。每次先读取 Run，再读取 Project 计划并核对 `run.planDigests`；摘要不一致直接拒绝，绝不用另一份计划运行。执行使用执行计划的 Harness、`executionConcurrency` 和 `retryPolicy`，评估使用评估计划的对应字段；ProjectSample 按不同 ID 批量读取并校验身份。
- 结果读取实现 `EvalRunQueries`（`getRun`、`getSampling`、`getEvaluation`、`listEvaluations`），由宿主基于自身存储提供；`toRunSnapshot` 投影 `operation`、`selector`、`targets` 与派生的 `phase/status`。

`RuntimeStore.admitRun()` 是 Store 侧的准入事务合同（见 `runtime/store.ts`）：在 Project 行锁内拒绝缺失/软删除 Project；同 key 同指纹重放、不同指纹或被替换的 key 拒绝，新 key 遇到未完成 Run 抛出 `RuntimeProjectBusyError`；复核计划摘要和评估计划存在；复核 `replacedSamplingIds` 仍等于目标的当前 Sampling（否则 `stale-targets`），evaluation 复核目标仍执行成功；execution/pipeline 删除被替换的 Sampling 及其评估和 Run 关联，evaluation 只删除目标 Sampling 的当前评估，绝不触碰未选中结果；批量插入新事实与 key ledger；首个 pipeline/evaluation Run 锁定评估计划，提交后才通知 Worker。

## 文件职责

```text
src/
├── plan/
│   └── index.ts             # 执行/评估计划校验、归一化、摘要与阶段推导
├── harness/
│   ├── model.ts             # SP 公开 Chat / Submission / Workspace 边界
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
│   ├── execution.ts         # Subject 执行、初始数据、产物和完整轨迹
│   ├── evaluation.ts        # Evaluation Agent、共享 Workspace 和轨迹物化
│   ├── store.ts             # 原子持久化端口、同一记录写入校准与重试
│   ├── projection.ts        # Sampling / Run 原始事实到公开快照的唯一投影
│   ├── resources.ts         # 原始资源快照的归属与无损 JSON 校验
│   ├── scheduler.ts         # 执行 / 评估两套 Agent 并发限制契约
│   └── retry.ts             # 阶段化重试决策和 Agent 重启策略
└── index.ts                 # 包统一导出
```

包入口为根 `.` 与 `./harness`。`canonicalJsonBytes`/`sha256Hex` 来自 `@springbrand/utils`（本地 `link:` 依赖，见 [SP 共享包发布待办](../../docs/sp-package-publishing-todo.md)）；指纹或摘要算法变化后本地开发库需清库重建。

计划、Harness 和 Runtime 是本包内的子模块，不是额外 workspace package。运行时只负责启动 Agent、完整收集产物和轨迹、分别控制执行/评估阶段的最大 DO 启动数量与重试，并把结果交给评估结果层；它不实现指标算法。Run 不保存配置正文，只保存 `operation`、`phases`、`selector`、`targets`、`samplingIds`、`evaluationIds`、`planDigests`、request identity 和停止标记。调度与停止流程见[架构方案](../../docs/architecture.md#run-调度与停止)。

恢复跳过已完成的阶段，并按 Attempt 原 `submissionId`、操作类型和幂等键向 SP 校准。已完成 Agent 的资源或产物保存失败只补收尾，不重新提交或重启。已保存的失败 Attempt 若 SP 校准暂不可用，仍保持待恢复，不能代替重启决策进入证据收尾。只有确认失败且重试决策拒绝后，Subject 证据保存完才写为 `failed`。`RuntimeRecoveryStore` 只提供 `isRunActive`、`isRunStopRequested`、`requestRunStop`、`markRunStopFinalized`，Run 当前状态仍只从子记录推导。Pipeline 中执行失败的 Sampling 不提交 Evaluator，其 EvaluationRecord 取消；成功的 Sampling 照常评估。仅评估 Run 不改动 Subject 的 Attempt、资源、产物、轨迹和状态。

Runtime 将计划中 Harness 的 `runtime` 选项传给 Harness；SP Harness 在创建 Chat 和提交 Prompt 时将其发送给 SP，在等待终态时使用其中的超时设置。素材准备的 SP 接口不接收 `runtime`，校准和产物收集也不使用这些选项。Subject 轨迹物化按 Subject Chat 身份幂等。`HarnessConfig` 只有 `kind: "sp"` 一种。

`ProjectSample.data.userPrompt` 只作为 Subject 的提交消息；`evalPrompt` 是 Evaluator 的提交消息。pipeline 和 evaluation 在准入时要求所有涉及的 ProjectSample 都有 `evalPrompt`（否则 `evaluation-prompt`）。Evaluator 初始化数据以 `evalPrompt` 作为自己的 `userPrompt`，只带 `evalInitialMaterials`（映射为初始化材料），不加载 Subject 的初始 Session；Subject 初始化数据只带 `initialMaterials`，不包含 `evalPrompt`。评估输出 JSON Schema 由 `getEvaluationOutputSchema` 解析后作为 `evaluation-output.schema.json` 写入每个 Evaluator 的 Workspace；Evaluator 输出（含 `structuredOutput`）原样保存。

类型化错误由 `runtime/errors.ts` 统一定义：找不到实体（`project`、`run`、`dataset`、`project-sample`、`sampling`、`evaluation`）抛出 `RuntimeEntityNotFoundError(entity, id)`；输入或计划校验失败抛出 `RuntimeInputError(message, field?)`；准入前提不满足抛出带 `reason` 的 `RuntimeAdmissionConflictError`（`evaluation-plan-required`、`plan-changed`、`stale-targets`、`empty-targets`、`evaluation-prompt`、`sampling-unavailable`、`source-branch`）；另有 `RuntimeProjectBusyError`、`RuntimeRunIdentityConflictError`、`RuntimeRunStoppedError`、`RuntimeRecordConflictError`、`RuntimeRecordPersistenceError`。控制面只按错误类映射 HTTP 响应。

SP 宿主与 Agent 框架分别配置：`kind: "sp"` 表示统一的云端 Harness，`framework` 必须显式选择 `sp`、`codex` 或 `cc`（Claude Code）。三者使用同一套生命周期，由 `ensureAgent` 将所选框架和 Agent Config 交给 SP 创建；返回的 Handle 必须对应请求的框架，后续提交、重启、等待和收集沿用该 Handle。评估 Agent 固定 `kind: "sp", framework: "sp"`。框架属于执行计划并进入执行计划摘要，不存在静默降级或旧配置兼容默认值。当前只完成评估侧契约和接线，SP 云端启动 Codex/CC 的实现仍由 SP 提供。

## 重要约束

1. 一个 `Sampling` 必须对应一个独立的 Subject Chat / Workspace。
2. SP Chat 就是持久 Session，其中每次提交都有独立的 Submission ID。`AgentHandle.ownerUserId` 固定 Chat 所属 Inbox 的路由归属。Subject 与 Evaluation Agent 都通过 Eval SP 自己的普通 Inbox 确保 Chat；Evaluation Agent 拥有独立 Chat / Session，并绑定 Subject 的物理 SpaceDO，其材料与结果写入 `/evaluations/<evaluationId>/`。Runtime 在 `ensureAgent` 前预分配并保存 Subject `subjectChatId` 或 Evaluator `chatId`；SP 的真实 Submission ID 只保存在对应 Attempt。
   Harness 必须按 Chat ID 获取或创建，重复或并发请求返回同一个 Agent；同一 ID 的归属、角色、框架、Agent Config 或 Evaluator Workspace 绑定不一致时返回不可重试的 `AgentIdentityConflictError`，不得静默重绑定。Eval Web 只通过 Run/Sampling/EvaluationRecord 展示这些 Chat，不提供普通 Inbox 管理或聊天驱动操作。
3. 重试不能把一次采样变成新的采样，只能增加该采样的执行或评估 attempt。
   `RetryController` 按 `creation`、`initialization`、`submission`、`status`、`collection`、`resources`、`persistence` 和 `restart` 区分决策；默认策略只定义确认失败后的 Agent 重启，其余操作是否重试由注入的控制器决定。Agent ensure 和初始化重试保留同一 Agent，各自独立计数，不新增执行/评估 attempt、不消耗 Agent 重启次数；收集或保存失败不得重启已经完成的 Submission。
4. Submission 终态以 Harness 推送通知为主；自动重试前仍必须按本次操作的幂等键查询原 `Submission`，不得因为响应丢失就盲目再次投递。
5. Subject Workspace 产物保留在原 SpaceDO；完整 Subject Trajectory 由 SP 物化到同一个 SpaceDO。已确认失败的 Subject Submission 也收集并保存可用产物及完整轨迹，保留原失败原因。收集失败时保留 `execution.evidencePending` 和非终态；恢复只补收证据，不提交或重启 Agent。证据引用与最终执行状态同时保存。SP 确认轨迹准备完成后，评估 Agent 才能提交任务。
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
17. `ProjectSample` 使用 `{ projectSampleId, projectId, dataId, datasetIds, samplingCount, data: Data }`，平台身份与完整业务 Data 分开。`ProjectSample.data.userPrompt` 必填且不能为空白，作为 Subject 当前任务原样发送；其他 JSON 业务字段通过 `materializeInitialData().data` 交给 SP，Subject 输入去除平台 `dataId` 和评估专用 `evalPrompt`、`evalInitialMaterials`，业务 `data.sampleId` 不覆盖、不删除。Evaluator 输入将 `evalPrompt` 映射成自己的 `userPrompt`，将 `evalInitialMaterials` 映射为初始化素材，去除 Subject 的 `userPrompt`、`initialMaterials` 和初始 Session。`initialSession` 和 `initialMaterials` 都可省略；提供时分别使用外部 `bundleId + sessionId`、`bundleId + materialId`，两个 ID 必须齐全，Runtime 不生成资源 ID。Session 正文不进入 Dataset、ProjectSample、Sampling 或执行 prompt。SP 公开能力将素材与 Session 副本落入目标 DO 的存储，由所选框架加载并重建 Context；Runtime 等准备完成后才发送相应阶段的原始 prompt，不自己解析 Session、拼接消息或把扩展数据包成新 prompt。
18. 初始数据准备使用 `initial-data:<chatId>` 的稳定幂等键；重复准备相同事实返回原结果，不能覆盖已经运行过的 Session。初始化发生可重试错误或响应丢失时，由 `RetryController` 的 `initialization` 决策决定是否重试完整准备流程，沿用同一目标 Agent、输入和幂等键，不重新创建或重启 Agent、不查询尚未提交的 Submission。不可重试错误立即失败，重试耗尽也不提交任务。不同 Sampling 使用不同目标 Agent 和幂等键；同一 Agent 自动重启沿用当前 Session，不重新加载初始 Session。SP 负责持久化初始化幂等，不增加 Runtime 准备状态表。
19. 评估 Agent 使用独立 Session，不把 Subject 的 `initialSession` 当作自己的初始会话。`ensureAgent()` 接收不可变的 `evaluationWorkspace={subject:{userId,chatId},evaluationId}`，SP 据此把 Evaluator Chat 绑定到 Subject 的物理 SpaceDO，并只允许它写本次评估目录。`materializeSubjectTrajectory()` 使用 `subject-trajectory:<subjectChatId>` 的稳定幂等键，请 SP 从 Subject Chat 读取完整轨迹并在该 SpaceDO 中物化一次；历次主动重评复用相同文件。Subject 产物不复制。响应丢失后的初始化重试沿用相同来源事实和幂等键，SP 返回原结果或续做未完成的物化；所有准备步骤确认前不得提交评估任务。
20. 每次实际提交的 Attempt 在投递前持久化 `resources: pending`，其中包含目标 `chatId` 和本次提交/重启的准确幂等键；SP 返回或恢复真实 Submission ID 后写到 Attempt，采集到的资源快照须包含三者。终态或投递/等待失败后通过公开 `collectAgentResources()` 收集资源，并先保存到对应 Attempt，再收集产物、决定是否重启或发布阶段终态。失败、取消和重启前的费用/Token/工具/Turn 都保留；未提交任务的创建/初始化失败不假装产生资源事实。
21. 资源快照只包含本次操作及其子 Agent 的新工作，不包含导入历史或共享的 Subject 证据。`usageEvents`、`telemetryEvents`、`billingSettlements` 是 SP 原始 JSON 记录；未知字段、缺失字段、null、顺序、重复事件、父子关联与来源数值全部保留。Runtime 只校验归属和无损可序列化性，不解析费用/Token、不抽取工具/Turn、不归一化、不去重、不计算统计、不新增汇总字段。源 `coverage/finalized` 也原样保存，由 Metric 判断是否适合统计。
22. 资源读取单独使用 `resources` 重试预算，与产物收集和 Agent 重启无关。采集状态只有 `pending | collected | failed`；`collected` 表示快照已保存，不表示来源完整。读取失败不能覆盖原 Agent 错误或使成功产物变成失败。Store 将 Attempt 与原始资源快照原子保存；查询从持久化记录读取，Metrics 不直接访问 SP/DO/私有数据库，而是读取 Runtime 原始内容进行解析、去重和所有统计。完整轨迹和大产物继续存引用，资源事件不构成另一份 Workspace/Session 副本。
23. 后续 Attempt 状态补丁基于当前执行上下文的最新 Attempt，而不是调用方的旧副本；原始快照写入已提交但响应丢失时，失败处理不能用旧 `pending` 覆盖它。运行时收尾异常先读取 Store 的最新事实，不以启动时的 `queued` 副本重写整个记录，也不把未确认的 Agent 操作误判为失败。查询只读取持久化结果，不从执行上下文的内存副本返回数据。
24. 一旦观察到 Agent 终态，立即固定 Attempt 的状态和完成时间，并先保存终态再收集资源，避免资源保存异常抹掉已确认事实。Agent 错误属于 Attempt，Runtime 收尾失败属于执行/评估阶段的 `lastError`，不得把已完成 Agent 记为失败。记录写入使用独立 `persistence` 重试，与生命周期共用本阶段的 RetryController：同一份记录固定后，保存失败先读取最新持久化事实确认提交；未确认且策略允许时只重写同一份记录，不能重新采集已有快照/产物、创建 Attempt、提交或重启 Agent。确认不依赖 JSON 对象键顺序，但不忽略数组顺序、重复记录或 null。次数和退避由注入策略决定，不新增默认政策。
25. Pipeline 中失败执行的评估取消独立收尾，不占用评估 Agent 并发槽、不成为成功样本评估的门槛。取消保存失败只校准/重试对应 EvaluationRecord；仍失败时把收尾错误写入该记录，已经保存的取消事实不降级。无法连错误记录也保存时，经 `EvalRunResumerDependencies.onError(error)` 上报带 Evaluation/Sampling 身份的错误；未注入回调时默认使用 `console.error`。不吞错、不把错误记在其他样本上，也不因取消收尾异常调用整批失败处理。

26. Sampling/Evaluation 的每次更新携带预期旧事实，Store 原子校验后写入；记录已变化时只读回校准，不用旧的整条记录覆盖。保存响应和读回都失败直到重试耗尽时，提交结果未知，Lifecycle 不写失败状态或补丁；上报异常并保留可恢复进度。确认写入未发生时，失败收尾仍须先读最新记录再更新。此条件写入不新增版本字段。
27. 已有 `resources: collected` 的 Attempt 补采失败时保留原始快照及其 `coverage/finalized`，单独经 `onError` 上报刷新错误；首次采集失败仍保存 `resources: failed`。已 `finalized` 的快照不再刷新。

Sampling 的三个边界固定如下：

- `SamplingState`：Store 长期持久化的 Sampling 事实；
- `RuntimeSamplingContext`：执行时临时拼接 `{ state, sample }`，不能持久化；
- `SamplingSnapshot`：`getSampling()` 对 API、Web 和 CLI 的稳定查询 DTO，与 Store 和运行时 Context 解耦。

轨迹通过 SP 正式接口完整获取，并由 SP 物化到 Subject 与 Evaluator 共用的 SpaceDO；本包不引入独立的轨迹树或线上流量评估子包。

## 暂不纳入本包

- 数据集持久化实现；
- 评估指标聚合实现；
- API、Web、CLI 应用；
- CC、Codex 等进程启动器；
- 第二套 SP Adapter 包。

后续非 SP Harness 接入若确有需要，再增加独立 Harness 实现，而不是改变本包的运行时控制面。
