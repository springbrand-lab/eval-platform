# Eval Metrics Code Review

## 评审范围与约定

- 日期：2026-10-08。
- 仓库：`eval-platform`；评审时 HEAD 为 `a7a369b`。
- 主要范围：`2617de5` 新增 Metrics 生产代码，以及 `a7a369b` 的 Runtime/Metrics 集成回归；`ba9e037`、`38b6cbe` 的模块边界调整作为上下文。
- 保持已确定的 `evaluators`、`aggregation`、`reporting` 职责；不恢复独立 attribution 模块，不重新拆分 workspace。
- 只从 Dataset/Runtime 的公开事实处理统计；不访问 SP 私有存储，不重算价格，不维护另一份运行状态。
- 按用户约定，大白话逐条讨论，用户确认后才将状态改为已确认；不把不存在的功能或越过契约的输入当成当前实际问题。
- 本轮修复确认的问题，并同步更新评审记录；不修改 SP。

## 当前记录

新增生产文件及相关回归已核对；Metrics 包的类型检查和 95 个测试通过。以下发现已独立复现，并按逐项讨论结果记录。

| 编号 | 问题 | 严重程度 | 状态 |
| --- | --- | --- | --- |
| M-01 | Subagent 摘要缺少可信指标时，仍遮掉有效子明细，丢失已知 Token/Provider 费用 | P2 | 已修复 |
| M-02 | 存在未提交资源的 Attempt 时，仍把已采集部分报成完整统计 | — | 已撤回，不是问题 |

### M-01：不完整的 Subagent 摘要遮掉有效子明细（已确认）

**所属提交**：`2617de5`。

**原问题位置**

- `packages/eval-metrics/src/aggregation/resources.ts`：原实现按整条 Subagent 摘要排除 child run，未按指标判断覆盖。

**大白话**

子 Agent 的明细已经记录了 100 个 Token、3 美元 Provider 成本。上层又有一条这个子 Agent 的摘要，但摘要这次没有拿到可信用量。现在代码只看“摘要存在”，就把下面的明细排除，最后把 Token 和 Provider 成本显示成未知。原始数据里的 100 和 3 并没有丢，是 Metrics 的去重逻辑把它们遮掉了。

摘要有可信数值时应避免重复统计；摘要没有某个指标的可信值时，不能因此丢掉该指标已经知道的子明细。

**输入契约依据**

- SP 当前结算请求契约明确支持 `outcome: "missing_trusted_usage"`，并要求这类事件不提供 `metrics`；`providerCostUsd` 也是可选字段。子 Agent 身份仍由 `subagentRunId` 和 `parentRunId` 指定。
- 对应本地契约位置：`/Users/apple/code/sp-platform/api/src/models/billing/index.ts:70`、`/Users/apple/code/sp-platform/api/src/models/billing/index.ts:90`。本轮只核对跨边界数据契约，没有修改 SP 或导入其私有实现。
- Runtime 的资源承载契约保留缺失字段，`validateResourceSnapshot()` 接受上述快照；这不是夹带不存在的 UI 字段或违反 JSON 契约的输入。
- 本条是合法契约输入的确定性复现，不声称线上已经发生，也不把尚未接入的真实 SP Adapter 当作问题。

**独立复现**

1. 用真实 `validateResourceSnapshot()` 校验完整、已 finalized 的快照。子明细使用 `kind: "assistant_model"`、`runId: "child-run"`，可信 Token 桶分别为 input 70、output 20、cacheRead 10、cacheWrite 0，Provider USD total 为 3。
2. 仅该子明细时，真实 `aggregateResources()` 返回 Token total 100、Provider USD 3，均为 complete。
3. 加入身份完整的 Subagent 摘要：`subagentRunId: "child-run"`、`parentRunId: "root-run"`、`outcome: "missing_trusted_usage"`，不提供 metrics/Provider cost。两项结果都变成 `{ value: null, coverage: "unavailable" }`；`overlappingUsageRecords` 为 1，diagnostics 为空。
4. 再换为 Token 桶完整、仅 Provider cost 缺失的合法摘要：Token total 保持 100，但 Provider USD 仍变成 unavailable。说明 Token 与成本不能共用“一次整体排除”的覆盖判断。
5. 将同一有效快照放进合法 SamplingSnapshot，通过真实 `createMetrics().getSamplingDetail()` 再次复现：统计值为未知，返回的原始 Attempt 中仍有完整子明细。权威 model debit 8 单位保留，证明错误只在用量/Provider 成本的重叠选择，不是重新计费或原始记录丢失。

