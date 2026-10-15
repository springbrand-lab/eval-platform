# Project、Runtime 与 Metrics 改造方向

> 状态：需求设计稿，尚未实现。本文是 Project 全链路的目标行为，重点补全 Runtime 和 Metrics 的改造范围。当前代码中的首次启动锁定、整批删除、实时 Dataset 归类和 Run 配置快照，都以本文为准替换。

## 一、背景

现在的 Project 只保存少量元数据和首次启动信息。执行配置单独引用一个 Dataset，运行时再读取实时 Dataset、Data 和 Sample。Dataset 或 Data 后续被编辑、移除关联或软删除后，同一个 Project 的重跑可能读到另一套输入。

当前 Runtime 把一次新执行或 Pipeline 理解成“整个 Project 换一批”：执行或联跑会清理全部旧 Sampling 和评估；仅评估会清理全部旧评估。这样无法支持按 Dataset、Sample 或单条 Sampling 局部重跑，也无法保留未选中的执行与评估结果。

当前 Metrics 已有 Project、Dataset、Sample、Sampling 四层入口，也能统计部分 Attempt 资源，但它按实时 Dataset 关系归类，不能保证 Project 历史绑定稳定；轨迹只保留引用，不能完整展示轨迹派生指标；评估输出主要是固定 score/reason 字段，不能展示和汇总 Project 绑定 JSON Schema 中的数值字段。

## 二、目的与边界

### 目标

1. Project 创建时一次固定完整计划和输入快照。Project 创建后不支持任何配置修改。
2. Project 后续运行只使用自己的快照，不读取来源 Dataset/Data 的新内容。
3. 每次启动时选择本次操作：仅执行、执行并评估、仅评估。操作模式不是 Project 配置，不写回 Project。
4. 支持 Project、Dataset、Sample、Sampling 四级选择和局部替换。
5. 局部重跑保留未选中的执行和评估；清理选中范围的旧评估；仅评估不清理执行事实。
6. 同一 Project 同时只能有一批未完成 Run；支持整批立即停止和停止后重新提交。
7. Metrics 能从固定绑定数据聚合当前结果，展示 Subject 与 Evaluator 的轨迹、费用、Token、时长、轮数、工具统计和 JSON Schema 数值结果。
8. 点击 Sampling 或评估记录，可以进入独立 Eval SP 的只读 Chat 观察页查看 Context、Workspace 和 Trajectory。

### 不在本次范围

- Project 配置编辑、草稿、Discard、当前配置与 Run 时配置的双状态。
- Project 结果历史版本或可回滚版本。Project 只保留当前结果集合；旧 Run 的身份账本只用于拒绝迟到重试。
- Eval 平台复制 SP Agent Config 正文、读取 SP 私有数据库或 Durable Object。
- 另建一个独立的 Chat、Workspace、Trajectory 或 Metrics 持久化系统替代 SP。

## 三、领域模型

### 3.1 Project 是不可修改的计划

Project 创建后不可修改，以下内容在创建事务中确定：

- Project ID、名称、描述、owner、Eval SP source branch；
- 绑定的 Dataset 快照：Dataset ID、名称、描述、kind、创建时的成员顺序；
- 绑定的 Data 快照：Data ID、完整业务字段、userPrompt、evalPrompt、初始 Session 引用、初始材料引用；
- 每条 Data 的 Sampling 次数；
- Subject 执行策略：框架、Agent Config 的固定公开引用/版本身份、并发、重试、超时；
- Evaluator 策略：Evaluator Agent Config 的固定公开引用/版本身份、并发、重试、超时；
- 评估输出 JSON Schema 的不可变 ID、内容摘要和完整 Schema 内容引用；
- Project 快照摘要和版本校验值。

Eval 不能保存 Agent Config 正文。SP 必须提供可固定的 Agent Config revision 或 immutable snapshot identity；只有 userAgentId 而没有版本身份时，Project 不能声称配置稳定。Project 创建时解析并保存 Eval 自己的执行策略快照，后续 Runtime 不再读取可编辑 ConfigStore。Run 也不保存第二份 config snapshot。

