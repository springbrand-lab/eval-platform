# @eval-platform/eval-metrics

Project 当前结果的只读统计与四层展示。只读取应用注入的一致事实快照，不运行 Agent，不读 SP 私有存储，不保存第二份状态。

```text
src/
├── index.ts                  # 唯一入口：createMetrics、错误类和模型类型
├── json.ts                   # 原始 JSON 读取、Pointer 与安全数值检查（包内共享）
├── evaluators/
│   ├── model.ts              # 评估输出视图、校验结果、字段展示定义与观察
│   ├── fields.ts             # 展示定义的唯一合并规则与范围内字段选择
│   ├── plan.ts               # Schema 编译为保留来源、引用上下文和适用条件的展示计划
│   ├── validation.ts         # 记录 Ajv 原始校验中的分支结果、引用目标与动态上下文
│   └── index.ts              # 严格解析、校验与每条记录唯一的观察事实
├── aggregation/
│   ├── model.ts              # 资源、轨迹、Agent 视图、输出字段、阶段与层级汇总模型
│   ├── agents.ts             # Subject/Evaluator 分视角、Attempt 与 Agent 时长
│   ├── resources.ts          # 资源聚合编排与 coverage
│   ├── resource-distributions.ts # 单 Agent 资源分布，复用资源事实解释与数值统计
│   ├── resource-facts.ts     # 诊断、数值校验与按来源身份去重
│   ├── resource-usage.ts     # Token/Provider USD 与 Subagent 覆盖
│   ├── resource-billing.ts   # 模型与 Action 结算
│   ├── resource-telemetry.ts # 模型请求、Turn、工具、长度、思考轮与内容轮
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

所有数值观察共用 `NumericSummary`，返回有效 `count`、`missing`、total、mean、总体 variance、min、max、median。均值与方差仅以有值的 N 为分母；缺失不补零，真实零参与。N=0 时各统计为 null，N=1 时方差为 0。方差单位是原数值单位的平方。

每层的 `executionAgent` / `evaluationAgents` 是 `AggregatedResourceStatistics`，在全范围原始事件去重后的累计资源上提供缓存命中率，并含 `distribution`：从各 Subject / Evaluator 的原始 Attempts 经同一资源解释器形成单 Agent 观察，再统计 Token（含缓存）、积分/成本、轮数、模型/工具次数及结果、思考轮、内容轮与两类对应的 Token、各工具和模型的分布。缓存命中率由 `cacheRead / (input + cacheRead)` 在 Metrics 内计算，并保留输入与缓存读取两者中较弱的 coverage；分母为零时为 null。思考轮和内容轮的数量与成功、失败、取消、进行中、未知状态都按命中标记对应的唯一 Turn 统计；它们可以重叠，不能相加推算处理轮。分组归属与数值完整性分别判断：完整事实证明未调用某类型时才产生真实零，其他类型的数值缺失不影响这个零；存在可能归入该类型的未知模型或工具名时，不能证明缺席，记为缺失，已知部分也不能标为 complete。分组与补零都由原始资源解释器处理，展示层不从累计数值猜测归属。工具长度和调用耗时仍按单次调用统计，Agent 时长按单 Agent，Schema 数值按字段观察值。绝不平均 Dataset/Sample 的下层汇总。

原始 `AgentResourceSnapshot` 是费用和 Token 的唯一来源：模型账单按 `accountId + eventId`、Action 按 `executionId`、遥测按 `sessionId + eventId` 去重；不重算价格，不把 reasoning 再加进 total；失败、取消、重启 Attempt 的消耗照常计入。已提交但没有收集记录的 Attempt 记为 `uncollected` 并使结果不完整；从未提交的 Attempt 不制造缺失。缺失值为 null 并带 coverage（complete/partial/unavailable）与 diagnostics，只有完整空流才证明 0。

轨迹指标来自每个 Attempt 已保存的 SP Telemetry 事件，跨 Attempt/分页合并后按 `sessionId + operationId` 归并操作：

- Turn 数及 completed/failed/cancelled/inProgress/unknown；
- 按 `toolName` 的调用数、结果、耗时，输入长度（`tool.started` 的 `payload.input`）与返回长度（`tool.finished` 的 `payload.output`，缺失时用 `response`，不相加），均为规范 JSON 的 UTF-8 字节数；缺失或被 SP 脱敏（`[CONTENT OMITTED]`/`[REDACTED]`）记为 missing；
- 思考轮：Turn 或其关联 generation 的输出中出现 `thinking`、`signature` 或 `*Signature` 标记；内容轮：输出中出现 `content` 标记。一个 Turn 可以同时属于思考轮和内容轮，工具调用也单独计入工具操作，因此这些分类的数量不要求相加等于 Turn 总数。思考轮 Token 和内容轮 Token 分别汇总明确归属到对应分类的 `generation.finished` 的 input/output/total；同一 generation 同时命中两类时两边都会保留，缺少关联时为 partial/unavailable，不用减法推算。


## JSON Schema 输出字段

每条评估的 `structuredOutput.content` 先严格解析（拒绝重复键），再用 Ajv 2020 按 Project 锁定的 Schema 校验：`valid`、`invalid`（`invalid-json`、`unsafe-number`、`schema-mismatch`）或 `unavailable`（`no-output`、`no-structured-output`、`no-schema`、`invalid-schema`）。NaN/Infinity/超出安全整数范围使整份输出无效。只有成功评估的有效输出才产生观察。`createEvaluationResultValidator()` 以同一套解析与校验规则检查单段原始文本，供结果提交工具和 Runtime 判定评估是否成功。

链路固定为 Schema → 展示计划 → 单条观察事实 → 范围汇总。`CompiledOutputPlan` 在一次 Metrics 事实读取中编译一次，计划不持久化、不可单独编辑。计划保留每个统计声明的来源、交并关系、条件及引用上下文；Ajv 仍是唯一校验器，通过已注册的 Schema 和根文档/动态锚点上下文执行规则，不另建脱离根环境的子 Schema。编译器只在自己的 Schema 副本上加入无校验副作用的执行记录，保留根校验实际命中的分支、引用目标及当时的上下文；重新检查展示候选时不记录执行事实。JSON Pointer、本地锚点、嵌套 `$id`、`$dynamicRef` 和递归引用都由同一引用入口处理。

`OutputFieldDefinition` 是计划的可展示投影：`jsonPointer`、`title`（没有 Schema 标题时为字段路径，根字段为 `$`）、`description`（未声明时为 null）、`kinds`、`values`、`nullable`。标题与说明优先取字段位置，再按引用及分支的声明顺序补充，字段与选项保持 Schema 顺序。计划的规则不暴露给应用；API 直接返回汇总中的标题、说明及统计类型，Web 无须解释 Schema。

节点自身、引用目标及 `allOf` 必须同时满足；`anyOf`/`oneOf` 是备选，`if` 决定 `then`/`else`。未声明统计类型的位置只提供约束，不能产生统计资格。字段路径为 JSON Pointer，数组下标统一为 `*`（如 `/checks/*/passed`），`instancePointer` 保留实际下标。字段种类（`OutputFieldKind`）：

- `number`/`integer`：`type` 允许的数值类型，或允许取值中的数字（全为整数时为 `integer`，如 `enum: [0.5, 1]` 为 `number`）；两者兼有时为 `number`。
- `boolean`：允许 `true` 或 `false`（`type` 含 `boolean` 即两者，`enum`/`const` 只取列出的）；布尔值只按 boolean 汇总，不算 enum。
- `enum`：允许取值中列出的字符串或数字（含 `oneOf`/`anyOf` 各分支的 `const`）。数字枚举同时得到数值汇总与分布。
- 允许 null（`nullable`）：允许取值中含 null。null 不是种类，也不在 `values` 中，只计入该字段的 `nullCount`。

例如 `{type:["string","null"],allOf:[{enum:["a"]}]}` 只允许 `"a"`，`{type:["number","boolean"],allOf:[{type:"number"}]}` 只有 `number`。一个字段可兼有多个种类（如 `type:["integer","boolean"]`），每个观察的种类只来自实际命中且允许该值的统计声明。自由文本 `type:string` 不声明统计类型，即使另一未命中的分支把相同字符串列为枚举，也不能借用该分支的资格。至少有一个种类的字段才汇总；对象和最终只允许 null 的字段也不汇总，原值仍在单条详情中。枚举数组就是元素字段 `/tags/*` 上的 enum。

每个声明与其所在的完整约束组绑定，所有有限候选（boolean、enum、const、null）在原声明的约束组内由 Ajv 确认后才合并，包含 `const`/`enum`、数值范围、条件守卫和 `not` 等约束。宽松分支不能恢复其他分支排除的候选。数值类型的描述只用于选择数值展示类型，实际数值是否参与仍须命中声明并满足约束。数组在每个真实位置先合并所有适用的 `prefixItems`/`items`，再折叠成 `*`；`false` Schema 和超出 `maxItems` 的位置不能贡献声明。

依赖执行时动态绑定的有限候选，留待实际根校验提供上下文后确认；预展示不在缺少绑定的环境执行动态引用。未使用的 `$defs`、默认值和示例不形成标量候选的执行依赖。命中的字典键先保留该位置的完整标量展示定义，再从实际命中的分支产生观察，因此未出现的枚举选项仍显示为 0。

reader 每条记录只解析、校验和执行计划一次，保留全部观察事实，包括 null-only 分支、数组位置和 map 键上的 null。详情与聚合都消费事实：详情按该记录的字段定义选择，聚合按查询范围合并后的定义选择，不从详情反推观察。字段合并后仍无任何种类时才排除，因此 `[true,null]` 的同一 `*` 字段有两次观察，跨记录的 boolean/null map 也能正确计数。

每条评估的 `observations` 列出其中被汇总的每个标量值：`jsonPointer`、`instancePointer`、`value`（number/boolean/string/null，原样记录）与该值计入的 `kinds`（null 为空数组，只计入字段的 `nullCount`）。

`OutputFieldSummary` 合并计划的静态字段定义及范围内实际展开的定义（map、`patternProperties`、递归）。合并仅决定展示元数据，不能给任何观察补统计资格。同一 JSON Pointer 的定义复用唯一合并规则：number 吸收 integer，种类与 nullable 取并集，取值保持首次声明顺序，标题/说明保留首次定义；字面对象键 `*` 与数组元素归入同一路径也如此。汇总直接包含 `title`、`description`，无须再查询一份展示配置。

- `kinds`：该形态的种类。
- `observationCount`：被汇总的值总数（含 null），数组字段一条评估可贡献多个；`contributingEvaluationCount` 为至少有一个值的评估数；`missingEvaluationCount` 按 not-succeeded/invalid-output/unavailable-output/absent 诊断。null 是被观察到的值，不是缺失。
- `numeric`：有数值种类时为数字值的 count/total/min/max/mean/variance/median，否则为 null；null、布尔和字符串从不进入数值统计。
- `distribution`：该形态的 boolean 与 enum 取值，按形态顺序全部列出（未出现时 count 为 0）；没有 boolean/enum 种类的字段为空数组（数字枚举仍有取值分布）。条目给出 `count`（出现次数）、`evaluations`（包含该值的评估数）与 `share = count / observationCount`（分母含 null 和不在分布中的值，如混合字段的数字；无观察时为 null）。
- `nullCount`：null 出现次数，独立于 `distribution`；当且仅当形态允许 null 时存在（尚未出现 null 时为 0），否则省略。null 从不算作 false、任何枚举值或缺失。
- 展示：`distribution` 各条目加一个由 `nullCount` 得出的固定 null 条目，占比为 `nullCount / observationCount`；只有每个非 null 值都在分布中时（纯 boolean、enum 字段），它与各条目 share 之和才为 1。boolean 字段排除 null 的通过率不是字段，由 true 的 count / (observationCount − nullCount) 得出。缺失评估（`missingEvaluationCount`）不进入 `observationCount`，与 null 不同。
- `coverage`：没有观察值为 unavailable；范围内每条评估都为该字段贡献成功、合法的观察时为 complete；有观察但存在缺失、失败或不可用输出时为 partial。输出整体的校验 coverage 与字段 coverage 分别计算。

Schema 声明顺序指：先节点自身的 `properties`，再依次为 `$ref`、`allOf`、`anyOf`、`oneOf`、`then`、`else` 中的声明，逐层深度优先；数组先按前缀位置顺序合并完整约束，再处理尾项。字段按此顺序列出，再按首次出现顺序（评估顺序、文档顺序）列出静态遍历无法命名的字段。取值顺序同理：先 Schema 声明顺序，再按首次出现顺序列出到达的 Schema 位置新增的取值。缺失与失败从不按 0 或 false 计。没有评估计划时输出字段为 unavailable，执行指标照常。

## 错误

查询范围外的 Project/Run/Dataset/ProjectSample/Sampling 抛 `MetricsEntityNotFoundError`（entity 为 `project | run | dataset | project-sample | sampling`），非法查询抛 `MetricsQueryError`，来源事实不一致（重复身份、越界 Sampling、缺失绑定 ProjectSample、绑定与计划不符、Schema 与评估计划不符等）抛 `MetricsSourceError`。

不实现实验对比、归因、查询缓存、指标持久化或 API/Web/CLI；本包只有包根入口。

`createEvaluationScoreReader()` 为可选 Langfuse 集成提供只读派生接口：复用同一个 Schema presentation plan、严格 JSON 解析和安全数值校验，只从成功且校验通过的原始输出读取顶层 numeric score 与可选字符串 reason。每个 Schema 独立编译，复用 `$id` 不冲突；不保存另一份解析结果到 Runtime。


项目结果工作台：ProjectOverview 额外返回去重的 projectSamples 行及每行当前 samplingIds，沿用同一事实快照和 Metrics 聚合口径，不由前端合计子层统计。默认是当前有效采样及评估结果，非历史运行总和；指定运行的范围仍由 runIds 控制。Web 将数据集作为筛选，按用例聚合、展开采样，单次采样直接打开结果抽屉；运行记录与配置分开展示。采样详情和抽屉共用结果组件，评估内容与产物优先、技术统计按需展开，文件预览复用已有只读 Workspace API 和公共渲染器，不读取 SP 私有存储。

## Compact resource facts

`compactResourceCollection` derives telemetry metric facts without event bodies. It keeps canonical SHA-256 fingerprints for source conflicts, canonical input/output lengths (including omitted-body and output/response fallback semantics), and versioned thinking/content marker flags. A sanitized or stale projection cannot prove marker absence, so the interpreter reports partial/unavailable coverage until a current projection is available. The existing interpreter consumes these facts with the same operation merging, completeness, distributions and exact medians as raw snapshots. The API owns persistence; this package performs no storage or background work. Original facts and evidence are never replaced by the projection.
