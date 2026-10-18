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
- **每个 Run 一个任务**：队列 `policy: exclusive`，`singletonKey` 为 Run ID，同一 Run 同时只有一个排队或执行中的任务；Run 已有任务时，停止请求的投递被其吸收。`notify: true` 让 Worker 立即被唤醒。
- **失败与恢复**：任务心跳 60 秒，Worker 崩溃后 pg-boss 重新投递；单任务最长 24 小时。一轮处理后 Run 仍处于活动状态（例如证据收尾失败）时抛出 `RunStillActiveError`，按退避重试（10 秒起，最长 10 分钟，最多 100 次）；最后一次重试中处理失败或之后 Run 仍处于活动状态时，Worker 写入系统停止请求并走同一停止收尾流程（中断 SP、收集证据、取消未完成阶段、写 `stopFinalized`），Project 自动释放。恢复不是新的 Agent 重试策略：Runtime `resume(runId)` 先读取 Run，再读取 Project 计划并核对 Run 保存的计划摘要（不一致直接拒绝），按 Attempt 幂等键继续，已终结的 Agent 只补收证据；SP 状态校准暂不可用时已保存的失败 Attempt 保持待恢复。`RuntimeRecoveryStore` 只提供 `isRunActive`、`isRunStopRequested`、`requestRunStop`、`markRunStopFinalized`，Run 状态仍只由子记录推导，没有第二份 Run 状态。
- **多实例**：可以部署多个 Worker 实例并滚动升级；同一 Run 的互斥由 pg-boss exclusive 唯一索引和 `SKIP LOCKED` 取任务保证。`EVAL_RUN_WORKER_CONCURRENCY` 限制每个实例同时处理的 Run 数，各 Run 内仍按执行/评估计划分别限制 Agent 并发。关闭时停止取任务并等待进行中的 Run 结束。
- **剩余风险**：心跳中断超过 60 秒或单任务超过 24 小时时，pg-boss 可能把任务交给另一个实例，与原处理短暂重叠；Runtime 的条件写入（携带预期旧事实）和 SP 操作幂等键保证重叠不会覆盖事实或重复提交。若最后一次停止收尾本身仍失败（例如 SP 长时间不可达），Run 保留停止请求、Project 保持忙碌；用户再次发起停止请求会为该 Run 重新投递任务完成收尾。

**停止语义**（本文是唯一完整描述）：停止请求由用户范围内、指名当前未结束 Run ID 的幂等请求发起，停止该 Run 的全部目标，不支持局部停止；`GET .../runs/current` 供重新加载后找回该 ID。已请求停止的 Run 重复请求返回原结果；已结束且未请求停止的 Run 返回冲突，因此旧 Run ID 不会误停后续批次。已经结束的目标不回滚，未选中的结果不受影响。PostgreSQL 在准入使用的同一 Project 行锁下保存停止标志，并在同一事务内投递 Run 任务。Runtime 的 `withRunDispatchGate()` 端口用 Run 行锁把 SP Chat 创建、初始化和 Submission 投递的启动动作与停止标志排序，等待 SP 前释放行锁；停止提交后，新的阶段动作不能越过此门。已在途的准备可能完成本地工作，SP 在 Chat 停止锁存保存后持久拒绝迟到的初始化和 Submission。

Worker 执行 Run 时每秒读取一次停止标志；读到后中止 `resume`，并在其返回前反复通过 SP 公开服务路由中断该 Run 的活跃 Chat。随后 `stop(runId)` 校准已终结的 Submission 及其原始资源，保存可取得的 Subject 产物和完整轨迹，再把未完成阶段标记为取消，最后写入 `stopFinalized`。缺失 Chat 只在未保存 Submission ID 时视为未提交并取消；已有 Submission ID 则保留异常等待下一轮。停止请求不改变 Run 的请求身份或计划摘要。直到所有阶段终结且 `stopFinalized` 写入前，Project 准入保持关闭；这些标志是控制事实，不是第二份持久状态。Run 查询先显示 `stopRequested`，子阶段已终结但收尾未完成时显示 `retrying`，全部完成后显示 `cancelled`，包括最后一个 Submission 在中断到达前自然完成的情况。SP 请求默认最多等待 60 秒，停止调用最多 10 秒；超时后保留停止意图，由后续轮次继续收尾。

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
- Subject 执行成功后导出一份不可变、按内容寻址的证据包（产物 + `sp-trajectory/v1` 原始轨迹 轨迹），`Sampling.evidence` 保存其引用；
- 评估使用普通 Agent：独立 Evaluation Chat / Session 和自己的 Space，不绑定 Subject；每次评估产生独立 `EvaluationRecord`，证据导入自己 Space 的 `/evidence/`，结果写到 `/output/result.json`。

## SP Harness 对齐