### 3.2 ProjectSample 是 Project 自己的输入

ProjectSample 是 Project 内部固定的一条测试输入，不等同于来源目录中会变化的 Sample。它至少包含：

- projectSampleId；
- 来源 Data ID；
- 来源 Dataset ID 列表和绑定顺序；
- Data 完整快照；
- samplingCount；
- 材料和 Session 的固定引用及 manifest/content hash。

同一个 Data 被多个所选 Dataset 绑定时，在一个 Project 内只生成一个 ProjectSample，Sampling 只执行一份。它可以在多个 Dataset 视图中出现，但 Project 总计按 ProjectSample/Sampling 去重。

来源 Dataset/Data 后续被改名、改内容、解除关联或软删除，不改变 ProjectSample。仍被 Project 快照引用的材料必须保持可读取；删除操作需要被 Project 引用约束拦截或只允许删除目录元数据而保留不可变内容。

### 3.3 Sampling、EvaluationRecord 与 Run

- Sampling 是一次 Subject 执行，拥有独立 Subject Chat、Attempt、产物、完整轨迹和原始资源。
- EvaluationRecord 是一次 Evaluator 执行，拥有独立 Evaluator Chat、Attempt、完整轨迹、评估输出和证据。
- Run 是一次提交的工作范围，只包含本次实际处理的 Sampling/EvaluationRecord。Project 当前结果集合不等于最近 Run 的成员集合。
- Run 不保存配置正文。Run 保存 operation、phase、target sampling/evaluation IDs、source commit、request identity、stop facts 和状态投影所需事实。

## 四、用户流程

### 4.1 创建与取消

创建表单填写 name、description，选择多个 Dataset；每个 Dataset 可选择全部 Data 或明确 Data 子集；每条入选 Data 填正整数 Sampling 次数。Subject 策略、Evaluator 策略和 JSON Schema 在创建时一起确定。

创建 Project 不选择并持久化某个“首次启动模式”。用户点击本次 Run 时才选择仅执行、执行并评估或仅评估。若产品需要创建后立即启动，创建 Project 和首个 Run 可以在一个事务中提交，但 operation 仍然属于该 Run，不写入 Project 计划。

点击 Cancel 不调用写接口。点击 Run 时，Project 快照、固定资源校验和首个 Run 必须原子提交；校验或准入失败不能留下半个 Project。空 Project 可以创建，但不能提交仅评估。

### 4.2 后续启动

每次启动提交：

- projectId；
- operation：execution、pipeline 或 evaluation；
- 选择器：全 Project、Dataset、ProjectSample、Sampling ID 的组合；
- 一次提交的确定 target IDs；
- idempotencyKey。

不提交 executionConfigId、evaluationConfigId、pipelineConfigId 或实时 Dataset/Data 内容。所有执行参数从 Project 唯一快照读取。

选择规则：

- Dataset 选择展开为该 Project 中绑定到该 Dataset 的全部 ProjectSample；
- ProjectSample 选择展开为该 Sample 当前保留的全部 Sampling；
- Sampling 选择只选该条；
- 重叠选择去重，顺序稳定；
- Dataset/Data 的展开基于 Project 快照，不基于实时目录；
- 仅评估只能选择执行成功的 Sampling；Dataset/ProjectSample 展开时过滤成功者，明确指定失败或未完成 Sampling 必须拒绝；
- API 在提交前返回最终 ID 列表、数量和快照摘要；重试沿用原列表，不能重新全选。

### 4.3 结果替换规则

| 操作 | 选中旧执行 | 选中旧评估 | 未选中执行 | 未选中评估 |
| --- | --- | --- | --- | --- |
| 仅执行重跑 | 删除旧 Sampling，创建新的 Sampling ID 和执行事实 | 清空；新 Sampling 没有评估 | 原样保留 | 原样保留 |
| 执行并评估 | 删除旧 Sampling，创建新的 Sampling ID；成功后创建评估 | 清空 | 原样保留 | 原样保留 |
| 仅重新评估 | **完全保留旧 Sampling、Chat、Attempt、产物、轨迹和资源** | 只清理选中 Sampling 的旧 EvaluationRecord，再创建新的评估 | 原样保留 | 原样保留 |

