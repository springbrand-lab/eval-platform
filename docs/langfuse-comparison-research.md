# Langfuse 比较看板事实调研

调研日期：**2026-10-28**。第 1–9 节为第一轮 Langfuse 实验比较事实调研，第 10 节记录第二轮对 eval-platform 当前能力的源码核验；**不是实施计划，业务代码未修改**。

## 1. 证据基线与阅读边界

| 项目 | 本次核验范围 |
| --- | --- |
| eval-platform | `/Users/apple/code/.worktrees/ep-results-agent-metrics-20261028`，HEAD `a2e9c35cfa307ef185720536f6c58c1fa1cf0e73`；第一轮读取仓库约束及笔记格式，第二轮业务实现的只读核验见第 10 节 |
| Langfuse 源码 | `/Users/apple/code/langfuse`，origin `https://github.com/langfuse/langfuse.git`；完整 HEAD **`9a29212e855c60ffb86d1989b62918b3781d9652`**，提交时间 `2026-10-01T14:23:32Z`；检查时工作树无修改 |
| 在线一手资料 | 本会话只读获取 langfuse.com 官方文档正文及官方 changelog，包括页面的 `.md` 正文；**没有核验线上应用部署 SHA 或文档仓库 SHA** |
| 新鲜度差异 | 在线存在 **2026-10-19** 的 Experiments 发布说明，新于本地 10 月 1 日源码。该说明中的多图表、汇总及审阅能力可作为官方产品声明，不能冒充其发布实现已在本地逐行验证。[W7] |
| 操作边界 | 未登录后台、未实测 UI、未启动服务/数据库、未安装依赖；未 fetch、切换或修改 Langfuse 仓库；未访问账户、密钥、私有数据或写第三方系统 |

下文使用四种证据标签：**文档事实**＝官方正文明确说明；**源码观察**＝上述固定提交中的行为；**推断**＝由事实推出的产品含义；**未知**＝本次未获得充分一手证据。所有入口和显示行为都不是浏览器验收结果。

已读取 research、codebase-design、Langfuse navigator 及 Langfuse 仓库约束。为解释数据路径，读取了 `clickhouse-best-practices`，并参考 `query-join-filter-before`、`query-join-null-handling` 关于查询范围与未匹配值的规则；本报告**不做 ClickHouse 性能、DDL 或调优合规审查，也不给优化建议**。

## 2. 概念纠偏：“项目对比看板”究竟指什么

**结论：最相关的已确证功能是同一 Langfuse Project 内的 Experiment/Dataset Run 比较，不是把 Project 本身当作候选版本。**

| 概念/功能 | 一手资料支持的含义 | 不应混同的内容 |
| --- | --- | --- |
| **Project** | **文档事实**：数据和访问控制隔离域；traces、scores、datasets、prompts 等归属 `projectId`。**源码观察**：实验比较和 Dashboard 请求都接受一个 `projectId` 并做项目权限检查。[W5][C8][C20] | 不是一次实验或一个模型版本。已核实入口不能证明原生跨 Project 联表比较；本次**未确证**这种功能，也不以搜索未命中断言整个产品不存在 |
| **Dataset / DatasetItem** | 测试集及测试用例，包含 input、expectedOutput、metadata。官方规定托管 DatasetItem ID 在 Project 内唯一，不能在另一 Dataset 复用。[W2] | Dataset 不是运行结果；相同内容、相同名称不等于同一个用例身份 |
| **Experiment Run / Dataset Run** | 官方把 DatasetRun 称为 Experiment Run：应用针对全部或选定 DatasetItems 的一次运行，可附带评分。新版 v4 也支持没有托管 Dataset 的本地数据实验。[W2] | “Experiment”和“Dataset Run”在这一产品语境常是同次运行的两种叫法，不是 Project 的别名；也不能把新版所有 Experiment 都要求为托管 DatasetRun |
| **Experiment Compare** | 比较多个运行的指标、输出和逐项差异，指定 baseline，打开关联 trace 做解释。[W1][W6] | 这是本次主要研究对象；比较对象是 run，不是多个权限隔离域 |
| **Trace Compare** | **确证的是**实验比较中的关联 trace 下钻；本地新版 peek 一次呈现一个 `TraceDetailBody`，可在同一样本的多个实验间切换。[C15] | 本次未确证一个独立、可任意选多条 trace 并自动对齐整棵调用树的通用 “Trace Compare”。检查的 `TracesTable` 批量菜单只有删除、加入标注队列等入口，不能据此证明所有版本都没有独立比较功能。[C21] |
| **Home / Custom Dashboards** | 项目级可观测指标分析：按模型、用户、时间等维度聚合 traces/observations/scores，配置 widgets、过滤和布局。现行官方文档还允许选择项目 Home 的默认 Dashboard。[W4][C20] | 能分析不同 cohort 的指标，不因此具备按稳定样本身份配对的实验比较语义；也不等于跨 Project 比较 |

**跨 Dataset ≠ 跨 Project。** 当前官方比较文档允许不同数据来源的 runs，但要求先确认输入和期望输出可比；本地新版选择器把运行按 Dataset 分组、优先显示 baseline 所属 Dataset，而不把别的 Dataset 禁选。托管 DatasetItem ID 又不能跨 Dataset 复用，因此“可同时选择”不能解读为“能自动找出语义相同的逐样本配对”。[W1][W2][C5]

## 3. 已核实的入口、对象数量与基线机制

### 3.1 旧版 Dataset Compare：一个 Dataset 内挑选多个 runs

**文档事实 + 源码观察**：

