# @eval-platform/eval-api

内部评估控制面的应用组合层：Hono HTTP 控制面、PostgreSQL 适配器（`DatasetStore`、Project 快照存储、`ProjectPlanReader`、`RuntimeStore`、只读 `MetricsSource`）、Project 创建与评估计划服务（含 Agent Config 冻结副本）、Eval SP 客户端与 SP Harness，以及 pg-boss Run Worker。不增加第五个共享包。设计见 [Project、Runtime 与 Metrics 设计](../../docs/eval-project-redesign.md)。

## 进程与环境变量

本文是环境变量的唯一完整列表。两个进程对接同一 Eval SP 发布，挂载同一个 `EVAL_BUNDLE_DIR`，配置无效时启动失败。日志统一使用 pino（API 请求日志用 `hono-pino`），错误经 `errorDiagnostics` 脱敏后记录。

`pnpm --filter @eval-platform/eval-api start:api`（`src/server.ts`，配置见 `src/config/api.ts`）启动 HTTP 控制面：

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | Eval PostgreSQL；API 也以生产者身份连接 pg-boss |
| `EVAL_SP_API_ORIGIN` | Eval SP API：会话校验与 Agent Config |
| `EVAL_WEB_ORIGIN` | Eval Web 来源：唯一的 CORS 与受信 Origin，同时作为 Agent Config 写请求发给 SP 的 Origin |
| `EVAL_SP_SOURCE_BRANCH`、`EVAL_SP_SOURCE_COMMIT` | 当前 Eval SP 发布的分支与完整 commit |
| `EVAL_BUNDLE_DIR` | 共享 Bundle 目录，绝对路径 |
| `EVAL_API_HOST`、`EVAL_API_PORT` | 可选，默认 `127.0.0.1`、`8788` |

收到 SIGINT/SIGTERM 后停止接收请求，等待活动请求结束，再关闭 Run 队列和数据库连接池。API 不持有 Agent Worker 服务凭证，也不在请求中运行 Agent。

`pnpm --filter @eval-platform/eval-api start:worker`（`src/run-worker-main.ts`，配置见 `src/config/worker.ts`）启动 Run Worker：

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | Eval PostgreSQL 与 pg-boss |
| `EVAL_SP_AGENT_ORIGIN` | Eval SP Agent Worker，提供 `/internal/v1/eval-harness` 服务路由 |
| `EVAL_SP_SERVICE_TOKEN` | Eval SP 服务凭证，作为 `X-Eval-Service-Token` 发送 |
| `EVAL_BUNDLE_DIR` | 与 API 相同的 Bundle 目录 |
| `EVAL_RUN_WORKER_CONCURRENCY` | 可选，每个实例同时处理的 Run 数，默认 `8` |

Worker 可多实例部署、滚动升级；收到信号后停止取任务，等待进行中的 Run 结束再关闭 pg-boss 和连接池。调度、恢复、停止语义和剩余风险见[架构方案](../../docs/architecture.md#run-调度与停止)。

## 本地开发

`@springbrand/eval-harness` 通过 `link:` 依赖 sp-platform 工作区，要求 sp-platform 检出在 eval-platform 的同级目录并已执行 `pnpm install`；发布计划见 [SP 共享包发布待办](../../docs/sp-package-publishing-todo.md)。`@springbrand/http` 直接来自 npm，与 SP 使用同一精确版本。

数据库只有 `migrations-postgres/0000_initial.sql` 一个初始基线，用 `pnpm --filter @eval-platform/eval-api db:migrate` 应用（需 `DATABASE_URL`）；本地旧库与新基线或新请求指纹不一致时清库重建。测试设置 `DATABASE_URL` 后为每次运行创建独立的临时数据库；不提供时跳过需数据库的测试。pg-boss 在同一数据库中自建 `pgboss` schema。

## HTTP 控制面

路由、信封、状态码、错误码和请求体规则只在 [Eval HTTP 控制面](../../docs/eval-http-api.md) 描述；Dataset 上传、初始资源与输出格式见 [Dataset upload](../../docs/eval-dataset-upload.md)。内容上限的唯一来源是 `src/limits.ts`（`RUN_TARGET_IDS` 同时限制一个 Project 绑定的 Data 数和一次 Run 的选择/目标 ID 数，超出的展开结果返回 413），各路由的请求体上限由其推导。

登录由 Eval SP 完成。浏览器从 Eval SP 的 `/api/auth/session` 获取会话 Bearer token，调用 Eval API 时携带该 token；Eval API 对每个受保护请求调用 Eval SP 的 `/api/auth/me` 校验活动会话，不仅解码 JWT，也不读 SP 数据库。Agent Config 的增删改查用同一 token 调用 Eval SP 的 `/api/user-agent-configs`，写请求带上 `EVAL_WEB_ORIGIN` 以满足 SP 的来源校验。Eval 不接受客户端自报的用户身份。

`owner-services.ts` 按已校验的用户组装一次用户范围内的服务；同一用户的并发请求经 `active-owner-admission.ts` 共享 Run 准入实例（`createEvalRunAdmission` + 用户范围的 `createPostgresProjectPlanReader` 与 `RuntimeStore`），请求结束后释放；准入不持有登录 token。

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

`src/sp/harness.ts` 用服务凭证确保 Inbox Chat、初始化、提交/重启、按键校准、收集完整产物/轨迹、原始资源和 Evaluator 原样的 `structuredOutput` 结果文件；`sp/submission-observer.ts` 以 WebSocket 终态推送为主，Ping/Pong 检测静默失活，断线后读取一次权威状态并有限重连，健康连接期间不轮询。SP HTTP 请求默认最多等待 60 秒，停止调用最多 10 秒。当前只支持 `sp` 框架，`codex`、`cc` 明确拒绝。服务契约、Bundle 文件布局与校验规则见 [Eval SP Harness service contract](../../docs/eval-sp-harness-protocol.md)。SP 服务路由已在独立 SP 分支实现，真实跨部署联调仍需完成。

`src/sp/bundle-directory.ts` 的 `openBundleDirectory` 是 API 上传与 Worker 读取共用的唯一 Bundle 目录实现；文件错误以 `BundleFileError` 表达，只有 `unavailable` 可重试。