全 Project 重跑就是选中了全部 Sampling，因此结果整体替换。局部操作不能删除未选中记录。替换在 Run 准入事务内完成；准入失败时旧结果保持不变。新 Run 停止后不恢复已完成的替换，未选中记录继续保留。

### 4.4 停止与删除

停止请求必须带具体 Run ID，只停止这一批 Run 的全部在途 Subject/Evaluator 工作，不支持局部停止。Worker 立即中断活跃 SP Submission，未开始的目标不再提交；已经结束的目标不回滚。

停止请求、证据收尾和 stopFinalized 必须全部落库后，Project 才能再次启动。停止收尾期间的新 key 返回 PROJECT_BUSY；同 key 重放返回原 Run。

Project 删除是软删除。只要存在 queued、starting、running、retrying 或 stop cleanup，删除返回冲突。删除后不出现在普通列表，详情、选择和新 Run 返回 not found；内部可保留当前结果和资源引用，不建立历史版本。

## 五、Runtime 改造范围

### 5.1 新的 Runtime 输入

Runtime 不再把独立 ConfigStore 作为已创建 Project 的运行来源。需要新增一个只读 ProjectPlanReader：

- getProjectPlan(projectId)：返回唯一不可修改的 ProjectPlanSnapshot；
- getProjectSamples(projectId, IDs)：按输入顺序返回 ProjectSample 快照；
- expandTarget(projectId, selector)：在 Project 快照内展开并去重；
- getEvaluationSchema(projectId)：返回已固定 Schema 和内容摘要。

Runtime 的 Admission Catalog 不再通过 Dataset ID 回查实时 Data 和 Sample。创建 Project 时由 API/Store 完成来源快照校验；Worker 恢复时只读取 ProjectPlanReader。

### 5.2 合同变化

新增或调整以下公共类型：

- ProjectPlanSnapshot：Project 元数据、DatasetSnapshot、ProjectSampleSnapshot、固定 ExecutionPlan、EvaluationPlan、SchemaRef；
- RunOperation：execution、pipeline、evaluation；
- RunTarget：all、dataset、projectSample、sampling；
- RunRequest：projectId、operation、targets、expandedSamplingIds、idempotencyKey；
- RuntimeRunRecord：operation、phase、samplingIds、evaluationIds、sourceCommit、requestIdentity、stop flags；删除 config 字段；
- SamplingState：增加 projectSampleId 和固定输入摘要；
- EvaluationRecord：增加 schemaValidation、rawStructuredOutput、numericObservations。

Agent Config 引用仍走 Eval SP 公开接口；Runtime 只使用 Project 快照中的固定 revision。不得把 Agent Config 正文复制进 Eval，也不得在每次恢复时读取可编辑的最新正文。

### 5.3 Admission 原子流程

每次 admission 必须在同一 Project 行锁和数据库事务中完成：

1. 校验 owner、Project 未删除和 source release；
2. 先按 projectId + idempotencyKey 查找现有 Run；
3. 比对 operation、固定 target IDs、Project plan digest 和 request fingerprint；
4. 相同事实返回原 Run；不同事实返回 identity conflict；
5. 新 key 检查 Project 没有未完成 Run；
6. 在 Project 快照内验证 target，并读取目标当前 Sampling 状态；
7. evaluation 只接受 execution.succeeded；
8. 局部重跑删除选中旧 Sampling 的旧 Run 关联和 EvaluationRecord；
9. 仅评估只删除选中 Sampling 的旧 EvaluationRecord，不动 Sampling；
10. 插入新 Sampling、新 EvaluationRecord、新 Run 关联和 key ledger；
11. 事务提交后才通知 Worker。

删除与插入必须按批处理，不能因为大批量全选触发 SQL 参数上限。任何一步失败都不能留下半批 Sampling、孤儿 Evaluation 或已经清理但没有新 Run 的状态。

