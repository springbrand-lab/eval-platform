# @eval-platform/eval-contracts

评估平台跨包共享的稳定契约层，公共契约从包根入口导入。`./http-errors` 是 Eval API 唯一的错误码目录（`defineErrorCatalog`），`./http` 是基于它的 Hono 响应器（`createHonoHttp`）；只有这两个 HTTP 边界子路径依赖 `@springbrand/http` 与 `hono`，包根不加载它们。HTTP 契约见 [Eval HTTP 控制面](../../docs/eval-http-api.md)。

负责 Project、Sampling、EvaluationRecord、HarnessConfig、ExecutionOutput、EvaluationAgentOutput（评估产物、分数、证据和完整轨迹）、ArtifactRef、TrajectoryRef 和 EvidenceRef 等运行与评估类型边界。证据和解释属于评估 Agent 输出，没有独立的归因契约。SP Chat 是持久 Session：`Sampling.subjectChatId` 和 `EvaluationRecord.chatId` 标识各自的 Chat，每个 Attempt 的 `submissionId` 标识该 Chat 内的一次提交。`AgentResourceCollection` 在投递前按 `chatId + idempotencyKey` 登记，采集成功后保留真实 `submissionId`，只表达 `pending | collected | failed` 的采集状态。Dataset/Data 由 `eval-dataset` 拥有，Sample 由 `eval-runtime` 的运行时模型拥有。

JSON 值与标识符规则也只在这里定义：`jsonValueSchema`、`jsonObjectSchema`（有限数、安全整数、无环纯数据）和 `identifierSchema`、`isIdentifier`、`IDENTIFIER_RULE`（非空且无首尾空白）。

状态词表只在这里定义：`SAMPLING_STATUSES`、`PENDING_SAMPLING_STATUSES`、`AGENT_STATUSES`、`TERMINAL_AGENT_STATUSES` 及谓词 `isPendingSamplingStatus`、`isTerminalAgentStatus`，`SamplingStatus`、`AgentStatus` 由它们派生，SQL 使用同一常量。`AgentSubmission.status` 是 SP 归一化后的状态，SP 原始状态只在 Eval API 的 Harness 适配层映射一次。

资源契约位于 `src/resources.ts`，通过包根入口导出。`AgentResourceSnapshot` 原样承载 SP 的 `usageEvents`、`telemetryEvents`、`billingSettlements`，记录是开放的 JSON 对象，而不是 Eval 重新设计的费用/Token/工具/Turn 事实模型。来源字段、缺失字段、`null`、事件顺序、重复事件、子 Agent 明细与汇总全部保留；Runtime 不补零、不换算、不抽取、不合并、不去重、不计算总量。

`coverage` 分别保留来源对三组记录的 `complete | partial | unavailable` 声明，`finalized` 保留操作终结声明；`collected` 只表示读到了并保存了原始快照，不保证来源完整。初始化 Session 历史和共享的 Subject 证据不属于本次资源范围。失败、取消和重启的原始记录不能因最终结果失败而删除，历次主动重评也不能混入同一评估记录。Metric 读取这些原始内容，负责来源解析、去重、重叠用量处理、费用/Token/工具/Turn 统计及汇总。

一旦观察到 Agent 终态，Attempt 的状态及完成时间就固定为该 Agent 事实，`error` 保留原 Agent 错误；Runtime 资源持久化/产物收尾失败由执行或评估阶段的 `lastError` 表达，不把已经 `completed` 的 Attempt 改为 Agent 失败。保存重试复用同一份事实，不改变 Sampling/Evaluation/Attempt/Submission 身份。

Subject 的产物和完整轨迹是执行终态的必需证据。`Sampling.execution.evidencePending` 表示 Agent 已终结、证据尚未完整保存；此时执行保持非终态，恢复进程只补收证据，不再次提交或重启 Agent。证据与执行终态在同一次 Sampling 写入中保存；原 Agent 错误保留在 Attempt 和阶段错误中。

`RunPhase` 只有 `execution | evaluation`。`RunPhases` 表示 Run 关联的实际阶段范围：只执行、只评估或顺序执行后评估；`RunSnapshot.phases` 返回该范围，`phase` 和 `status` 返回从 Sampling 推导的当前进度。Pipeline 只负责组合两阶段，没有第三种阶段、Run kind 或独立的 Pipeline 数据模型。

`RunSnapshot.stopRequested` 表示 Project 当前 Run 已请求停止；停止期间与收尾后的 Run 状态见[架构方案](../../docs/architecture.md#run-调度与停止)。

三个运行请求都要求调用方提供同一次意图稳定复用的 `idempotencyKey`。`StartRunRequest` 使用 `executionConfigId`，`EvaluateRequest` 使用 `evaluationConfigId` 和确定的 `samplingIds`，`PipelineRequest` 使用 `pipelineConfigId`。具体 Dataset、Agent、并发和重试策略属于 `eval-runtime/config`，不在请求契约中复制。

每次部署选定一个 SP 分支并独立发布整套 Eval SP。Project 绑定该分支，并记录首次成功创建 Run 时选定的执行或 Pipeline 操作及配置；后续执行必须沿用这项选择。空 Project 不能以只评估启动；已有成功 Sampling 的 Project 可新增独立评估 Run，而不改首次选择。Run 记录准入时该发布使用的 SP commit；Sampling 不存分支。Agent Config 引用指向 Eval SP 自己的 `user-agent` 库，不跨 dev/production 实时共享配置。

Project 只绑定评估输出格式的 ID。格式本身是 Eval API 中独立上传的一份带名称和描述的 draft 2020-12 JSON Schema 文件。首次评估 Run 准入后绑定不可修改；所有评估 Run 必须有格式 ID，Runtime 按 ID 读取 Schema 内容，每个 Eval Agent 初始化前在自己的 Workspace 的素材根目录下收到 `evaluation-output.schema.json`。

`AgentFramework` 为 `sp | codex | cc`。`HarnessConfig.kind` 表示统一的 SP 云端宿主，必填的 `framework` 表示所运行的 Agent 框架；三种框架都引用 SP 管理的 Agent Config，复用同一 Chat/Submission/Workspace 边界。执行配置可选择三者，评估配置固定 SP 框架，不由本包实现进程启动或云端部署。

每个 Evaluator 仍有独立 Chat、Submission 和轨迹，但通过执行 Chat 的 `{userId, chatId}` 关联同一个物理 SpaceDO。Subject 产物留在原 Workspace；SP 将完整 Subject 轨迹物化进去，Evaluator 的材料与结果写在 `/evaluations/<evaluationId>/`。Workspace 绑定由 Runtime 在创建 Evaluator Chat 时给出，不是 Harness 配置项。

本包不负责运行 Agent、读取 SP Workspace、访问 R2、持久化数据库或实现 API/Web/CLI。
