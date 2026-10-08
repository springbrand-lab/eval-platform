# @eval-platform/eval-contracts

评估平台跨包共享的稳定契约层，公共类型从包根入口和 `./model` 子路径导出。

负责 Project、Sampling、EvaluationRecord、HarnessConfig、ExecutionOutput、EvaluationAgentOutput（评估产物、分数、证据和完整轨迹）、EvaluatorResult、ArtifactRef、TrajectoryRef 和 EvidenceRef 等运行与评估类型边界。证据和解释属于评估 Agent 输出，没有独立的归因契约。每个执行/评估 Attempt 的 `AgentResourceCollection` 按 `submissionId + idempotencyKey` 精确归属，只表达 `pending | collected | failed` 的采集状态。Dataset/Data 由 `eval-dataset` 拥有，Sample 由 `eval-runtime` 的运行时模型拥有。

资源契约位于 `src/resources.ts`，通过包根入口及 `./model` 导出。`AgentResourceSnapshot` 原样承载 SP 的 `usageEvents`、`telemetryEvents`、`billingSettlements`，记录是开放的 JSON 对象，而不是 Eval 重新设计的费用/Token/工具/Turn 事实模型。来源字段、缺失字段、`null`、事件顺序、重复事件、子 Agent 明细与汇总全部保留；Runtime 不补零、不换算、不抽取、不合并、不去重、不计算总量。

`coverage` 分别保留来源对三组记录的 `complete | partial | unavailable` 声明，`finalized` 保留操作终结声明；`collected` 只表示读到了并保存了原始快照，不保证来源完整。初始化 Session 历史和复制的 Subject 证据不属于本次资源范围。失败、取消和重启的原始记录不能因最终结果失败而删除，历次主动重评也不能混入同一评估记录。Metric 读取这些原始内容，负责来源解析、去重、重叠用量处理、费用/Token/工具/Turn 统计及汇总。

一旦观察到 Agent 终态，Attempt 的状态及完成时间就固定为该 Agent 事实，`error` 保留原 Agent 错误；Runtime 资源持久化/产物收尾失败由执行或评估阶段的 `lastError` 表达，不把已经 `completed` 的 Attempt 改为 Agent 失败。保存重试复用同一份事实，不改变 Sampling/Evaluation/Attempt/Submission 身份。

`RunPhase` 只有 `execution | evaluation`。`RunPhases` 表示 Run 关联的实际阶段范围：只执行、只评估或顺序执行后评估；`RunSnapshot.phases` 返回该范围，`phase` 和 `status` 返回从 Sampling 推导的当前进度。Pipeline 只负责组合两阶段，没有第三种阶段、Run kind 或独立的 Pipeline 数据模型。

运行请求只携带配置引用：`StartRunRequest` 使用 `executionConfigId`，`EvaluateRequest` 使用 `evaluationConfigId`，`PipelineRequest` 使用 `pipelineConfigId`。具体 Dataset、Agent、并发和重试策略属于 `eval-runtime/config`，不在请求契约中复制。

`AgentFramework` 为 `sp | codex | cc`。`SpHarnessConfig.kind` 表示统一的 SP 云端宿主，必填的 `framework` 表示所运行的 Agent 框架；三种框架都引用 SP 管理的 Agent Config，复用同一 Chat/Submission/Workspace 边界。执行配置可选择三者，评估配置固定 SP 框架，不由本包实现进程启动或云端部署。

本包不负责运行 Agent、读取 SP Workspace、访问 R2、持久化数据库或实现 API/Web/CLI。