### 5.4 三种运行实现

#### execution

对目标 ProjectSample 按固定 samplingCount 创建新 Sampling。对目标单条 Sampling 重跑时一对一创建新 Sampling。Worker 只处理新 Sampling，保存 Subject Chat、Attempt、产物、完整轨迹和资源。

#### pipeline

先执行新 Sampling；每条 execution.succeeded 的 Sampling 单独进入评估。失败或取消的 Subject 不提交 Evaluator，EvaluationRecord 进入明确 cancelled/blocked 终态。一个 Subject 失败不能阻塞其他成功 Sampling 的评估。

#### evaluation

只创建新的 EvaluationRecord，复用选中 Sampling 的 ProjectSample、Subject Chat、产物和轨迹。Subject 的 executionAttempts、resources、artifacts、trajectory、status 不得被 Runtime reset 或覆盖。Evaluator 只读取固定 ProjectSample 的 evalPrompt、Schema 和 Subject 证据。

### 5.5 恢复、重试与证据

Worker resume(runId) 先读取 Run，再读取 ProjectPlanSnapshot 和目标记录；不读取 ConfigStore，也不依赖实时 Dataset/Data。已完成阶段跳过，未完成阶段继续。

同一 Chat 的初始化、Submission 状态校准、资源收集和重启使用稳定操作身份。网络响应丢失先按原 key 校准，不能盲目创建第二个 Chat 或第二次 Submission。重启增加 Attempt，不增加 Sampling。

每个 Subject 和 Evaluator 都必须完整保存产物和完整轨迹引用。Subject 失败也要收集可用证据。资源采集 pending/failed 时记录 evidencePending 和覆盖状态，恢复只补收集，不重复提交已完成 Agent。

### 5.6 停止并发与 Worker

Run dispatch gate 与 stop intent 在 Run 行锁下协调；停止后不能再发起新的 SP 操作。Worker 收到停止信号时中止本地 resume、调用 SP stop Chat/Submission、收尾 Attempt 与证据，然后写 stopFinalized。

Worker 调度沿用已落地的 pg-boss 方案（见 [architecture](architecture.md) 的「Run 调度与停止」）：Run 准入与停止在同一事务内投递任务，每个 Run 同时只有一个任务，可部署多个 Worker。

### 5.7 Runtime 持久化改造

删除：

- projects.initialLaunch；
- projects.evaluationOutputSchemaLocked；
- runs.config；
- 依赖 runs.config 恢复的代码；
- Project 输出格式后绑定和 Project 配置修改路由。

新增：

- Project 固定计划/快照表；
- Project Dataset 快照及 Data 成员快照；
- ProjectSample 表及 Dataset 关联表；
- Project 计划的 digest 和不可变 Schema 引用；
- Sampling 到 ProjectSample 的外键；
- EvaluationRecord 的结构化输出、Schema 校验和数值观察；
- 目标范围和 Run/结果当前关联；
- Project deletedAt 与引用资源保护。

### 5.8 Runtime 测试

至少覆盖：

- 创建快照后修改来源 Data，重跑仍使用旧内容；
- 同一 Data 被多个 Dataset 绑定只创建一组 Sampling；
- 首次 Run 的三种 operation 行为；
- Dataset、ProjectSample、单条 Sampling 选择展开和去重；
- 局部重跑保留未选中执行/评估；
- 仅评估保留全部执行事实，只替换选中评估；
- Pipeline 部分执行成功仍继续评估成功项；
- active Run、stop cleanup、deleted Project 的冲突；
- 相同 key 并发和跨进程数据库唯一约束；
- 配置/来源变化不改变同 key 重放；
- 停止中断全部目标但不影响未选中结果；
- 证据补收不重复 Submission；
- Agent Chat、Submission、Attempt 身份恢复。

## 六、Metrics 改造范围

### 6.1 Metrics 的职责

