# @eval-platform/eval-contracts

## New SP Pi-native evidence and resource boundary

`native-trajectory.ts` describes the browser-safe persisted evidence/resource
shape and bounded byte-stream safety checks. The API HTTP seam validates
headers, native/billing pages, evidence pages and references with the installed
`@springbrand/eval-harness@0.1.0-alpha.7` public exports, not these local
page schemas. The local shape is not a copy of SP's
private trajectory parser: a native record has `format:"pi-trajectory/v1"`,
`resource:{agentId,sessionId}`, `submissionId`, a safe projection policy and
`record:{type:"conversation"|"entry",value}`; the raw `{ingestSeq,record}` is
stored unchanged. A page row may instead be
`{ingestSeq,reference:{format:"sp-pi-trajectory-record/v1",throughSeq,identity,byteLength,sha256}}`:
the identity is Runtime's canonical `[agentId,sessionId,type,nativeId]`, and the
SHA-256 and byte length cover only the UTF-8 JSON of `record`, not its ingest
wrapper. Only the SP HTTP Harness adapter resolves it. Evidence JSONL contains
**complete original** `{ingestSeq,record}` rows, never reference placeholders.
Historical `AgentResourceSnapshot.nativeRecords` have full source rows; the
SP adapter now reduces referenced native bodies to verified Pi identities and
body-free versioned Metrics facts. The public SP page cannot supply those local
projections. New collections use the published bounded resource
header/native/billing schemas at the HTTP boundary; the old unbounded combined
route is not a fallback. The package remains browser-safe and does not depend
on SP's runtime or private implementation.
`AgentResourceSnapshotDownload` is a temporary, page-backed application-to-Store
value (summary plus `readPages`/`dispose`), not a second Pi wire or persisted
format. The existing stored
`AgentResourceSnapshot` has `nativeRecords`, not `telemetryEvents`; its independent
`usageEvents`/`billingSettlements` and readiness remain intact. New evidence manifests
are schema 2 with `trajectory.format:"sp-pi-trajectory/v1"`. Version 1 bundle bytes,
hashes, refs and already accepted evaluation results are never rewritten. An old
event-only bundle is deliberately not decoded as Pi-native evidence. The outer
`ingestSeq` cannot also appear inside a native record; scoped reads accept the
requested Submission, a directly parented child or a descendant with a
verified chain, never an arbitrary foreign parent. An attributed child Context
is included only when its
same-Chat parent Submission is verified in the ordered resource stream; a
Chat-wide imported Context or older Submission stays only in evidence. The
published SP `alpha.7` is the authority for the finalized wire, but lacks the
post-wait `allowPartial` query and record-byte `resourceKey` public contract;
local structural storage/byte checks do not establish live deployment parity.

The separate public SP Chat *debug* trajectory read, relayed by Eval API to Web,
returns `{records:[{ingestSeq,record} | {ingestSeq,reference}],beforeSeq,hasOlder}`.
Its native row/reference types are shared here, but it does not use the frozen
evidence page's `format/cursor/nextAfterSeq`. Web cannot fetch a referenced
record body through its observation route and displays an explicit placeholder
instead of pretending it has a full record or projecting a legacy `event`.

## Saved Dashboard configuration

看板配置的 `excludedDataIds` 是已确认的数据展示排除集合，不是指标快照。创建时默认空集合；更新省略该字段时保留现有选择，显式空集合表示恢复全部。集合内身份唯一，配置仍使用同一 revision 防止丢失更新。

Source-user IDs are opaque Auth identifiers, including legacy non-UUID IDs and
the official account `springbrand-official` with its optional `official` flag.
They are bounded to 200 characters and cannot contain whitespace, controls,
path/query delimiters or dot segments. Source paths encode the ID as one segment.
Source-account case is preserved, even for UUID-shaped IDs.
Agent, task and target IDs remain UUIDs. Preview still requires one source user;
this validation does not replace source lifecycle, scope or target ownership checks.

