# @eval-platform/eval-api

内部评估控制面的数据库与执行器组合层：PostgreSQL `DatasetStore`、`RuntimeStore`、Project/Sample Catalog、只读 `MetricsSource` 和单实例 Run Worker。连接池由宿主注入；迁移位于 `migrations-postgres/`，用 `pnpm --filter @eval-platform/eval-api db:migrate` 应用（需 `DATABASE_URL`）。

Catalog 提供 Project 下执行成功 Sampling 的分页查询及全选 ID 查询，二者使用同一 owner/Project/执行状态条件，按 Sampling ID 稳定排序。独立评估的 HTTP 处理器提供分页、全选 ID、显式 ID 提交、Run 状态和本次 Run 的 Evaluation 结果查询；路由和请求契约见[独立评估入口](../../docs/eval-independent-evaluation-entry.md)。提交时将已确定的 ID 列表交给 Runtime `evaluate()`；重试复用同一列表和 Project 范围内唯一的 `idempotencyKey`。三个 Run 入口的 key 与请求事实指纹在同一次 Run 准入事务中持久化，相同请求返回原 Run，冲突请求拒绝，只有新 Run 发送 Worker 通知。

`createIndependentEvaluationApi({ spClient, createOwnerServices, webOrigin? })` 提供 Fetch `handle(Request)`；每个受保护请求都通过 Eval SP 校验 Bearer 会话。服务工厂按校验得到的用户 ID 创建并缓存用户范围内的 Catalog/Runtime，同一用户的并发提交共享 Runtime 的待准入请求。`createPostgresIndependentEvaluationApi({ db, spClient, harness, webOrigin? })` 默认使用同一用户的只读 `createPostgresConfigReader()`，并接入 PostgreSQL Catalog、RuntimeStore 和 Runtime；这份缓存不持有某次登录的 Bearer token。配置编辑后仍由 Runtime 保存的 Run 快照判断旧 key 重放。调用方也可注入其他按用户隔离的 `configStoreForOwner`。`createIndependentEvaluationHttpServer(api)` 是 Node 传输层。批量 Evaluation 结果在 owner/Project/Run 范围内一次查询，不按记录逐条读库。

`pnpm --filter @eval-platform/eval-api start:api` 启动当前独立评估路由的 Node 进程。必需环境变量：`DATABASE_URL`、`EVAL_SP_ORIGIN`、`EVAL_SP_SERVICE_TOKEN`、`EVAL_WEB_ORIGIN`；可选 `EVAL_API_HOST`（默认 `0.0.0.0`）和 `EVAL_API_PORT`（默认 `3000`）。进程接到 SIGINT/SIGTERM 后停止接收新请求，等待活动请求结束，再关闭数据库连接。部署前先应用本包迁移；Run 的实际执行由独立 `start:worker` 进程负责。

目标应用组合层还负责 Eval 独立 SP 的登录校验、`user-agent` 配置列表/编辑、公开 Chat/Submission/Trajectory/Workspace HTTP 与 WebSocket 客户端，以及真实 SP Harness。所有 SP 地址均指向 Eval SP API/Agent/Space，不请求 dev/production SP。Eval SP API/数据库保存账户、Agent Config、计费、Action 等 SP 事实；本应用的 PostgreSQL 只保存评估业务、SP 身份/证据引用及已采集的原始资源快照。Project 绑定当前发布的 SP 分支；首次 Run 准入时在同一事务内固定 Project 的初始操作和配置，此后执行或 Pipeline 新 Run 必须沿用该选择。Run 记录本次发布的实际 SP commit。独立评估只能使用原 Project 已成功的 Sampling，新增评估 Run 不修改 Project 的初始选择；不增加第五个共享包。

登录由 Eval SP 完成。浏览器从 Eval SP 的 `/api/auth/session` 获取会话 Bearer token，调用 Eval API 时携带该 token；Eval API 对每个受保护请求调用固定 Eval SP 地址的 `/api/auth/me` 校验活动会话，不能仅解码 JWT 或直接读 SP 数据库。Agent Config 的列表和编辑通过同一 token 调用 Eval SP 的 `/api/user-agent-configs`；写请求由宿主注入 Eval SP 已信任的 Web Origin，满足 SP 的来源校验。Eval 不保存配置正文，也不接受客户端自报的用户身份。

`src/sp/harness.ts` 实现 Eval 侧 SP Harness：服务凭证请求普通 Inbox Chat 的幂等确保、初始化、提交/重启、按键校准、完整产物/轨迹和原始资源读取。终态以 WebSocket 推送为主；Ping/Pong 检测静默失活，断线后按原 Chat/Submission 读取一次权威状态并有限重连，健康连接期间不轮询。当前真实接入只支持 `sp` 框架；`codex`、`cc` 明确拒绝。请求路由、JSON 和事件的目标契约见 [Eval SP Harness service contract](../../docs/eval-sp-harness-protocol.md)。这些服务路由目前仍待 SP 侧统一提供，Eval 侧的模拟接口测试通过不等于已与 SP 联调。