Metrics 是只读统计和展示模块，不负责启动 Agent、停止 Run、读取 SP 私有存储或决定 Project 归属。它读取一次一致的 MetricsFacts：

- ProjectPlanSnapshot：固定 Dataset/Data/ProjectSample 层级和 Schema；
- 当前保留的 Sampling；
- 当前保留的 EvaluationRecord；
- Run 的查询范围和状态；
- Subject/Evaluator Attempt 原始资源快照；
- 轨迹引用和持久化轨迹摘要；
- 评估结构化输出及 Schema 校验事实。

MetricsSource 必须在一个 repeatable-read 只读事务内返回事实。默认查询读取 Project 当前结果全集，不自动只取最后 Run；runIds 是可选的“本批工作”过滤器。

### 6.2 四层层级和去重

四层固定为：

Project → Dataset → ProjectSample → Sampling

EvaluationRecord 作为 Sampling 下的当前评估列表。来源 Data 是 Dataset 和 ProjectSample 的绑定内容，不使用实时 dataset_data 反推。

每层显示：

- 固定绑定数量：Dataset、Data、ProjectSample；
- 当前 Sampling 数量；
- 当前 EvaluationRecord 数量；
- execution/evaluation 状态分布；
- Subject/Evaluator 资源和轨迹指标；
- JSON Schema 数值字段统计。

上层从底层原始事实重新聚合，不能平均下层平均值。一个共享 ProjectSample 在多个 Dataset 行中出现，但 Project 总数按 Sampling ID 和 Evaluation ID 去重。没有运行过的固定 Data/ProjectSample 仍展示，数值为 null/unavailable；只有完整空流才能确认 0。

### 6.3 Sampling 的 Agent 分视角

Sampling 明细必须把 Subject 和每个当前 Evaluator 分开显示：

- Chat ID、只读观察入口、Workspace 和 Trajectory 入口；
- Attempt 数、首次开始时间、最终结束时间、Agent duration；
- input/output/cacheRead/cacheWrite/reasoning/total Token；
- Provider USD；
- 已结算模型 credit、Action charged credit、rated/shortfall/platform-owned units；
- 模型请求数、Turn 数、工具调用数；
- 资源 collection 覆盖和 diagnostics；
- artifacts、完整轨迹引用和评估证据。

原始 AgentResourceSnapshot 是费用和 Token 的权威来源。不能从价格表估算 credit，不能把 reasoning 作为额外 Token 再加一次，不能把同一模型 settlement 或 Action settlement 重复计算。失败、取消、重启 Attempt 已发生的消耗仍计入当前 Sampling。

### 6.4 轨迹指标

SP 公开 TrajectoryPage 按 Chat 分页提供完整事件。Eval 通过公开接口读取，不读取 DO/私有数据库。Worker 在终态和证据收尾时生成派生摘要，并保存 coverage、lastObservedAt、diagnostics；详情页可以继续按页读取原始轨迹。

轨迹事件按事件 ID、session ID、operation ID 去重，并与 telemetry 同源事件建立唯一映射，不能把轨迹和资源流各算一遍。

| 指标 | 规则 |
| --- | --- |
| 总轮数 | 唯一 turn.started operationId；展示 completed、failed、cancelled、inProgress、unknown。 |
| 工具类型 | 使用正式 toolName 分组；每个唯一 tool operation 计一次，展示调用、completed、failed、cancelled、unknown。 |
| 工具调用长度 | 读取 tool.started 的 payload.input，按确定性 JSON 序列化计算 UTF-8 字节数。 |
| 工具返回长度 | 优先读取 tool.finished 的 payload.output，缺失时读取 response；两个字段不相加，按 UTF-8 字节数计算。 |
| 工具长度分布 | 每种工具分别给 available count、missing count、total、min、max、mean、median 和 coverage。正文缺失或被脱敏不能补零。 |
| 非工具轮数 | 没有关联 tool operation 的唯一 Turn 数。跨页工具操作必须先合并再判断。 |
| 非工具轮 Token | 仅汇总通过 parentOperationId/operationId 明确归属到非工具 Turn 的 generation Token；不能用总 Token 减工具 Token 猜测。 |

