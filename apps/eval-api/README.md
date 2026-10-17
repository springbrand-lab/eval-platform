# @eval-platform/eval-api

内部评估控制面的应用组合层：Hono HTTP 控制面、PostgreSQL 适配器（`DatasetStore`、Project 快照存储、`ProjectPlanReader`、`RuntimeStore`、只读 `MetricsSource`）、Project 创建与评估计划服务（含 Agent Config 冻结副本）、Eval SP 客户端与 SP Harness，以及 pg-boss Run Worker。不增加第五个共享包。设计见 [Project、Runtime 与 Metrics 设计](../../docs/eval-project-redesign.md)。

## 进程与环境变量

本文是环境变量的唯一完整列表。两个进程对接同一 Eval SP 发布，挂载同一个 `EVAL_BUNDLE_DIR`，配置无效时启动失败。日志统一使用 pino（API 请求日志用 `hono-pino`），错误经 `errorDiagnostics` 脱敏后记录。

`pnpm --filter @eval-platform/eval-api start:api`（`src/server.ts`，配置见 `src/config/api.ts`）启动 HTTP 控制面：

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | Eval PostgreSQL；API 也以生产者身份连接 pg-boss |
| `EVAL_SP_API_ORIGIN` | Eval SP API：启动时校验服务会话，以及 Agent Config |
| `EVAL_SP_SERVICE_USER_ID` | 固定的 Eval SP 服务账号 ID，所有数据都归属这个账号 |
| `EVAL_SP_SERVICE_SESSION_TOKEN` | 该服务账号的长期会话 token，由 SP 的 `eval:bootstrap-service-account` 脚本签发 |
| `EVAL_SP_ADMIN_TOKEN` | Eval SP 部署自己的 `RESOURCE_ADMIN_TOKEN`，只用于给服务账号加积分，不能与 dev/production 共用 |
| `EVAL_WEB_ORIGIN` | Eval Web 来源：唯一的 CORS 与受信 Origin，同时作为 Agent Config 写请求发给 SP 的 Origin |
| `EVAL_SP_SOURCE_BRANCH`、`EVAL_SP_SOURCE_COMMIT` | 当前 Eval SP 发布的分支与完整 commit |
| `EVAL_BUNDLE_DIR` | 共享 Bundle 目录，绝对路径 |
| `EVAL_SP_AGENT_ORIGIN` | Eval SP Agent Worker：只读观察时读取 Chat 消息与工作区 |
| `EVAL_SP_TRUSTED_ORIGIN` | 只读观察请求发给 Eval SP 时携带的 Origin，必须是 Eval SP Agent 信任的来源（eval 部署为 `https://devrapp.springbrand.ai`） |
| `EVAL_WEB_API_TOKEN` | 与 eval-web Worker 共享的令牌（至少 32 个字符）。配置后 `/api/*` 只接受带正确 `X-Eval-Web-Token` 的请求；只有本地开发可以不配 |
| `EVAL_API_HOST`、`EVAL_API_PORT` | 可选，默认 `127.0.0.1`、`8788` |
| `LANGFUSE_BASE_URL`、`LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY`、`LANGFUSE_ENVIRONMENT` | 可选，与 Worker 相同；配置后才能调用 Run 的分数补同步接口 |

收到 SIGINT/SIGTERM 后停止接收请求，等待活动请求结束，再关闭 Run 队列和数据库连接池。API 不持有 Agent Worker 服务凭证，也不在请求中运行 Agent。