1. 进入 Project → **Datasets** → 某 Dataset → **Experiments**。
2. 勾选 runs → **Actions → Compare**，进入 `/project/{projectId}/datasets/{datasetId}/compare?runs=...`。
3. **Outputs** 显示逐项对照；**Charts** 显示选中运行的指标；每个运行列头可 **Set as baseline / Clear baseline**，基线放在 URL 的 `baseline` 参数中。[W8][W6][C3]

所查旧版选择逻辑和 router 没有显式最大 run 数校验；**不能据此写“无限制”**。动作菜单只要求至少选中一行；Charts 的数据 hook 在多于一个 run 时才启用比较查询。选择器不允许删掉最后一个运行。[C3][C16]

### 3.2 本地新版 Experiments：Project 级运行目录与比较结果页

**源码观察，限定于本地版本**：

- 新入口 `/project/{projectId}/experiments`；Dataset 的 Experiments 页也能显示限定该 Dataset 的同一新版表。勾选运行 → **Compare** → `/project/{projectId}/experiments/results?baseline=A&c=B&c=C`。[C2][C4]
- 比较动作以**当前表格顺序中最上方的已选行**为初始 baseline，其余为 comparisons；不是按用户点击顺序，也不是自动批准“生产版本”。[C4]
- **最多 10 个选中运行，包含 baseline**。超过 10 个，表格 Compare 禁用；结果页去重后保留前 10 个；有基线时就是 1 个 baseline 加至多 9 个 comparisons。用户可换基线、清空基线但保留所选运行。这个上限是源码事实，**不是对 10 月 19 日以后线上上限的验证**。[C4]
- 打开只有 baseline 的结果页时，默认可自动加入同 Dataset 的上一个运行作为 comparison；有可关闭的用户偏好；不会自动跨 Dataset 挑 comparison。它只是便利选择，不是合格性或基线批准机制。[C5]
- 新版可访问性由 **v4 read path** 决定；本地 `useExperimentAccess` 明确没有独立 Experiments opt-in。旧 compare 页在该状态下重定向至新结果页。这是版本/读取路径切换，不应误写为付费开关。[C2]

**在线文档事实**：现行流程是打开 Experiments、选择可比 runs、打开比较并选择已审阅的 release run 为 baseline；2026-10-19 发布说明建议选择两个或更多运行进行逐项比较。**UI 里的 baseline 选择不配置 CI gate，也不等于批准发布基线**，批准及发布策略由团队另行维护。[W1][W7]

## 4. 比较能力：确证项与重要限定

| 关注点 | 核实结果 |
| --- | --- |
| **运行总览** | **文档事实**：质量、成本、延迟的跨运行图表与 summary statistics，并可从均值进入回归用例。[W1][W7] **源码观察**：新版运行表含 itemCount、errorCount、Prompt、metadata、totalCost、平均 root span 时长，以及 trace/observation item scores 和 experiment-level scores；本地表上方是单个可切指标的 metric strip，不能用它代替 10 月 19 日多图表布局的实现证据。[C7][C8] |
| **逐样本布局** | **源码观察**：支持 Side by side（每实验一列）、Diff（每样本一行，堆叠各实验值）、Score matrix（评分为行、运行为列）；Input、Expected Output、Output、评分和资源指标可控制列可见性与行高；I/O 支持 JSON/Formatted。[C6] |
| **baseline / candidate 差值** | **文档事实**：评分、成本、延迟的差值指示及关联 trace 访问。[W6] **源码观察**：逐项 numeric diff 为“当前值 − baseline”，任一侧为空不算差值；categorical 显示变化而不计算数值距离。成本/延迟更低显示为较好方向；不能把所有正差值都解释为改善。[C11][C14] |
| **按类型汇总评分** | **源码观察**：本地新版页级汇总对 numeric 取样本值均值、boolean 取 true-rate、categorical 展示众数及分布；统计 improved/regressed/unchanged/changed/notComparable。两侧各自已有评分的样本参与各自均值，movement 才逐对计算，**不是只在共同有效样本上算的配对均值差**。汇总的 delta 方向为其 primary/baseline 减 comparison，与候选单元格可能相反。[C11] |
| **总览与当前页不是同一范围** | **源码观察**：run-level metrics 以运行 ID 查询整体；本地新版逐项表汇总基于已加载页，grid 明写 **`SUMMARY · this page`**。List 列头和 Score matrix 使用评分比较筛选前的整页；grid 则收到筛选后的可见行用于其 summary。不同布局的局部统计范围也不应默认为一致，更不能当全 Dataset/全运行的回归计数。[C8][C11][C12] |
| **筛选** | **文档事实**：按评分阈值缩小结果；旧发布说明也描述成本/延迟等条件。[W1][W6] **源码观察**：新版可指定筛选作用于哪个实验，支持状态 level、ID、时间、成本、延迟、numeric/boolean/categorical scores、item/event metadata；普通条件传后端。另有 Worse/Better/Different 的**评分间比较筛选仅在当前已加载页客户端执行**，URL 可分享；任一侧无评分不匹配这些比较条件，不表示该样本通过。[C12] |
| **排序** | **已核实区别**：运行列表把 `orderBy` 传到 repository；但本地逐项列表虽存在排序状态、控件及输入参数，`experiments.items` 没把 `input.orderBy` 传入 repository，样本 qualification 固定按 `experiment_item_id ASC`。旧版对照表也没有向该查询传排序字段。**未确证逐项全量 score-delta 排序，不应写成已有能力**；最新线上是否修正未知。[C9][C12] |
| **版本与配置元数据** | **文档事实**：比较 release runs 应使用同一 Dataset 版本及 evaluator 定义；记录应用 commit、prompt/model/evaluator version。[W1] **源码观察**：运行列表展示 Prompt 名称/版本链接和 metadata；Baseline details 展示 Dataset、首个 Prompt 及版本、metadata 中的 provider/model、其余 metadata，也识别 PR/CI job URL。不能把“能展示 metadata”当成“自动冻结并校验所有配置版本”。[C7][C13] |
| **差异下钻与审阅** | **文档事实**：打开失败样本 trace 检查 retrieval/model/tool；可增加人工分数、评论、修正输出，协作使用 annotation queues。[W1][W7] **源码观察**：点具体实验单元格，peek 会选该实验 trace/observation，而不是无条件回到 baseline；可以切换所选实验、展开到 trace 页面。旧比较页另有 Annotate 侧栏。[C15][C16] |
| **输出差异的实际含义** | 已确证并排输出及指标差值，不应追加“自动理解 Agent 行为差异”。本地 `Expected → Output` 模式做的是去首尾空白后的**精确字符串相等**，不是语义评分；若相等文本可能已被截断则不显示 match 结论。该能力也不证明有通用代码 diff 或跨 trace 树节点自动对齐。[C6][C10] |