`src/agent-imports.ts` 拥有 dev → Eval 按 ID 覆盖导入的公共 DTO 与严格 preview/apply 请求 Schema：
`AgentImportConfig`、`AgentImportSourceUser`、`AgentImportSourceUserPage`、
`AgentImportCandidate`、`AgentImportCandidatePage`、
`AgentImportTaskView`。来源用户仅限定已授权导出范围，目标仍是固定 Eval 服务账号。
`AgentImportSourceUserPage` 为严格的 `{users:[{id,name,email}],nextCursor:string|null}`，
每页最多 20 个用户；Schema 与类型均从包根入口导出。
`GET /api/agent-config-sync/users` 无需姓名或邮箱输入：省略或空白 `q` 浏览导出范围内
全部符合条件的 dev 账号，可选搜索 `q` 去除首尾空白后最多 200 字符。
`limit` 为 1–20、默认 20；可选的非空 `cursor` 最多 4,096 字符，作为来源拥有的 opaque
游标原样传递。SP 按名称/ID 稳定分页，Eval 不截断目录或另配用户白名单。
Web 仅展示用户名，仍以 ID 选择；email 字段为兼容性保留，不要求用户输入。
任务可表达部分失败与结果待校准；来源/回执/凭据只属于 API 内部事实，不加入普通 Agent DTO。
已有 ID 的自有活动 Agent、用户 Skill 和 Reference 原地覆盖元数据与内容，缺失 ID 新建；不跨目标账号覆盖或复活受保护资源。
逐 Agent 的可选 `overwrite` 预览提示和 `overwritten` 完成状态区分覆盖与新建；
`summary.overwritten` 可选以兼容历史任务，新任务始终提供覆盖数量。历史 `skipped` 状态只用于读取旧任务。
任务级 `importing` 包含后台自动回执校准（`progress.stage: receipts`），期间逐 Agent 可为
`outcome_unknown`；任务级 `outcome_unknown` 仅表示自动恢复预算耗尽、需要人工核验的终态。
Web 轮询前者、停止自动轮询后者，不根据逐 Agent 的未知结果提前结束整个任务。
本包不执行下载、导入、队列或数据库操作。HTTP 使用 `/api/agent-config-sync` 的
`config`、`users`、`users/:sourceUserId/agents`、`previews`、`tasks/:taskId`、
`tasks/:taskId/apply`；preview/apply 均返回 202 `{taskId}`。

`IDEMPOTENT_RETRY_POLICY` 与 `idempotentRetryBackoffMs()` 是跨 Runtime/Web 共用的纯重试契约：恢复预算 10 次，退避从 250ms 指数增长、上限 10s；本包不执行循环或计时器。Runtime 保持首次操作加 10 次幂等重试，Web 在一次未确认的 DELETE 后把这份恢复预算用于最多 10 次只读确认（首次立即查询）。Agent 的 `maxRestarts` 独立，不由该预算改变。

`EvalInputLimits` 与 `evalInputLimitsSchema` 定义控制面公开的输入上限形状，不定义 SP 或应用的数值。API 从实际校验常量投影，Web 通过 `GET /api/input-limits` 获取，不维护第二套数值。

`Dashboard`、`DashboardInput`、`DashboardCreateInput`、`DashboardUpdateInput` 与对应严格 Schema 定义可保存的数据看板配置。配置只包含名称、说明、有序且不同的至少两个 Project；创建请求另带 `idempotencyKey`，编辑请求另带正整数 `revision`。读取结果提供 UUID `dashboardId`、配置版本与创建/更新时间，不包含 owner 凭据、指标缓存、历史结果或采样快照。Project 数量上限仍由 API 的 `comparisonProjects` 控制。创建和保存不会运行 Agent；当前比较结果继续由 Metrics 的公开 Interface 派生。

`InitialResourceFile` 与 `initialResourceFileSchema` 定义初始素材、初始上下文共用的只读文件目录投影：资源内绝对路径、媒体类型、字节数。不包含内容副本、预览状态或 SP Workspace 身份。内容仍从 API 的 Bundle 目录按精确路径读取。

`EVALUATION_RESULTS_MCP_PATH`、`isEvaluationResultsMcpUrl` 与 `resolveEvaluationResultsMcp` 是 Agent 用途分类和 Agent 编辑器共用的公开评估结果提交 MCP 判定；只有唯一启用且使用 Bearer 鉴权的用户 MCP 可用，分类不依赖 MCP 的展示名称或描述。

`AgentPurpose` 是 Eval Agent Config 当前的 `execution | evaluation` 用途，可在编辑时切换；它与 Runtime 的 `AgentRole` 分开，Subject/Evaluator 运行契约不因此改变。切换为评估用途时由 Eval 自动绑定评估结果 MCP，切回执行用途时移除该绑定。

评估平台跨包共享的稳定契约层，公共契约从包根入口导入。`./http-errors` 是 Eval API 唯一的错误码目录（`defineErrorCatalog`），`./http` 是基于它的 Hono 响应器（`createHonoHttp`）；只有这两个 HTTP 边界子路径依赖 `@springbrand/http` 与 `hono`，包根不加载它们。HTTP 契约见 [Eval HTTP 控制面](../../docs/eval-http-api.md)。

