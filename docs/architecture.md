# eval-platform 架构方案

## 目标

`eval-platform` 是独立项目，负责把数据和 Agent Harness 解耦，并围绕 Agent 产物完成评估。SP 只是第一方 Harness，不是评估平台的父项目。

## 已确定的部署模式

Eval 的一次发布流程从固定的 SP Git 分支解析出 commit，独立发布一套 Eval SP：SP API 及其数据库、Agent Worker、Space Worker、专用 DO 命名空间和 R2。Eval SP Agent 的 `API_ORIGIN` 指向 Eval SP API；Eval 的登录、Agent Config、Chat、Submission、Workspace、轨迹、计费和 Action 接入也全部指向 Eval SP，不依赖 dev/production SP 服务。Eval API、Run Worker、Web 随同一发布流程上线。完整数据归属与发布约束见 [Eval 独立 SP 部署方案](eval-sp-deployment.md)。

Agent Config 存在 Eval SP 自己的 `user-agent` 库，但只在 Eval 内通过 `/api/agent-configs` 增删改查；Eval SP 只是承载层，Eval 不另建配置库，也不在线读取 dev/production 的配置。`eval_agent_config_purposes` 是用途（`execution`/`evaluation`）的唯一事实源；缺失记录只在首次选项读取时通过 SP 公共 MCP 目录一次性 reconciliation，目录不可用、canonical 评估结果 MCP 歧义或已选 MCP 不可用时返回 `AGENT_CONFIG_PURPOSE_UNAVAILABLE`（503），不产生 unknown 选项。用途可在编辑时切换，服务端同步评估结果 MCP；Project 的用途筛选、创建、更新与冻结都复用当前记录。Project 引用的是创建 Project 或保存评估计划时在 Eval SP 生成的冻结副本，副本不出现在 Agent Config 列表中，也不能被编辑或删除。Git 分支绑定 Project；固定分支阶段只能选择已部署的分支。Run 记录实际 SP commit 作为代码来源，Sampling 不存分支；更新 SP 代码不重建 Eval SP 数据库或 Eval PostgreSQL。

## 第一阶段包边界

包边界保持四个 workspace：契约、来源目录、运行编排和结果统计各占一个：

```text
packages/
├── eval-contracts/
├── eval-dataset/
├── eval-runtime/
└── eval-metrics/

apps/
├── eval-api/
├── eval-web/
└── eval-cli/

deploy/  # 计划增加：固定 SP 源码与编排 Eval 发布；不是 workspace 包
```

四个顶层包内部再按职责提供子模块：

```text
eval-dataset: dataset/
eval-runtime: plan/ harness/ runtime/
eval-metrics: evaluators/ aggregation/ reporting/
```

`@eval-platform/eval-runtime` 拥有评估流程的控制面和 SP Harness 边界，但不复制 SP Runtime 的执行内核。`HarnessConfig.kind: "sp"` 表示统一云端宿主，必填的 `framework: "sp" | "codex" | "cc"` 表示执行框架；三者复用同一套 Chat/Submission/Workspace 生命周期，不在 eval 内创建 CLI 或进程启动器。执行计划选择 Subject 框架和冻结的 Subject Agent Config 副本；评估计划固定 SP 框架并选择冻结的 Evaluator 副本。框架进入执行计划摘要、请求幂等指纹和 Agent 创建事实，SP 实际的 Codex/CC 云端部署由 SP 负责。

## Project 计划

Project 由两部分组成，设计记录见 [Project、Runtime 与 Metrics 设计](eval-project-redesign.md)：

