# 独立评估入口：选择与提交契约

## 范围与现状

执行成功的 Sampling 可以在原 Project 下单独发起评估，不重新执行 Subject。新建的空 Project 不能以只评估启动，也不能引用其他 Project 的 Sampling。Project 只保留当前状态：新执行或联跑原子删除旧 Run、Sampling 和 EvaluationRecord，再从零启动；新独立评估保留本轮执行的全部 Sampling 事实（仅成功者可入选评估），原子替换旧 Run 和 EvaluationRecord。旧 Run ID 的结果查询在替换后返回 404。

当前已实现 Catalog 的选择查询、Runtime `evaluate()`、PostgreSQL 幂等准入和 Eval API 的独立评估 HTTP 路由。Runtime 只接收调用方确定的 Sampling ID 列表，不根据筛选条件重新选一批。

## 选择

控制面从已校验的 Eval SP 会话取得 `ownerUserId`，用它创建用户范围内的 Catalog。选择始终带 `projectId`，只匹配该 Project 中 `execution.status === "succeeded"` 的 Sampling；评估状态不影响候选资格。

| 操作 | 输入 | 输出 |
| --- | --- | --- |
| 分页筛选 `listSuccessfulSamplings` | `projectId`；可选 `sampleId`、排他游标 `afterSamplingId`、`limit`（默认 100，范围 1–1000） | 按 `samplingId` 升序的 `{samplingId, sampleId}` 列表和 `nextCursor`；无后续页时为 `null` |
| 全选 `selectAllSuccessfulSamplingIds` | `projectId`；可选 `sampleId` | 同一筛选条件下、按 `samplingId` 升序的全部 ID；无匹配时为空数组；超过单次提交上限时报错，不返回截断列表 |

两个查询共用用户、Project、执行成功状态和可选 Sample 的条件。分页用于展示和手动选择；“一键全选”调用全选查询一次，取得确定的 ID 数组。单次全选或提交最多 10,000 个 ID；全选超过上限时报错，可按 Sample 筛选或分次手动选择，不会返回误称“全部”的截断列表。提交的请求体上限由该 ID 数量推导，满额的合法列表不会因体积被拒。全选结果是查询时的候选集合，不是一个持续变化的筛选表达式，也不另存一份选择状态。

## 提交与重试

控制面提交显式的 `EvaluateRequest`：

```ts
{
  projectId,
  evaluationConfigId,
  samplingIds: selectedSamplingIds,
  idempotencyKey,
}
```

手动选择与全选都传确定、非空、无重复的 `samplingIds`，并传本次用户意图的 `idempotencyKey`。一次意图从首次提交到超时重试、网络重发和重复点击，都复用**同一 ID 顺序、配置 ID、Project 和 key**；重试不能再次调用全选查询来生成新列表。若全选为空，不提交评估请求。API 将这份请求交给 Runtime `evaluate()`，并把其 `RunHandle` 返回调用方。

幂等键在 Project 内唯一，`start()`、`pipeline()` 和 `evaluate()` 共用这条规则。当前 Run 的相同 key 与请求事实返回原 Run；同一 key 换操作、配置 ID 或 Sampling ID 列表（包括顺序）时报冲突。同一 Runtime 实例内，并发的同一意图共用第一次提交的 Promise，因此即使配置在两次点击之间改变，本次提交仍使用第一次解析并准入的生效配置。已准入后的重放用原 Run 保存的有效配置校验，不重新解析已修改的配置。全新的一次主动重跑或重评估需要新 key；已被替换的旧 key 留在仅保存请求身份的账本中，迟到重试以冲突拒绝，不会重新启动。Runtime 和 Store 在准入前后分别查重，数据库唯一约束兜底并发请求；只有新 Run 投递 Worker 任务。内存同步只处理同一实例内的并发，不代替 Store 的持久化幂等。

同一 Project 同时只允许一批未结束的 Run，执行、联跑和独立评估共用此限制。Store 在 Project 行锁内先处理同 key 重放，再检查是否有 `queued`、`starting`、`running` 或 `retrying` 的 Sampling 或 EvaluationRecord；新 key 遇到未结束 Run 时被拒绝，且不产生新 Run 或评估记录。停止请求也必须完成证据收尾后才可重跑。原 Run 的所有阶段进入终态后，新 key 在同一事务中清掉被替换的运行状态并启动新批次。执行重跑中的 Sampling 未完成前，Project 忙碌检查阻止启动独立评估；未成功的 Sampling 本身也不进入候选集。配置在这段时间内可以编辑，当前 Run 和同 key 重放仍沿用原快照。

提交时 Runtime 分批读取 Sampling 和不同 Sample 的输入，再检查每个 Sampling 属于该 Project、执行成功且输入可读取；Store 在原子准入中再次检查。选择后若候选已失效，整批提交失败，不留下半批 Run 或 EvaluationRecord。调用方需要重新选择并以新意图提交。

## HTTP 控制面

路由、请求体、状态码与错误码见 [Eval HTTP 控制面](eval-http-api.md)；停止当前 Run 的异步收尾语义见[架构方案](architecture.md#run-调度与停止)。控制面从已校验的 Eval SP 会话取得用户 ID，客户端不能提交用户 ID；无权访问的 Project 或 Run 按不存在处理。

同一用户的活动请求共享一套用户范围内的 Project Catalog、ConfigReader 和 Runtime 准入实例，因此并发的同一意图由同一 Runtime 实例合并；空闲用户条目从内存移除。Run 准入事务分批写入大量关联，全选列表不会触及单条 SQL 的参数上限；Run 状态与 Evaluation 结果在同一只读事务内分批读取和投影。准入成功时 Run 任务在同一事务内投递给独立的 Run Worker，HTTP 进程不持有 SP Harness 服务凭证。

## 控制面接入验收

- 同一用户的分页与全选返回相同条件下的候选；其他用户或 Project 的 Sampling 不可见。
- 全选后提交的是返回的固定 ID 数组；同一意图重试不重新筛选。
- 重复点击和并发提交同一 key 只得到一个 Run 和一批 EvaluationRecord；冲突事实被拒绝；新 key 必须等当前 Run 结束后才能主动重评估。
- 无候选、非法或不再成功的 Sampling 不产生部分提交。

跨 API 实例仍由 Store 的唯一约束阻止两批 Run；进程内内存同步不承诺跨实例配置变更时两次调用都得到相同响应。页面交互由 Web 接入时确定。