`pnpm --filter @eval-platform/eval-api start:worker`（`src/run-worker-main.ts`，配置见 `src/config/worker.ts`）启动 Run Worker：

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | Eval PostgreSQL 与 pg-boss |
| `EVAL_SP_AGENT_ORIGIN` | Eval SP Agent Worker，提供 `/internal/v1/eval-harness` 服务路由 |
| `EVAL_SP_SERVICE_TOKEN` | Eval SP 服务凭证，作为 `X-Eval-Service-Token` 发送 |
| `EVAL_BUNDLE_DIR` | 与 API 相同的 Bundle 目录；未配置 R2 时证据包存放在其下的 `evidence/` |
| `EVAL_EVIDENCE_R2_ENDPOINT`、`EVAL_EVIDENCE_R2_BUCKET`、`EVAL_EVIDENCE_R2_ACCESS_KEY_ID`、`EVAL_EVIDENCE_R2_SECRET_ACCESS_KEY` | 可选，四者同时设置：Eval 专用 R2 桶的 S3 接口地址（如 `https://<account>.r2.cloudflarestorage.com`）、桶名与访问密钥。设置后证据包存入该桶 |
| `EVAL_RUN_WORKER_CONCURRENCY` | 可选，每个实例同时处理的 Run 数，默认 `8` |
| `LANGFUSE_BASE_URL`、`LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY` | 可选，三者同时设置：Eval SP 上报 trace 的同一个 Langfuse 项目。设置后评委分数同步为被测 Chat 的 session 分数 |
| `LANGFUSE_ENVIRONMENT` | 可选，必须与 Eval SP trace 的 environment 一致（eval 部署为 `dev`） |

被测执行成功后，Worker 经 SP 导出接口取得被测产物清单、逐个文件和完整轨迹（完整原始事件按顺序分片），由 `src/evidence/` 按内容 hash 固化为证据包：`evidence/blobs/<sha256>` 与 `evidence/<evidenceId 的 hex>/manifest.json`，Sampling 只记录 `evidence` 引用。评估时评委是普通 Agent，有自己的 Chat 和 Space；Worker 把证据包导入评委 Space 的 `/evidence/`（`manifest.json`、`artifacts/<原路径>`、`trajectory/events-000001.jsonl` 等有序分片），评委看不到被测 Workspace。

评估 Agent 通过 Eval API 自带的 MCP Server（`POST /mcp/evaluation-results`，工具 `submit_evaluation`，需配置 `EVAL_RESULT_MCP_TOKEN`）直接提交结果，提交时按锁定 Schema 校验并存入 `eval_evaluation_submissions`；没有提交时依次回退到 SP 返回的 `/output/result.json` 和最终回复中的 JSON。只有合法结果才使评估成功，详见[评估结果提交](../../docs/eval-evaluation-result-submission.md)。Metrics 统一按 Project 锁定 Schema 解析和展示所有支持的字段。配置 Langfuse 时，同一 Metrics reader 从合法输出派生顶层 numeric `score` 和可选字符串 `reason`，发布到被测 Chat 的 session，名称 `judge-score`、ID `eval-score:<evaluationId>`。原始输出不增加派生 score/reason 字段；没有 numeric score 不影响评估。同步失败只记在 `scoreSync`，补同步重新从原始输出与锁定 Schema 派生。