- **执行计划**在创建事务中确定，之后没有任何修改入口：元数据、source branch、绑定的 Dataset 快照（名称、描述、kind、创建时成员顺序）、ProjectSample、Subject Harness（框架、冻结副本引用、超时）、`executionConcurrency`、`retryPolicy` 和 Subject Agent Config 正文快照（仅展示）。`executionPlanDigest` 覆盖执行计划、Dataset 绑定和全部 ProjectSample。
- **评估计划**可在创建时填写，也可之后补填；未锁定时只有一份当前值，可通过 `PUT /api/projects/:id/evaluation-plan` 整体替换（重新保存会生成新 Evaluator 副本并删除旧副本）。内容是 Evaluator Harness、`evaluationConcurrency`、`retryPolicy`、评估输出 JSON Schema 的 ID 与内容摘要和 Evaluator 正文快照。读取时是一个 `ProjectEvaluation`（`plan`、`digest`、`lockedAt`），未填写时整体为 null。首个 pipeline/evaluation Run 在准入事务内写入 `lockedAt`，之后 Run 停止或失败也不解锁，替换返回冲突。

`retryPolicy` 的 Project 请求只配置 `maxRestarts`，控制确认失败后的 Agent 重启；计划仍保存 `initialBackoffMs` 和 `maxBackoffMs`，但由 Runtime 写入固定的 250ms 和 10s。创建、初始化、提交校准、状态读取、产物/证据、资源读取、持久化和停止调用等幂等瞬态操作由 Runtime 固定重试 10 次，不提供单独配置。

ProjectSample 是 Project 自己的固定输入：来源 Data 的完整副本、所属 Dataset ID 列表（按绑定顺序）和 `samplingCount`。同一 Data 被多个所选 Dataset 绑定时只生成一个 ProjectSample。Material/Session/Schema 只保存引用：正文不可变，软删除只让它们退出目录，已有 Project 仍按 ID 读取。来源 Dataset/Data 之后被修改、解除关联或软删除，以及原 Agent Config 被修改，都不影响已有 Project。

`eval-runtime/plan` 是计划校验、归一化和摘要的唯一入口。Runtime 只通过只读 `ProjectPlanReader` 和 `RuntimeStore` 读取输入，不读取实时 Dataset/Data、可编辑 Agent Config 或任何配置表；Run 不保存配置正文。

以下包明确不单独创建：

- `eval-config`：Project 计划的校验与摘要属于 `eval-runtime/plan` 子模块；
- `eval-evaluators`：评估器属于 `eval-metrics/evaluators` 子模块；
- `eval-sp-adapter`：SP 边界直接属于 runtime 的 Harness seam；
- `eval-process-adapter`：CC、Codex 等未来统一经过 Cloudflare Agent，不提前引入进程层；
- `eval-storage`：Agent 项目素材由对应 Harness 的 Workspace 持有，评估运行记录由 `eval-api` 的 PostgreSQL 适配器持久化，不单独拆包；
- `eval-agent-tools`：评估 Agent 工具属于 SP Agent Config 和 Runtime 能力，不在评估包内重建；
- 独立轨迹树或线上流量评估包：轨迹从 SP 正式接口获取，线上评估不属于当前核心范围。

`eval-contracts` 只定义评估域的稳定契约，不复制 SP 的 Agent、Submission 或 Trajectory 内部实现；SP 公共契约在 Harness 边界消费。`eval-metrics` 负责已有评估结果整理、资源统计、聚合和四层查询。证据与解释由评估 Agent 输出，不引入独立归因流程。

## Run 准入与独立评估