Agent 编辑器使用的 SP 领域错误由 `sp-editor-errors.ts` 从 SP 公开错误目录选取，状态码、默认文案和删除阻挡详情 Schema 均复用上游定义。仅 HTTP 子路径加载这些契约；服务账号认证失败仍由 API 翻译为依赖不可用，不要求浏览器重新登录。

`./web-gateway-errors` 是 Worker 与完整 HTTP 目录共用的轻量错误定义入口，拥有 takt 登录、Eval 权限及 Web 网关依赖不可用的错误；Worker 不加载完整 HTTP 目录或 SP 契约。浏览器解码既保留领域详情，也保留这些网关错误及认证语义。

负责 Project 与其固定计划（`ProjectPlan`、`ExecutionPlan`、`EvaluationPlan`、Dataset 快照和 Agent Config 快照）、Sampling、EvaluationRecord、Run 选择/目标、HarnessConfig、ExecutionOutput、EvaluationAgentOutput、AgentObservationRef、ArtifactRef、TrajectoryRef 和 EvidenceRef 等公开边界。`src/evidence.ts` 定义 Subject 的 schemaVersion 2 `EvidenceBundleRef`、`EvidenceManifest`、`EvidenceTrajectoryPart`、`EvidenceExportProgress`、Artifact/Omission、`EvidenceLimits` 与路径常量；native `sp-pi-trajectory/v1` 原始行只存一次。`EvidenceTrajectoryPin`、`EvidenceTrajectoryCursor` 和 `evidenceTrajectoryPinOf` 保存/传递冻结的 native 格式与截止点，旧的 `throughSeq` 进度仍保留该截止点；未完成的旧事件格式不能当作 Pi 恢复。`EvidenceRef` 仍是 Evaluator 输出中的证据引用，不是 Subject 证据包。SP Chat 是持久 Session：Sampling 和 EvaluationRecord 各自标识 Chat，Attempt 保存该 Chat 内真实的 `submissionId`。Attempt 的 `AgentResourceState` 在投递前按 `chatId + idempotencyKey` 登记 `pending`，`collected` 只保存 `summarizeResourceSnapshot` 摘要（含 `submissionId` 与 usage/native/billing 数量），另有下载计数和放弃标记；原始正文在单独快照中，Metrics 按记录逐条读取。Dataset/Data 由 `eval-dataset` 拥有，ProjectSample 由 `eval-runtime` 拥有；`Sampling.projectSampleId` 引用它。

JSON 值与标识符规则也只在这里定义：`jsonValueSchema`、`jsonObjectSchema`（有限数、安全整数、无环纯数据）、原地校验不复制的 `jsonObjectInPlaceSchema` 与 `jsonObjectArrayInPlaceSchema`（大体量原始记录，如资源快照事件数组，Eval API 线协议与 Runtime 共用）和 `identifierSchema`、`isIdentifier`、`IDENTIFIER_RULE`（非空且无首尾空白）。

状态词表只在这里定义：`SAMPLING_STATUSES`、`PENDING_SAMPLING_STATUSES`、`AGENT_STATUSES`、`TERMINAL_AGENT_STATUSES` 及谓词 `isPendingSamplingStatus`、`isTerminalAgentStatus`，`SamplingStatus`、`AgentStatus` 由它们派生，SQL 使用同一常量。`AgentSubmission.status` 是 SP 归一化后的状态，SP 原始状态只在 Eval API 的 Harness 适配层映射一次。

资源契约位于 `src/resources.ts`，通过包根入口导出。新的 `AgentResourceSnapshotDownload` 只携带已核验的摘要和有界页流，Store 原子保存后释放临时字节；已保存的 `AgentResourceSnapshot` 原样承载 SP 的 `usageEvents`、`billingSettlements`、覆盖度与 readiness，`nativeRecords` 保留已核验的来源身份及 body-free Metrics facts，不在 PostgreSQL 重复保存 Pi 大正文，也不是 Eval 重新设计的费用/Token/Tool/Turn 模型。来源缺失、`null`、顺序、重复记录及子 Agent 身份保留；Runtime 不补零、不换算、不抽取、不合并、不去重、不计算总量。历史原始快照不迁移，旧 `telemetryEvents` 不属于新快照契约。SP `alpha.7` 已作为 npm 公共包安装，HTTP finalized 页使用其 Schema；partial 请求尚无公共包契约，本地消费者不代表部署互通或全局 OOM 安全。