**影响范围**

- `aggregateMetrics()` 及 Project/Dataset/Sample/Sampling 四层视图共用此资源聚合路径，因此都会漏掉被无效指标摘要遮住的已知用量或 Provider 成本。
- 混有其他有效主 Agent 用量时，返回的已知部分也会偏小；并不是只能出现整个值为 null。
- 同一摘要可以对 Token 有效、对 Provider cost 无效；不能用摘要的存在或任意一个有效字段决定所有指标的明细覆盖。

**待讨论的合理行为**

- 按具体指标确认可信摘要是否真的覆盖该 child run；该指标的摘要有效时不再加子明细，避免重复计量。
- 摘要缺少或没有可信指标值时，保留该指标的有效子明细作为已知部分，并根据真实覆盖情况标明 partial/unavailable，不能补零或假装完整。
- 不修改原始资源记录，不通过价格估算 Provider 成本，不合并或丢弃独立的真实 billing settlements。
- 现有“摘要身份冲突/循环时保留子明细”的处理仍保留；本条补充的是摘要数值缺失时的覆盖条件。

**用户结论**：是问题。当前需要确认的是：Eval 是否已经支持真实子 Agent；结论是，Metrics/资源契约支持子 Agent 数据，但 Runtime 当前只编排 subject 和 evaluator 两类 Agent，并不自己创建或嵌套调度子 Agent。

**修复方案**

- 为 `inputTokens`、`outputTokens`、缓存 Token、`reasoningTokens`、`totalTokens` 和 `providerUsd` 分别计算有效覆盖范围。
- 只有摘要自身拥有该指标的合法数值时，才排除对应 child run 的明细；摘要缺少该指标时，继续保留 child detail。
- 同一摘要可以覆盖 Token 但不覆盖 Provider USD，两个指标分别得到正确的去重结果。
- 保留冲突摘要和循环关系的既有保护，不修改 Runtime 保存的原始事件。

**新增回归测试**

- `packages/eval-metrics/src/aggregation/resources.test.ts` 覆盖：摘要无可信 Token/Provider 成本、摘要只有 Token、Provider 成本从 child detail 保留，以及既有父子汇总去重。
- Metric 包测试结果：6 个测试文件，95 个测试通过。

**处理状态**：已修复，尚未提交本轮改动。

### M-02：未提交 Attempt 被误认为资源缺失（已撤回）

**问题位置**：`packages/eval-metrics/src/aggregation/resources.ts:57` 附近的 `readStream()`。

**复核结论**

这不是问题。`resources` 缺失的 Attempt 如果从未真正提交 Agent，就没有任何 Agent 资源需要采集；它不是“资源未知”，而是“这次没有产生资源”。因此，另一个已经提交并完成资源采集的 Attempt 仍然可以让资源流保持 complete。真正需要影响完整性的，是已提交 Attempt 的资源采集处于 pending/failed，或快照本身未 finalized/不完整。

**处理状态**：已撤回，不修改业务代码或测试。

## 本轮验证

- `pnpm --filter @eval-platform/eval-metrics check` 通过。
- `pnpm --filter @eval-platform/eval-metrics test` 通过：6 个测试文件，95 个测试。
- `pnpm check`、`pnpm test`、`pnpm build`、packages no-unused 检查和 `git diff --check` 均通过。
- 未修改 SP、CI 或 Runtime 原始数据契约；本轮修改了 Metrics 聚合代码、回归测试和本评审记录，尚未提交 Git。
