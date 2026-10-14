# 独立评估入口：选择与提交契约

## 范围与现状

执行成功的 Sampling 可以在原 Project 下单独发起评估，不重新执行 Subject。新建的空 Project 不能以只评估启动，也不能引用其他 Project 的 Sampling。一次评估请求保存新的 Run 和每个 Sampling 对应的 EvaluationRecord；有意再次评估同一批 Sampling 时使用新幂等键，已有执行与评估记录不被覆盖。

当前已实现 Catalog 的选择查询、Runtime `evaluate()`、PostgreSQL 幂等准入和 Eval API 的独立评估 HTTP 路由。Runtime 只接收调用方确定的 Sampling ID 列表，不根据筛选条件重新选一批。

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

## HTTP 控制面

所有路由都要求 `Authorization: Bearer <Eval SP session token>`。API 每次请求向固定的 Eval SP `/api/auth/me` 校验活动会话，再按返回的用户 ID 访问该用户的 Catalog 和 RuntimeStore；客户端不能提交用户 ID。无权访问的 Project 或 Run 返回 404。

| 路由 | 请求 | 成功响应 |
| --- | --- | --- |
| `GET /api/projects/:projectId/samplings/successful` | 可选 `sampleId`、`afterSamplingId`、`limit` | `200 { samplings, nextCursor }` |
| `GET /api/projects/:projectId/samplings/successful/ids` | 可选 `sampleId` | `200 { samplingIds }` |
| `POST /api/projects/:projectId/evaluations` | JSON `{ evaluationConfigId, samplingIds, idempotencyKey }` | `202 { runId, samplingIds }`，重放也返回原 RunHandle |
| `GET /api/projects/:projectId/runs/:runId` | 无 | `200 { run }`，包含本次 Run 的 Evaluation ID 列表和状态 |
| `GET /api/projects/:projectId/runs/:runId/evaluations` | 无 | `200 { evaluations }`，按 Run 的 Evaluation ID 顺序返回记录和结果 |

提交接口只接受显式、非空、无重复的 ID 列表，不接受筛选表达式或“提交时全选”。查询时的一键全选结果由调用方固定后提交；同一意图重试发送原请求体。标识符和幂等键最多 512 字符，幂等键不能有首尾空白。POST 要求 `Content-Type: application/json`，请求体上限 4 MiB；格式不符分别返回 415、413。其他无效输入返回 400，缺失或失效会话返回 401，未找到的 Project/Run/评估配置返回 404，幂等身份冲突或已失效的 Sampling 选择返回 409；未预期的内部错误返回 500，Eval SP 校验不可用返回 502。错误响应为 `{ "error": { "code": string, "message": string } }`。宿主可配置可信 Web Origin；配置后预检请求只对该 Origin 开放，其他 Origin 返回 403。

API 的服务工厂按 Eval SP 用户 ID 创建并缓存一套用户范围内的 Catalog、ConfigStore/ConfigResolver 和 Runtime 准入接口；同一用户的并发提交由同一 Runtime 实例处理。HTTP 路由只负责鉴权、输入校验、Project/Run 归属和组合调用；Run 准入与结果事实仍由 Runtime 和 Store 负责。Run 状态与 Evaluation 结果在同一只读事务内批量读取和投影。`start:api` 进程使用用户范围 PostgreSQL ConfigReader，不持有 SP Harness 服务凭证；独立 `start:worker` 进程用真实 Harness 执行已入库的 Run。

## 控制面接入验收

- 同一用户的分页与全选返回相同条件下的候选；其他用户或 Project 的 Sampling 不可见。
- 全选后提交的是返回的固定 ID 数组；同一意图重试不重新筛选。
- 重复点击和并发提交同一 key 只得到一个 Run 和一批 EvaluationRecord；冲突事实被拒绝，新 key 可以主动重评估。
- 无候选、非法或不再成功的 Sampling 不产生部分提交。

跨 API 实例仍由 Store 的唯一约束阻止两批 Run；进程内内存同步不承诺跨实例配置变更时两次调用都得到相同响应。页面交互由 Web 接入时确定。