Harness 只依赖以下正式边界：

SP Chat 是持久 Session：Sampling/EvaluationRecord 保存各自 Chat ID；每次 Prompt 提交在该 Chat 中创建一个 Submission，真实 Submission ID 由对应 Attempt 保存。自动重试沿用 Chat，而新提交拥有自己的 Submission 身份。

1. Agent Config 引用：`ownerUserId`、`userAgentId`；
2. Eval SP 的普通 Inbox/Chat 创建：Subject 和 Evaluator 都进入 **Eval SP 自己的** Inbox，不进入 dev/production 的 Inbox；Eval 预分配 Chat ID 并要求同 ID 幂等。Evaluator 创建时只携带 `evaluationId`；
3. 消息投递：`dispatchMessage(message, "enqueue" | "steer")`；
4. Submission 终态推送：Harness 接收可靠的完成/失败/取消通知；`SubmissionReceipt` 和按幂等键的操作查询只用于提交后的初始确认、断线恢复和重试前校准；
5. Trajectory：`TrajectoryPage`，按 `beforeSeq` 分页读取完整轨迹，单页不超过 `200`；
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

Subject 执行整体成功后，Runtime 经 `Harness.exportEvidence` 读取产物清单、逐个文件和 SP 完整原始 `trajectory_events` 的有序分片，按 `DEFAULT_EVIDENCE_LIMITS`（单文件 25 MB、总量 500 MB、20,000 个文件、排除 `node_modules` 等目录）写入证据包，未纳入的文件记入 `omitted`。导出与执行阶段共用 Runtime 固定的 10 次幂等重试；瞬态失败耗尽时保留已有产物和轨迹，Sampling 置为 `retrying + evidencePending`，由后续 Worker 只补收证据，不重复提交或重启 Agent；不可重试的最终化错误才置为 `failed`。评估准备时 `Harness.importEvidence` 以 `evidence:<evidenceId>:<evaluationId>` 为幂等键把证据包写入 Evaluator 自己的 Space，manifest 最后写入；同一 Sampling 的多次评估复用同一证据包。Eval 不绕过 SP 的公开边界操作 DO。

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

`eval-metrics` 从应用注入的一致事实快照（Project 计划、ProjectSample、当前 Sampling/EvaluationRecord、Run）聚合，层级固定为 Project → Dataset → ProjectSample → Sampling，来自 Project 快照而不是实时目录；未运行的 ProjectSample 照常出现，共享 ProjectSample 在 Project 汇总中按 Sampling/Evaluation 身份去重。Subject 与每个 Evaluator 分别给出 `AgentMetricView`（资源、Attempt、时长、轨迹）。轨迹指标来自 Attempt 已保存的 SP telemetry 事件：Turn 数、按工具的调用数/结果/输入与返回字节长度、按 `generation` operation 统计的模型 Step，以及命中 `thinking`/`signature` 或 `content` 标记的思考步骤/内容步骤和各自 Token；一个 Turn 可以包含多个 Step，一个 Step 可以同时命中两类，分类按各自命中的 Step 统计并允许重叠。评估结果按 Schema 声明的 number/integer、boolean、enum（含枚举数组元素）字段逐层汇总：数值字段给出数值统计，boolean/enum 给出按声明顺序的非 null 分布条目；Schema 允许 null 时另给独立的 `nullCount`，不进入分布与数值统计、不算 false 或任何枚举值，也不同于缺失。规则见 [eval-metrics README](../packages/eval-metrics/README.md)。没有评估计划时为 unavailable。

每个 Sampling 和 EvaluationRecord 在任何 Run 状态下都有只读观察入口：Eval API 校验 owner、Project 与当前 Sampling/Evaluation 身份后返回 `AgentObservationRef`（角色、Chat 所属用户、Chat ID、`not-started | available`），不向浏览器暴露可写 Chat URL。Context、Workspace 和 Trajectory 的读接口由 Eval SP 提供，交互式观察的只读权限由 SP 服务端执行。

## 接入真实环境前的剩余事项

1. 给 SP API、Agent、Space 配置 Eval 独立发布目标和持久资源；Eval 的全部 SP 地址指向这套部署，登录与 Agent Config 由 Eval SP 提供；
2. 在真实部署中联调证据导出与导入、Evaluator 结果文件收集、提交恢复、长连接终态、无人值守处理和原始资源读取；SP 仍需在服务端执行只读观察的访问控制，详见[接口需求](sp-eval-api-requirements.md)；
3. 把 `eval-api` 的 API、Run Worker、PostgreSQL 迁移和共享 Bundle 目录部署到目标环境；
4. SP 的公开 Agent 创建边界需支持 `framework` 选择和绑定，并实际提供 Codex/CC 云端运行；评估侧只传递选择，不重建这些启动器。
