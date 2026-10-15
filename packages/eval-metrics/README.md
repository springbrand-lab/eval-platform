# @eval-platform/eval-metrics

Project 当前结果的只读统计与四层展示。只读取应用注入的一致事实快照，不运行 Agent，不读 SP 私有存储，不保存第二份状态。

```text
src/
├── index.ts                  # 唯一入口：createMetrics、错误类和模型类型
├── json.ts                   # 原始 JSON 记录/文本读取（包内共享）
├── evaluators/
│   ├── model.ts              # 评估输出视图、Schema 校验结果、字段形态与观察
│   └── index.ts              # 严格解析、Ajv 2020 校验、唯一的 Schema 遍历（字段形态与观察抽取）
├── aggregation/
│   ├── model.ts              # 资源、轨迹、Agent 视图、输出字段、阶段与层级汇总模型
│   ├── agents.ts             # Subject/Evaluator 分视角、Attempt 与 Agent 时长
│   ├── resources.ts          # 资源聚合编排与 coverage
│   ├── resource-facts.ts     # 诊断、数值校验与按来源身份去重
│   ├── resource-usage.ts     # Token/Provider USD 与 Subagent 覆盖
│   ├── resource-billing.ts   # 模型与 Action 结算
│   ├── resource-telemetry.ts # 模型请求、Turn、工具、长度与非工具轮
│   ├── output-fields.ts      # JSON Schema 输出字段汇总
│   ├── statistics.ts         # NumericSummary 与唯一的 coverage 规则
│   └── index.ts              # 单层汇总
└── reporting/
    ├── model.ts              # 查询、MetricsFacts/MetricsSource、四层视图
    └── index.ts              # 事实校验、固定层级与四层视图
```

依赖方向为 evaluators → aggregation → reporting：evaluators 只解读单条评估输出，aggregation 负责所有分组统计（含输出字段），两者共用的 JSON 读取在 `json.ts`。

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

每层 `MetricSummary` 包含：固定绑定数（datasets/data/projectSamples）、当前 samplings/evaluations、执行与评估阶段（状态分布、成功率、Attempt/重启、Agent 时长与 Attempt 时长）、`executionAgent` 与 `evaluationAgents` 分开的资源统计，以及 `evaluationOutputs`。`getSamplingDetail` 额外返回 Subject 与每个 Evaluator 的 `AgentMetricView`，以及每条评估的 `EvaluationOutputView`（原始文本、解析后的 JSON、校验结果、字段观察、产物、证据与轨迹引用）。

## 资源与轨迹

原始 `AgentResourceSnapshot` 是费用和 Token 的唯一来源：模型账单按 `accountId + eventId`、Action 按 `executionId`、遥测按 `sessionId + eventId` 去重；不重算价格，不把 reasoning 再加进 total；失败、取消、重启 Attempt 的消耗照常计入。已提交但没有收集记录的 Attempt 记为 `uncollected` 并使结果不完整；从未提交的 Attempt 不制造缺失。缺失值为 null 并带 coverage（complete/partial/unavailable）与 diagnostics，只有完整空流才证明 0。

轨迹指标来自每个 Attempt 已保存的 SP Telemetry 事件，跨 Attempt/分页合并后按 `sessionId + operationId` 归并操作：

- Turn 数及 completed/failed/cancelled/inProgress/unknown；
- 按 `toolName` 的调用数、结果、耗时，输入长度（`tool.started` 的 `payload.input`）与返回长度（`tool.finished` 的 `payload.output`，缺失时用 `response`，不相加），均为规范 JSON 的 UTF-8 字节数；缺失或被 SP 脱敏（`[CONTENT OMITTED]`/`[REDACTED]`）记为 missing；
- 非工具轮：经 `parentOperationId`（嵌套工具沿父工具上溯）没有任何工具归属的 Turn；非工具轮 Token 只汇总明确归属到这些 Turn 的 `generation.finished` 的 input/output/total。缺少关联时为 partial/unavailable，不用减法推算。

## JSON Schema 输出字段

每条评估的 `structuredOutput.content` 先严格解析（拒绝重复键），再用 Ajv 2020 按 Project 锁定的 Schema 校验：`valid`、`invalid`（`invalid-json`、`unsafe-number`、`schema-mismatch`）或 `unavailable`（`no-output`、`no-structured-output`、`no-schema`、`invalid-schema`）。NaN/Infinity/超出安全整数范围使整份输出无效。只有成功评估的有效输出才产生观察。

字段形态（`OutputFieldShape`）由一个 Schema 遍历得出：节点自身、其本地 `$ref` 目标与 `allOf` 成员必须同时成立，取交集；`anyOf`/`oneOf` 的分支与 `then`/`else` 是备选，取并集。未声明 `type`/`enum`/`const` 的位置不声明任何取值，在交并中都不起作用。子实例同样如此：同一节点的 `properties`、匹配的 `patternProperties`（两者都不匹配时为 `additionalProperties`）、`prefixItems`/`items` 一并适用。抽取时对象和数组只走自身实际满足的 `anyOf`/`oneOf`/`if` 分支，标量值按其所在 Schema 位置的完整形态计种类。字段路径为 JSON Pointer，数组下标统一为 `*`（如 `/checks/*/passed`），`instancePointer` 保留实际下标。字段种类（`OutputFieldKind`）：

