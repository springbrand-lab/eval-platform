# @eval-platform/eval-runtime

评估运行时的控制面和执行编排。它只依赖 SP 的公开 Harness 边界，不复制 SP Runtime，也不直接读取 Durable Object 存储。

## 对外边界

运行时最终向 API、Web 和 CLI 暴露同一组控制面：

- `listProjects()`
- `listAgents()`
- `listDatasets()`
- `listData()`
- `listSamples()`
- `start()`：持久化被评估 Agent 的执行 Run；
- `evaluate()`：持久化已有执行结果的独立评估 Run；
- `pipeline()`：持久化执行加评估的 Run，不创建独立的 Pipeline 实体；
- `resume(runId)`：从持久化 Run、Sampling、Evaluation 和 Attempt 事实继续运行；
- `getRun()`：读取项目、阶段、数据、样本、采样和执行状态；
- `getSampling()`：读取单次采样的执行事实；
- `getEvaluation()` / `listEvaluations()`：读取独立的评估记录。

这些接口属于运行时控制面，不绑定具体的 HTTP、Web 或 CLI 实现。

## 文件职责

```text
src/
├── model.ts                 # 对 eval-contracts 和运行时 Sample 的公共导出
├── config/
│   ├── model.ts             # Execution / Evaluation / Pipeline 配置模型和解析端口
│   └── index.ts             # 配置创建、校验、归一化和组合解析
├── harness/
│   ├── model.ts             # SP 公开 Chat / Submission / Workspace 边界
│   └── index.ts             # Harness 子包入口
├── runtime/
│   ├── model.ts             # 控制面、Catalog 和临时 Sampling Context
│   ├── index.ts             # Run 入库、断点续跑和阶段编排
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

四个顶层包及其内部文件均保持在当前仓库中；内部目录是模块，不是新的 workspace package。

配置、Harness 和 Runtime 是本包内的子模块，不是额外 workspace package。运行时只负责启动 Agent、完整收集产物和轨迹、分别控制执行/评估阶段的最大 DO 启动数量与重试，并把结果交给评估结果层；它不实现指标算法。`RuntimeStore` 是持久化端口，实际实现由 API/DO/数据库层注入；Run、Sampling、EvaluationRecord 和本次生效配置快照的聚合写入必须由 Store 在一个持久化边界内原子完成。

三个启动入口只原子提交运行事实并返回 `RunHandle`，不在请求进程里执行 Agent。应用层唤醒单实例执行器调用 `resume(runId)`；恢复时使用 Run 已保存的生效配置和 Sample 引用，跳过已完成的阶段，并按 Attempt 原 `submissionId`、操作类型和幂等键向 SP 校准。已完成 Agent 的资源或产物保存失败只补收尾，不重新提交或重启。进程中断后遗留的未完成阶段由执行器接手；已处理且重试决策拒绝的失败写为 `failed`，定时扫描不构成无限次的隐式重试。`RuntimeRecoveryStore` 仅供应用扫描未完成 Run，Run 当前状态仍只从子记录推导。

`ExecutionConfig` 是完整的执行方案，包含 Dataset、可选 Sample 子集、Sampling 次数、Subject Harness、执行并发和重试策略。`EvaluationConfig` 包含 Evaluation Harness、评估并发和重试策略。`PipelineConfig` 只组合一个 ExecutionConfig 和一个 EvaluationConfig，不是新的 Runtime 阶段。Config ID 由配置创建函数自动生成；实际运行请求只引用 `executionConfigId`、`evaluationConfigId` 或 `pipelineConfigId`，不再重复携带这些配置字段。`ConfigResolver` 在启动前统一读取、校验和归一化配置，输出带明确默认值的 `Resolved*Config`；Run 同时保存本次实际生效的不可变配置快照，不引入 version。SP Harness 的 `runtime` 参数会继续传入 Agent 创建、素材准备、提交、状态等待/校准和产物收集；Subject 轨迹物化按 Subject Chat 身份幂等，不把评估运行选项计入物化身份。当前 Runtime 对未实现的 Remote Harness 明确报错，不会丢弃 `runOptions`。

SP 宿主与 Agent 框架分别配置：`kind: "sp"` 表示统一的云端 Harness，`framework` 必须显式选择 `sp`、`codex` 或 `cc`（Claude Code）。三者使用同一套生命周期，由 `ensureAgent` 将所选框架和 Agent Config 交给 SP 创建；返回的 Handle 必须对应请求的框架，后续提交、重启、等待和收集沿用该 Handle。评估 Agent 固定 `kind: "sp", framework: "sp"`，仍通过 `agentConfig` 选择。框架写入有效配置快照并参与请求幂等指纹，不存在静默降级或旧配置兼容默认值。当前只完成评估侧契约和接线，SP 云端启动 Codex/CC 的实现仍由 SP 提供。

## 重要约束

1. 一个 `Sampling` 必须对应一个独立的 Subject Chat / Workspace。
2. Evaluation Agent 使用独立的 Chat / Session，并绑定 Subject 的物理 SpaceDO；其材料与结果写入 `/evaluations/<evaluationId>/`。当前模型中预分配的 `submissionId` 实际承担 Chat 身份；真实 SP Submission ID 的拆分留待 SP Harness 接入。
   Runtime 在调用 `ensureAgent` 前分配并持久化该 ID。Harness 必须按 ID 获取或创建，重复或并发请求返回同一个 Agent；同一 ID 的归属、角色、框架、Agent Config 或 Evaluator Workspace 绑定不一致时返回不可重试的 `AgentIdentityConflictError`，不得静默重绑定。
3. 重试不能把一次采样变成新的采样，只能增加该采样的执行或评估 attempt。
   `RetryController` 按 `creation`、`initialization`、`submission`、`status`、`collection`、`resources`、`persistence` 和 `restart` 区分决策；默认策略只定义确认失败后的 Agent 重启，其余操作是否重试由注入的控制器决定。Agent ensure 和初始化重试保留同一 Agent，各自独立计数，不新增执行/评估 attempt、不消耗 Agent 重启次数；收集或保存失败不得重启已经完成的 Submission。
4. Submission 终态以 Harness 推送通知为主；自动重试前仍必须按本次操作的幂等键查询原 `Submission`，不得因为响应丢失就盲目再次投递。
5. Subject Workspace 产物保留在原 SpaceDO；完整 Subject Trajectory 由 SP 物化到同一个 SpaceDO。SP 确认轨迹准备完成后，评估 Agent 才能提交任务。
6. 推送丢失、连接断开或运行时恢复时，`inspectAgentOperation` 只做一次或有限次状态校准，不作为主流程的持续轮询。
7. 评估平台只消费 SP 的公开契约，不依赖 SP 的 DO SQLite、内部类或 Web 投影。
8. 再次主动调用 `evaluate()` 会新建评估记录并在启动前分配新的评估 ID；这是有意重新评估，不是丢响应后的 ensure 重试。被评估 Agent 的 ID 保持不变，旧评估记录不被覆盖。
9. `start()`、`pipeline()` 和 `evaluate()` 不分别写 Run、Sampling 和 EvaluationRecord。三者都使用 `createRunWithSamplings()` 原子提交；命令失败时不能留下半批状态或清掉旧评估记录。
10. `start()` 和 `pipeline()` 必须带调用方 `requestId`，可选 `idempotencyKey`；Runtime 先快速查重，再由 Store 在 Run/Sampling 原子事务内二次查重。相同身份直接返回原 `RunHandle`，身份对应不同请求事实时拒绝，不得依赖内存 Map。
11. `RuntimeRunRecord` 只保存不可变的阶段范围 `phases`，不保存当前阶段或 Run 状态；`RunSnapshot.phase/status` 由 `getRun()` 根据关联 Sampling 即时推导，是查询投影而不是第二份权威状态。单独执行范围为 `["execution"]`，单独评估为 `["evaluation"]`，联跑为 `["execution", "evaluation"]`；没有 `pipeline` 阶段或 Run kind。
12. 联跑刚创建且所有 Execution Sampling 仍为 `queued` 时，Run 也必须是 `queued`。执行尚未结束时当前阶段为 `execution`；执行结束且存在成功 Sampling 后当前阶段为 `evaluation`，交接等待不能提前显示成功，成功 Sampling 的评估全部结束前 Run 仍是运行态。执行失败的 Sampling 不启动评估 Agent，其 EvaluationRecord 标记为 `cancelled`。
13. `SamplingState` 只保存单次执行状态，不保存评估结果、`Sample`、JSON、初始 Session 引用、初始素材引用或 metadata；评估由独立 `EvaluationRecord` 通过 `samplingId` 关联。
14. 执行使用临时 `RuntimeSamplingContext`，评估使用临时 `RuntimeEvaluationContext`，二者都不能整体交给 Store。独立评估先通过 `RuntimeCatalog.getSample()` 按不同 Sample ID 批量关联输入，再原子提交新的 EvaluationRecord；恢复时按持久化 Sample ID 重建这些临时 Context。输入缺失或返回的 Sample ID 不匹配时，不清除已有评估结果，也不启动新评估 Agent。
15. `getSampling()` 返回扁平的 `SamplingSnapshot`，只复制公开的 Sampling 字段，不暴露 Store 包装结构、`Sample` 或 Runtime 临时对象。
16. `start()` 只接收项目和 `executionConfigId`；`evaluate()` 只接收项目、Sampling IDs 和 `evaluationConfigId`；`pipeline()` 只接收项目和 `pipelineConfigId`。Dataset 和 Sampling 次数由 ExecutionConfig 决定，评估 Agent 由 EvaluationConfig 决定。
17. `Sample` 使用 `{ sampleId, data: Data }`，平台样本身份与完整业务 Data 分开，不兼容旧的扁平结构。`Sample.data.userPrompt` 必填且不能为空白，作为当前任务原样发送；其他 JSON 业务字段通过 `materializeInitialData().data` 完整交给 SP，只去除 Data 的平台 `dataId`，业务 `data.sampleId` 不覆盖、不删除。`initialSession` 和 `initialMaterials` 都可省略；提供时分别使用外部 `bundleId + sessionId`、`bundleId + materialId`，两个 ID 必须齐全，Runtime 不生成资源 ID。Session 正文不进入 Dataset、Sample、Sampling 或执行 prompt。SP 公开能力将素材与 Session 副本落入目标 DO 的存储，由所选框架加载并重建 Context；Runtime 等准备完成后才发送 `userPrompt`，不自己解析 Session、拼接消息或把扩展数据包成新 prompt。
18. 初始数据准备使用 `initial-data:<submissionId>` 的稳定幂等键；重复准备相同事实返回原结果，不能覆盖已经运行过的 Session。初始化发生可重试错误或响应丢失时，由 `RetryController` 的 `initialization` 决策决定是否重试完整准备流程，沿用同一目标 Agent、输入和幂等键，不重新创建或重启 Agent、不查询尚未提交的 Submission。不可重试错误立即失败，重试耗尽也不提交任务。不同 Sampling 使用不同目标 Agent 和幂等键；同一 Agent 自动重启沿用当前 Session，不重新加载初始 Session。SP 负责持久化初始化幂等，不增加 Runtime 准备状态表。
19. 评估 Agent 使用独立 Session，不把 Subject 的 `initialSession` 当作自己的初始会话。`ensureAgent()` 接收不可变的 `evaluationWorkspace={subject:{userId,chatId},evaluationId}`，SP 据此把 Evaluator Chat 绑定到 Subject 的物理 SpaceDO，并只允许它写本次评估目录。`materializeSubjectTrajectory()` 使用 `subject-trajectory:<subjectChatId>` 的稳定幂等键，请 SP 从 Subject Chat 读取完整轨迹并在该 SpaceDO 中物化一次；历次主动重评复用相同文件。Subject 产物不复制。响应丢失后的初始化重试沿用相同来源事实和幂等键，SP 返回原结果或续做未完成的物化；所有准备步骤确认前不得提交评估任务。
20. 每次实际提交的 Attempt 在投递前持久化 `resources: pending`，其中包含目标 `submissionId` 和本次提交/重启的准确幂等键。终态或投递/等待失败后通过公开 `collectAgentResources()` 收集资源，并先保存到对应 Attempt，再收集产物、决定是否重启或发布阶段终态。失败、取消和重启前的费用/Token/工具/Turn 都保留；未提交任务的创建/初始化失败不假装产生资源事实。
21. 资源快照只包含本次操作及其子 Agent 的新工作，不包含导入历史或共享的 Subject 证据。`usageEvents`、`telemetryEvents`、`billingSettlements` 是 SP 原始 JSON 记录；未知字段、缺失字段、null、顺序、重复事件、父子关联与来源数值全部保留。Runtime 只校验归属和无损可序列化性，不解析费用/Token、不抽取工具/Turn、不归一化、不去重、不计算统计、不新增汇总字段。源 `coverage/finalized` 也原样保存，由 Metric 判断是否适合统计。
22. 资源读取单独使用 `resources` 重试预算，与产物收集和 Agent 重启无关。采集状态只有 `pending | collected | failed`；`collected` 表示快照已保存，不表示来源完整。读取失败不能覆盖原 Agent 错误或使成功产物变成失败。Store 将 Attempt 与原始资源快照原子保存；查询从持久化记录读取，Metrics 不直接访问 SP/DO/私有数据库，而是读取 Runtime 原始内容进行解析、去重和所有统计。完整轨迹和大产物继续存引用，资源事件不构成另一份 Workspace/Session 副本。
23. 后续 Attempt 状态补丁基于当前执行上下文的最新 Attempt，而不是调用方的旧副本；原始快照写入已提交但响应丢失时，失败处理不能用旧 `pending` 覆盖它。运行时收尾异常先读取 Store 的最新事实，不以启动时的 `queued` 副本重写整个记录，也不把未确认的 Agent 操作误判为失败。查询只读取持久化结果，不从执行上下文的内存副本返回数据。
24. 一旦观察到 Agent 终态，立即固定 Attempt 的状态和完成时间，并先保存终态再收集资源，避免资源保存异常抹掉已确认事实。Agent 错误属于 Attempt，Runtime 收尾失败属于执行/评估阶段的 `lastError`，不得把已完成 Agent 记为失败。记录写入使用独立 `persistence` 重试，与生命周期共用本阶段的 RetryController：同一份记录固定后，保存失败先读取最新持久化事实确认提交；未确认且策略允许时只重写同一份记录，不能重新采集已有快照/产物、创建 Attempt、提交或重启 Agent。确认不依赖 JSON 对象键顺序，但不忽略数组顺序、重复记录或 null。次数和退避由注入策略决定，不新增默认政策。
25. Pipeline 中失败执行的评估取消独立收尾，不占用评估 Agent 并发槽、不成为成功样本评估的门槛。取消保存失败只校准/重试对应 EvaluationRecord；仍失败时把收尾错误写入该记录，已经保存的取消事实不降级。无法连错误记录也保存时，经 `EvalRuntimeDependencies.onError(error)` 上报带 Evaluation/Sampling 身份的错误；未注入回调时默认使用 `console.error`。不吞错、不把错误记在其他样本上，也不因取消收尾异常调用整批失败处理。

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