`src/db/client.ts`、`schema.ts` 定义与 SP 一致的 Drizzle/`pg` 注入边界和表结构；`src/db/dataset.ts` 将 Dataset/Data 及事务导入限定到已认证用户，`src/db/catalog.ts` 将 Project/Sample 查询限定到同一用户。Sampling、Run 和 Run/Sampling 关联携带用户归属，PostgreSQL 组合外键保证 Project、Sample、Sampling 和 Run 同用户；每个 Run 必须有幂等键及请求事实指纹，键在 Project 内唯一。`createPostgresCatalog(db, ownerUserId, agents, release)` 和 `createPostgresRuntimeStore(db, ownerUserId, release)` 使用同一已解析的 `EvalSpRelease`（分支和完整 commit），`createPostgresMetricsSource(db, ownerUserId)` 供用户请求使用；`ownerUserId` 必须来自 Eval SP 会话校验。新 Run 的分支和 commit 必须匹配发布信息，旧 Run 的幂等重放仍返回原 Run。查询和条件写入直接按用户过滤，Metrics 的 Run、Sampling 和 Evaluation 读取也在 SQL 中限定 Project。仅 Worker 使用 `createPostgresWorkerRuntimeStore(db)` 跨用户恢复 Run，HTTP 路由不能注入该 Store。`src/db/runtime.ts` 原子写入 Run/Sampling/Evaluation 和有效配置，并拒绝跨用户 Dataset/Sample；`src/db/metrics.ts` 在单个只读、一致性事务中投影四层展示所需的原始事实。Run 当前状态复用 Runtime 公共投影，不在数据库存第二份。初始 Session/素材只存外部引用，Agent 工作区和完整轨迹只保留 Runtime 原始引用；数据迁移不触碰 SP DO。

`createPostgresConfigStore(db, ownerUserId, sp, sessionToken)` 实现 Runtime 只读 `ConfigStore`，并为 API 控制面提供 Execution、Evaluation、Pipeline 配置的创建、编辑、列表和单条查询。`ownerUserId` 必须来自已校验的 Eval SP 会话；配置 ID 由服务端生成，编辑时以路径 ID 为准。Execution 配置关联同一用户的 Dataset，指定的 Sample 必须在保存事务中仍属于该 Dataset；Pipeline 只能引用该用户的两个基础配置。保存时用当前会话向 Eval SP 查询 Agent Config，核对真实归属；数据库外键保证 Dataset/Pipeline 引用。被执行配置引用的 Dataset 不可删除，删除请求得到 `DatasetInUseError`。不保存 SP Agent Config 正文。修改配置只影响未来新 Run，已启动 Run 继续使用自己的有效配置快照。

`createPostgresConfigReader(db, ownerUserId)` 只提供 Runtime 所需的三种配置查询，使用同一用户范围的 SQL，不保留登录 token；写入仍必须使用上面的完整 Store 验证当前 SP Agent Config 归属。

`src/worker.ts` 提供 `startEvalRunWorker({ runtime, store, notifications })` 和 `createPostgresRunNotifications(DATABASE_URL)`。新增 Run 与 `pg_notify` 在同一事务内提交；Worker 先监听、再分页扫描未完成 Run，连接恢复时及定时扫描补漏，进程内同一 Run 不并行处理。通知不是持久任务；Run/Attempt 事实仍由 PostgreSQL 和 SP 公开操作持久化。Worker 进程可同时处理多个 Run，各 Run 内仍按执行和评估配置分别控制 Agent 并发。

`pnpm --filter @eval-platform/eval-api start:worker` 启动常驻的、只恢复已入库 Run 的 Node 进程。必需环境变量为 `DATABASE_URL`、`EVAL_SP_ORIGIN`、`EVAL_SP_SERVICE_TOKEN`；可选 `EVAL_RUN_WORKER_CONCURRENCY`、`EVAL_RUN_WORKER_SCAN_MS`。进程使用独立 Eval SP 服务身份，不保存用户登录 token；启动扫描前注册 SIGINT/SIGTERM，收到信号后等待活动 Run 完成再关闭数据库。运行配置从已保存的 Run 快照读取，Worker 只注入 Sample 读取、Store 和 Harness；Config 创建/解析仍属于 API 控制面。部署只能同时运行一个 Worker 实例。

RuntimeStore 的 Sampling/Evaluation 写入必须携带预期旧事实。PostgreSQL 使用同一条条件 `UPDATE` 对 JSONB `facts` 做比较后替换；条件未命中即报告冲突，由 Runtime 读回校准，不覆盖其他已提交的 Attempt、资源或终态。无需额外版本列或状态表。

部署时 Worker 必须是**同一时刻只有一个实例的常驻 Node 进程**；升级先停止旧实例，再启动新实例，新实例会自动接手未完成 Run。不能把它启动在每个 HTTP 请求里，也不能只靠进程内 `Set` 防止跨进程竞争。宿主负责注入真实 SP Harness、Sample 读取、RuntimeStore 和数据库连接；Catalog 与 ConfigResolver 由 API 控制面注入。停止时先中止启动扫描的继续派发，再等待 Worker 的 `close()` 完成已启动的 Run、关闭连接池并启动新实例；尚未接手的 Run 留待下次扫描。运行中的 Agent 不因此标记失败。

测试设置 `DATABASE_URL` 后使用独立的临时 PostgreSQL 数据库执行集成测试；不提供时跳过需数据库的测试。唯一的初始迁移直接创建按用户隔离的 Dataset/Data/Sample 和 Config 结构。当前 Node Server 只提供独立评估路由；其余控制面路由由后续工作接入。SP 服务端尚未提供上面的 Harness 路由，因此 Worker 在这些路由落地前不能执行真实 Agent。Dataset 不隶属于某个 Project，但属于一个 Eval SP 用户；Catalog 的 Agent 列表由 API 控制面注入，不在 Worker 里维护第二份 Agent 注册表。