`coverage` 分别保留来源对三组记录的 `complete | partial | unavailable` 声明，`finalized` 保留操作终结声明；`collected` 只表示读到了并保存了快照，不保证来源完整。资源等待到期后通过公共 Harness 的显式 `allowPartial` 选项采集时，未终结的三个来源均为 `partial`，有界页和已核验字节仍按真实数量原子写入；未完成计费、未投递记录以及暂时为零的已知条目不能宣称完整或推断为零费用。初始化 Session 历史和导入的 Subject 证据不属于本次资源范围。失败、取消和重启的使用/结算来源事实与 compact Pi facts 不能因最终结果失败而删除，历次主动重评也不能混入同一评估记录。Metrics 读取这些事实，负责来源解析、去重、重叠用量处理、费用/Token/工具/Turn 统计及汇总。

一旦观察到 Agent 终态，Attempt 的状态及完成时间就固定为该 Agent 事实，`error` 保留原 Agent 错误；Runtime 资源持久化/产物收尾失败由执行或评估阶段的 `lastError` 表达，不把已经 `completed` 的 Attempt 改为 Agent 失败。保存重试复用同一份事实，不改变 Sampling/Evaluation/Attempt/Submission 身份。

Subject 的产物和完整轨迹是执行终态的必需证据。`Sampling.execution.evidencePending` 表示 Agent 已终结、证据尚未完整保存；此时执行保持非终态，恢复进程只补收证据，不再次提交或重启 Agent。证据与执行终态在同一次 Sampling 写入中保存；原 Agent 错误保留在 Attempt 和阶段错误中。

`RunOperation` 为 `execution | pipeline | evaluation`，由每次启动选择，不写入 Project。`RunPhase` 只有 `execution | evaluation`；`RunPhases` 由 operation 推导：只执行、只评估或顺序执行后评估。`RunSnapshot` 返回 `operation`、`phases`、`selector`、`targets`、`samplingIds`、`evaluationIds`，`phase` 和 `status` 从子记录推导。Pipeline 只负责组合两阶段，没有第三种阶段或独立的 Pipeline 数据模型。

`RunRequest` 包含 `idempotencyKey`、`projectId`、`operation`、`selector`、`targets` 和必填 `expectedPlanDigests:{execution:string,evaluation?:string}`（规范 JSON SHA-256 小写十六进制）。提交必须从同一次 preview 原样携带计划摘要：execution 只有 execution；pipeline/evaluation 同时有 execution 与 evaluation。该字段只在准入时核对，不另存一份；Run 已有的 `planDigests` 是唯一持久副本。只读 `RunReplayRequest` 允许省略摘要，用于按原 key/完整意图核对旧已存 Run；它不能准入新 Run。请求不携带任何配置 ID 或 Dataset/Data 内容。`RunTargetSelector` 是 `all`、`datasetIds`、`projectSampleIds`、`samplingIds` 的组合，只在 Project 快照内展开；`RunTargets` 是 preview 返回的固定、去重结果（`projectSampleIds` 与 `samplingIds`），提交和重试时原样带回。evaluation 的 `projectSampleIds` 为空，`samplingIds` 为要重新评估的成功 Sampling。