要实现非工具轮 Token，SP 公共事件必须提供稳定 Turn→generation 关联和 generation Token 字段；缺失时显示 partial/unavailable。工具调用长度是字节数，不是 Token。

### 6.5 资源和时长统计

现有 aggregateResources 的事件去重、Subagent 按字段覆盖、Provider USD、模型/Action settlement、Telemetry operation 统计继续复用，但输出需要增加：

- executionResources 和 evaluationResources 明确分开；
- Subject 与每个 Evaluator 分组，而非只给总和；
- Attempt duration 与 Agent 总 duration 分开；
- Tool duration 与 Run 墙钟时间分开；
- coverage 为 complete、partial、unavailable；
- 原始 identity/conflict/unsupported/invalid diagnostics；
- 已提交但未收齐资源的 Attempt 不能被误报为完整；
- 没有实际提交的 Attempt 不制造虚假的资源缺失。

Agent duration 使用该 Agent 首个有效 Attempt startedAt 到最后终态 completedAt；有重启时覆盖整个 Agent 生命周期，同时保留各 Attempt duration。

### 6.6 JSON Schema 评估结果

EvaluationRecord 必须保存：

- evaluator 返回的完整结构化 JSON；
- 原始输出内容或可验证的 immutable 引用；
- Project Schema ID/content digest；
- validationStatus：valid、invalid、unavailable；
- validationErrors；
- 从有效输出抽取的 numericObservations。

Schema 不是只给 Evaluator 的初始化材料，也必须用于结果读取和统计。Schema 变化不允许影响已创建 Project；Project 固定 Schema 内容摘要，评估使用该版本。

数值提取规则：