### 4.1 缺失、失败与不可比较：不能合并成一个“差”

以下是不同数据状态的呈现，主要为**源码观察**：

- **某 run 没有该 item 的结果**：新版 grid 显示 **No data**；切到无对应 trace 的实验，peek 明确显示 **No run for this item in the selected experiment**。旧表在无 runData 时留空；新建运行短时间内可能先显示 skeleton。[C14][C16]
- **baseline 外的样本**：新版默认 `baseline-only`，可切 **Show all items**；这是从已记录实验项选择 baseline 集合或更宽集合，不是校验完整 Dataset 必需项。**推断**：所有所选运行都没有记录的必需用例，不会凭该 events 查询自动补成缺失行。[C6][C9]
- **未记录成本/延迟**：新版单元格和运行指标组件有 **not recorded**，tooltip 解释来源。需注意本地运行列表还把 `cost === 0` 视为未记录，而 grid 单元格仅检查空值、可显示 0；这不是统一的“已证明免费”或数据完整性契约，不宜照搬。[C14]
- **未评分或不可比较评分**：汇总单独列 **Not scored**；单侧缺分、categorical 没有唯一代表值等进入 notComparable，不计作 improved/regressed；无评分不产生差值。[C11]
- **已记录 ERROR**：运行总览 errorCount 统计含 ERROR observation 的不同 item，点击能进入对应状态筛选；单元格也能显示 level。这里的 ERROR 是可观测记录的等级，**不是执行/取消/重试的完整生命周期状态机**。[C7][C8][C14]
- **trace/observation 404**：旧比较单元格有 NotFoundCard，与仍在加载、未输出是不同分支。[C16]

**未知**：最新线上对任务未启动、取消、超时、整次实验配置失败、evaluator 独立失败的全部视觉状态，本次未实测。官方要求先处理 evaluator 无结果/错误，不能因此推断 UI 会替用户完成完整性 gate。[W1]

## 5. 支撑产品结论的身份与持久化路径

### 5.1 样本对齐靠身份，不靠行序、输出或 trace ID

**旧版源码观察**：

```text
Project
  └─ Dataset
       ├─ DatasetItem.id                ← 跨运行稳定的样本身份
       └─ DatasetRun.id                 ← 一次运行身份
            └─ DatasetRunItem
                 ├─ datasetItemId
                 ├─ traceId
                 └─ observationId?     ← 追踪下钻目标，不是样本对齐键
```

- PostgreSQL `Dataset`、带 `validFrom/validTo` 的 `DatasetItem`、`DatasetRuns` 描述目录/版本/运行；run name 在 `(datasetId, projectId, name)` 内唯一。创建或获取同名 run 返回同一 run ID；每次结果关联的 run-item ID 本身不适合作为跨 run 的样本 ID。[C1]
- 旧比较先查符合过滤的 **datasetItemIds**，再取这些 item 在所有选中 runs 下的结果，以 `item.id → runData` 组织表格。不同实验各有 trace，能比较是因为共同引用 DatasetItem。[C16]
- **版本注意**：旧比较共享的 input/expectedOutput 栏从未指定历史版本的 ACTIVE DatasetItems 读取，而非逐个 run 的冻结输入。新版 batch I/O 优先取 baseline 的 input/expectedOutput，缺失再取其他非空值；这也不是对每侧输入相等的校验。[C10][C16]

**新版源码观察**：

- 输入 OTel attributes 含 `langfuse.experiment.id`、`langfuse.experiment.dataset.id`、`langfuse.experiment.item.id`、item version、root observation ID、期望输出及 metadata；服务端将其转成 event 的对应字段。[C18]
- 旧 run-item 向 events 传播的映射明确为 `experiment_id = dataset_run_id`、`experiment_item_id = dataset_item_id`；新版查询在单一 Project 范围内按 **`experiment_item_id`** 分组，再按 `experiment_id` 填各列。[C9][C18]
- local-data 实验也可进入 Experiments，但本报告未审计各 SDK 的本地 item ID 生成算法，**不声称按内容哈希或列表下标自动可靠配对**。[W2]

**推断**：ID 相同只保证身份相同，不保证输入/期望输出版本相同。DatasetItem 版本主键包含 `validFrom`，比较分组却不是按 `(itemId, version)`；因此需额外判断数据版本、evaluator 定义及输入证据是否可比。官方 Dataset 版本记录 item 的增改删/归档，不包含 Dataset schema 版本；默认读取 latest。[W1][W3][C1][C9]

### 5.2 运行结果不是一个“比较页面缓存”

