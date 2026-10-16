# @eval-platform/eval-contracts

评估平台跨包共享的稳定契约层，公共契约从包根入口导入。`./http-errors` 是 Eval API 唯一的错误码目录（`defineErrorCatalog`），`./http` 是基于它的 Hono 响应器（`createHonoHttp`）；只有这两个 HTTP 边界子路径依赖 `@springbrand/http` 与 `hono`，包根不加载它们。HTTP 契约见 [Eval HTTP 控制面](../../docs/eval-http-api.md)。

负责 Project 与其固定计划（`src/project.ts`：`ProjectPlan`、`ExecutionPlan`、`EvaluationPlan`、`ProjectDatasetSnapshot`、`AgentConfigSnapshot`、`EvaluationOutputSchemaRef`）、Sampling、EvaluationRecord、Run 选择与目标、HarnessConfig、ExecutionOutput、EvaluationAgentOutput（评估产物、原始结构化输出、证据和完整轨迹）、AgentObservationRef、ArtifactRef、TrajectoryRef 和 EvidenceRef 等运行与评估类型边界。Subject 证据包契约位于 `src/evidence.ts`：`EvidenceBundleRef`（`Sampling.evidence`）、`EvidenceManifest`、`EvidenceArtifact`、`EvidenceOmission`、`TrajectoryEvent`（`sp-trajectory/v1` 原始轨迹）、`EvidenceLimits` 与 `DEFAULT_EVIDENCE_LIMITS`，以及 `EVIDENCE_ROOT`、`EVIDENCE_MANIFEST_PATH`、`EVIDENCE_ARTIFACTS_ROOT`、`EVIDENCE_TRAJECTORY_ROOT`、`EVALUATION_RESULT_PATH` 等路径常量；`EvidenceRef` 仍是评委输出中的证据引用，两者不同。证据和解释属于评估 Agent 输出，没有独立的归因契约。SP Chat 是持久 Session：`Sampling.subjectChatId` 和 `EvaluationRecord.chatId` 标识各自的 Chat，每个 Attempt 的 `submissionId` 标识该 Chat 内的一次提交。`AgentResourceCollection` 在投递前按 `chatId + idempotencyKey` 登记，采集成功后保留真实 `submissionId`，只表达 `pending | collected | failed` 的采集状态。Dataset/Data 由 `eval-dataset` 拥有，ProjectSample（Project 创建时的完整 Data 副本）由 `eval-runtime` 的运行时模型拥有；`Sampling.projectSampleId` 指向它。

JSON 值与标识符规则也只在这里定义：`jsonValueSchema`、`jsonObjectSchema`（有限数、安全整数、无环纯数据）和 `identifierSchema`、`isIdentifier`、`IDENTIFIER_RULE`（非空且无首尾空白）。

状态词表只在这里定义：`SAMPLING_STATUSES`、`PENDING_SAMPLING_STATUSES`、`AGENT_STATUSES`、`TERMINAL_AGENT_STATUSES` 及谓词 `isPendingSamplingStatus`、`isTerminalAgentStatus`，`SamplingStatus`、`AgentStatus` 由它们派生，SQL 使用同一常量。`AgentSubmission.status` 是 SP 归一化后的状态，SP 原始状态只在 Eval API 的 Harness 适配层映射一次。

资源契约位于 `src/resources.ts`，通过包根入口导出。`AgentResourceSnapshot` 原样承载 SP 的 `usageEvents`、`telemetryEvents`、`billingSettlements`，记录是开放的 JSON 对象，而不是 Eval 重新设计的费用/Token/工具/Turn 事实模型。来源字段、缺失字段、`null`、事件顺序、重复事件、子 Agent 明细与汇总全部保留；Runtime 不补零、不换算、不抽取、不合并、不去重、不计算总量。

`coverage` 分别保留来源对三组记录的 `complete | partial | unavailable` 声明，`finalized` 保留操作终结声明；`collected` 只表示读到了并保存了原始快照，不保证来源完整。初始化 Session 历史和导入的 Subject 证据不属于本次资源范围。失败、取消和重启的原始记录不能因最终结果失败而删除，历次主动重评也不能混入同一评估记录。Metric 读取这些原始内容，负责来源解析、去重、重叠用量处理、费用/Token/工具/Turn 统计及汇总。

一旦观察到 Agent 终态，Attempt 的状态及完成时间就固定为该 Agent 事实，`error` 保留原 Agent 错误；Runtime 资源持久化/产物收尾失败由执行或评估阶段的 `lastError` 表达，不把已经 `completed` 的 Attempt 改为 Agent 失败。保存重试复用同一份事实，不改变 Sampling/Evaluation/Attempt/Submission 身份。

Subject 的产物和完整轨迹是执行终态的必需证据。`Sampling.execution.evidencePending` 表示 Agent 已终结、证据尚未完整保存；此时执行保持非终态，恢复进程只补收证据，不再次提交或重启 Agent。证据与执行终态在同一次 Sampling 写入中保存；原 Agent 错误保留在 Attempt 和阶段错误中。