- 只提取 Schema 实际声明为 number 或 integer 且输出命中的字段；
- 处理本地 $ref、oneOf、anyOf、allOf 等结构，保留实际命中的路径；
- 使用稳定 JSON Pointer；数组用 /items/* 或等价的数组通配路径；
- 字符串形式的数字、布尔值和未声明字段不转换；
- NaN、Infinity、超出安全范围的数字标为 invalid；
- 评估失败、缺字段、Schema 校验失败不按 0 参与。

每个数值路径输出：

- observationCount；
- contributingEvaluationCount；
- missingEvaluationCount；
- total、min、max、mean、median；
- coverage 和 diagnostics。

数组一条 EvaluationRecord 可以产生多个 observation，因此必须同时展示观测数和贡献记录数。若 Schema 中有 score 字段，score 只作为该 JSON Pointer 统计一次，不再和单独的旧 score 字段重复累计。

### 6.7 Metrics 公共模型

新增或调整：

- AgentMetricView：role、agentConfigRef、chatId、attempts、resources、trajectorySummary、duration；
- TrajectorySummary：turns、nonToolTurns、tools、nonToolToken、coverage、diagnostics；
- ToolMetric：toolName、count、completed、failed、cancelled、unknown、inputLength、outputLength、duration；
- NumericObservationSummary：jsonPointer、schemaType、observationCount、contributingRecords、NumericSummary、coverage；
- EvaluationOutputView：rawJson、validation、numericObservations、artifacts、evidenceRefs；
- MetricSummary：executionAgent、evaluationAgents、numericOutputs、status/attempt/resource 汇总。

ProjectOverview、DatasetOverview、SampleOverview、SamplingDetail 都返回 NumericObservationSummary；只有 SamplingDetail 和 EvaluationDetail 返回完整 JSON、原始轨迹入口和工具正文入口。

### 6.8 MetricsSource 与 SQL

createPostgresMetricsSource 改为：

1. 读取 Project 和 ProjectPlanSnapshot；
2. 按 Project 固定 Dataset/ProjectSample 关联查询全部绑定数据；
3. 默认读取 Project 当前保留 Sampling 和 EvaluationRecord；
4. 按 runIds 时只限制本批事实，不改变父级绑定；
5. 批量读取 Attempts、资源、轨迹摘要、结构化输出；
6. 在同一快照内构造 MetricsFacts；
7. Metrics 包负责四层聚合和去重。

不能再通过实时 dataset_data、当前 samples.dataId 或最新 runSamplings 推断 Project 归属。不能因为一个 ProjectSample 没有 Sampling 就把它从 Dataset/Project 层删掉。

### 6.9 Metrics API 和只读观察

保留四层指标接口，并让响应包含固定绑定和当前结果：

- GET /api/metrics/projects/:projectId；
- GET /api/metrics/projects/:projectId/datasets/:datasetId；
- GET /api/metrics/projects/:projectId/samples/:projectSampleId；
- GET /api/metrics/projects/:projectId/samplings/:samplingId。

新增 Sampling/Evaluation 的只读观察入口解析：

- API 先校验 owner、Project、Sampling/Evaluation 当前身份；
- Subject 入口使用 Sampling.subjectChatId；
- Evaluator 入口使用 EvaluationRecord.chatId；
- 返回独立 Eval SP Web 观察 URL 或受控 deep link；
- 轨迹分页、Context 和 Workspace 读接口由 Eval SP 提供；
- Eval API 不把普通可写 Chat URL 直接暴露给浏览器。

只读不是 Metrics 的职责。Runtime 保存 Chat 身份，Eval API 做归属和入口校验，SP 服务端执行只读权限，Web 负责导航和展示。

### 6.10 Metrics 测试

至少覆盖：

- 来源 Dataset/Data 改动后 Project 固定层级不变；
- 未运行 Data/ProjectSample 仍出现在 Dataset/Project；
- 多 Dataset 共享 Data 时 Dataset 视图可重复、Project 数值不重复；
- 未选中结果保留在默认 Project 指标；
- runIds 只过滤本批，不破坏父级绑定；
- Subject 与 Evaluator 资源分开；
- credit、Token、cache、Provider USD、Action settlement 去重；
- 轨迹跨页合并、事件去重、轮数、工具类型、成功失败和长度；
- 非工具轮和 generation Token 在有明确关联时计算，缺关联时标记不可用；
- 完整/部分/不可用 coverage 和 diagnostics；
- Schema 嵌套数值、数组数值、oneOf/anyOf、$ref、缺失字段和非法数字；
- 局部重跑只替换选中 Sampling 的评估数值；
- 仅评估不改变执行 Agent 资源/Token/轨迹；
- 四层聚合从底层原始值重算，不平均子层均值。

## 七、API、数据库与包边界

### API

- POST /api/projects：创建完整 Project 快照；不接受后续 PATCH/PUT。
- POST /api/projects/:id/runs：提交 operation、targets、expanded IDs、idempotencyKey。
- POST /api/projects/:id/runs/:runId/stop：停止当前 Run 全部目标。
- DELETE /api/projects/:id：运行中拒绝，其他情况软删除。
- GET Project 列表/详情：返回固定计划、固定绑定、当前 Run 和结果概览。
- GET 选择预览：返回 Project 快照下的最终 ID 集合，提交时必须带回。
- GET 四层 Metrics 和 Sampling/Evaluation 详情。
- GET 只读 Chat 观察入口。

删除所有 Project 配置修改、输出格式后绑定、initialLaunch 修改和 Run config 读取路由。

### 数据库基线

这是全新功能，直接修改 0000_initial.sql，不设计 legacy/version1 迁移。建议结构：

- eval_projects：元数据、source branch、plan digest、deletedAt；
- eval_project_datasets：Dataset 固定元数据快照；
- eval_project_samples：Data 完整快照、samplingCount、固定资源引用；
- eval_project_sample_datasets：ProjectSample 与 Dataset 的固定关联；
- eval_project_plans：ExecutionPlan、EvaluationPlan、SchemaRef 的唯一快照；
- eval_samplings：projectSampleId、当前执行事实和 Subject Chat；
- eval_evaluations：当前评估、Evaluator Chat、完整 JSON 输出、Schema 校验和数值观察；
- eval_runs：operation、phase、目标 IDs、source commit、stop facts、request fingerprint；
- eval_run_request_keys：Project-scoped immutable idempotency ledger；
- Run/Sampling/Evaluation 关联表和 Attempt 事实表。

外键保证 owner、Project、ProjectSample、Sampling、Evaluation 的归属；固定引用的材料和 Schema 不得被破坏。结果替换只删除选中关系和记录，不能级联删除未选中结果。

### 包职责

| 模块 | 改造 |
| --- | --- |
| eval-contracts | ProjectPlanSnapshot、ProjectSampleSnapshot、RunOperation/Target、结构化 EvaluationOutput、观察入口引用。 |
| eval-dataset | 继续管理可编辑来源 Dataset/Data；提供创建时一致读取，不保存 Project 结果。 |
| eval-runtime | 固定计划读取、目标展开、局部准入、三种 operation、停止、幂等、Worker 恢复、Chat/证据身份。 |
| eval-metrics | 固定层级读取、资源/轨迹统计、四层数值聚合、Schema 数值抽取和 coverage。 |
| eval-api | Project 快照写入、Run 事务、MetricsSource、观察入口归属校验、HTTP 错误语义。 |
| eval-web | 创建、运行选择、停止、删除、四层 Metrics、只读 Chat/Workspace/Trajectory 展示；没有 Project 编辑页。 |
| Eval SP | 公开 Chat/Context/Workspace/Trajectory 只读访问、完整结构化输出、固定 Agent Config revision、服务端写权限隔离。 |

## 八、验收场景与实现顺序

### 验收场景

1. 创建 Project 后修改来源 Data，重跑仍使用创建时完整 Data。
2. 同一 Data 被两个 Dataset 绑定，只形成一个 ProjectSample 和一组 Sampling，Dataset 小计可分别显示，Project 总计不重复。
3. 选择一个 Sampling 重跑，其他 Sampling 的执行、评估、Chat、轨迹和资源完全不变。
4. 仅评估一个成功 Sampling，Subject 执行 Attempt、Token、credit、时长和轨迹完全不变，只替换该 Sampling 的 EvaluationRecord。
5. 选择 Sample 或 Dataset，展开和去重结果稳定；Pipeline 只评估本次新执行成功项。
6. 运行中重复新 key、删除 Project、评估失败 Sampling 都得到明确冲突；停止后证据收尾完成才能重跑。
7. 同一 idempotencyKey 在配置、来源或目标事实不变时只产生一个 Run；旧 key 在被替换后不能复活。
8. Project 绑定的空 Data 仍在四层 Metrics；来源目录删除后固定层级仍可读。
9. Sampling 详情分别展示 Subject/Evaluator 的 credit、Token、时长、轨迹轮数、工具成功失败和输入/返回长度。
10. JSON Schema 有嵌套数值、数组数值、字符串数字和无效输出时，只有有效声明数值逐级聚合。
11. 点击 Sampling 可进入 Subject Chat，点击评估可进入 Evaluator Chat；Context、Workspace、Trajectory 可读，消息、steer、审批、停止和 Workspace 写入均被 SP 服务端拒绝。

### 实现顺序

1. 先改 contracts，删除 ProjectInitialLaunch 和 RunConfigSnapshot 作为运行来源，增加 ProjectPlanSnapshot、目标选择和结构化输出。
2. 修改 0000 数据库基线，实现 Project 快照、ProjectSample、不可变计划和局部替换事务。
3. 修改 Runtime admission/resume/stop/worker，所有运行从 Project 快照读取，补齐幂等、局部保留和证据恢复测试。
4. 修改 eval-metrics 模型、轨迹摘要、资源统计、Schema 数值抽取和四层聚合测试。
5. 修改 eval-api MetricsSource、Run API、观察入口和归属校验。
6. 最后接 Web 的创建、运行选择、指标、只读 Chat/Workspace/Trajectory 展示，并同步 architecture、package-boundaries、HTTP 和 SP 接口文档。

本文只描述目标改造，不表示上述行为已经实现。
