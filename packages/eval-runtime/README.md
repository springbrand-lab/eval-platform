# @eval-platform/eval-runtime

评估运行时的控制面和执行编排。它只依赖 SP 的公开 Harness 边界，不复制 SP Runtime，也不直接读取 Durable Object 存储。

## 对外边界

运行时最终向 API、Web 和 CLI 暴露同一组控制面：

- `listProjects()`
- `listAgents()`
- `listDatasets()`
- `listData()`
- `listSamples()`
- `start()`：只启动被评估 Agent；
- `evaluate()`：只评估已有执行结果；
- `pipeline()`：在同一批 Sampling 上顺序编排执行和评估，不创建独立的 Pipeline 实体；
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
│   ├── index.ts             # API 控制面和阶段编排入口
│   ├── agent-lifecycle.ts   # Agent ensure、提交、终态推送、校准和重试
│   ├── execution.ts         # Subject 执行、初始数据、产物和完整轨迹
│   ├── evaluation.ts        # Evaluation Agent、输入复制和评估输出
│   ├── store.ts             # Run / Sampling / EvaluationRecord 原子持久化端口
│   ├── resources.ts         # 原始资源快照的归属与无损 JSON 校验
│   ├── scheduler.ts         # 执行 / 评估两套 Agent 并发限制契约
│   └── retry.ts             # 阶段化重试决策和 Agent 重启策略
└── index.ts                 # 包统一导出
```

四个顶层包及其内部文件均保持在当前仓库中；内部目录是模块，不是新的 workspace package。

配置、Harness 和 Runtime 是本包内的子模块，不是额外 workspace package。运行时只负责启动 Agent、完整收集产物和轨迹、分别控制执行/评估阶段的最大 DO 启动数量与重试，并把结果交给评估结果层；它不实现指标算法。`RuntimeStore` 是持久化端口，实际实现由 API/DO/数据库层注入；Run、Sampling、EvaluationRecord 和本次生效配置快照的聚合写入必须由 Store 在一个持久化边界内原子完成。

`ExecutionConfig` 是完整的执行方案，包含 Dataset、可选 Sample 子集、Sampling 次数、Subject Harness、执行并发和重试策略。`EvaluationConfig` 包含 Evaluation Harness、评估并发和重试策略。`PipelineConfig` 只组合一个 ExecutionConfig 和一个 EvaluationConfig，不是新的 Runtime 阶段。Config ID 由配置创建函数自动生成；实际运行请求只引用 `executionConfigId`、`evaluationConfigId` 或 `pipelineConfigId`，不再重复携带这些配置字段。`ConfigResolver` 在启动前统一读取、校验和归一化配置，输出带明确默认值的 `Resolved*Config`；Run 同时保存本次实际生效的不可变配置快照，不引入 version。SP Harness 的 `runtime` 参数会继续传入 Agent 创建、素材准备、提交、状态等待/校准、产物收集和评估输入准备；当前 Runtime 对未实现的 Remote Harness 明确报错，不会丢弃 `runOptions`。

SP 宿主与 Agent 框架分别配置：`kind: "sp"` 表示统一的云端 Harness，`framework` 必须显式选择 `sp`、`codex` 或 `cc`（Claude Code）。三者使用同一套生命周期，由 `ensureAgent` 将所选框架和 Agent Config 交给 SP 创建；返回的 Handle 必须对应请求的框架，后续提交、重启、等待和收集沿用该 Handle。评估 Agent 固定 `kind: "sp", framework: "sp"`，仍通过 `agentConfig` 选择。框架写入有效配置快照并参与请求幂等指纹，不存在静默降级或旧配置兼容默认值。当前只完成评估侧契约和接线，SP 云端启动 Codex/CC 的实现仍由 SP 提供。

## 重要约束

1. 一个 `Sampling` 必须对应一个独立的 Subject Chat / Workspace。
2. Evaluation Agent 使用独立的 Evaluation Chat / Workspace；对外只记录一个 `submissionId`，它同时表示 SP 的 Chat/Submission，不重复记录 `chatId`。
   Runtime 在调用 `ensureAgent` 前分配并持久化该 ID。Harness 必须按 ID 获取或创建，重复或并发请求返回同一个 Agent；同一 ID 的归属、角色、框架或 Agent Config 不一致时返回不可重试的 `AgentIdentityConflictError`，不得静默重绑定。
3. 重试不能把一次采样变成新的采样，只能增加该采样的执行或评估 attempt。
   `RetryController` 按 `creation`、`initialization`、`submission`、`status`、`collection`、`resources` 和 `restart` 区分决策；默认策略只定义确认失败后的 Agent 重启，其余操作是否重试由注入的控制器决定。Agent ensure 和初始化重试保留同一 Agent，各自独立计数，不新增执行/评估 attempt、不消耗 Agent 重启次数；收集失败不得重启已经完成的 Submission。
4. Submission 终态以 Harness 推送通知为主；自动重试前仍必须按本次操作的幂等键查询原 `Submission`，不得因为响应丢失就盲目再次投递。
5. Subject Workspace 产物和完整 Trajectory 必须复制到评估 Chat / Workspace 后，评估 Agent 才能启动。
6. 推送丢失、连接断开或运行时恢复时，`inspectAgentOperation` 只做一次或有限次状态校准，不作为主流程的持续轮询。
7. 评估平台只消费 SP 的公开契约，不依赖 SP 的 DO SQLite、内部类或 Web 投影。
8. 再次主动调用 `evaluate()` 会新建评估记录并在启动前分配新的评估 ID；这是有意重新评估，不是丢响应后的 ensure 重试。被评估 Agent 的 ID 保持不变，旧评估记录不被覆盖。
9. `start()`、`pipeline()` 和 `evaluate()` 不分别写 Run、Sampling 和 EvaluationRecord。三者都使用 `createRunWithSamplings()` 原子提交；命令失败时不能留下半批状态或清掉旧评估记录。
10. `start()` 和 `pipeline()` 必须带调用方 `requestId`，可选 `idempotencyKey`；Runtime 先快速查重，再由 Store 在 Run/Sampling 原子事务内二次查重。相同身份直接返回原 `RunHandle`，身份对应不同请求事实时拒绝，不得依赖内存 Map。
11. `RuntimeRunRecord` 只保存不可变的阶段范围 `phases`，不保存当前阶段或 Run 状态；`RunSnapshot.phase/status` 由 `getRun()` 根据关联 Sampling 即时推导，是查询投影而不是第二份权威状态。单独执行范围为 `["execution"]`，单独评估为 `["evaluation"]`，联跑为 `["execution", "evaluation"]`；没有 `pipeline` 阶段或 Run kind。
12. 联跑刚创建且所有 Execution Sampling 仍为 `queued` 时，Run 也必须是 `queued`。执行尚未结束时当前阶段为 `execution`；执行结束且存在成功 Sampling 后当前阶段为 `evaluation`，交接等待不能提前显示成功，成功 Sampling 的评估全部结束前 Run 仍是运行态。执行失败的 Sampling 不启动评估 Agent，其 EvaluationRecord 标记为 `cancelled`。
13. `SamplingState` 只保存单次执行状态，不保存评估结果、`Sample`、JSON、初始 Session 引用、初始素材引用或 metadata；评估由独立 `EvaluationRecord` 通过 `samplingId` 关联。
14. 执行使用临时 `RuntimeSamplingContext`，评估使用临时 `RuntimeEvaluationContext`，二者都不能整体交给 Store。独立评估先通过 `RuntimeCatalog.getSample()` 按不同 Sample ID 批量关联输入，再原子提交新的 EvaluationRecord；Pipeline 直接沿用执行阶段已关联的输入。输入缺失或返回的 Sample ID 不匹配时，不清除已有评估结果，也不启动新评估 Agent。
15. `getSampling()` 返回扁平的 `SamplingSnapshot`，只复制公开的 Sampling 字段，不暴露 Store 包装结构、`Sample` 或 Runtime 临时对象。
16. `start()` 只接收项目和 `executionConfigId`；`evaluate()` 只接收项目、Sampling IDs 和 `evaluationConfigId`；`pipeline()` 只接收项目和 `pipelineConfigId`。Dataset 和 Sampling 次数由 ExecutionConfig 决定，评估 Agent 由 EvaluationConfig 决定。
17. `Sample` 使用 `{ sampleId, data: Data }`，平台样本身份与完整业务 Data 分开，不兼容旧的扁平结构。`Sample.data.userPrompt` 必填且不能为空白，作为当前任务原样发送；其他 JSON 业务字段通过 `materializeInitialData().data` 完整交给 SP，只去除 Data 的平台 `dataId`，业务 `data.sampleId` 不覆盖、不删除。`initialSession` 和 `initialMaterials` 都可省略；提供时分别使用外部 `bundleId + sessionId`、`bundleId + materialId`，两个 ID 必须齐全，Runtime 不生成资源 ID。Session 正文不进入 Dataset、Sample、Sampling 或执行 prompt。SP 公开能力将素材与 Session 副本落入目标 DO 的存储，由所选框架加载并重建 Context；Runtime 等准备完成后才发送 `userPrompt`，不自己解析 Session、拼接消息或把扩展数据包成新 prompt。
18. 初始数据准备使用 `initial-data:<submissionId>` 的稳定幂等键；重复准备相同事实返回原结果，不能覆盖已经运行过的 Session。初始化发生可重试错误或响应丢失时，由 `RetryController` 的 `initialization` 决策决定是否重试完整准备流程，沿用同一目标 Agent、输入和幂等键，不重新创建或重启 Agent、不查询尚未提交的 Submission。不可重试错误立即失败，重试耗尽也不提交任务。不同 Sampling 使用不同目标 Agent 和幂等键；同一 Agent 自动重启沿用当前 Session，不重新加载初始 Session。SP 负责持久化初始化幂等，不增加 Runtime 准备状态表。
19. 评估 Agent 使用独立 Session，不把 Subject 的 `initialSession` 当作自己的初始会话。Subject 的产物和完整轨迹由 `materializeEvaluationInput()` 使用 `evaluation-input:<evaluationSubmissionId>` 的稳定幂等键复制到评估 Agent 的存储作为证据，不作为评估 Agent 的活动 Session 导入。复制响应丢失后重新准备仍使用同一份来源、目标和输入事实；SP 返回原成功结果或继续未完成的复制，对同一键的不同事实拒绝处理。评估初始化的所有准备步骤完成前不得提交评估任务。
20. 每次实际提交的 Attempt 在投递前持久化 `resources: pending`，其中包含目标 `submissionId` 和本次提交/重启的准确幂等键。终态或投递/等待失败后通过公开 `collectAgentResources()` 收集资源，并先保存到对应 Attempt，再收集产物、决定是否重启或发布阶段终态。失败、取消和重启前的费用/Token/工具/Turn 都保留；未提交任务的创建/初始化失败不假装产生资源事实。
21. 资源快照只包含本次操作及其子 Agent 的新工作，不包含导入历史或复制的 Subject 证据。`usageEvents`、`telemetryEvents`、`billingSettlements` 是 SP 原始 JSON 记录；未知字段、缺失字段、null、顺序、重复事件、父子关联与来源数值全部保留。Runtime 只校验归属和无损可序列化性，不解析费用/Token、不抽取工具/Turn、不归一化、不去重、不计算统计、不新增汇总字段。源 `coverage/finalized` 也原样保存，由 Metric 判断是否适合统计。
22. 资源读取单独使用 `resources` 重试预算，与产物收集和 Agent 重启无关。采集状态只有 `pending | collected | failed`；`collected` 表示快照已保存，不表示来源完整。读取失败不能覆盖原 Agent 错误或使成功产物变成失败。Store 将 Attempt 与原始资源快照原子保存；查询从持久化记录读取，Metrics 不直接访问 SP/DO/私有数据库，而是读取 Runtime 原始内容进行解析、去重和所有统计。完整轨迹和大产物继续存引用，资源事件不构成另一份 Workspace/Session 副本。
23. 后续 Attempt 状态补丁基于当前执行上下文的最新 Attempt，而不是调用方的旧副本；原始快照写入已提交但响应丢失时，失败处理不能用旧 `pending` 覆盖它。协调器兜底错误处理也读取 Store 中的最新评估记录再更新状态，不以启动时的 `queued` 副本重写整个记录。查询只读取持久化结果，不从执行上下文的内存副本返回数据。

Sampling 的三个边界固定如下：

- `SamplingState`：Store 长期持久化的 Sampling 事实；
- `RuntimeSamplingContext`：执行时临时拼接 `{ state, sample }`，不能持久化；
- `SamplingSnapshot`：`getSampling()` 对 API、Web 和 CLI 的稳定查询 DTO，与 Store 和运行时 Context 解耦。

轨迹通过 SP 正式接口完整获取，并无条件复制到评估 Agent 的 Workspace；本包不引入独立的轨迹树或线上流量评估子包。

## 暂不纳入本包

- 数据集持久化实现；
- 评估指标聚合实现；
- API、Web、CLI 应用；
- CC、Codex 等进程启动器；
- 第二套 SP Adapter 包。

后续非 SP Harness 接入若确有需要，再增加独立 Harness 实现，而不是改变本包的运行时控制面。
