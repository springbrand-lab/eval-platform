# 仅评估 Run：选择与提交契约

## 范围

仅评估（`operation: "evaluation"`）在原 Project 中为执行成功的 Sampling 重新评估，不重新执行 Subject。它与 execution、pipeline 使用同一组准入接口，选择始终在 Project 快照内展开；准入、幂等键、单一未结束 Run 和结果替换规则的唯一完整描述见[架构方案](architecture.md#run-准入与独立评估)，目标行为见 [Project、Runtime 与 Metrics 改造方向](eval-project-redesign.md)。

前提：

- Project 已有评估计划，否则返回 `evaluation-plan-required`；首个 pipeline/evaluation Run 准入时锁定评估计划；
- 新 Project 没有成功 Sampling，因此首个 Run 不能是仅评估；也不能引用其他 Project 的 Sampling；
- 涉及的每个 ProjectSample 都有 `evalPrompt`，否则返回 `evaluation-prompt`。

## 选择

选择器是 `all`、`datasetIds`、`projectSampleIds`、`samplingIds` 的组合，至少一项，ID 总数不超过 10,000：

- `all` 与 Dataset 按 Project 绑定顺序和成员顺序展开为 ProjectSample，与显式 `projectSampleIds` 合并去重；
- 每个 ProjectSample 再展开为其当前执行成功的 Sampling，其他状态静默过滤；
- 显式 `samplingIds` 必须属于该 Project 且执行成功，否则拒绝（`sampling-unavailable` 或 not found）；
- 结果去重、顺序稳定；展开为空时拒绝（`empty-targets`）。

`EvalRunAdmission.preview({projectId, operation: "evaluation", selector})` 返回固定 `targets`（`projectSampleIds` 为空，`samplingIds` 为待评估的 Sampling）、将创建的评估数和计划摘要。preview 不写任何状态。

## 提交与重试

`submit({idempotencyKey, projectId, operation: "evaluation", selector, targets})` 原样提交 preview 返回的 `targets`，Runtime 只校验、不重新展开。一次意图从首次提交到超时重试、网络重发和重复点击，都复用同一 `targets` 和 key；重试不能重新 preview 生成新列表。请求指纹覆盖 Project、operation、selector、targets、执行计划摘要和评估计划摘要。

Store 在同一事务内复核每个目标仍执行成功，只删除目标 Sampling 的当前 EvaluationRecord，为每个目标新建一条 EvaluationRecord，并在首个带评估的 Run 时锁定评估计划。目标 Sampling 的 Chat、Attempt、产物、轨迹、资源和状态完全保留，未选中 Sampling 的执行与评估不受影响。候选在 preview 之后失效时整批拒绝，不留下半批 Run 或 EvaluationRecord，调用方需重新 preview 并以新 key 提交。

## HTTP

路由、请求体、状态码与错误码见 [Eval HTTP 控制面](eval-http-api.md)；停止 Run 的异步收尾语义见[架构方案](architecture.md#run-调度与停止)。控制面从已校验的 Eval SP 会话取得用户 ID，客户端不能提交用户 ID；无权访问的 Project 或 Run 按不存在处理。准入成功时 Run 任务在同一事务内投递给独立的 Run Worker，HTTP 进程不持有 SP Harness 服务凭证。

## 验收

- Dataset/ProjectSample 展开只包含执行成功的 Sampling，基于 Project 快照而不是实时目录；
- 同一意图重试提交相同 `targets`，只得到一个 Run 和一批 EvaluationRecord；不同事实以同一 key 提交被拒绝；
- 评估失败、未完成或其他 Project 的 Sampling 不产生部分提交；
- 仅评估后 Subject 的执行 Attempt、Token、credit、时长和轨迹不变，只替换目标 Sampling 的评估。
