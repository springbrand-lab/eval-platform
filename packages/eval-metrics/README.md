# @eval-platform/eval-metrics

Project 当前结果的只读统计与四层展示。只读取应用注入的一致事实快照，不运行 Agent，不读 SP 私有存储，不保存第二份状态。

```text
src/
├── index.ts                  # 唯一入口：createMetrics、错误类和模型类型
├── json.ts                   # 原始 JSON 记录/文本读取（包内共享）
├── evaluators/
│   ├── model.ts              # 评估输出视图、Schema 校验结果与数值观察
│   └── index.ts              # 严格解析、Ajv 2020 校验、按 Schema 抽取数值
├── aggregation/
│   ├── model.ts              # 资源、轨迹、Agent 视图、数值字段、阶段与层级汇总模型
│   ├── agents.ts             # Subject/Evaluator 分视角、Attempt 与 Agent 时长
│   ├── resources.ts          # 资源聚合编排与 coverage
│   ├── resource-facts.ts     # 诊断、数值校验与按来源身份去重
│   ├── resource-usage.ts     # Token/Provider USD 与 Subagent 覆盖
│   ├── resource-billing.ts   # 模型与 Action 结算
│   ├── resource-telemetry.ts # 模型请求、Turn、工具、长度与非工具轮
│   ├── numeric-outputs.ts    # JSON Schema 数值字段汇总
│   ├── statistics.ts         # NumericSummary 与唯一的 coverage 规则
│   └── index.ts              # 单层汇总
└── reporting/
    ├── model.ts              # 查询、MetricsFacts/MetricsSource、四层视图
    └── index.ts              # 事实校验、固定层级与四层视图
```

依赖方向为 evaluators → aggregation → reporting：evaluators 只解读单条评估输出，aggregation 负责所有分组统计（含数值字段），两者共用的 JSON 读取在 `json.ts`。

```ts
const metrics = createMetrics({ source });
const scope = { projectId, runIds }; // runIds 可选
await metrics.getProjectOverview(scope);
await metrics.getDatasetOverview({ ...scope, datasetId });
await metrics.getSampleOverview({ ...scope, projectSampleId });
await metrics.getSamplingDetail({ ...scope, samplingId });
```

## 层级

Project → Dataset → ProjectSample → Sampling，EvaluationRecord 挂在 Sampling 下。层级只来自 `facts.plan.datasets` 与 `facts.projectSamples`（Project 创建时的快照），不读实时目录。未运行的 ProjectSample 照常出现，数值为 null/unavailable。共享 ProjectSample 在每个 Dataset 行中出现，Project 汇总按 Sampling/Evaluation 身份去重。每层都从底层原始记录重算，不平均子层结果。默认读取当前结果全集；`runIds` 只过滤 Sampling/Evaluation，不改变固定绑定。

每层 `MetricSummary` 包含：固定绑定数（datasets/data/projectSamples）、当前 samplings/evaluations、执行与评估阶段（状态分布、成功率、Attempt/重启、Agent 时长与 Attempt 时长）、`executionAgent` 与 `evaluationAgents` 分开的资源统计，以及 `numericOutputs`。`getSamplingDetail` 额外返回 Subject 与每个 Evaluator 的 `AgentMetricView`，以及每条评估的 `EvaluationOutputView`（原始文本、解析后的 JSON、校验结果、数值观察、产物、证据与轨迹引用）。

## 资源与轨迹

原始 `AgentResourceSnapshot` 是费用和 Token 的唯一来源：模型账单按 `accountId + eventId`、Action 按 `executionId`、遥测按 `sessionId + eventId` 去重；不重算价格，不把 reasoning 再加进 total；失败、取消、重启 Attempt 的消耗照常计入。已提交但没有收集记录的 Attempt 记为 `uncollected` 并使结果不完整；从未提交的 Attempt 不制造缺失。缺失值为 null 并带 coverage（complete/partial/unavailable）与 diagnostics，只有完整空流才证明 0。

轨迹指标来自每个 Attempt 已保存的 SP Telemetry 事件，跨 Attempt/分页合并后按 `sessionId + operationId` 归并操作：

- Turn 数及 completed/failed/cancelled/inProgress/unknown；
- 按 `toolName` 的调用数、结果、耗时，输入长度（`tool.started` 的 `payload.input`）与返回长度（`tool.finished` 的 `payload.output`，缺失时用 `response`，不相加），均为规范 JSON 的 UTF-8 字节数；缺失或被 SP 脱敏（`[CONTENT OMITTED]`/`[REDACTED]`）记为 missing；
- 非工具轮：经 `parentOperationId`（嵌套工具沿父工具上溯）没有任何工具归属的 Turn；非工具轮 Token 只汇总明确归属到这些 Turn 的 `generation.finished` 的 input/output/total。缺少关联时为 partial/unavailable，不用减法推算。

## JSON Schema 数值

每条评估的 `structuredOutput.content` 先严格解析（拒绝重复键），再用 Ajv 2020 按 Project 锁定的 Schema 校验：`valid`、`invalid`（`invalid-json`、`unsafe-number`、`schema-mismatch`）或 `unavailable`（`no-output`、`no-structured-output`、`no-schema`、`invalid-schema`）。只有成功评估的有效输出才抽取数值：值所在的 Schema 节点必须声明 `number`/`integer`，解析本地 `$ref`，`oneOf`/`anyOf`/`if` 只走实际通过校验的分支，`allOf` 全部生效。字段路径为 JSON Pointer，数组下标统一为 `*`（如 `/scores/*/value`），`instancePointer` 保留实际下标。字符串数字、布尔和未声明字段忽略；NaN/Infinity/超出安全整数范围使整份输出无效。

每个字段汇总 observationCount、contributingEvaluationCount、missingEvaluationCount（按 not-succeeded/invalid-output/unavailable-output/absent 诊断）、total/min/max/mean/median 与 coverage；缺失与失败从不按 0 计。没有评估计划时数值为 unavailable，执行指标照常。

## 错误

查询范围外的 Project/Run/Dataset/ProjectSample/Sampling 抛 `MetricsEntityNotFoundError`（entity 为 `project | run | dataset | project-sample | sampling`），非法查询抛 `MetricsQueryError`，来源事实不一致（重复身份、越界 Sampling、缺失绑定 ProjectSample、绑定与计划不符、Schema 与评估计划不符等）抛 `MetricsSourceError`。

不实现实验对比、归因、缓存、指标持久化或 API/Web/CLI；本包只有包根入口。