- `number`/`integer`：`type` 允许的数值类型，或允许取值中的数字（全为整数时为 `integer`，如 `enum: [0.5, 1]` 为 `number`）；两者兼有时为 `number`。
- `boolean`：允许 `true` 或 `false`（`type` 含 `boolean` 即两者，`enum`/`const` 只取列出的）；布尔值只按 boolean 汇总，不算 enum。
- `enum`：允许取值中列出的字符串或数字（含 `oneOf`/`anyOf` 各分支的 `const`）。数字枚举同时得到数值汇总与分布。
- 允许 null（`nullable`）：允许取值中含 null。null 不是种类，也不在 `values` 中，只计入该字段的 `nullCount`。

例如 `{type:["string","null"],allOf:[{enum:["a"]}]}` 只允许 `"a"`，`{type:["number","boolean"],allOf:[{type:"number"}]}` 只有 `number`。一个字段可兼有多个种类（如 `type:["integer","boolean"]`），每个观察值进入与其类型相符的种类。至少有一个种类的字段才汇总：自由文本字符串、对象和只允许 null 的位置不汇总，仍可在单条评估详情的原始 JSON 中查看。枚举数组就是元素字段 `/tags/*` 上的 enum：每个条目同时给出出现次数和包含它的评估数，null 元素计入 `nullCount`，嵌套数组同理。

每条评估的 `observations` 列出其中被汇总的每个标量值：`jsonPointer`、`instancePointer`、`value`（number/boolean/string/null，原样记录）与该值计入的 `kinds`（null 为空数组，只计入字段的 `nullCount`）。

每个字段（`OutputFieldSummary`）的形态是 Schema 静态声明的形态与范围内各评估实际到达该字段的 Schema 位置形态之并；后者使 map 键、`patternProperties` 与递归字段同样有声明的种类、取值与 nullable，判断“Schema 允许 null”只此一条规则。汇总：

- `kinds`：该形态的种类。
- `observationCount`：被汇总的值总数（含 null），数组字段一条评估可贡献多个；`contributingEvaluationCount` 为至少有一个值的评估数；`missingEvaluationCount` 按 not-succeeded/invalid-output/unavailable-output/absent 诊断。null 是被观察到的值，不是缺失。
- `numeric`：有数值种类时为数字值的 count/total/min/max/mean/median，否则为 null；null、布尔和字符串从不进入数值统计。
- `distribution`：该形态的 boolean 与 enum 取值，按形态顺序全部列出（未出现时 count 为 0）；没有 boolean/enum 种类的字段为空数组（数字枚举仍有取值分布）。条目给出 `count`（出现次数）、`evaluations`（包含该值的评估数）与 `share = count / observationCount`（分母含 null 和不在分布中的值，如混合字段的数字；无观察时为 null）。
- `nullCount`：null 出现次数，独立于 `distribution`；当且仅当形态允许 null 时存在（尚未出现 null 时为 0），否则省略。null 从不算作 false、任何枚举值或缺失。
- 展示：`distribution` 各条目加一个由 `nullCount` 得出的固定 null 条目，占比为 `nullCount / observationCount`；只有每个非 null 值都在分布中时（纯 boolean、enum 字段），它与各条目 share 之和才为 1。boolean 字段排除 null 的通过率不是字段，由 true 的 count / (observationCount − nullCount) 得出。缺失评估（`missingEvaluationCount`）不进入 `observationCount`，与 null 不同。
- `coverage`：全部评估都可用且字段有值时为 complete，有值时为 partial，否则 unavailable。

Schema 声明顺序指：先节点自身的 `properties`，再依次为 `$ref`、`allOf`、`anyOf`、`oneOf`、`then`、`else` 中的声明，逐层深度优先。字段按此顺序列出，再按首次出现顺序（评估顺序、文档顺序）列出静态遍历无法命名的字段。取值顺序同理：先 Schema 声明顺序，再按首次出现顺序列出到达的 Schema 位置新增的取值。缺失与失败从不按 0 或 false 计。没有评估计划时输出字段为 unavailable，执行指标照常。

## 错误

查询范围外的 Project/Run/Dataset/ProjectSample/Sampling 抛 `MetricsEntityNotFoundError`（entity 为 `project | run | dataset | project-sample | sampling`），非法查询抛 `MetricsQueryError`，来源事实不一致（重复身份、越界 Sampling、缺失绑定 ProjectSample、绑定与计划不符、Schema 与评估计划不符等）抛 `MetricsSourceError`。

不实现实验对比、归因、缓存、指标持久化或 API/Web/CLI；本包只有包根入口。