Worker 可多实例部署、滚动升级；收到信号后停止取任务，等待进行中的 Run 结束再关闭 pg-boss 和连接池。调度、恢复、停止语义和剩余风险见[架构方案](../../docs/architecture.md#run-调度与停止)。

## 本地开发

`start:api` 和 `start:worker` 自动加载本包目录下的 `.env.eval`（不提交），已有 shell 环境变量优先；文件不存在时只读取 shell 环境变量。根目录 `pnpm dev` 同时启动这两个进程与 Web。使用 Web 默认代理时，在 `.env.eval` 中设置 `EVAL_API_PORT=18788`，并确保 Web 的 `EVAL_API_ORIGIN` 指向该端口。

`@springbrand/eval-harness` 以精确版本从 npm 安装，版本需与 Eval SP 部署的契约一致；ZIP 检查、错误类型和初始化上限均从这个公开入口读取，不直接依赖 SP 的 utils。`@springbrand/http` 直接来自 npm，与 SP 使用同一精确版本。

数据库只有 `migrations-postgres/0000_initial.sql` 一个初始基线，用 `pnpm --filter @eval-platform/eval-api db:migrate` 应用于本地库（需 `DATABASE_URL`），与部署镜像共用同一迁移入口。命令先从实际连接输出库名、角色和服务地址，不输出连接串或凭据；迁移前校验已应用记录的时间与 SQL hash，迁移后用当前 Drizzle schema 验证所有表、列可读取。改写已应用 SQL、未知迁移或缺失结构都会阻断部署，不会因 Drizzle 跳过旧编号而报成功。命令不清库，也不兼容旧结构。本地旧库与新基线或新请求指纹不一致时清库重建；共享库必须经确认的数据恢复/升级操作处理，不能把本地命令指向共享库。测试设置 `DATABASE_URL` 后为每次运行创建独立的临时数据库；不提供时跳过需数据库的测试。pg-boss 在同一数据库中自建 `pgboss` schema。

## 部署

`pnpm --filter @eval-platform/eval-api build` 用 esbuild 把 `src/server.ts`、`src/run-worker-main.ts` 和 `src/migrate.ts`（用 drizzle-orm 应用 `migrations-postgres`）打包为 `dist/*.js`，只把 `pg` 留作外部依赖；`scripts/runtime-package.mjs` 据此从锁文件生成只含这些依赖的运行时包。`Dockerfile`（在仓库根目录构建）的运行时镜像只有 `dist/`、迁移目录和这些生产依赖，不含 TypeScript 源码和 tsx，分别以 `node dist/server.js`、`node dist/run-worker-main.js`、`node dist/migrate.js` 运行。本地开发仍用 `start:api`、`start:worker`（tsx）。生产环境与 Eval SP 共用 AWS 资源：

- 运行在 Eval SP 所在的 EC2 实例上，compose 项目 `eval-platform`（`/opt/eval-platform/production`），服务 `api` 与 `run-worker` 共享 `bundles` 卷作为 `EVAL_BUNDLE_DIR`；日志写入 CloudWatch `/springbrand/eval-platform/production`。
- 数据库是 Eval SP RDS 实例上的 `eval-platform` 库，角色 `eval_platform_app`。
- `api` 加入 Eval SP 的 compose 网络 `eval_default`（别名 `eval-platform-api`），由该网络的 cloudflared 隧道 `sp-platform-api-eval` 对外提供 `https://evalapi.springbrand.ai`；不开放任何主机端口。
- 运行配置在 Secrets Manager：`eval-platform/api/production`（上文环境变量，`DATABASE_URL`、`EVAL_BUNDLE_DIR`、`EVAL_API_HOST`/`PORT` 除外）与 `eval-platform/database/production`（数据库凭证）。部署时生成 `DATABASE_URL`，API 与 Worker 只拿到各自需要的变量。Eval SP 重新发布后需更新其中的 `EVAL_SP_SOURCE_COMMIT` 并重新部署。

AWS 资源由 `infra/aws/cloudformation.yaml`（栈 `eval-platform-api`）创建。推送到 `main` 且改动涉及 eval-api、共享包或部署文件时，`.github/workflows/ci.yml` 在 eval-api（及共享包）测试通过后经 GitHub OIDC 构建并推送 ECR 镜像，再通过 SSM 在实例上执行 `infra/aws/deploy/deploy.sh`：拉取镜像、运行迁移、替换两个服务，检查 `/healthz` 并以 Web 凭证读取初始素材、初始上下文、Prompt 数据集和评分 Schema 四个目录。部署不重建数据库，也不自动上传演示数据；可重复使用的模拟输入见 [联调数据](../../fixtures/eval-demo/README.md)。

## HTTP 控制面

`GET /api/input-limits` 从实际校验常量返回上传与选择上限，Web 不保存数值副本。

Project 视图的 `runSequence` 和 `currentRun` 从同一最新 Run 行及其当前工作投影读取；序号复用准入已有的 `runs.sequence`，没有另一份版本存储。Web 因而能发现两次轮询间已经结束的短 Run。

`GET /api/projects/{projectId}/evaluation-output-schema` 在同一只读快照中检查 Project 归属和可见性，复用 Worker 的计划引用及摘要校验，返回 Schema 引用与正文；没有评估计划时为 null。Schema 目录软删除不影响此读取，目录接口仍禁止新选择已删除项。

路由、信封、状态码、错误码和请求体规则只在 [Eval HTTP 控制面](../../docs/eval-http-api.md) 描述；Dataset 上传、初始资源与输出格式见 [Dataset upload](../../docs/eval-dataset-upload.md)。内容上限的唯一来源是 `src/limits.ts`（`RUN_TARGET_IDS` 同时限制一个 Project 绑定的 Data 数和一次 Run 的选择/目标 ID 数，超出的展开结果返回 413），各路由的请求体上限由其推导。

Eval API 不做交互式登录，固定以一个 Eval SP 服务账号运行。服务账号与它的长期会话由 sp-platform 的 `pnpm --filter sp-platform-api eval:bootstrap-service-account` 在 `sp-platform-eval` 库中创建，可重复执行，每次轮换会话。进程启动时用 `EVAL_SP_SERVICE_SESSION_TOKEN` 调用一次 Eval SP 的 `/api/auth/me`，结果必须是 `EVAL_SP_SERVICE_USER_ID`，否则拒绝启动；之后每个 `/api/*` 请求都归属这个账号，请求不需要携带 `Authorization`，客户端也不能指定用户。Agent Config 的增删改查用服务会话调用 Eval SP 的 `/api/user-agent-configs`，写请求带上 `EVAL_WEB_ORIGIN` 以满足 SP 的来源校验。Eval 不保存配置正文。服务账号的积分不自动发放，由 `/api/credits/grants` 用 `EVAL_SP_ADMIN_TOKEN` 调用 Eval SP 的管理员加积分接口手动添加（见 HTTP 契约的 Credits 一节）。API 是内部服务，只能部署在受信网络内。

共享 Agent 编辑器的默认模板、模型和资源库经 `/api/agent-library` 的显式方法/路径表转发；资源库正文由 SP 公共接口校验，Eval 统一执行请求体限长、JSON 唯一字段、Origin 与固定服务账号规则。配置写入不在此转发表内，仍经过已有冻结副本服务。传输层从 Eval HTTP 目录解码公开编辑器错误，保留验证后的删除阻挡详情；SP 服务会话失效始终是依赖不可用，不能触发浏览器重新登录。接口列表与字节限制见 HTTP 契约。

`owner-services.ts` 按服务账号组装一次用户范围内的服务；同一用户的并发请求经 `active-owner-admission.ts` 共享 Run 准入实例（`createEvalRunAdmission` + 用户范围的 `createPostgresProjectPlanReader` 与 `RuntimeStore`），请求结束后释放；准入不持有登录 token。

### Project 创建、评估计划与冻结副本

`src/projects/service.ts` 是 Project 唯一的写入口：

- 创建：在一个 repeatable-read 只读事务里读取所选的自有、未软删除 Dataset 及其当前成员（`dataIds` 必须是当前成员），同一 Data 在多个 Dataset 中只生成一个 ProjectSample（`datasetIds` 按绑定顺序），`samplingCount` 是默认次数，`samplingCounts` 按 Data 覆盖。随后通过 SP 公开接口克隆所选 Agent Config（`src/agent-configs.ts`），用 Runtime 的 `normalize*Plan`/`digest*Plan` 校验与摘要计划，Schema 摘要是规范 JSON 的 sha256。Project、Dataset/Data 快照、两个计划和副本对应行在一个事务内写入，再以 `{all:true}` 预览并提交首个 Run。
- 幂等：请求体顶层 `idempotencyKey` 在用户内唯一（`eval_projects.creation_key`，与校验后请求体的指纹 `creation_fingerprint` 一起保存），首个 Run 使用同一个 key。克隆 SP 副本之前先按 key 查找：同一请求体重放原 `{project, run}`（若上次在创建事务后、准入前中断，则此时补交首个 Run），不同请求体返回 `PROJECT_IDEMPOTENCY_CONFLICT`，已软删除的 Project 不会复活（无论请求体都返回 `PROJECT_NOT_FOUND`）；重放请求的首个 Run 准入失败时只返回错误，从不补偿删除别的请求创建的 Project。并发的相同请求只有一个创建事务提交，其余请求删除自己的副本后重放。
- 补偿：写入事务前任何失败都删除已建的 SP 副本；首个 Run 准入失败时，若该 Project 仍没有任何 Run，就硬删除它的全部行再删除副本（`deleteUnrun`），否则保留已准入的 Project。SP 删除尽力而为，残留的孤儿副本不会出现在列表中。
- 评估计划：`PUT /evaluation-plan` 先确认未锁定（避免多余副本），冻结新的 Evaluator 副本，再在与准入相同的 Project 行锁下替换计划、标记旧副本 retired；提交后删除旧副本，事务失败则删除新副本。首个 pipeline/evaluation Run 在准入事务中写入 `locked_at`。
- 冻结副本：SP 创建体为 `{slug: "eval-frozen-<uuid>", name: "<原名> (frozen)", description, setting}`（SP 对已存在的 slug 返回原记录，所以每次都用新 slug）；判定与可见性规则见 [Agent Config 冻结副本](../../docs/eval-project-redesign.md#23-agent-config-冻结副本)，实现在 `src/agent-configs.ts`。

## PostgreSQL 适配器

`src/db/client.ts`、`schema.ts` 定义与 SP 一致的 Drizzle/`pg` 注入边界和表结构；领域错误类集中在 `src/db/errors.ts`。所有记录都携带用户归属，组合外键保证 Project、ProjectSample、Sampling、Run 和 Evaluation 同用户。

表结构见 [Project、Runtime 与 Metrics 改造方向](../../docs/eval-project-redesign.md#46-持久化)。目录侧的 Dataset/Data/素材 Bundle/上下文 Bundle/Material/Session/输出格式软删除从不被 Project 阻挡：快照复制了 Data，Worker 按 ID 读取素材文件和 Schema。

- `createPostgresProjectStore` 写 Project 快照、替换评估计划、软删除（存在活动 Run 时拒绝）和读取计划视图；`createPostgresProjectPlanReader`（用户范围）与 `createPostgresWorkerProjectPlanReader`（仅 Worker）实现 Runtime 的 `ProjectPlanReader`，已软删除的 Project 读为不存在，详情、预览、Run、Metrics 和观察入口因此一律 404。
- `createPostgresRuntimeStore` 与 HTTP 路由使用同一已校验的 `EvalSpRelease`；`admitRun` 在 Project 行锁下完成重放/冲突（同 key 只能重放 Project 最新的 Run）、忙碌检查、发布校验、计划摘要与评估计划复核、目标与当前 Sampling 集合复核、只删除选中记录及其 Run 关联、分批插入、首次评估锁定评估计划，并在同一事务内经 `fromDrizzle(transaction)` 投递 pg-boss 任务。Run 行从不删除，被替换的成员从其 Run 关联中移除。
- `createPostgresWorkerRuntimeStore` 只供 Worker 跨用户恢复 Run，HTTP 路由不能注入它。
- Sampling/Evaluation 写入携带预期旧事实，PostgreSQL 用同一条条件 `UPDATE` 比较 JSONB `facts` 后替换；未命中即报告冲突，由 Runtime 读回校准，不新增版本列。
- `createPostgresMetricsSource` 在一个 repeatable-read 只读事务内按固定计划读取范围内全部 ProjectSample（含从未运行的）、当前 Sampling/Evaluation（可按 `runIds` 过滤）和相关 Run 投影，全部为集合查询，不用实时 `dataset_data` 推断归属。`createPostgresObservationReader` 校验 Project 与当前记录后返回只读观察引用，从不返回可写 Chat URL。
- 初始 Session/素材只存外部引用，Agent 工作区和完整轨迹只保留 Runtime 原始引用；迁移不触碰 SP DO。

## SP Harness 与 Bundle 目录

`src/sp/harness.ts` 用服务凭证确保 Inbox Chat、初始化、提交/重启、按键校准、收集完整产物/轨迹、原始资源、Evaluator 原样的 `structuredOutput` 结果文件，以及按轨迹读取 Evaluator 最后一条回复（`readFinalReply`）；`sp/submission-observer.ts` 以 WebSocket 终态推送为主，Ping/Pong 检测静默失活，断线后读取一次权威状态并有限重连，健康连接期间不轮询。SP HTTP 请求默认最多等待 60 秒，停止调用最多 10 秒。当前只支持 `sp` 框架，`codex`、`cc` 明确拒绝。服务契约、Bundle 文件布局与校验规则见 [Eval SP Harness service contract](../../docs/eval-sp-harness-protocol.md)。SP 服务路由已在独立 SP 分支实现，真实跨部署联调仍需完成。

`src/sp/bundle-directory.ts` 的 `openBundleDirectory` 是 API 上传与 Worker 读取共用的唯一 Bundle 目录实现；文件错误以 `BundleFileError` 表达，只有 `unavailable` 可重试。`src/sp/bundle-content.ts` 是 Material 与 Session 内容的唯一校验规则，上传、ZIP 导入和读取共用；`src/bundle-zip/` 用 SP 的 `inspectStrictZip` 读取 ZIP，再按 Bundle 类型分组成资源。

资源目录通过现有 `BundleCatalog` 的 `listFiles` / `getFile` 提供只读文件清单和内容，先检查当前用户的活动 Bundle 与资源，再读取同一份 Bundle 文件。素材保留资源内路径；上下文以单个 `/context.json` 或 `/context.jsonl` 文件公开原文。HTTP 文件响应与运行观察文件共用附件、sandbox CSP 和禁止缓存的响应边界。目录软删除不开放浏览，Worker 对既有 Project 引用的读取不变。已存内容损坏为 `corrupt`，HTTP 映射为安全的 `500 BUNDLE_FILE_CORRUPT` 并保留内部 cause；上传校验仍为 `invalid` / `too-large`。


数据集维护：DatasetService.addData(datasetId, inputs) 校验全部输入并生成身份，DatasetStore.createDataBatch 在一个事务中创建全部 Data 及其关联，失败不保留部分用例。HTTP `POST /api/datasets/{datasetId}/data/import` 接受 `{format: "json" | "jsonl", content: string}`，采用用例列表的严格解析、资源引用限制及 prompt 文件/请求大小上限；返回 201 Data[]。原有完整文档导入的身份冲突和重放语义不变。Web 导航调整不改变 Subject/Evaluator、资源引用和项目冻结副本契约。


手动重新收集结果：POST /api/projects/{projectId}/samplings/{samplingId}/collect 与 /evaluations/{evaluationId}/collect 返回 202 {runId, queued}。仅接受归属匹配、最后 Attempt 为 completed 且有 Chat/Submission 的失败阶段；已成功为幂等无操作，重复待收集请求不重复入队，项目忙或 Run 已停止时拒绝。API 在 Project 行锁内设置 retrying + collectionPending，并原子提交原 Run 队列任务。Worker 只读取已有输出，不创建或重启 Agent/Attempt；执行侧必须归档产物和完整轨迹，评估侧保存原始结果并沿用校验和同步。失败清除待收集标记并保留错误，支持再次补收。补收执行不自动启动之前已取消的评估。当前运行查询允许旧 Run 因补收重新活跃，runSequence 仍是最大创建序号。

Run 评估列表省略可选 output 正文和 attempt.resources 原始快照；详情接口仍提供完整记录。避免列表重复传输完整遥测导致响应超过客户端限制。

## Metrics memory bounds

Sampling/Evaluation writes atomically persist `metric_facts`, a rebuildable body-free telemetry projection, alongside unchanged raw `facts`. Project/Dataset/Sample metrics read this projection; single-Sampling details read only that Sampling's raw records. Run progress reads status fields, not resource bodies. The additive migration and its bounded backfill retain existing data and process one record per transaction. Old writers invalidate changed projections during a rolling release; a missing projection is read and compacted individually, with no unbounded raw-project query. Deployment finishes any remaining backfill after both writers are upgraded; rerunning the migration is safe. No increase to heap/container memory or request timeouts is required.

MCP-enabled Evaluations complete on validated result acceptance, atomically with the result and metric facts. Status-socket loss is recoverable observation failure, not an Evaluation terminal fact. Late submissions cannot bypass Project deletion, Run stop/cancellation or replacement. Runtime preserves accepted results when subsequent observation or collection fails. See [evaluation result submission](../../docs/eval-evaluation-result-submission.md).
