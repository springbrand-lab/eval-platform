# @eval-platform/eval-api

内部评估控制面的数据库与执行器组合层：PostgreSQL `DatasetStore`、`RuntimeStore`、Project/Sample Catalog、只读 `MetricsSource` 和单实例 Run Worker。连接池由宿主注入；迁移位于 `migrations-postgres/`，用 `pnpm --filter @eval-platform/eval-api db:migrate` 应用（需 `DATABASE_URL`）。

目标应用组合层还负责 Eval 独立 SP 的登录校验、`user-agent` 配置列表/编辑、公开 Chat/Submission/Trajectory/Workspace HTTP 与 WebSocket 客户端，以及真实 SP Harness。所有 SP 地址均指向 Eval SP API/Agent/Space，不请求 dev/production SP。Eval SP API/数据库保存账户、Agent Config、计费、Action 等 SP 事实；本应用的 PostgreSQL 只保存评估业务、SP 身份/证据引用及已采集的原始资源快照。Project 绑定固定 SP 分支、Run 记录实际 commit 属于待实现的应用/数据库改动；不增加第五个共享包。

登录由 Eval SP 完成。浏览器从 Eval SP 的 `/api/auth/session` 获取会话 Bearer token，调用 Eval API 时携带该 token；Eval API 对每个受保护请求调用固定 Eval SP 地址的 `/api/auth/me` 校验活动会话，不能仅解码 JWT 或直接读 SP 数据库。Agent Config 的列表和编辑通过同一 token 调用 Eval SP 的 `/api/user-agent-configs`；写请求由宿主注入 Eval SP 已信任的 Web Origin，满足 SP 的来源校验。Eval 不保存配置正文，也不接受客户端自报的用户身份。

`src/db/client.ts`、`schema.ts` 定义与 SP 一致的 Drizzle/`pg` 注入边界和表结构；`src/db/dataset.ts` 将 Dataset/Data 及事务导入限定到已认证用户，`src/db/catalog.ts` 将 Project/Sample 查询限定到同一用户；`src/db/runtime.ts` 原子写入 Run/Sampling/Evaluation 和有效配置，并拒绝跨用户 Dataset/Sample；`src/db/metrics.ts` 在单个只读、一致性事务中投影四层展示所需的原始事实。Run 当前状态复用 Runtime 公共投影，不在数据库存第二份。初始 Session/素材只存外部引用，Agent 工作区和完整轨迹只保留 Runtime 原始引用；数据迁移不触碰 SP DO。

`src/worker.ts` 提供 `startEvalRunWorker({ runtime, store, notifications })` 和 `createPostgresRunNotifications(DATABASE_URL)`。新增 Run 与 `pg_notify` 在同一事务内提交；Worker 先监听、再分页扫描未完成 Run，连接恢复时及定时扫描补漏，进程内同一 Run 不并行处理。通知不是持久任务；Run/Attempt 事实仍由 PostgreSQL 和 SP 公开操作持久化。Worker 进程可同时处理多个 Run，各 Run 内仍按执行和评估配置分别控制 Agent 并发。

RuntimeStore 的 Sampling/Evaluation 写入必须携带预期旧事实。PostgreSQL 使用同一条条件 `UPDATE` 对 JSONB `facts` 做比较后替换；条件未命中即报告冲突，由 Runtime 读回校准，不覆盖其他已提交的 Attempt、资源或终态。无需额外版本列或状态表。

部署时 Worker 必须是**同一时刻只有一个实例的常驻 Node 进程**；升级先停止旧实例，再启动新实例，新实例会自动接手未完成 Run。不能把它启动在每个 HTTP 请求里，也不能只靠进程内 `Set` 防止跨进程竞争。宿主负责注入真实 SP Harness、Catalog、ConfigResolver 和数据库连接，停止时等待 Worker 的 `close()` 完成所有进行中的 Run，再关闭连接池和启动新实例；尚未接手的 Run 留待下次扫描。运行中的 Agent 不因此标记失败。

测试设置 `DATABASE_URL` 后使用独立的临时 PostgreSQL 数据库执行集成测试；不提供时跳过需数据库的测试。唯一的初始迁移直接创建按用户隔离的 Dataset/Data/Sample 结构。不包含可直接运行的 Node Server、SP Harness 实现、配置存储或生产路由；当前 Worker 函数尚不能独立连接真实 Agent。Dataset 不隶属于某个 Project，但属于一个 Eval SP 用户；Catalog 的 Agent 列表由宿主注入，不在此处维护第二份 Agent 注册表。
