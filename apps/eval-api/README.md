# @eval-platform/eval-api

内部评估控制面的应用组合层：Hono HTTP 控制面、PostgreSQL 适配器（`DatasetStore`、`RuntimeStore`、Project/Sample Catalog、Config 存储、只读 `MetricsSource`）、Eval SP 客户端与 SP Harness，以及 pg-boss Run Worker。不增加第五个共享包。

## 进程与环境变量

本文是环境变量的唯一完整列表。两个进程对接同一 Eval SP 发布，挂载同一个 `EVAL_BUNDLE_DIR`，配置无效时启动失败。日志统一使用 pino（API 请求日志用 `hono-pino`），错误经 `errorDiagnostics` 脱敏后记录。

`pnpm --filter @eval-platform/eval-api start:api`（`src/server.ts`，配置见 `src/config/api.ts`）启动 HTTP 控制面：

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | Eval PostgreSQL；API 也以生产者身份连接 pg-boss |
| `EVAL_SP_API_ORIGIN` | Eval SP API：启动时校验服务会话，以及 Agent Config |
| `EVAL_SP_SERVICE_USER_ID` | 固定的 Eval SP 服务账号 ID，所有数据都归属这个账号 |
| `EVAL_SP_SERVICE_SESSION_TOKEN` | 该服务账号的长期会话 token，由 SP 的 `eval:bootstrap-service-account` 脚本签发 |
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

路由、信封、状态码、错误码和请求体规则只在 [Eval HTTP 控制面](../../docs/eval-http-api.md) 描述；独立评估的选择与提交语义见[独立评估入口](../../docs/eval-independent-evaluation-entry.md)，Dataset 上传、初始资源与输出格式见 [Dataset upload](../../docs/eval-dataset-upload.md)。内容上限的唯一来源是 `src/limits.ts`，各路由的请求体上限由其推导。

Eval API 不做交互式登录，固定以一个 Eval SP 服务账号运行。服务账号与它的长期会话由 sp-platform 的 `pnpm --filter sp-platform-api eval:bootstrap-service-account` 在 `sp-platform-eval` 库中创建，可重复执行，每次轮换会话。进程启动时用 `EVAL_SP_SERVICE_SESSION_TOKEN` 调用一次 Eval SP 的 `/api/auth/me`，结果必须是 `EVAL_SP_SERVICE_USER_ID`，否则拒绝启动；之后每个 `/api/*` 请求都归属这个账号，请求不需要携带 `Authorization`，客户端也不能指定用户。Agent Config 的列表和编辑用服务会话调用 Eval SP 的 `/api/user-agent-configs`，写请求带上 `EVAL_WEB_ORIGIN` 以满足 SP 的来源校验。Eval 不保存配置正文。API 是内部服务，只能部署在受信网络内。

`owner-services.ts` 按服务账号组装一次用户范围内的服务；同一用户的并发请求经 `active-owner-admission.ts` 共享 Run 准入实例，请求结束后释放。Run 准入使用不保留登录 token 的 `createPostgresConfigReader`；配置编辑使用 `createPostgresConfigStore`，保存时用服务会话向 Eval SP 核对 Agent Config 的真实归属。

## PostgreSQL 适配器

`src/db/client.ts`、`schema.ts` 定义与 SP 一致的 Drizzle/`pg` 注入边界和表结构；领域错误类集中在 `src/db/errors.ts`。Dataset/Data、Project/Sample、Sampling、Run、Evaluation 都携带用户归属，组合外键保证 Project、Sample、Sampling、Run 和 Evaluation 同用户；同一 Run 内每个 Sampling 只有一条 Evaluation，Run 阶段与请求身份由 CHECK 约束守护，违反时报告 `RuntimeInputError`。每个 Run 必须有幂等键与请求事实指纹，键在 Project 内唯一。

- `createPostgresProjectCatalog`、`createPostgresCatalog`、`createPostgresRuntimeStore` 使用同一已校验的 `EvalSpRelease`；新 Run 的分支和 commit 必须匹配发布信息。`ownerUserId` 必须来自 Eval SP 会话校验。
- `createPostgresWorkerRuntimeStore` 只供 Worker 跨用户恢复 Run，HTTP 路由不能注入它。Run 准入与停止请求在同一事务内经 `fromDrizzle(transaction)` 投递 pg-boss 任务。
- Sampling/Evaluation 写入携带预期旧事实，PostgreSQL 用同一条条件 `UPDATE` 比较 JSONB `facts` 后替换；未命中即报告冲突，由 Runtime 读回校准，不新增版本列。大量 Run/Sampling/Evaluation 关联在同一事务内分批写入，避开单条 SQL 参数上限。
- Execution 配置的 Dataset 检查在保存事务中加锁，Pipeline 引用只靠外键；被 Execution 配置引用的 Dataset 不可删除。修改配置只影响未来新 Run。
- `createPostgresMetricsSource` 与 Run 视图读取在单个只读、一致性事务中批量投影，Run 状态复用 Runtime 公共投影，不存第二份。
- 初始 Session/素材只存外部引用，Agent 工作区和完整轨迹只保留 Runtime 原始引用；迁移不触碰 SP DO。

## SP Harness 与 Bundle 目录

`src/sp/harness.ts` 用服务凭证确保 Inbox Chat、初始化、提交/重启、按键校准、收集完整产物/轨迹和原始资源；`sp/submission-observer.ts` 以 WebSocket 终态推送为主，Ping/Pong 检测静默失活，断线后读取一次权威状态并有限重连，健康连接期间不轮询。SP HTTP 请求默认最多等待 60 秒，停止调用最多 10 秒。当前只支持 `sp` 框架，`codex`、`cc` 明确拒绝。服务契约、Bundle 文件布局与校验规则见 [Eval SP Harness service contract](../../docs/eval-sp-harness-protocol.md)。SP 服务路由已在独立 SP 分支实现，真实跨部署联调仍需完成。

`src/sp/bundle-directory.ts` 的 `openBundleDirectory` 是 API 上传与 Worker 读取共用的唯一 Bundle 目录实现；文件错误以 `BundleFileError` 表达，只有 `unavailable` 可重试。