`RunOperation` 为 `execution | pipeline | evaluation`，由每次启动选择，不写入 Project。`RunPhase` 只有 `execution | evaluation`；`RunPhases` 由 operation 推导：只执行、只评估或顺序执行后评估。`RunSnapshot` 返回 `operation`、`phases`、`selector`、`targets`、`samplingIds`、`evaluationIds`，`phase` 和 `status` 从子记录推导。Pipeline 只负责组合两阶段，没有第三种阶段或独立的 Pipeline 数据模型。

`RunRequest` 只包含 `idempotencyKey`、`projectId`、`operation`、`selector` 和 `targets`，不携带任何配置 ID 或 Dataset/Data 内容。`RunTargetSelector` 是 `all`、`datasetIds`、`projectSampleIds`、`samplingIds` 的组合，只在 Project 快照内展开；`RunTargets` 是 preview 返回的固定、去重结果（`projectSampleIds` 与 `samplingIds`），提交和重试时原样带回。evaluation 的 `projectSampleIds` 为空，`samplingIds` 为要重新评估的成功 Sampling。

`RunSnapshot.stopRequested` 表示 Run 已请求停止；停止期间与收尾后的 Run 状态见[架构方案](../../docs/architecture.md#run-调度与停止)。

每次部署选定一个 SP 分支并独立发布整套 Eval SP。`Project` 只含元数据和该分支；Run 记录准入时该发布使用的 SP commit；Sampling 不存分支。

`ProjectPlan` 是一次一致读取的 Project 计划：`project`、按绑定顺序的 `datasets`（每个含创建时成员顺序的 `projectSampleIds`）、`execution` 与 `executionPlanDigest`，以及可空的 `evaluation: ProjectEvaluation`（`plan`、`digest`、`lockedAt` 只能一起存在）。`ExecutionPlan` 创建后不可修改，含 Subject `harness`、`subjectAgentConfig`、`executionConcurrency` 和 `retryPolicy`；`EvaluationPlan` 含 SP 框架的 `evaluationHarness`、`evaluatorAgentConfig`、`evaluationConcurrency`、`retryPolicy` 和 `outputSchema`（Schema ID 与规范 JSON 的 sha256），在首个 pipeline/evaluation Run 准入时锁定，锁定前可整体替换。Harness 中的 `agentConfig` 是 Project 的冻结副本引用，指向 Eval SP 自己的 `user-agent` 库；`AgentConfigSnapshot` 是冻结时的正文快照，只用于展示，运行从不用它重建配置。

评估输出格式是 Eval API 中独立上传的一份带名称和描述的 draft 2020-12 JSON Schema 文件，正文不可变。每个 Evaluator 初始化时通过专用字段在自己 Workspace 的固定路径 `/evaluation-output.schema.json` 收到 Schema，与素材目录分开。`EvaluationAgentOutput.structuredOutput` 是 Evaluator 写在自己 Space `/output/result.json` 的结果文件：路径、原始 UTF-8 文本和可选 hash，不是解析后的副本；缺失时由 Metrics 报告为 unavailable，不当作 0。

`AgentObservationRef` 是 Sampling（Subject）或 EvaluationRecord（Evaluator）的只读观察目标：角色、Project、Sampling、可选 Evaluation、Chat 所属用户、可选 Chat ID 和 `not-started | available`。它不包含可写 Chat URL。

`AgentFramework` 为 `sp | codex | cc`。`HarnessConfig.kind` 表示统一的 SP 云端宿主，必填的 `framework` 表示所运行的 Agent 框架；三种框架都引用 SP 管理的 Agent Config，复用同一 Chat/Submission/Workspace 边界。执行计划可选择三者，评估计划固定 SP 框架，不由本包实现进程启动或云端部署。

Subject 执行成功后导出一份不可变证据包：`manifest.json`（`schemaVersion: 1`、`evidenceId`、来源、`subjectInputs` 原始素材身份和文件信息、`artifacts` 产物信息、`trajectory` 有序分片及完整性、`omitted`）加按 sha256 存一次的文件。轨迹分片记录 size、sha256 和事件数，保留每行原始 `{ingestSeq,event}`，不生成第二套轨迹格式。`evidenceId` 是去掉自身字段后规范 manifest 的 `sha256:<hex>`。`Sampling.evidence` 是 `{evidenceId, manifestSha256, exportedAt}`，`Sampling.trajectory` 指向 `evidence:<evidenceId>/trajectory/`，内容摘要使用 manifest hash。产物超出 `DEFAULT_EVIDENCE_LIMITS` 的记录进入 `omitted`；完整轨迹按事件边界分片，单事件超过文件上限则明确失败，不截断。完整接口约束见[包边界](../../docs/package-boundaries.md#evidence-export-and-import)。

原始 `structuredOutput` 是评估输出的唯一事实。可选 Langfuse 分数由 Metrics 同一 Schema reader 派生，不在 `EvaluationAgentOutput` 再保存 `score` 或 `reason`。`scoreSync` 只记录外部投递结果。

每个 Evaluator 是普通 Agent，拥有独立 Chat、Submission、轨迹和自己的 Space，不绑定 Subject。证据包导入到 `/evidence/`（`manifest.json`、`artifacts/<原路径>`、`trajectory/events-000001.jsonl` 等有序分片），结果写到 `/output/result.json`。

本包不负责运行 Agent、读取 SP Workspace、访问 R2、持久化数据库或实现 API/Web/CLI。
