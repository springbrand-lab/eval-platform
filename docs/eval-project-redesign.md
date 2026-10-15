# Project、Runtime 与 Metrics 设计

> 状态：已实现。本文是 Project 全链路的设计记录：Project 快照、Runtime 准入与运行、Metrics 统计和只读观察入口。路由与错误码只在 [Eval HTTP 控制面](eval-http-api.md) 描述；准入、幂等键与替换规则以及停止语义的完整描述在[架构方案](architecture.md#run-准入与独立评估)。SP 与 Web 仍需完成的部分见第八节。
>
> 核心决定：Project 不支持配置修改；唯一例外是评估计划，它可以在创建时填写或之后补填，锁定前可反复整体替换，首个带评估的 Run 准入后锁定。Project 引用的快照固定，来源 Dataset/Data/Agent Config 后续被修改或软删除都不影响 Project。Agent Config 在 Eval 内增删改查（Eval SP 只是承载层），Project 通过冻结副本保证稳定。

## 一、目的与边界

### 目标

1. Project 创建时一次固定执行计划和输入快照，执行计划没有修改入口。评估计划可在创建时填写或之后补填，锁定前可整体替换，首个带评估的 Run 准入后不可修改。
2. Project 运行只使用自己的快照，不读取来源 Dataset/Data/Agent Config 的新内容。
3. 每次启动选择本次操作：仅执行、执行并评估、仅评估。操作属于 Run，不写回 Project。
4. 支持 Project、Dataset、ProjectSample、Sampling 四级选择和局部替换。
5. 局部重跑保留未选中的执行和评估；清理选中范围的旧评估；仅评估不动执行事实。
6. 同一 Project 同时只能有一批未完成 Run；支持整批停止和停止后重新提交。
7. Metrics 从固定绑定数据聚合当前结果，分别展示 Subject 与 Evaluator 的轨迹、费用、Token、时长、轮数、工具统计和 JSON Schema 数值结果。
8. 每个 Sampling 和评估记录都有指向独立 Eval SP Chat 的只读观察入口。

### 不在范围内

- Project 配置编辑、草稿、Discard、当前配置与 Run 时配置的双状态（锁定前的评估计划只有一份当前值，没有草稿）。
- Project 结果的历史版本或回滚。Project 只保留当前结果集合；旧 Run 行作为来源记录保留，见 2.5。
- 读取 SP 私有数据库或 Durable Object；要求 SP 提供 Agent Config 版本历史。
- 另建 Chat、Workspace、Trajectory 或 Metrics 持久化系统替代 SP。

## 二、领域模型

### 2.1 ProjectPlan：执行计划与评估计划

Project 的一次一致读取是 `ProjectPlan`（`packages/eval-contracts/src/project.ts`）：`project` 元数据、按绑定顺序的 `datasets`、`execution` 与 `executionPlanDigest`，以及可空的 `evaluation: ProjectEvaluation`（`{plan, digest, lockedAt}`，计划与摘要只同时存在）。ProjectSample 不在 ProjectPlan 内，按 ID 分批读取。

| 部分 | 内容 | 确定时机 | 锁定时机 |
| --- | --- | --- | --- |
| 执行计划 | 元数据、Dataset/Data 快照、每条 ProjectSample 的 `samplingCount`、Subject 策略 | 创建事务 | 创建即锁定，永不可改 |
| 评估计划 | Evaluator 策略、评估输出 JSON Schema 引用 | 创建时可选填写，或之后补填 | 首个 pipeline/evaluation Run 的准入事务 |

执行计划：

- Project ID、名称、描述、owner、Eval SP source branch；
- Dataset 快照 `ProjectDatasetSnapshot`：Dataset ID、名称、描述、kind、创建时成员顺序的 `projectSampleIds`；
- ProjectSample：完整 Data 副本和各自的 `samplingCount`，见 2.4；
- `ExecutionPlan`：Subject `harness`（框架、冻结副本 `AgentConfigRef`、可选超时）、`subjectAgentConfig` 正文快照、`executionConcurrency`、`retryPolicy`；
- `executionPlanDigest`：覆盖执行计划、Dataset 绑定和全部 ProjectSample 快照。

评估计划（可为空，`ProjectEvaluation`）：

- `plan`（`EvaluationPlan`）：SP 框架的 `evaluationHarness`（冻结 Evaluator 副本引用、可选超时）、`evaluatorAgentConfig` 正文快照、`evaluationConcurrency`、`retryPolicy`、`outputSchema`（Schema ID 与规范 JSON 的 sha256）；
- `digest`：评估计划摘要；
- `lockedAt`：未锁定时为空。

评估计划规则：

- 未锁定时只有一份当前值，可整体替换任意次；
- 未填写时，pipeline 和 evaluation 准入返回 `evaluation-plan-required`；
- 首个 pipeline/evaluation Run 在准入事务内写入 `evaluation.lockedAt`；该 Run 之后停止或失败也不解锁；
- 锁定后替换返回冲突；
- 执行计划没有任何修改入口。

`eval-runtime/plan` 是计划校验、归一化和摘要的唯一入口。Runtime 的全部参数来自 Project 计划，Run 不保存配置正文。

### 2.2 引用稳定性

| 来源对象 | 来源是否可变 | Project 的保存方式 |
| --- | --- | --- |
| Dataset 元数据和成员 | 可整体替换、attach/detach、软删除 | 复制进 Project 快照 |
| Data 内容 | 可原地替换、软删除 | 复制完整内容进 ProjectSample |
| Material / Session 文件 | 正文不可变；软删除只打标记，不删文件；Worker 按 ID 从 Bundle 目录读取，不检查删除标记 | 只保存引用 |
| 评估输出 JSON Schema | 正文不可变，只能修改元数据；软删除不影响按 ID 读取 | 保存 ID 和内容摘要 |
| Agent Config | 在 Eval 内增删改查，SP 侧原地更新，没有版本历史 | 冻结副本，见 2.3 |

软删除的来源对象仍可被已有 Project 引用和执行，只是不再出现在目录中，也不能被新的 Data 或 Project 选择。因此目录删除从不被 Project 阻挡：

- 输出格式的软删除总是允许；
- Dataset 软删除从不被 Project 阻挡；
- Data 软删除只在它仍属于某个未删除 Dataset 时被拒绝，与 Project 无关；
- Material/Session/Bundle 软删除只在仍被活动 Data 引用时被拒绝（见 [Dataset upload](eval-dataset-upload.md)）。

### 2.3 Agent Config 冻结副本

Agent Config 在 Eval 中通过 `/api/agent-configs` 增删改查，Eval SP 只是承载层。由于 SP 原地更新配置，Project 不直接引用用户的可编辑 Agent Config：

- 创建 Project（Subject，以及填写时的 Evaluator）或保存评估计划（Evaluator）时，Eval API 读取所选 Agent Config，通过 SP 公开创建接口生成内容相同的副本（slug `eval-frozen-<uuid>`，名称追加 ` (frozen)`），计划引用副本的 `userAgentId`；
- 计划同时保存 `AgentConfigSnapshot` 正文快照，只用于展示；运行始终通过副本引用调用 SP，不从正文重建配置；
- `eval_project_agent_configs` 记录副本、角色、所属 Project 和正文快照；被替换的 Evaluator 副本标记 `retired_at`，行保留；
- 冻结副本的判定只有一处：被某个 Project 记录（当前或 retired），或 slug 以 `eval-frozen-` 开头（覆盖创建响应丢失、Project 行从未写入的孤儿）。冻结副本不出现在 `/api/agent-configs` 与 `/api/agents` 列表中；PATCH/DELETE 以及以副本为冻结来源都返回 `AGENT_CONFIG_FROZEN`；GET 可只读查看；`eval-frozen-` 前缀保留给副本，用户创建或修改 Agent Config 时 slug（去空白、不区分大小写）不能以它开头；
- 修改原 Agent Config 只影响之后新建的 Project 或重新保存的未锁定评估计划；
- 副本在 SP 中创建，不在 Eval 数据库事务内；补偿删除见 3.1、3.2，SP 删除尽力而为，残留的孤儿副本按上面的判定始终隐藏；
- Runtime、Harness 和 SP ensureChat 合同不变，仍然接收 `{ownerUserId, userAgentId}`。

### 2.4 ProjectSample 是 Project 自己的输入

ProjectSample 是 Project 内固定的一条测试输入：`{ projectSampleId, projectId, dataId, datasetIds, samplingCount, data }`。`dataId` 只用于展示和 Dataset 分组；`datasetIds` 是包含该 Data 的全部绑定 Dataset（按绑定顺序）；`data` 是创建时的完整 Data 副本，其中的 Material/Session 引用按 ID 读取。

同一个 Data 被多个所选 Dataset 绑定时，Project 内只生成一个 ProjectSample，Sampling 只执行一份；它出现在每个所属 Dataset 视图中，Project 总计按 Sampling/Evaluation 去重。来源 Dataset/Data 之后被改名、改内容、解除关联或软删除，不改变 ProjectSample。

### 2.5 Sampling、EvaluationRecord 与 Run

- Sampling 是一次 Subject 执行，引用自己的 `projectSampleId`，拥有独立 Subject Chat、Attempt、产物、完整轨迹和原始资源。
- EvaluationRecord 是一次 Evaluator 执行，拥有独立 Evaluator Chat、Attempt、完整轨迹和原始评估输出。
- Run 是一次提交的工作范围，保存 operation、phases、selector、targets、`samplingIds`、`evaluationIds`、两个计划摘要、source commit、Project 内递增的 `sequence`、请求身份和停止标记，不保存配置正文。
- Project 当前结果集合不等于最近 Run 的成员集合。Run 行从不删除，作为来源记录保留；当它的 Sampling 或 EvaluationRecord 被后续 Run 替换时，这些成员从它的关联中移除，`RunSnapshot.samplingIds/evaluationIds` 只列出仍为当前的记录。

## 三、用户流程

### 3.1 创建

创建表单填写 name、description，选择多个 Dataset；每个 Dataset 可选全部当前成员或明确的 Data 子集；`samplingCount` 是每条入选 Data 的默认次数，`samplingCounts` 按 Data 覆盖；选择 Subject Agent Config 和执行策略。评估计划（Evaluator Agent Config、评估策略、输出格式）可以在创建时填写，也可以先不填。

创建时选择首个 Run 的操作：仅执行，或执行并评估。执行并评估必须同时填写评估计划。operation 属于该 Run，不写入 Project。新 Project 没有成功 Sampling，因此首个 Run 不能是仅评估。点击 Cancel 不调用任何写接口。

`POST /api/projects` 是一次完整创建：

1. 在一个一致读取中读取所选的自有、未删除 Dataset 及其当前成员，构造 Dataset 快照和 ProjectSample；
2. 在 SP 中冻结 Subject（及 Evaluator）副本；
3. 在一个数据库事务内写入 Project、Dataset/Data 快照、两个计划和副本对应行；
4. 以 `{all:true}` 预览并提交首个 Run。

请求体顶层的 `idempotencyKey` 在用户内唯一，首个 Run 使用同一个 key；Project 保存 key 和校验后请求体（不含 key）的指纹。克隆副本之前先按 key 查找：

- 同一请求体重放原 `{project, run}`，`run` 是以创建 key 准入的首个 Run（之后有别的 Run 也返回它）；若首个 Run 从未准入，重放只在 Project 还没有任何 Run 时补交（在准入的 Project 行锁下判定），否则返回 `run: null`；
- 不同请求体返回冲突；
- key 对应的 Project 已软删除时，无论请求体都返回 not found，不会复活；
- 并发的相同请求只有一个创建事务提交，落败者删除自己创建的副本后重放胜者；
- 重放请求从不补偿：它的首个 Run 准入失败只返回错误，Project 留给下一次重放。

补偿只由提交了该 Project 的创建请求执行，规则只有一条：只移除不可用或不需要的 Project。第 3 步之前任何失败都删除已建副本；首个 Run 准入失败时，未软删除且仍没有任何 Run 的 Project 硬删除全部行并删除副本，但 `plan-changed`（评估计划替换先落地，首个 Run 在有限次数内重新预览提交，用尽后返回冲突）和 `creation-superseded`（已有 Run）不补偿，用户已软删除的 Project 及其副本行也原样保留。补偿删除 Project 后，同一 key 会创建新的 Project；保留下来、没有 Run 的 Project 由同一 key 的重放补交首个 Run。错误码见 [Eval HTTP 控制面](eval-http-api.md#projects)。

### 3.2 评估计划补填与锁定

评估计划尚未锁定的 Project 可以在详情页填写或修改评估计划（`PUT /api/projects/:id/evaluation-plan`）。保存是整体替换：先确认未锁定，再冻结新的 Evaluator 副本，然后在与准入相同的 Project 行锁下替换计划并标记旧副本 retired；提交后删除旧副本，事务失败则删除新副本。首次启动执行并评估或仅评估后，评估计划锁定，详情页只读展示。执行计划始终只读。

### 3.3 后续启动

每次启动分两步，由 `EvalRunAdmission` 完成：

1. `preview({projectId, operation, selector})`：选择器是 `all`、`datasetIds`、`projectSampleIds`、`samplingIds` 的组合，在 Project 快照内展开为固定 `targets: {projectSampleIds, samplingIds}`，并返回将替换/新建的 Sampling 数、评估数和计划摘要；
2. `submit({idempotencyKey, projectId, operation, selector, targets})`：原样带回 preview 的 `targets`，Runtime 只校验、不重新展开；重试沿用同一 `targets` 和 key。

请求不携带任何配置 ID 或实时 Dataset/Data 内容；Sampling 次数取各 ProjectSample 的 `samplingCount`，Agent、并发与重试全部来自 Project 计划。展开规则：

- `all` 和 Dataset 按绑定顺序和成员顺序展开为 ProjectSample；
- execution/pipeline：目标 ProjectSample 替换其当前全部 Sampling，按 `samplingCount` 新建（从未运行过的同样新建）；目标 Sampling 一对一替换，其 ProjectSample 已被整条选中时被吸收；
- evaluation：`targets.projectSampleIds` 为空；ProjectSample 展开为其当前执行成功的 Sampling（其他状态静默过滤），显式 Sampling 必须执行成功，否则拒绝；
- 结果去重、顺序稳定，展开为空时拒绝。

### 3.4 结果替换规则

| 操作 | 选中旧执行 | 选中旧评估 | 未选中执行 | 未选中评估 |
| --- | --- | --- | --- | --- |
| 仅执行 | 删除旧 Sampling，创建新的 Sampling | 随旧 Sampling 删除；新 Sampling 没有评估 | 原样保留 | 原样保留 |
| 执行并评估 | 删除旧 Sampling，创建新的 Sampling；成功后各自评估 | 随旧 Sampling 删除 | 原样保留 | 原样保留 |
| 仅评估 | **完全保留 Sampling、Chat、Attempt、产物、轨迹和资源** | 删除选中 Sampling 的当前 EvaluationRecord，新建评估 | 原样保留 | 原样保留 |

全 Project 重跑就是选中全部目标。替换在 Run 准入事务内完成；准入失败时旧结果不变；新 Run 停止后不恢复已完成的替换。

### 3.5 幂等键

请求指纹覆盖 `projectId`、operation、selector、targets 和计划摘要（pipeline/evaluation 另含评估计划摘要）。key 在 Project 内唯一：

- 同 key 同指纹只在它的 Run 仍是该 Project 最新的 Run 时重放原 Run（即使仍在运行）；
- 一旦该 Project 存在更晚的 Run，这个 key 被拒绝，旧 key 不能复活；
- 同 key 不同指纹被拒绝；
- 新 key 遇到未完成 Run 返回忙碌。

完整准入规则见[架构方案](architecture.md#run-准入与独立评估)。

### 3.6 停止与删除

停止请求指名具体 Run ID，停止该 Run 的全部目标，不支持局部停止；已结束的目标不回滚，未选中结果不受影响。停止请求、证据收尾和 `stopFinalized` 全部落库后 Project 才能再次启动；收尾期间的新 key 返回忙碌。完整语义见[架构方案](architecture.md#run-调度与停止)。

Project 删除是软删除；存在未完成 Run 或停止收尾时拒绝。删除后不出现在列表中，详情、预览、Run、结果、Metrics 和观察入口一律 not found；当前结果和资源引用保留，不建立历史版本。

## 四、Runtime

### 4.1 输入

Runtime 只通过只读 `ProjectPlanReader` 和 `RuntimeStore` 读取输入，不读取实时 Dataset/Data、可编辑 Agent Config 或任何配置表：

- `getProjectPlan(projectId)`：返回 `ProjectPlan`；未知或已软删除的 Project 为 null；
- `getProjectSamples(projectId, ids)`：按输入顺序返回 ProjectSample 或 null；
- `getEvaluationOutputSchema(projectId)`：返回评估计划引用的 Schema 正文；没有评估计划时为 null。

选择器展开由 `EvalRunAdmission.preview` 在 Project 快照内完成。API 进程注入用户范围的 reader，Worker 注入跨用户 reader。Worker 恢复 pipeline/evaluation Run 时评估计划必然已锁定，读取的就是准入时的内容。

### 4.2 公共类型

- `ProjectPlan`、`ExecutionPlan`、`EvaluationPlan`、`ProjectDatasetSnapshot`、`AgentConfigSnapshot`、`EvaluationOutputSchemaRef`（`eval-contracts`）；
- `ProjectSample`（`eval-runtime`）；
- `RunOperation`：execution、pipeline、evaluation；
- `RunTargetSelector`：`all`、`datasetIds`、`projectSampleIds`、`samplingIds`；
- `RunTargets`：`projectSampleIds`、`samplingIds`；
- `RunRequest`：`idempotencyKey`、`projectId`、`operation`、`selector`、`targets`；
- `RuntimeRunRecord`：operation、phases、selector、targets、`samplingIds`、`evaluationIds`、`planDigests`、sourceCommit、requestIdentity、停止标记；
- `Sampling`：含 `projectSampleId`；
- `EvaluationRecord`：`output` 为 `EvaluationAgentOutput`，其中 `structuredOutput` 是 Evaluator 结果文件的原始文本 `{path, content, contentHash?}`，没有结果文件时省略。

Runtime 只用 Project 计划中冻结副本的 `AgentConfigRef` 调用 Eval SP。

### 4.3 Admission 事务

`submit` 只调用一次 `RuntimeStore.admitRun()`。PostgreSQL 实现在同一 Project 行锁和数据库事务中：

1. 拒绝缺失或软删除的 Project；
2. 按 projectId + idempotencyKey 处理重放与冲突（3.5）；
3. 新 key 检查 Project 没有未完成 Run，并核对 source release；
4. 复核计划摘要；pipeline/evaluation 要求评估计划已填写；
5. 复核目标 ProjectSample 属于 Project；evaluation 复核目标仍执行成功；execution/pipeline 复核被替换集合仍等于目标的当前 Sampling；
6. execution/pipeline 删除被替换 Sampling 的评估、Run 关联和 Sampling；evaluation 只删除目标 Sampling 的当前评估及其 Run 关联；
7. 写入新 Run（Project 内递增 `sequence`，`(project_id, idempotency_key)` 唯一）、新 Sampling、新 EvaluationRecord 和 Run 关联；
8. pipeline/evaluation 且评估计划未锁定时写入锁定时间；
9. 在同一事务内投递 Worker 任务。

评估计划保存与准入使用同一 Project 行锁，准入使用的评估计划必然是被锁定的内容。删除与插入按批处理，不触发 SQL 参数上限；任何一步失败都不留下半批状态。

### 4.4 三种运行

- **execution**：Worker 只处理新 Sampling，保存 Subject Chat、Attempt、产物、完整轨迹和资源。
- **pipeline**：先执行新 Sampling；每条执行成功的 Sampling 单独进入评估。失败或取消的 Subject 不提交 Evaluator，其 EvaluationRecord 取消；一个 Subject 失败不阻塞其他成功 Sampling 的评估。
- **evaluation**：只创建新的 EvaluationRecord，复用选中 Sampling 的 ProjectSample、Subject Chat、产物和轨迹；Subject 的 Attempt、资源、产物、轨迹和状态不被改动。Evaluator 只读取固定 ProjectSample 的 `evalPrompt`、`evalInitialMaterials`、评估输出 Schema 和 Subject 证据。

评估输出 Schema 由 `getEvaluationOutputSchema` 读取，作为 `evaluation-output.schema.json` 写入每个 Evaluator 的初始化素材根目录；Evaluator 输出原样保存，Runtime 不解析、不校验。

### 4.5 恢复、重试与证据

Worker `resume(runId)` 先读取 Run，再读取 Project 计划并核对 Run 保存的计划摘要（不一致直接拒绝），然后读取目标记录；已完成阶段跳过，未完成阶段继续。Chat 初始化、Submission 校准、资源收集和重启使用稳定操作身份；响应丢失先按原 key 校准，不创建第二个 Chat 或第二次 Submission。重启增加 Attempt，不增加 Sampling。

每个 Subject 和 Evaluator 都保存产物和完整轨迹引用；Subject 失败也收集可用证据。证据收集未完成时记录 `evidencePending`，恢复只补收集，不重复提交。调度与停止见[架构方案](architecture.md#run-调度与停止)。

### 4.6 持久化

数据库只有 `apps/eval-api/migrations-postgres/0000_initial.sql` 一个基线：

- `eval_projects`：元数据、source branch、创建 key 与指纹、`deleted_at`；
- `eval_project_datasets`：Dataset 固定元数据；
- `eval_project_samples`：Data 完整副本与 `sampling_count`；
- `eval_project_sample_datasets`：ProjectSample 与 Dataset 的固定关联和成员顺序；
- `eval_project_execution_plans`：ExecutionPlan 与摘要，创建后不更新；
- `eval_project_evaluation_plans`：当前 EvaluationPlan、摘要、`output_schema_id`、`locked_at`；锁定前可整体替换；
- `eval_project_agent_configs`：冻结副本、角色、所属 Project、正文快照、`retired_at`；
- `eval_samplings`：`project_sample_id` 与执行事实（含 Attempt 和原始资源快照）；
- `eval_evaluations`：评估事实（含 Attempt、原始资源快照和原始评估输出）；
- `eval_runs`：operation、phases、selector、targets、两个计划摘要、`sequence`、幂等键与指纹、停止标志；
- `eval_run_samplings`、`eval_run_evaluations`：Run 的当前成员。

组合外键保证 owner、Project、ProjectSample、Sampling、Evaluation 与 Run 的归属。结果替换只删除选中记录及其关联，不级联删除未选中结果。

## 五、Metrics

### 5.1 职责

Metrics 是只读统计和展示模块，不启动 Agent、不停止 Run、不读取 SP 私有存储、不决定 Project 归属。它从应用注入的 `MetricsSource` 读取一次一致的 `MetricsFacts`：

- `ProjectPlan` 与评估计划的 Schema 正文（没有评估计划时为 null）；
- 查询范围内全部绑定 ProjectSample，包括从未运行的；
- 当前 Sampling 与 EvaluationRecord（含 Attempt 原始资源快照和原始评估输出）；
- 相关 Run 快照。

PostgreSQL 实现在一个 repeatable-read 只读事务内读取。默认查询读取 Project 当前结果全集；`runIds` 只过滤 Sampling 与 Evaluation，不改变固定绑定。层级只来自 Project 快照表，不用实时 `dataset_data`、Data 或最近 Run 推断归属。

### 5.2 四层层级和去重

Project → Dataset → ProjectSample → Sampling，EvaluationRecord 挂在 Sampling 下。每层 `MetricSummary` 包含固定绑定数（Dataset、Data、ProjectSample）、当前 Sampling/Evaluation 数、执行与评估阶段统计、Subject 与 Evaluator 分开的资源统计和 JSON Schema 数值汇总。

上层从底层原始事实重新聚合，不平均下层结果。共享 ProjectSample 在多个 Dataset 行中出现，但 Project 总数按 Sampling ID 和 Evaluation ID 去重。没有运行过的 ProjectSample 仍展示，数值为 null/unavailable；只有完整空流才能确认 0。

### 5.3 Agent 分视角

Sampling 明细把 Subject 和每个当前 Evaluator 分开为 `AgentMetricView`：Chat ID、Attempt 列表与重启数、首次开始与最终结束时间、Agent 时长、资源统计（Token、Provider USD、模型与 Action 结算、模型请求、轨迹指标、coverage 与 diagnostics）、产物和完整轨迹引用。

原始 `AgentResourceSnapshot` 是费用和 Token 的唯一来源：不从价格表估算，不把 reasoning 再加进 total，不重复计算同一结算。失败、取消、重启 Attempt 的消耗计入当前 Sampling。已提交但未收齐资源的 Attempt 使结果不完整；从未提交的 Attempt 不制造缺失。Agent 时长从首个有效 Attempt 开始到最后终态结束，同时保留各 Attempt 时长；时长不代表批次的并行墙钟时间。

### 5.4 轨迹指标

轨迹指标来自每个 Attempt 资源快照中保存的 telemetry 事件；它们与 SP `TrajectoryPage` 使用同一种 UniversalTelemetryEvent 格式，Eval 不另外保存轨迹摘要。事件跨 Attempt 合并，按 session + eventId 去重，按 session + operationId 归并操作。

| 指标 | 规则 |
| --- | --- |
| 轮数 | 唯一 Turn operation；展示 completed、failed、cancelled、inProgress、unknown。 |
| 工具类型 | 按 `toolName` 分组；每个唯一 tool operation 计一次，展示调用数、结果和耗时。 |
| 工具调用长度 | `tool.started` 的 `payload.input` 规范 JSON 的 UTF-8 字节数。 |
| 工具返回长度 | `tool.finished` 的 `payload.output`，缺失时用 `response`，两者不相加；UTF-8 字节数。 |
| 长度分布 | 每种工具给 count、missing、total、min、max、mean、median 和 coverage；正文缺失或被脱敏记为 missing，不补零。 |
| 非工具轮 | 经 `parentOperationId` 没有任何工具归属的 Turn。 |
| 非工具轮 Token | 只汇总明确归属到非工具轮的 generation Token；不用总 Token 减工具 Token 推算。 |

缺少 Turn→generation 关联字段时，相关指标为 partial/unavailable。工具长度是字节数，不是 Token。

### 5.5 JSON Schema 评估结果

EvaluationRecord 只保存 Evaluator 原始输出（`structuredOutput` 的文件路径、原始文本和可选 hash）。Schema 校验和数值抽取在 `eval-metrics` 读取时完成：

- `content` 严格解析（拒绝重复键），再按评估计划锁定的 Schema 用 draft 2020-12 校验；结果为 valid、invalid 或 unavailable，并给出原因和校验错误；
- Schema 属于评估计划，首个带评估的 Run 准入后锁定，同一 Project 的全部 EvaluationRecord 使用同一版本；
- 没有评估计划时数值结果为 unavailable，执行指标照常展示。

数值提取规则：

- 只从成功评估的有效输出中提取 Schema 声明为 `number`/`integer` 的字段；
- 解析本地 `$ref`；`oneOf`/`anyOf`/`if` 只走实际通过校验的分支，`allOf` 全部生效；
- 字段路径为 JSON Pointer，数组下标统一为 `*`，同时保留实际实例路径；
- 字符串数字、布尔值和未声明字段不转换；NaN、Infinity、超出安全整数范围使整份输出无效；
- 评估失败、缺字段、校验失败不按 0 参与。

每个数值路径输出 observationCount、contributingEvaluationCount、missingEvaluationCount（附缺失原因）、total/min/max/mean/median 与 coverage。数组字段一条记录可产生多个观测，因此同时展示观测数和贡献记录数。

### 5.6 公共模型

字段级定义是 `@eval-platform/eval-metrics` 的公共类型：`MetricSummary`、`AgentMetricView`、`ResourceStatistics`、`TrajectorySummary`、`ToolMetric`、`EvaluationOutputView`、`NumericOutputSummary`、`NumericObservationSummary`，以及四层视图 `ProjectOverview`、`DatasetOverview`、`SampleOverview`、`SamplingDetail`。各层视图都含数值汇总；只有 `SamplingDetail` 返回每条评估的原始文本、解析后的 JSON、校验结果、数值观察和轨迹引用。

### 5.7 只读观察

每个当前 Sampling 和 EvaluationRecord 在任何 Run 状态下都有观察入口。Eval API 校验 owner、未删除的 Project 和记录仍为当前后，返回 `AgentObservationRef`：角色、Project、Sampling、可选 Evaluation、Chat 所属用户、可选 Chat ID 和 `not-started | available`，不含 URL。Subject 使用 `Sampling.subjectChatId`，Evaluator 使用 `EvaluationRecord.chatId`。只读 Chat、Context、Workspace、Trajectory 页面及其服务端权限属于 Eval SP；Web 负责导航和展示。

## 六、API 与包边界

### API

路由、请求体与错误码见 [Eval HTTP 控制面](eval-http-api.md)。Project 的写入口只有：创建（`POST /api/projects`）、评估计划替换（`PUT /api/projects/:id/evaluation-plan`）和软删除；Run 的写入口是提交与停止，预览不写状态。

### 包职责

| 模块 | 职责 |
| --- | --- |
| eval-contracts | ProjectPlan、ExecutionPlan、EvaluationPlan、ProjectDatasetSnapshot、AgentConfigSnapshot、RunOperation/Selector/Targets、原始 `structuredOutput`、AgentObservationRef。 |
| eval-dataset | 可编辑来源 Dataset/Data；不保存 Project 或结果。 |
| eval-runtime | 计划校验与摘要、ProjectSample、目标展开、准入、三种 operation、停止、幂等、Worker 恢复、Chat/证据身份。 |
| eval-metrics | 固定层级、资源与轨迹统计、Schema 校验与数值抽取、四层聚合和 coverage。 |
| eval-api | Project 快照写入、冻结副本及补偿、评估计划保存、Run 事务、MetricsSource、观察入口、HTTP 错误语义。 |
| eval-web | 创建、评估计划补填/修改（锁定前）、运行选择、停止、删除、四层 Metrics、只读观察展示；没有执行计划编辑页。 |
| Eval SP | 公开 Chat/Context/Workspace/Trajectory 只读访问、Evaluator 原始结构化输出、服务端写权限隔离；Agent Config 沿用公开增删改查。 |

## 七、测试覆盖

Runtime 与 API：

- 创建后修改来源 Data，重跑仍使用快照；来源 Data、Material、Session、Schema 软删除后已有 Project 仍可重跑；
- 创建后修改原 Agent Config，重跑仍使用冻结副本；冻结副本隐藏、拒绝编辑和删除；
- 评估计划为空时 pipeline/evaluation 被拒绝；锁定前可反复替换；首个带评估的 Run 后锁定，停止后仍锁定；
- 评估计划保存与准入并发时不会使用未锁定内容；
- 同一 Data 被多个 Dataset 绑定只创建一组 Sampling；
- 首个 Run 的仅执行、执行并评估，以及首个仅评估被拒绝；
- 创建幂等：重放、不同请求体冲突、已删除返回 not found、并发落败者丢弃副本、重放不补偿；
- 选择展开、去重与局部替换；仅评估保留全部执行事实；Pipeline 部分成功仍评估成功项；
- 未完成 Run、停止收尾、已删除 Project 的冲突；同 key 并发与数据库唯一约束；被后续 Run 取代的 key 被拒绝；
- 停止中断全部目标但不影响未选中结果；证据补收不重复 Submission；Chat、Submission、Attempt 身份恢复。

Metrics：

- 来源改动后固定层级不变；未运行 ProjectSample 仍出现；共享 Data 在 Dataset 视图重复、Project 汇总不重复；
- 未选中结果保留在默认指标；`runIds` 只过滤本批；
- Subject 与 Evaluator 资源分开；credit、Token、cache、Provider USD、Action 结算去重；
- 轨迹跨 Attempt 合并、事件去重、轮数、工具结果与长度、非工具轮与 generation Token；
- complete/partial/unavailable coverage 与 diagnostics；
- Schema 嵌套数值、数组数值、组合分支、`$ref`、缺失字段与非法数字；
- 四层聚合从底层原始值重算。

## 八、验收场景

1. 创建 Project 后修改来源 Data，重跑仍使用创建时完整 Data。
2. 同一 Data 被两个 Dataset 绑定，只形成一个 ProjectSample 和一组 Sampling，Dataset 小计可分别显示，Project 总计不重复。
3. 选择一个 Sampling 重跑，其他 Sampling 的执行、评估、Chat、轨迹和资源完全不变。
4. 仅评估一个成功 Sampling，Subject 执行 Attempt、Token、credit、时长和轨迹完全不变，只替换该 Sampling 的 EvaluationRecord。
5. 选择 ProjectSample 或 Dataset，展开和去重结果稳定；Pipeline 只评估本次新执行成功项。
6. 运行中重复新 key、删除 Project、评估失败 Sampling 都得到明确冲突；停止后证据收尾完成才能重跑。
7. 同一 idempotencyKey 在事实不变时只产生一个 Run；被后续 Run 取代的 key 不能复活。
8. Project 绑定但未运行的 Data 仍在四层 Metrics；来源目录删除后固定层级仍可读。
9. Sampling 详情分别展示 Subject/Evaluator 的 credit、Token、时长、轨迹轮数、工具成功失败和输入/返回长度。
10. JSON Schema 有嵌套数值、数组数值、字符串数字和无效输出时，只有有效声明数值逐级聚合。
11. 点击 Sampling 可进入 Subject Chat，点击评估可进入 Evaluator Chat；Context、Workspace、Trajectory 可读，消息、steer、审批、停止和 Workspace 写入均被 SP 服务端拒绝。
12. 创建 Project 后在 Eval 中修改原 Agent Config，重跑仍使用创建时的配置；冻结副本不出现在 Agent Config 列表，也不能被编辑或删除。
13. 来源 Data、Material、Session、Schema 软删除后，已有 Project 仍可重跑和评估。
14. 仅执行创建的 Project 不填评估计划也能运行；之后补填、修改评估计划，启动评估后评估计划变为只读；未填写时启动评估被拒绝。
15. Cancel 创建不产生任何 Project、副本或 Run。

场景 11 的只读页面与服务端写入拒绝，以及场景 9、10 所依赖的 Evaluator 原始结构化输出，待 Eval SP 与 Eval Web 完成（见 [SP 接口需求](sp-eval-api-requirements.md)）。