**准入、幂等键与替换规则**（本节是唯一完整描述）：每次启动选择本次操作 `execution`、`pipeline` 或 `evaluation`；操作属于 Run，不写回 Project。创建 Project 时先提交 Project，再在独立事务中准入首个 Run，只能是 execution 或 pipeline；新 Project 没有成功 Sampling，不能以仅评估开始。首个 Run 准入失败时的补偿见 [Project 创建](eval-project-redesign.md#31-创建)。

准入分两步，都由 `EvalRunAdmission` 完成：

1. `preview({projectId, operation, selector})` 在 Project 快照内展开选择器（`all`、`datasetIds`、`projectSampleIds`、`samplingIds` 的组合），返回去重、顺序稳定的固定 `targets`（展开为空时拒绝）、将替换/新建的 Sampling 数、将创建的评估数和计划摘要。`all`/Dataset 按 Dataset 绑定顺序和成员顺序展开为 ProjectSample。execution/pipeline 中，ProjectSample 目标替换其当前全部 Sampling 并按 `samplingCount` 新建（从未运行过的同样新建），Sampling 目标一对一替换，其 ProjectSample 已被整条选中时被吸收。evaluation 中，ProjectSample 展开为其当前执行成功的 Sampling（过滤其他状态），显式指定的 Sampling 必须执行成功。
2. `submit({idempotencyKey, projectId, operation, selector, targets})` 以 preview 返回的 `targets` 为准校验，不重新展开；重试沿用同一 `targets` 和 key。

请求指纹覆盖 `projectId`、operation、selector、targets 和计划摘要（执行计划摘要，pipeline/evaluation 另含评估计划摘要）。`RuntimeStore.admitRun()` 在 Project 行锁下的一个事务内完成：拒绝缺失或软删除的 Project 和 source release 不符；同 key 同指纹重放原 Run（即使仍在运行），不同指纹或已被后续 Run 取代的 key（以 Project 内递增的 `sequence` 判定）返回冲突；Project 创建 key 只能准入 Project 的第一个 Run，Project 已有任何 Run 时返回 `creation-superseded`（创建重放据此返回 `run: null`）；新 key 遇到未完成 Run 返回 `RuntimeProjectBusyError`；复核计划摘要，pipeline/evaluation 要求评估计划已填写（否则 `evaluation-plan-required`）；复核被替换的 Sampling 仍等于目标的当前 Sampling（否则 `stale-targets`），evaluation 复核目标仍执行成功；然后按批删除与插入，首个带评估的 Run 锁定评估计划，并在同一事务内投递 Worker 任务。PostgreSQL 的 `(project_id, idempotency_key)` 唯一约束保证同一意图只创建一批；同一 Runtime 实例内相同 Project/key 的并发提交先在内存合并，但内存不是权威状态。

| 操作 | 选中执行 | 选中评估 | 未选中执行与评估 |
| --- | --- | --- | --- |
| execution | 删除旧 Sampling（含 Run 关联），新建 Sampling | 随旧 Sampling 删除，新 Sampling 没有评估 | 原样保留 |
| pipeline | 同上；新 Sampling 执行成功后各自评估 | 随旧 Sampling 删除 | 原样保留 |
| evaluation | 完全保留 Sampling、Chat、Attempt、产物、轨迹和资源 | 删除选中 Sampling 的当前评估，新建 EvaluationRecord | 原样保留 |

Project 只保留当前结果集合，它不等于最近 Run 的成员；全 Project 重跑就是选中全部目标。准入失败时旧结果不变；新 Run 停止后不恢复已完成的替换。Run 保存 operation、phases、selector、targets、`samplingIds`、`evaluationIds`、`planDigests`、Project 内递增的序号、source commit、请求身份和停止标记，不保存配置正文；Run 行从不删除，作为来源记录保留，其被后续 Run 替换的 Sampling/EvaluationRecord 从关联中移除；Run 状态从子记录推导，没有第二份可变状态。同一 Project 同时最多一个未结束 Run：任一 Sampling 或 EvaluationRecord 处于 `queued`、`starting`、`running` 或 `retrying`，或停止尚未收尾。Web 可以禁用启动按钮作反馈，但并发边界是 Store。HTTP 契约见 [Eval HTTP 控制面](eval-http-api.md)。

**有意保留的语义**：每个 Sampling 只有一条当前 EvaluationRecord，重跑评估即替换，不保留多份评估或评估历史；评估计划在首个 pipeline/evaluation Run 锁定后不再变更，也不做版本化。调整评估标准或输出 Schema 需要新建 Project 并重新执行；评估者一致性、人工校准等评估可信度分析当前尚未提供，后续补充时也不改变上述模型。

## Run 调度与停止

**决策：Run Worker 使用 pg-boss 队列调度。** SP 的 `apps/api` 已用 pg-boss 处理后台任务，Eval 使用同一库与版本（`apps/eval-api/src/run-worker-queue.ts`），不手写调度协议。

- **事务内投递**：Run 准入和停止请求在写入 Run 事实的同一个数据库事务中，通过 `fromDrizzle(transaction)` 向 `eval-runs` 队列投递 `{runId}` 任务；事务回滚则没有任务，提交后不存在“有 Run 无任务”的窗口。API 进程只以生产者身份连接 pg-boss（不做维护），Worker 负责消费与维护；pg-boss 在同一 PostgreSQL 中自建 `pgboss` schema。
- **每个唤醒键一个任务**：队列 `policy: exclusive`，普通任务的 `singletonKey` 为 Run ID；补采唤醒使用 `collection:{runId}`，避免等待普通任务的重试退避；资源检查定时唤醒使用 `resources:{runId}`，不阻塞即时请求。同一个键同时只有一个排队或执行中的任务，同一 Run 的不同唤醒可能重叠。`notify: true` 让 Worker 立即被唤醒。
- **原子收尾**：应用层的 `RunRecoveryStore.settleRunJob(runId, jobId)` 与结果接受、补采、停止和准入使用同一 Project 行锁，在取得锁后重新读取待办；没有工作则在同一事务内完成当前任务，只有未来资源检查则完成并安排延迟唤醒，仍有工作则保留当前任务供重试。所有成功退出都经过此入口，包括首次查询认为 Run 已空闲的路径；pg-boss 随后的自动确认只重复确认同一个旧任务 ID。新待办要么先提交并被收尾看见，要么等待收尾提交后重新入队，正确性不依赖为不同入口增加去重键。行锁内只有数据库操作，不调用 SP。
- **失败与恢复**：任务心跳 60 秒，Worker 崩溃后 pg-boss 重新投递；单任务最长 24 小时。一轮处理后 Run 只在等待资源 readiness 检查（无待处理成员、未请求停止、最早 `nextAttemptAt` 仍在未来）时，原子收尾入口按该时间安排延迟任务，空闲等待不消耗重试次数；其他仍处于活动状态的情况（例如证据收尾失败、检查已过期未推进）抛出 `RunStillActiveError`，按退避重试（10 秒起，最长 10 分钟，最多 100 次）；最后一次重试中处理失败或之后 Run 仍有待处理工作时，Worker 写入系统停止请求并走同一停止收尾流程（中断 SP、终结未完成阶段、写 `stopFinalized`），Project 自动释放。停止待收尾的 Run 不延迟、不 `resume`，同一轮内完成收尾。恢复不是新的 Agent 重试策略：Runtime `resume(runId)` 先读取 Run，再读取 Project 计划并核对 Run 保存的计划摘要（不一致直接拒绝），按 Attempt 幂等键继续，已终结的 Agent 只补收证据；SP 状态校准暂不可用时已保存的失败 Attempt 保持待恢复。共享包的 `RuntimeRecoveryStore` 仍只提供 `isRunActive`、`isRunStopPending`、`requestRunStop`、`markRunStopFinalized`；应用层的任务收尾不进入共享包，Run 状态仍只由子记录推导，没有第二份 Run 状态。
- **多实例**：可以部署多个 Worker 实例并滚动升级；pg-boss exclusive 唯一索引和 `SKIP LOCKED` 保证每个唤醒键的任务领取互斥，Project 行锁协调同一 Run 的收尾与新请求，Runtime 条件写入和 SP 操作幂等键处理重叠唤醒。`EVAL_RUN_WORKER_CONCURRENCY` 限制每个实例同时处理的 Run 数，各 Run 内仍按执行/评估计划分别限制 Agent 并发。关闭时停止取任务并等待进行中的 Run 结束。
- **剩余风险**：心跳中断超过 60 秒或单任务超过 24 小时时，pg-boss 可能把任务交给另一个实例，与原处理短暂重叠；Runtime 的条件写入（携带预期旧事实）和 SP 操作幂等键保证重叠不会覆盖事实或重复提交。若最后一次停止收尾本身仍失败（例如 SP 长时间不可达），Run 保留停止请求、Project 保持忙碌；用户再次发起停止请求会为该 Run 重新投递任务完成收尾。

**停止语义**（本文是唯一完整描述）：停止请求由用户范围内、指名当前未结束 Run ID 的幂等请求发起，停止该 Run 的全部目标，不支持局部停止；`GET .../runs/current` 供重新加载后找回该 ID。已请求停止的 Run 重复请求返回原结果；已结束且未请求停止的 Run 返回冲突，因此旧 Run ID 不会误停后续批次。已经结束的目标不回滚，未选中的结果不受影响。PostgreSQL 在准入使用的同一 Project 行锁下保存停止标志，并在同一事务内投递 Run 任务。Runtime 的 `withRunDispatchGate()` 端口用 Run 行锁把 SP Chat 创建、初始化和 Submission 投递的启动动作与停止标志排序，等待 SP 前释放行锁；停止提交后，新的阶段动作不能越过此门。已在途的准备可能完成本地工作，SP 在 Chat 停止锁存保存后持久拒绝迟到的初始化和 Submission。

Worker 执行 Run 时每秒读取一次待收尾的停止；读到后中止 `resume`，并在其返回前反复通过 SP 公开服务路由中断该 Run 中可能仍在运行（最后 Attempt 尚无终态）的 Chat。随后 `stop(runId, reporter)` 在同一轮内把每个待处理阶段确定地终结，不重新运行 Agent、不导出证据、不等待资源 readiness，并保留已保存的 Attempt、资源、产物、轨迹引用、输出和 `evidenceExport` 进度：尚无终态的 Attempt 先按原键校准一次，已终结的只记录终态并收集输出；已终结 Agent 的产物/轨迹或评估输出缺失时尽力收集一次（固定幂等重试），失败只写入错误。停止收尾从不读取资源：仍欠资源且没有已采集快照的已结束 Attempt 记为 `resources: failed`（`Run stopped before resources were collected`），已采集快照原样保留，并清除 `resourcesPending`。

资源快照原文（全部 usage/telemetry/billing 事件，含完整 prompt 与工具输入输出）只存一份，在阶段记录之外（Eval API 的 `eval_attempt_resources`），与标记 `collected` 的阶段写入在同一事务中提交（`updateSampling`/`updateEvaluation` 的 `resources` 参数），条件写冲突时两者都不落库，快照与摘要不会分叉；阶段事实只保存资源状态与摘要（scope、observedAt、finalized、coverage、事件数）、下载计数和是否已放弃，所以调度、状态、停止、汇总和每次阶段写入都不读写快照正文，阶段写入以记录的 `revision` 做条件写。

生命周期与结束后刷新共用 `collectResources()` 编排预算、readiness、下载和放弃通知：先检查已存下载次数，预算耗尽就保存 `exhausted` 并清除资源等待，不再请求 SP。取得进程共享的下载名额后、发请求前，把该 Attempt 的下载计数加一并保存，进程在下载中崩溃也计入同一个 `resources` 重试预算；排队取消不消耗次数。名额持续持有到真实请求、正文读取及快照原子保存结束，计数保存的 CAS 重试也在名额内；readiness 等待和下载退避在名额外。停止通过 `CollectAgentResourcesInput.signal` 取消底层请求与正文，不能只结束上层等待后提前释放名额。排队和退避也可取消，已停止的排队任务不启动下载。快照原地校验、不复制。

已接受 MCP 结果但尚未确认终态的 Evaluator，在同一资源流程的预算准入后先校准 receipt，确认终态后立即用既有 CAS 重试保存状态和固定完成时间，再处理资源。终态写入失败保留持久化等待入口，Worker 恢复后可继续；已有 finalized 快照只补终态，不重新请求 readiness 或下载。预算耗尽不执行此准备步骤，也不读取 receipt。

重试期间 `failed` 的 `error` 随每次失败更新；预算用尽时该 Attempt 记为 `failed`（已有快照保留为 `collected`，下载计数保留）并标记 `exhausted`，不再欠资源，阶段状态不变、`resourcesPending` 清除，Run 可以结束。统一采集流程在保存放弃状态后尽力通过 `onError` 报告一次，后续恢复不重复报告；通知不属于持久化事务，保存后立即崩溃仍可能漏报。手动资源补采清除 `downloads`/`exhausted`，重新给完整预算。刷新轮次在到期后出错同样结束等待。原始快照可经 `GET /api/projects/{projectId}/{samplings|evaluations}/{id}/attempts/{attemptId}/resource-snapshot` 按 Attempt 下载，见 [Eval HTTP API](eval-http-api.md)。

停止收尾时，最后 Attempt 为 `completed` 的阶段写为 `failed`（`Run stopped before evidence export finished` 或 `... output collection finished`，附上次错误），可用手动补收续传；其他待处理阶段写为 `cancelled`（`Run stopped`；状态无法校准时为 `Run stopped before its status was confirmed: ...`），Pipeline 中尚未开始的评估一并取消；最后写入 `stopFinalized`。缺失 Chat 只在未保存 Submission ID 时视为未提交并取消；已有 Submission ID 则保留异常等待下一轮。Worker 记录 `run_stop_finalizing`（按 `<阶段>.<状态>[.<待处理标记>]` 计数）、每个被终结阶段的 `run_stage_stopped`（仅 ID、状态与原因）和 `run_stop_finalized`。停止收尾后，已终结 Agent 的输出和停止时记为失败的资源仍可手动补收：补收让 Run 重新活跃但不重开停止，Worker 照常 `resume`；输出补收不读取资源、不开始资源等待，资源补采按普通刷新轮次读取；此时再次请求停止会重开停止并重新收尾。停止请求不改变 Run 的请求身份或计划摘要。直到所有阶段终结且 `stopFinalized` 写入前，Project 准入保持关闭；这些标志是控制事实，不是第二份持久状态。Run 查询先显示 `stopRequested`，子阶段已终结但收尾未完成时显示 `retrying`，全部完成后显示 `cancelled`，包括最后一个 Submission 在中断到达前自然完成的情况。SP 请求默认最多等待 60 秒，停止调用最多 10 秒；超时后保留停止意图，由后续轮次继续收尾。

## 核心实体

```text
Project ──> 执行计划 / 评估计划 / Dataset 快照 ──> ProjectSample ──> Sampling ──> Subject Chat / execution attempts
                                                                   Sampling ──> EvaluationRecord ──> Evaluator Chat / evaluation attempts
Project ──> Run ──(本次处理的 Sampling / EvaluationRecord)
Dataset ──> Data ──(创建 Project 时复制)──> ProjectSample
```

- `Project` 属于用户并绑定 SP Git 分支；当前固定分支阶段仅能绑定已部署分支，Run 记录实际 commit。Project 删除是软删除，存在未完成 Run 或停止收尾时拒绝；
- `Dataset` 属于一个 Eval SP 用户；同一用户的 Data 可在多个 Dataset 间复用，Dataset/Data 是可编辑的来源目录；
- `Data.userPrompt` 是必填的当前任务，其余 JSON 业务字段自由提供并完整保留；单个 `initialSession` 引用与 `initialMaterials`、`evalInitialMaterials` 两个有序素材引用数组都可选（规则见[包边界](package-boundaries.md#eval-dataset)），引用内的 Bundle ID 和资源 ID 必须由外部提供；
- `initialSession` 只引用独立保存的初始化 Session，启动时由 Harness 复制到目标 DO 并交给所选框架加载、重建 Context；准备完成后发送原始 `userPrompt`；
- `ProjectSample` 是 Project 内固定的一条测试输入，结构见[包边界](package-boundaries.md#eval-runtime)；
- `Sampling` 是一次独立运行，引用自己的 `projectSampleId`，拥有自己的 Subject Chat / Workspace；
- `Run` 是一次提交的工作范围，只包含本次实际处理的 Sampling/EvaluationRecord；Project 当前结果集合不等于最近 Run 的成员；
- Subject 执行成功后导出一份不可变、按内容寻址的证据包（产物为主 + 原样 `sp-pi-trajectory/v1` native JSONL 为辅助），新 manifest 为 schemaVersion 2，`Sampling.evidence` 保存其引用；旧版本字节、引用和评分不改写；
- 评估使用普通 Agent：独立 Evaluation Chat / Session 和自己的 Space，不绑定 Subject；每次评估产生独立 `EvaluationRecord`，证据导入自己 Space 的 `/evidence/`，结果写到 `/output/result.json`。

## SP Harness 对齐

Harness 只依赖以下正式边界：

SP Chat 是持久 Session：Sampling/EvaluationRecord 保存各自 Chat ID；每次 Prompt 提交在该 Chat 中创建一个 Submission，真实 Submission ID 由对应 Attempt 保存。自动重试沿用 Chat，而新提交拥有自己的 Submission 身份。

1. Agent Config 引用：`ownerUserId`、`userAgentId`；
2. Eval SP 的普通 Inbox/Chat 创建：Subject 和 Evaluator 都进入 **Eval SP 自己的** Inbox，不进入 dev/production 的 Inbox；Eval 预分配 Chat ID 并要求同 ID 幂等。Evaluator 创建时只携带 `evaluationId`；
3. 消息投递：`dispatchMessage(message, "enqueue" | "steer")`；
4. Submission 终态推送：Harness 接收可靠的完成/失败/取消通知；`SubmissionReceipt` 和按幂等键的操作查询只用于提交后的初始确认、断线恢复和重试前校准；
5. Trajectory：公开 `sp-pi-trajectory/v1` 页按 `afterSeq`、固定 `throughSeq` 分页读取完整 native 轨迹，每页不超过 `200` 条且 Eval 限制 JSON 为 4,000,000 字节；
6. Workspace：tree、manifest 和 content 的正式接口。

评估输入准备流程是：

```text
Subject Space ──exportEvidence（产物 + 轨迹）──→ 证据包（R2 或本地 evidence/）
                                                   │ 按 sha256 去重、manifest 固化
                                                   ↓ importEvidence
                                        Evaluator 自己的 Space
                                          /evidence/manifest.json
                                          /evidence/subject-inputs/…
                                          /evidence/artifacts/…
                                          /evidence/trajectory/events-000001.jsonl, …
                                          /output/result.json ← 评估结果
```

Subject 执行整体成功后，Runtime 经 `Harness.exportEvidence` 读取产物清单、逐个文件及 SP 公开 native 页 `{format:"sp-pi-trajectory/v1",cursor:{throughSeq},records:[{ingestSeq,record}],nextAfterSeq}`；`throughSeq` 随进度保存以防续传混入新记录。按 `DEFAULT_EVIDENCE_LIMITS`（单文件 95 MB、全部产物/原始输入/轨迹 500 MB、20,000 个文件、排除 `node_modules` 等目录）写入证据包，未纳入的**产物**记入 `omitted`；超出单文件或总证据限制的 native 记录明确失败，不截断/省略。导出与执行阶段共用固定的幂等重试；瞬态耗尽保留已有产物与 native 轨迹进度，由后续 Worker 只补收，不重复运行 Agent；不可重试错误使该阶段失败。Evaluator 用 `evidence:<evidenceId>:<evaluationId>` 幂等键把证据包导入自己的 Space，manifest 最后写入；同一 Sampling 可复用同一新证据包。Eval 不绕过 SP 公开接口操作 DO。SP 新 package 发布和端到端字节/指标 parity 是上线前置条件，详见 [cutover gate](pi-native-eval-cutover.md)。

## 生命周期语义

- `EvalRunAdmission.submit()` 只原子提交对应 Run 和关联记录，随后返回；
- Run Worker 按 pg-boss 任务调用 `resume(runId)`，调度与停止见上文；`pipeline` 只编排执行和评估，不是第三种阶段。执行和评估使用彼此独立的并发队列：某条 Sampling 的执行及证据保存成功后立即提交对应评估，其他 Sampling 可以继续执行；执行失败或取消的 Sampling 不提交 Evaluator，其 EvaluationRecord 取消，成功的 Sampling 照常评估；
- evaluation Run 不改动 Subject 的 Attempt、资源、产物、轨迹和状态；
- 恢复读取 Project 计划并核对计划摘要，按 Attempt 幂等键继续，Agent 已完成时只补收集与保存；
- ProjectSample 的 `samplingCount` 决定整条重跑时新建的 Sampling 数；
- `executionConcurrency` 是执行阶段同时启动的最大 DO 数量，一个 Subject Agent 对应一个 DO；
- `evaluationConcurrency` 是评估阶段同时启动的最大 DO 数量，一个 Evaluation Agent 对应一个 DO；
- 正常完成路径由 Submission 终态推送驱动；
- 推送丢失、连接断开或运行时恢复时，有限次调用 `getSubmission()` 做校准；
- 网络、LLM、网站等临时故障先查询原 Submission，再决定是否重启同一个 Chat / Workspace；
- 手动取消、鉴权失败、配置错误不自动重启；
- 每次执行和评估都完整收集对应 Agent 的产物与轨迹；Subject 证据导出为不可变证据包后导入 Evaluator 自己的 Space，评估不读取 Subject Workspace；没有证据包的 Sampling不能评估；结果评估以产物为主，轨迹作为补充证据；
- Evaluator 输出中的 `structuredOutput` 是 Evaluator 写入自己 Space `/output/result.json` 的原始结果文件文本，Runtime 原样保存；`eval-metrics` 读取时按评估计划锁定的 Schema 校验并抽取可统计字段。

## Metrics 与只读观察

`eval-metrics` 从应用注入的一致事实快照（Project 计划、ProjectSample、当前 Sampling/EvaluationRecord、Run）聚合，层级固定为 Project → Dataset → ProjectSample → Sampling，来自 Project 快照而不是实时目录；未运行的 ProjectSample 照常出现，共享 ProjectSample 在 Project 汇总中按 Sampling/Evaluation 身份去重。Subject 与每个 Evaluator 分别给出 `AgentMetricView`（资源、Attempt、时长、轨迹）。新轨迹指标只来自 Attempt 已保存的 safe Pi `nativeRecords`：Turn、原生 Tool ID 的调用数/结果/输入与返回字节长度、以 native request ID 为模型 Step，以及 Pi assistant `thinking`/`signature` 与 `text` 块标记的两类 Step/Token。一个 Turn 可包含多个 Step，一个 Step 可重叠两类；缺失或脱敏的消息/请求事实不填零。费用和总 Token 仍以独立 `usageEvents`/`billingSettlements` 为权威来源。评估结果按锁定 Schema 声明的 number/integer、boolean、enum（含枚举数组元素）字段逐层汇总：数值字段给出数值统计，boolean/enum 给出按声明顺序的非 null 分布条目；Schema 允许 null 时另给独立 `nullCount`，不进入分布与数值统计、不算 false 或任何枚举值，也不同于缺失。规则见 [eval-metrics README](../packages/eval-metrics/README.md)。没有评估计划时为 unavailable。

每个 Sampling 和 EvaluationRecord 在任何 Run 状态下都有只读观察入口：Eval API 校验 owner、Project 与当前 Sampling/Evaluation 身份后返回 `AgentObservationRef`（角色、Chat 所属用户、Chat ID、`not-started | available`），不向浏览器暴露可写 Chat URL。Context、Workspace 和 Trajectory 的读接口由 Eval SP 提供，交互式观察的只读权限由 SP 服务端执行。

## 接入真实环境前的剩余事项

1. 给 SP API、Agent、Space 配置 Eval 独立发布目标和持久资源；Eval 的全部 SP 地址指向这套部署，登录与 Agent Config 由 Eval SP 提供；
2. 在真实部署中联调证据导出与导入、Evaluator 结果文件收集、提交恢复、长连接终态、无人值守处理和原始资源读取；SP 仍需在服务端执行只读观察的访问控制，详见[接口需求](sp-eval-api-requirements.md)；
3. 把 `eval-api` 的 API、Run Worker、PostgreSQL 迁移和共享 Bundle 目录部署到目标环境；
4. SP 的公开 Agent 创建边界需支持 `framework` 选择和绑定，并实际提供 Codex/CC 云端运行；评估侧只传递选择，不重建这些启动器。
