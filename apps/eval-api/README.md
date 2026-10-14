# @eval-platform/eval-api

内部评估控制面的数据库与执行器组合层：PostgreSQL `DatasetStore`、`RuntimeStore`、Project/Sample Catalog、只读 `MetricsSource` 和单实例 Run Worker。连接池由宿主注入；迁移位于 `migrations-postgres/`，用 `pnpm --filter @eval-platform/eval-api db:migrate` 应用（需 `DATABASE_URL`）。

目标应用组合层还负责 Eval 独立 SP 的登录校验、`user-agent` 配置列表/编辑、公开 Chat/Submission/Trajectory/Workspace HTTP 与 WebSocket 客户端，以及真实 SP Harness。所有 SP 地址均指向 Eval SP API/Agent/Space，不请求 dev/production SP。Eval SP API/数据库保存账户、Agent Config、计费、Action 等 SP 事实；本应用的 PostgreSQL 只保存评估业务、SP 身份/证据引用及已采集的原始资源快照。Project 绑定固定 SP 分支、Run 记录实际 commit 属于待实现的应用/数据库改动；不增加第五个共享包。

登录由 Eval SP 完成。浏览器从 Eval SP 的 `/api/auth/session` 获取会话 Bearer token，调用 Eval API 时携带该 token；Eval API 对每个受保护请求调用固定 Eval SP 地址的 `/api/auth/me` 校验活动会话，不能仅解码 JWT 或直接读 SP 数据库。Agent Config 的列表和编辑通过同一 token 调用 Eval SP 的 `/api/user-agent-configs`；写请求由宿主注入 Eval SP 已信任的 Web Origin，满足 SP 的来源校验。Eval 不保存配置正文，也不接受客户端自报的用户身份。

`src/sp/harness.ts` 实现 Eval 侧 SP Harness：服务凭证请求普通 Inbox Chat 的幂等确保、初始化、提交/重启、按键校准、完整产物/轨迹和原始资源读取。终态以 WebSocket 推送为主；Ping/Pong 检测静默失活，断线后按原 Chat/Submission 读取一次权威状态并有限重连，健康连接期间不轮询。当前真实接入只支持 `sp` 框架；`codex`、`cc` 明确拒绝。请求路由、JSON 和事件的目标契约见 [Eval SP Harness service contract](../../docs/eval-sp-harness-protocol.md)。这些服务路由目前仍待 SP 侧统一提供，Eval 侧的模拟接口测试通过不等于已与 SP 联调。

`src/db/client.ts`、`schema.ts` 定义与 SP 一致的 Drizzle/`pg` 注入边界和表结构；`src/db/dataset.ts` 将 Dataset/Data 及事务导入限定到已认证用户，`src/db/catalog.ts` 将 Project/Sample 查询限定到同一用户。Sampling、Run 和 Run/Sampling 关联携带用户归属，PostgreSQL 组合外键保证 Project、Sample、Sampling 和 Run 同用户；Run 请求 ID 与可选幂等键在用户内唯一。`createPostgresRuntimeStore(db, ownerUserId)` 和 `createPostgresMetricsSource(db, ownerUserId)` 供用户请求使用，`ownerUserId` 必须来自 Eval SP 会话校验；查询和条件写入直接按用户过滤。仅 Worker 使用 `createPostgresWorkerRuntimeStore(db)` 跨用户恢复 Run，HTTP 路由不能注入该 Store。`src/db/runtime.ts` 原子写入 Run/Sampling/Evaluation 和有效配置，并拒绝跨用户 Dataset/Sample；`src/db/metrics.ts` 在单个只读、一致性事务中投影四层展示所需的原始事实。Run 当前状态复用 Runtime 公共投影，不在数据库存第二份。初始 Session/素材只存外部引用，Agent 工作区和完整轨迹只保留 Runtime 原始引用；数据迁移不触碰 SP DO。

`src/worker.ts` 提供 `startEvalRunWorker({ runtime, store, notifications })` 和 `createPostgresRunNotifications(DATABASE_URL)`。新增 Run 与 `pg_notify` 在同一事务内提交；Worker 先监听、再分页扫描未完成 Run，连接恢复时及定时扫描补漏，进程内同一 Run 不并行处理。通知不是持久任务；Run/Attempt 事实仍由 PostgreSQL 和 SP 公开操作持久化。Worker 进程可同时处理多个 Run，各 Run 内仍按执行和评估配置分别控制 Agent 并发。

`pnpm --filter @eval-platform/eval-api start:worker` 启动常驻的、只恢复已入库 Run 的 Node 进程。必需环境变量为 `DATABASE_URL`、`EVAL_SP_ORIGIN`、`EVAL_SP_SERVICE_TOKEN`；可选 `EVAL_RUN_WORKER_CONCURRENCY`、`EVAL_RUN_WORKER_SCAN_MS`。进程使用独立 Eval SP 服务身份，不保存用户登录 token；启动扫描前注册 SIGINT/SIGTERM，收到信号后等待活动 Run 完成再关闭数据库。运行配置从已保存的 Run 快照读取，Worker 只注入 Sample 读取、Store 和 Harness；Config 创建/解析仍属于 API 控制面。部署只能同时运行一个 Worker 实例。

RuntimeStore 的 Sampling/Evaluation 写入必须携带预期旧事实。PostgreSQL 使用同一条条件 `UPDATE` 对 JSONB `facts` 做比较后替换；条件未命中即报告冲突，由 Runtime 读回校准，不覆盖其他已提交的 Attempt、资源或终态。无需额外版本列或状态表。

部署时 Worker 必须是**同一时刻只有一个实例的常驻 Node 进程**；升级先停止旧实例，再启动新实例，新实例会自动接手未完成 Run。不能把它启动在每个 HTTP 请求里，也不能只靠进程内 `Set` 防止跨进程竞争。宿主负责注入真实 SP Harness、Catalog、ConfigResolver 和数据库连接，停止时等待 Worker 的 `close()` 完成所有进行中的 Run，再关闭连接池和启动新实例；尚未接手的 Run 留待下次扫描。运行中的 Agent 不因此标记失败。

测试设置 `DATABASE_URL` 后使用独立的临时 PostgreSQL 数据库执行集成测试；不提供时跳过需数据库的测试。唯一的初始迁移直接创建按用户隔离的 Dataset/Data/Sample 结构。不包含 Node HTTP Server、Config 存储或生产路由；它们由 API 控制面提供。SP 服务端尚未提供上面的 Harness 路由，因此 Worker 在这些路由落地前不能执行真实 Agent。Dataset 不隶属于某个 Project，但属于一个 Eval SP 用户；Catalog 的 Agent 列表由 API 控制面注入，不在 Worker 里维护第二份 Agent 注册表。