`RunSnapshot.stopRequested` 表示 Run 已请求停止；停止期间与收尾后的 Run 状态见[架构方案](../../docs/architecture.md#run-调度与停止)。

每次部署选定一个 SP 分支并独立发布整套 Eval SP。`Project` 只含元数据和该分支；Run 记录准入时该发布使用的 SP commit；Sampling 不存分支。

`ProjectPlan` 是一次一致读取的 Project 计划：`project`、按绑定顺序的 `datasets`（每个含创建时成员顺序的 `projectSampleIds`）、`execution` 与 `executionPlanDigest`，以及可空的 `evaluation: ProjectEvaluation`（`plan`、`digest`、`lockedAt` 只能一起存在）。`ExecutionPlan` 创建后不可修改，含 Subject `harness`、`subjectAgentConfig`、`executionConcurrency` 和 `retryPolicy`；`EvaluationPlan` 含 SP 框架的 `evaluationHarness`、`evaluatorAgentConfig`、`evaluationConcurrency`、`retryPolicy` 和 `outputSchema`（Schema ID 与规范 JSON 的 sha256），在首个 pipeline/evaluation Run 准入时锁定，锁定前可整体替换。Harness 中的 `agentConfig` 是 Project 的冻结副本引用，指向 Eval SP 自己的 `user-agent` 库；`AgentConfigSnapshot` 是冻结时的正文快照，只用于展示，运行从不用它重建配置。

`RetryPolicy.maxRestarts` 控制确认失败后的 Agent 重启；计划仍保存 `initialBackoffMs` 和 `maxBackoffMs`，由 Runtime 写入固定的 250ms 和 10s。创建、初始化、提交校准、状态读取、产物/证据、资源读取、持久化和停止调用等幂等瞬态操作固定重试 10 次，不提供单独配置。

评估输出格式是 Eval API 中独立上传的一份带名称和描述的 draft 2020-12 JSON Schema 文件，正文不可变。每个 Evaluator 初始化时通过专用字段在自己 Workspace 的固定路径 `/evaluation-output.schema.json` 收到 Schema，与素材目录分开。`EvaluationAgentOutput.structuredOutput` 是 Evaluator 的原始结果：路径（结果文件路径或 `mcp:submit_evaluation` / `final-reply`）、原始 UTF-8 文本、可选 hash 和可选来源 `source`（`submission | result-file | final-reply`，旧记录缺省即结果文件），不是解析后的副本；缺失时由 Metrics 报告为 unavailable，不当作 0。

`EvaluationOutputSchemaDocument` 把同一次读取的 `reference`（Schema ID 与摘要）和 `content` 绑定在一起，供 Project 只读查看；目录软删除不改变引用，也不增加可编辑的 Schema 副本。

`AgentObservationRef` 是 Sampling（Subject）或 EvaluationRecord（Evaluator）的只读观察目标：角色、Project、Sampling、可选 Evaluation、Chat 所属用户、可选 Chat ID 和 `not-started | available`。它不包含可写 Chat URL。

`AgentFramework` 为 `sp | codex | cc`。`HarnessConfig.kind` 表示统一的 SP 云端宿主，必填的 `framework` 表示所运行的 Agent 框架；三种框架都引用 SP 管理的 Agent Config，复用同一 Chat/Submission/Workspace 边界。执行计划可选择三者，评估计划固定 SP 框架，不由本包实现进程启动或云端部署。

新运行的 Subject 成功后导出一份不可变证据包：`manifest.json`（`schemaVersion: 2`、`evidenceId`、来源、`subjectInputs`、`artifacts`、`trajectory.format: "sp-pi-trajectory/v1"`、有序分片及完整性、`omitted`）加按 sha256 存一次的文件。轨迹分片记录 size、sha256 和原生记录数，保留每行原始 `{ingestSeq,record}`，不把旧事件改名为 Pi。`evidenceId` 是去掉自身字段后规范 manifest 的 `sha256:<hex>`。`Sampling.evidence` 是 `{evidenceId, manifestSha256, exportedAt}`，`Sampling.trajectory` 指向 `evidence:<evidenceId>/trajectory/`，内容摘要使用 manifest hash。产物超出 `DEFAULT_EVIDENCE_LIMITS` 的记录进入 `omitted`；完整轨迹按记录边界分片，单条记录超过文件上限则明确失败，不截断。历史 schemaVersion 1 的字节、引用和评分保留，但不作为新格式解码。完整接口约束见[包边界](../../docs/package-boundaries.md#evidence-export-and-import)。

原始 `structuredOutput` 是评估输出的唯一事实。可选 Langfuse 分数由 Metrics 同一 Schema reader 派生，不在 `EvaluationAgentOutput` 再保存 `score` 或 `reason`。`scoreSync` 只记录外部投递结果。

每个 Evaluator 是普通 Agent，拥有独立 Chat、Submission、轨迹和自己的 Space，不绑定 Subject。证据包导入到 `/evidence/`（`manifest.json`、`artifacts/<原路径>`、`trajectory/events-000001.jsonl` 等有序分片），结果通过 `submit_evaluation` 工具提交（见[评估结果提交](../../docs/eval-evaluation-result-submission.md)），未配置该工具时写到 `/output/result.json`。

本包不负责运行 Agent、读取 SP Workspace、访问 R2、持久化数据库或实现 API/Web/CLI。


手动重新收集结果：POST /api/projects/{projectId}/samplings/{samplingId}/collect 与 /evaluations/{evaluationId}/collect 返回 202 {runId, queued}。仅接受归属匹配、最后 Attempt 为 completed 且有 Chat/Submission 的失败阶段；已成功为幂等无操作，重复待收集请求不重复入队，项目忙或 Run 已停止时拒绝。API 在 Project 行锁内设置 retrying + collectionPending，并原子提交原 Run 队列任务。Worker 只读取已有输出，不创建或重启 Agent/Attempt；执行侧必须归档产物和完整轨迹，评估侧保存原始结果并沿用校验和同步。失败清除待收集标记并保留错误，支持再次补收。补收执行不自动启动之前已取消的评估。当前运行查询允许旧 Run 因补收重新活跃，runSequence 仍是最大创建序号。