**旧链路源码观察**：[C17]

```text
POST dataset-run-items
  → 按 Project + Dataset + runName 创建/获取 PostgreSQL run
  → 产生关联 trace/observation、DatasetItem 版本的 ingestion event
  → Worker 写 ClickHouse run-item 记录
       保存 run/item 身份、输入/期望输出/metadata 快照、版本、error
  → 比较读取时关联实际 trace/observation 输出及独立 scores
```

**v4 链路源码观察**：[C18]

```text
带 experiment/item attributes 的 trace observations
  → OTel 字段提取
  → eventRecord 保存 experiment/item/root-span/version 等归属
  → EventsFull 写队列（其下游生成 core 数据）
  → Experiments repository 从 events 聚合 runs / 读取逐项结果
```

在 `events_only` 部署中，旧 `POST dataset-run-items` 兼容接口**不再写旧 run-item 表**，只根据 `(projectId, datasetId, runName)` 返回稳定 experiment ID；真实 trace ↔ experiment 归属来自 OTel ingestion。不能把这次 HTTP 响应误当成“实验结果已持久化”。这也说明不能把所有版本都解释成“先存一张独立 Experiment 表再比较”。[C18]

评分独立保存，带 `trace_id`、`observation_id` 或 `dataset_run_id` 等归属；比较读取保留 observation item scores、trace item scores 与整次 experiment scores 的区别。**整次 run 的 evaluator 分数不必等于逐项分数平均值**，官方也单独定义 Run Evaluator。[W2][C8][C19]

### 5.3 聚合、逐样本与重复执行的关系

- **运行整体**：本地 events 聚合的 cost 为运行 observations 的 cost 总和；平均延迟取已结束 item root spans 的时长，不是整个实验调度 wall-clock，也不是每个工具耗时简单相加。itemCount 是不同 item ID 数；errorCount 是至少记录一次 ERROR 的不同 item 数。[C8]
- **逐样本**：查询先确定样本 ID 页，再取这些样本的所有所选实验数据；cost 覆盖该样本对应 trace 的 observation 子树，延迟来自所选 root 行；随后用 observationId/traceId 关联评分并加载 I/O。**概览和细表共享运行/样本身份，但不保证范围、覆盖率和聚合公式相同**。[C9]
- **重复执行限制十分关键**：现行官方数据模型明确假定每个 DatasetItem 在一个实验只出现一次，读取至多一个结果。本地查询也对 `(experiment_item_id, experiment_id)` 选 root 优先、开始时间较新的一个结果，I/O 同样取最新。**这不是多次采样分布，也不是保留全部 Attempts 的比较模型**。[W2][C9][C10]

## 6. 最有借鉴价值的八个产品模式

以下为基于上述事实的**产品归纳**，不代表本平台已决定实现：

1. **稳定样本 × 候选运行的结果矩阵**：身份对齐，缺侧显式呈现；读者不必在多次运行详情之间手动找同一用例。[C9][C14]
2. **总览 → 退化用例 → 原始证据的漏斗**：先比较质量/成本/时间，再检查具体输出、评分解释和 trace，避免只凭平均分选版本。[W1][W7]
3. **显式 baseline，其他候选围绕它阅读**：可切换/清除，选择与布局写进 URL；批准发布基线与临时查看基准分开。[W1][C4][C6]
4. **类型感知的评分汇总及 movement**：numeric 均值、boolean 比率、categorical 分布各用合适语义；单列出不可比较样本，而不是把所有分数强转成平均值。[C11]
5. **有实验作用域的筛选工作单**：既能设某运行阈值，也能定位一对结果的变化，并明确客户端页级筛选范围；过滤视图可转交审阅者。[W1][C12]
6. **质量、资源开销、版本背景同时可读**：不同模型/Prompt 版本和配置元数据紧挨结果，支持判断“质量改善是否值得代价”，而不是单指标排行榜。[W1][C7][C13]
7. **比较与人审在同一上下文闭环**：评分、评论、修正输出及队列协作不必离开用例；trace 下钻选中准确候选，避免看错 baseline。[W7][C15][C16]
8. **同一数据多种阅读形态**：并排输出、堆叠对照、评分矩阵与可调行高，兼顾长文本阅读和密集指标扫描；明确精确输出匹配不是语义正确性。[C6][C10]

## 7. 给第二轮调研的产品约束：不能直接照搬的假设

以下是**研究交接约束，不是实施步骤或新业务契约**：

