# @eval-platform/eval-contracts

评估平台跨包共享的稳定契约层，公共类型从包根入口和 `./model` 子路径导出。

负责 Project、Sampling、HarnessConfig、ExecutionOutput、EvaluationAgentOutput（评估产物、分数、证据和完整轨迹）、EvaluatorResult、AttributionResult、ArtifactRef、TrajectoryRef 和 EvidenceRef 等运行与评估类型边界。Dataset/Data 由 `eval-dataset` 拥有，Sample 由 `eval-runtime` 的运行时模型拥有。

本包不负责运行 Agent、读取 SP Workspace、访问 R2、持久化数据库或实现 API/Web/CLI。
