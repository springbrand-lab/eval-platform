# 独立评估入口：选择与提交契约

## 范围与现状

执行成功的 Sampling 可以在原 Project 下单独发起评估，不重新执行 Subject。新建的空 Project 不能以只评估启动，也不能引用其他 Project 的 Sampling。一次评估请求保存新的 Run 和每个 Sampling 对应的 EvaluationRecord；有意再次评估同一批 Sampling 时使用新幂等键，已有执行与评估记录不被覆盖。

当前已实现 Catalog 的选择查询、Runtime `evaluate()` 和 PostgreSQL 幂等准入。Eval API 的 HTTP 控制面尚无调用方；接入时按下述契约组合现有能力，不让 Runtime 根据筛选条件重新选一批 Sampling。

## 选择

控制面从已校验的 Eval SP 会话取得 `ownerUserId`，用它创建用户范围内的 Catalog。选择始终带 `projectId`，只匹配该 Project 中 `execution.status === "succeeded"` 的 Sampling；评估状态不影响候选资格。

| 操作 | 输入 | 输出 |
| --- | --- | --- |
| 分页筛选 `listSuccessfulSamplings` | `projectId`；可选 `sampleId`、排他游标 `afterSamplingId`、`limit`（默认 100，范围 1–1000） | 按 `samplingId` 升序的 `{samplingId, sampleId}` 列表和 `nextCursor`；无后续页时为 `null` |
| 全选 `selectAllSuccessfulSamplingIds` | `projectId`；可选 `sampleId` | 同一筛选条件下、按 `samplingId` 升序的全部 ID；无匹配时为空数组 |

两个查询共用用户、Project、执行成功状态和可选 Sample 的条件。分页用于展示和手动选择；“一键全选”调用全选查询一次，取得确定的 ID 数组。全选结果是查询时的候选集合，不是一个持续变化的筛选表达式，也不另存一份选择状态。

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

幂等键在 Project 内唯一，`start()`、`pipeline()` 和 `evaluate()` 共用这条规则。相同 key 与请求事实返回原 Run；同一 key 换操作、配置 ID 或 Sampling ID 列表（包括顺序）时报冲突。同一 Runtime 实例内，并发的同一意图共用第一次提交的 Promise，因此即使配置在两次点击之间改变，本次提交仍使用第一次解析并准入的生效配置。已准入后的重放用原 Run 保存的有效配置校验，不重新解析已修改的配置。全新的一次主动重评估需要新 key。Runtime 和 Store 在准入前后分别查重，数据库唯一约束兜底并发请求；只有新 Run 唤醒 Worker。内存同步只处理同一实例内的并发，不代替 Store 的持久化幂等。

提交时 Runtime 再检查每个 Sampling 属于该 Project、执行成功且输入可读取；Store 在原子准入中再次检查。选择后若候选已失效，整批提交失败，不留下半批 Run 或 EvaluationRecord。调用方需要重新选择并以新意图提交。

## 控制面接入验收

- 同一用户的分页与全选返回相同条件下的候选；其他用户或 Project 的 Sampling 不可见。
- 全选后提交的是返回的固定 ID 数组；同一意图重试不重新筛选。
- 重复点击和并发提交同一 key 只得到一个 Run 和一批 EvaluationRecord；冲突事实被拒绝，新 key 可以主动重评估。
- 无候选、非法或不再成功的 Sampling 不产生部分提交。

控制面接入时，同一用户的并发提交需复用同一 Runtime 实例，才能共享上述进程内待准入请求。跨实例仍由 Store 的唯一约束阻止两批 Run；本次内存同步不承诺跨实例配置变更时两次调用都得到相同响应。

HTTP 路径、请求参数编码和前端交互由控制面接入时确定；本契约约束其选择与提交语义。