- **先界定本平台比较的是哪些对象**：Langfuse Project 是权限域，不能直接映射成本平台固定配置/数据快照的 Project。若本平台要比较不同 Project，需另核实所有权、共同样本身份与冻结版本；不能只把 Project 名称换成 Langfuse run 名称。
- **保留多层执行身份**：Langfuse“一个 item / 实验只读一个结果”的假设，不适用于已有 ProjectSample、多个 Sampling、独立 Evaluation 和 Attempt。不能用“最新一条”抹掉重复采样、重评、重试或替换语义，也不能拿任意业务 `sampleId`、行号、Chat/trace ID 充当平台样本身份。
- **完整性不能由有数据的行反推**：baseline-only、页内比较过滤和忽略单侧缺分会让缺失退出可见集；缺失、未评、失败、取消、资源缺报不等于 0 或通过。必需样本集合、共同覆盖范围及总览分母必须能被解释。
- **总体统计与显示页严格区分**：本地 Langfuse 的页级 summary、movement、比较过滤不能冒充全量实验统计；均值差不等于配对变化均值，页内“没有回归”也不等于全运行无回归。不能照搬尚未核实有效的全量排序能力。
- **版本与分数方向必须可解释**：同一 item ID 不保证相同输入；同名 evaluator/score 不保证相同规则。成本/耗时通常越低越好，但风险分等指标也可能越低越好，不能沿用“评分高就是改善”的硬编码。临时 baseline 不自动成为批准的 release baseline。
- **Agent 证据不能简化为一段 output**：本平台既有约束要求产物为主要证据、完整轨迹为辅助证据；执行 Agent 与评估 Agent 分开，Dataset/Execution/Evaluation 独立启动。不能用单个 root span 或最终答复替代产物、结构化评估结果和完整轨迹。
- **资源指标不能套用 LLM 调用计费假设**：Langfuse 的 cost 基于上报 token/模型定价，root span 时长不是本平台任务全生命周期。不得将 provider USD、实际结算/Action 费用、资源覆盖率或执行 Agent/评估 Agent 统计混为一个“成本”，也不能从缺报推得免费。
- **复用呈现模式，不改变事实归属**：第二轮仍受根 `AGENTS.md` 和 `docs/package-boundaries.md` 约束：不读写 SP 私有存储，不改 Subject/Evaluator 公共契约，不让前端页内合计取代既有 Metrics 口径，不把比较界面变成新的运行状态来源。平台显示角色仍为“执行 Agent / 评估 Agent”。

本平台约束定位：`AGENTS.md:7–20`；`docs/package-boundaries.md:97–103`（固定样本、独立 Evaluation 与证据）、`:157`（所有权和 Metrics 范围）、`:165`（分页不改变 Metrics 范围）、`:205`（结果工作台及同一事实快照）。这些是交接前提，不是本轮对本平台实现完成度的判断。

## 8. 开源/商业边界与仍未知的信息

**已核实**：

- 根 `LICENSE:3–17` 指定 `ee/`、`web/src/ee/`、`worker/src/ee/` 以外的相应内容适用 MIT；`ee/LICENSE:1–23` 明确商业许可边界。所查核心实验比较路径位于普通 `web/src/features`、`packages/shared`、`worker/src/features`，不能说“baseline 比较是企业版专属”。[C22]
- 当前官方自托管价格表把 Datasets、SDK/UI Experiments、Custom dashboards 列为 Open Source 可用；没有在该表中看到单列“比较最多几个运行”的付费限制。**这不构成所有云套餐、组织权限或未来版本均无差异的承诺**。[W9]

**未核实/不得推断**：

1. 最新在线应用精确版本、10 月 19 日发布实现的源码定位、线上数量上限及逐项排序是否与本地一致。
2. 独立任意 Trace Compare、跨 Project 原生比较/聚合的完整能力与限制；本轮只证实项目内实验比较和关联 trace 下钻。
3. 任意不同 Dataset/本地数据间自动语义配对，以及所有 SDK 的 item ID 生成算法。
4. 自动统计显著性检验、置信区间、Agent 轨迹结构 diff；本次证据不足，不能因有 summary/delta 就补齐。
5. 未启动/取消/超时/evaluator 失败的最新 UI 全状态、UI 选基线之外的自动发布批准机制。

## 9. 主要来源与固定源码索引

### 官方文档与发布说明

- **W1**：[Compare experiments][W1] — 可比运行、baseline、逐项审阅、缺结果、版本和 CI gate 区别。
- **W2**：[Experiments Data Model][W2] — Project 内 item ID、DatasetRun/Experiment Run、run/item/trace/score 关系、本地数据及不支持 repetitions 的读取假设。
- **W3**：[Datasets — Versioning][W3] — 时间戳版本、默认 latest、仅 item 版本而非 schema 版本。
- **W4**：[Custom Dashboards][W4] — widget 配置、维度/过滤、项目协作及 Home 默认 Dashboard。
- **W5**：[Data isolation][W5] — Project 数据与授权隔离，不是独立部署或实验版本。
- **W6**：[2025-11-06 Baseline Support in Experiment Compare View][W6] — 基线、逐项差值、Charts/Outputs 和 trace 下钻的历史发布事实。
- **W7**：[2026-10-19 Experiments show which metric moved, and why][W7] — 新于本地源码的图表/汇总/阈值/人审发布声明。
- **W8**：[2024-11-18 Dataset Run Comparison View][W8] — 早期 Dataset → runs → Actions → Compare 入口。
- **W9**：[Self-Hosted Pricing][W9] — 本次读取时的 OSS 功能列表；不是未来套餐承诺。

### 本地源码索引

以下路径均相对 `/Users/apple/code/langfuse`，链接固定到 **`9a29212e855c60ffb86d1989b62918b3781d9652`**；附属路径也使用同一版本与本地行号。

| 编号 | 已读文件与关键行 |
| --- | --- |
| [C1] | `packages/shared/prisma/schema.prisma:626–708`：Dataset、版本化 DatasetItem、DatasetRuns；`packages/shared/src/server/repositories/dataset-runs.ts:30–73`：按 Project/Dataset/name 创建或复用 run |
| [C2] | `web/src/features/experiments/hooks/useExperimentAccess.ts:1–15`；`web/src/features/datasets/DatasetComparePage.tsx:227–256`：旧页重定向；`web/src/features/experiments/ExperimentsPage.tsx:20–79`；`web/src/features/datasets/DatasetExperimentsPage.tsx:239–251` |
| [C3] | `web/src/features/datasets/components/DatasetRunsTable.tsx:122–144`；`web/src/features/navigation/utils/dataset-run-compare-tabs.ts:3–23`；`web/src/features/datasets/components/DatasetRunAggregateColumnHelpers.tsx:46–105`；`web/src/features/datasets/hooks/useDatasetRunCompareChartData.ts:14–38`；`DatasetComparePage.tsx:130–176` |
| [C4] | `web/src/features/experiments/hooks/useExperimentResultsState.ts:35–108`；`web/src/features/experiments/constants/comparison.ts:1`；`web/src/features/experiments/components/table/ExperimentsTable.tsx:137–230` |
| [C5] | `web/src/features/experiments/components/ExperimentComparisonSelector.tsx:175–195`；`web/src/features/experiments/hooks/useExperimentComparisonAutoSelect.ts:18–73` |
| [C6] | `web/src/features/experiments/components/ExperimentDisplaySettings.tsx:83–156`；`web/src/features/experiments/hooks/useExperimentResultsState.ts:113–159`；`web/src/features/experiments/ExperimentResultsPage.tsx:128–190` |
| [C7] | `web/src/features/experiments/components/table/ExperimentsTable.tsx:584–633,683–736,739–805`；`web/src/features/experiments/components/ExperimentMetricStrip.tsx:59–60,126–159` |
| [C8] | `web/src/features/experiments/server/router.ts:435–491`；`packages/shared/src/server/queries/clickhouse-sql/event-query-builder.ts:1969–1990`：run-level item/error/cost/latency/Prompt 聚合 |
| [C9] | `packages/shared/src/server/repositories/experiments.ts:1054–1135,1191–1199,1271–1402`；`web/src/features/experiments/server/router.ts:309–324,626–765`：列表排序传参、样本对齐、页范围、cost 子树、选择单个结果及评分关联 |
| [C10] | `packages/shared/src/server/repositories/experiments.ts:1427–1532`；`web/src/features/experiments/components/table/ExperimentItemsTable.tsx:366–386`：batch I/O、基线值优先、截断和精确匹配 |
| [C11] | `web/src/features/experiments/fns/summariseScoreColumn.ts:12–48,93–133,144–233`；`web/src/features/experiments/components/table/ExperimentGridSummary.tsx:67–80,112`；`ScoreColumnHeaderSummary.tsx:227–254`；`web/src/features/datasets/lib/calculateBaselineDiff.ts:25–85` |
| [C12] | `web/src/features/experiments/config/experiment-items-filter-config.ts:9–130`；`web/src/features/experiments/hooks/useScoreComparisonFilters.ts:10–26`；`web/src/features/experiments/fns/scoreComparisonFilter.ts:79–116`；`ExperimentItemsTable.tsx:626–629,692–713,1026–1048,1760–1782,2102–2132`；排序落点见 C9 |
| [C13] | `web/src/features/experiments/components/ExperimentOverviewPanel.tsx:42–69,112–145,155–184`：模型 metadata、Prompt 链接、CI 信息与额外 metadata |
| [C14] | `web/src/features/experiments/components/table/ExperimentGridView.tsx:179–224`；`ExperimentGridCell.tsx:335–408,733–737`；`NotRecordedMetric.tsx:3–23`；`createExperimentMetricColumn.tsx:12–54` |
| [C15] | `web/src/features/experiments/components/table/ExperimentItemsTable.tsx:1661–1691`；`web/src/components/table/peek/peek-experiment-item-detail.tsx:17–41,59–66`；`web/src/features/experiments/components/ExperimentPeekFooter.tsx:31–68` |
| [C16] | `web/src/features/datasets/server/dataset-router.ts:1947–2051`；`web/src/features/datasets/components/DatasetRunAggregateColumnHelpers.tsx:199–215`；`DatasetAggregateTableCell.tsx:65–105,144–159,181–194,205–217`；`DatasetCompareRunsTable.tsx:70–86,245–269` |
| [C17] | `web/src/features/datasets/server/publicDatasetService.ts:815–949`；`worker/src/services/IngestionService/index.ts:533–622`：旧 API 关联、版本和 run-item 快照写入 |
| [C18] | `packages/shared/src/server/otel/attributes.ts:46–55`；`OtelIngestionProcessor.ts:3465–3540`；`worker/src/services/IngestionService/index.ts:482–529`；`worker/src/features/eventPropagation/handleExperimentBackfill.ts:487–519`；`web/src/pages/api/public/dataset-run-items.ts:24–36`；`publicDatasetService.ts:727–812`：v4 字段、持久化及 events_only 兼容语义 |
| [C19] | `worker/src/services/IngestionService/index.ts:690–707,790–799`：scores 独立写入；按评分层级读取见 C8 |
| [C20] | `web/src/features/dashboard/README.md:3–16`；`web/src/features/dashboard/server/dashboard-router.ts:446–483,500–531`：Dashboard 项目作用域 |
| [C21] | `web/src/features/traces/TracesTable.tsx:704–733`：所查 trace 批量菜单；这只是限定入口的观察，不是全产品不存在证明 |
| [C22] | `LICENSE:3–17`；`ee/LICENSE:1–23`：MIT 与 Enterprise 许可范围 |

### 本轮验证记录

使用 `code_search` 定位后，以 `git rev-parse/log/remote/status/ls-files/grep`、`ls`、`cat/sed/nl` 等只读检查源码；以 `web_search` 和只读 HTTP GET 核验官方正文。报告做了引用完整性、源码范围及尾随空白检查，仓库做了 `git diff --check`。未运行应用测试、lint、构建或数据库检查：本轮只新增本文，没有业务代码变更，也未启动任何栈。源码结论限定于上述提交，UI 能力注明来自文档或源码，而非运行验收。

[W1]: https://langfuse.com/docs/evaluation/experiments/compare-experiments
[W2]: https://langfuse.com/docs/evaluation/experiments/data-model
[W3]: https://langfuse.com/docs/evaluation/experiments/datasets#versioning
[W4]: https://langfuse.com/docs/metrics/features/custom-dashboards
[W5]: https://langfuse.com/security/data-isolation
[W6]: https://langfuse.com/changelog/2025-11-06-compare-view-baseline-support
[W7]: https://langfuse.com/changelog/2026-10-19-experiments
[W8]: https://langfuse.com/changelog/2024-11-18-dataset-runs-comparison-view
[W9]: https://langfuse.com/pricing-self-host
[C1]: https://github.com/langfuse/langfuse/blob/9a29212e855c60ffb86d1989b62918b3781d9652/packages/shared/prisma/schema.prisma#L626-L708
[C2]: https://github.com/langfuse/langfuse/blob/9a29212e855c60ffb86d1989b62918b3781d9652/web/src/features/experiments/hooks/useExperimentAccess.ts#L1-L15
[C3]: https://github.com/langfuse/langfuse/blob/9a29212e855c60ffb86d1989b62918b3781d9652/web/src/features/datasets/components/DatasetRunsTable.tsx#L122-L144
[C4]: https://github.com/langfuse/langfuse/blob/9a29212e855c60ffb86d1989b62918b3781d9652/web/src/features/experiments/hooks/useExperimentResultsState.ts#L35-L108
[C5]: https://github.com/langfuse/langfuse/blob/9a29212e855c60ffb86d1989b62918b3781d9652/web/src/features/experiments/components/ExperimentComparisonSelector.tsx#L175-L195
[C6]: https://github.com/langfuse/langfuse/blob/9a29212e855c60ffb86d1989b62918b3781d9652/web/src/features/experiments/components/ExperimentDisplaySettings.tsx#L83-L156
[C7]: https://github.com/langfuse/langfuse/blob/9a29212e855c60ffb86d1989b62918b3781d9652/web/src/features/experiments/components/table/ExperimentsTable.tsx#L584-L805
[C8]: https://github.com/langfuse/langfuse/blob/9a29212e855c60ffb86d1989b62918b3781d9652/web/src/features/experiments/server/router.ts#L435-L491
[C9]: https://github.com/langfuse/langfuse/blob/9a29212e855c60ffb86d1989b62918b3781d9652/packages/shared/src/server/repositories/experiments.ts#L1271-L1402
[C10]: https://github.com/langfuse/langfuse/blob/9a29212e855c60ffb86d1989b62918b3781d9652/packages/shared/src/server/repositories/experiments.ts#L1427-L1532
[C11]: https://github.com/langfuse/langfuse/blob/9a29212e855c60ffb86d1989b62918b3781d9652/web/src/features/experiments/fns/summariseScoreColumn.ts#L144-L233
[C12]: https://github.com/langfuse/langfuse/blob/9a29212e855c60ffb86d1989b62918b3781d9652/web/src/features/experiments/hooks/useScoreComparisonFilters.ts#L10-L26
[C13]: https://github.com/langfuse/langfuse/blob/9a29212e855c60ffb86d1989b62918b3781d9652/web/src/features/experiments/components/ExperimentOverviewPanel.tsx#L42-L184
[C14]: https://github.com/langfuse/langfuse/blob/9a29212e855c60ffb86d1989b62918b3781d9652/web/src/features/experiments/components/table/ExperimentGridCell.tsx#L335-L408
[C15]: https://github.com/langfuse/langfuse/blob/9a29212e855c60ffb86d1989b62918b3781d9652/web/src/components/table/peek/peek-experiment-item-detail.tsx#L17-L66
[C16]: https://github.com/langfuse/langfuse/blob/9a29212e855c60ffb86d1989b62918b3781d9652/web/src/features/datasets/server/dataset-router.ts#L1947-L2051
[C17]: https://github.com/langfuse/langfuse/blob/9a29212e855c60ffb86d1989b62918b3781d9652/web/src/features/datasets/server/publicDatasetService.ts#L815-L949
[C18]: https://github.com/langfuse/langfuse/blob/9a29212e855c60ffb86d1989b62918b3781d9652/worker/src/services/IngestionService/index.ts#L482-L529
[C19]: https://github.com/langfuse/langfuse/blob/9a29212e855c60ffb86d1989b62918b3781d9652/worker/src/services/IngestionService/index.ts#L690-L707
[C20]: https://github.com/langfuse/langfuse/blob/9a29212e855c60ffb86d1989b62918b3781d9652/web/src/features/dashboard/server/dashboard-router.ts#L446-L531
[C21]: https://github.com/langfuse/langfuse/blob/9a29212e855c60ffb86d1989b62918b3781d9652/web/src/features/traces/TracesTable.tsx#L704-L733
[C22]: https://github.com/langfuse/langfuse/blob/9a29212e855c60ffb86d1989b62918b3781d9652/LICENSE#L3-L17

## 10. 第二轮：eval-platform 当前能力核验

第二个子 agent 基于第一轮结论调查本平台，随后对历史读取、计划摘要和可比性进行了聚焦复核。以下是截至上述 eval-platform 提交的源码事实及必要的研究结论，不是已经实现的比较功能。

| 关注点 | 核验结果 |
| --- | --- |
| **当前结果不是历史结果快照** | 执行重跑会删除被替换 Sampling 的评估成员、Evaluation、执行成员和 Sampling，再插入新记录；评估重跑保留 Sampling，但替换其当前 Evaluation。删除与新 Run 准入在同一事务内完成。因此不能仅凭旧 Run ID 还原被替换前的完整结果集。[E1] |
| **旧 Run 正常情况下仍可读，但成员会缩水** | Run 的 `samplingIds` / `evaluationIds` 从当前成员表读取，不是存在 Run 行中的原始结果快照。正常替换成对删除成员和结果，旧 Run 可只剩部分成员或空成员；`readRunView` 的 missing-member 错误是防御性不一致分支，不能说旧 Run 必然报错。Web 已说明被替换的历史结果不在当前汇总中。[E2][E3][E9] |
| **`runIds` 不等于时间旅行查询** | Metrics 对当前 Sampling/Evaluation 及当前 Run 成员做过滤；被物理替换的记录不再出现在这些查询里。没有核验备份或外部留存，不能据此断言任何其他来源都无法恢复；可以确认现有公开读取路径不提供完整历史还原。[E4] |
| **跨 Project 需区分样本身份与输入版本** | `ProjectSample` 保存创建时的完整 Data 副本，`(projectId, dataId)` 唯一；同一个源 Data 在一个 Project 内去重，但在另一 Project 中可以冻结为不同内容。`dataId` 能作为对齐身份，不能独自证明输入等价；各 Project 的 `projectSampleId` 不应直接配对。[E5] |
| **计划 digest 是完整性指纹，不是跨 Project 的语义配置指纹** | `digestExecutionPlan` 包含独立生成的 `projectSampleId`，以及带冻结 Agent 引用的完整执行计划。不同 Project 即使使用相同模型和指令也可能有不同 digest；digest 不同不能直接判定模型、指令或评分标准发生变化。[E6] |
| **输入应遵循实际消费投影** | 执行初始化排除评估专用字段和平台身份；评估使用自己的 `evalPrompt`、素材和 Schema。不能简单把整条 Data 的摘要当成两类输入各自的等价判定，也不能把任意业务字段擅自当作纯展示信息而剔除。初始资源的引用身份与平台的不可变内容约定应分别说明，未额外读取/校验的文件字节不能声称本轮已经核验。[E8] |
| **已有 Metrics 类型可以承载大部分描述性比较** | `MetricSummary` 分开执行与评估资源；数值、有效观察数、缺失、coverage、布尔/枚举分布已有公共模型。该模型要求每层由底层事实重算，不平均子层 summary；比较页的可见 20 行不能冒充全范围统计。[E7] |
| **当前一致性读取只覆盖一个 Project** | `createPostgresMetricsSource.read` 在 owner 作用域内，以一个 `READ_SNAPSHOT` 事务读取单个 Project 的计划、Schema、样本与结果。循环调用它得到的是多个事务，不是跨 Project 的单一原子快照。这是比较读取需要处理的现有 Interface 特征，不是新表的证据。[E4] |

**可比性的研究结论**：同一 Schema 内容摘要不足以证明同一评分标准，还需考虑评估 Agent 配置、逐用例 `evalPrompt` 与评估素材。执行 Agent、模型或指令的差异则可能正是实验变量，不能因为存在这些差异就一概禁比。需要分别说明“可并排列值”“同口径数值差”“是否能解释为改善”，而不是给出一个无条件的 winner。

**重复采样与统计结论**：本平台保留同一用例的多次 Sampling；不能照搬 Langfuse 所查数据模型的“至多读一条结果”。用例身份可以支持 case 层配对，但随机重复不能仅按界面序号配成独立对子，Bootstrap 也不会创造配对身份。任何配对均值、区间或显著性声明都需要明确估计目标、观察层级、有效 N、缺失策略及原始观察；本轮未运行此类分析。

**核验边界**：第二轮没有实现比较 Module、Interface 或页面，没有创建结果快照，也没有执行数据库读取、迁移、Agent 任务或应用测试。实现建议在本轮对话中提出；这里只保存支撑建议的事实。研究阶段仅新增本文，未修改业务代码；研究过程没有执行提交或推送。

[E1]: https://github.com/springbrand-lab/eval-platform/blob/a2e9c35cfa307ef185720536f6c58c1fa1cf0e73/apps/eval-api/src/db/runtime.ts#L246-L305
[E2]: https://github.com/springbrand-lab/eval-platform/blob/a2e9c35cfa307ef185720536f6c58c1fa1cf0e73/apps/eval-api/src/db/run-records.ts#L203-L228
[E3]: https://github.com/springbrand-lab/eval-platform/blob/a2e9c35cfa307ef185720536f6c58c1fa1cf0e73/apps/eval-api/src/db/run-view.ts#L18-L30
[E4]: https://github.com/springbrand-lab/eval-platform/blob/a2e9c35cfa307ef185720536f6c58c1fa1cf0e73/apps/eval-api/src/db/metrics.ts#L29-L127
[E5]: https://github.com/springbrand-lab/eval-platform/blob/a2e9c35cfa307ef185720536f6c58c1fa1cf0e73/apps/eval-api/src/db/schema.ts#L296-L309
[E6]: https://github.com/springbrand-lab/eval-platform/blob/a2e9c35cfa307ef185720536f6c58c1fa1cf0e73/packages/eval-runtime/src/plan/index.ts#L77-L114
[E7]: https://github.com/springbrand-lab/eval-platform/blob/a2e9c35cfa307ef185720536f6c58c1fa1cf0e73/packages/eval-metrics/src/aggregation/model.ts#L288-L322
[E8]: https://github.com/springbrand-lab/eval-platform/blob/a2e9c35cfa307ef185720536f6c58c1fa1cf0e73/docs/package-boundaries.md#L97-L103
[E9]: https://github.com/springbrand-lab/eval-platform/blob/a2e9c35cfa307ef185720536f6c58c1fa1cf0e73/apps/eval-web/src/features/projects/project-detail-page.tsx#L179-L184
