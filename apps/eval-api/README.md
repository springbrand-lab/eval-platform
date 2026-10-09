# @eval-platform/eval-api

内部评估控制面的数据库与执行器组合层：PostgreSQL `DatasetStore`、`RuntimeStore`、Project/Sample Catalog、只读 `MetricsSource` 和单实例 Run Worker。连接池由宿主注入；迁移位于 `migrations-postgres/`，用 `pnpm --filter @eval-platform/eval-api db:migrate` 应用（需 `DATABASE_URL`）。

`src/db/client.ts`、`schema.ts` 定义与 SP 一致的 Drizzle/`pg` 注入边界和表结构；`src/db/dataset.ts` 实现全局共享 Dataset/Data 及事务导入；`src/db/catalog.ts` 管理属于用户的 Project 和指向 Data 的 Sample；`src/db/runtime.ts` 原子写入 Run/Sampling/Evaluation 和有效配置；`src/db/metrics.ts` 在单个只读、一致性事务中投影四层展示所需的原始事实。Run 当前状态复用 Runtime 公共投影，不在数据库存第二份。初始 Session/素材只存外部引用，Agent 工作区和完整轨迹只保留 Runtime 原始引用；数据迁移不触碰 SP DO。

`src/worker.ts` 提供 `startEvalRunWorker({ runtime, store, notifications })` 和 `createPostgresRunNotifications(DATABASE_URL)`。新增 Run 与 `pg_notify` 在同一事务内提交；Worker 先监听、再分页扫描未完成 Run，连接恢复时及定时扫描补漏，进程内同一 Run 不并行处理。通知不是持久任务；Run/Attempt 事实仍由 PostgreSQL 和 SP 公开操作持久化。Worker 进程可同时处理多个 Run，各 Run 内仍按执行和评估配置分别控制 Agent 并发。

部署时 Worker 必须是**同一时刻只有一个实例的常驻 Node 进程**；升级先停止旧实例，再启动新实例，新实例会自动接手未完成 Run。不能把它启动在每个 HTTP 请求里，也不能只靠进程内 `Set` 防止跨进程竞争。宿主负责注入真实 SP Harness、Catalog、ConfigResolver 和数据库连接，停止时等待 Worker 的 `close()` 完成所有进行中的 Run，再关闭连接池和启动新实例；尚未接手的 Run 留待下次扫描。运行中的 Agent 不因此标记失败。

测试设置 `DATABASE_URL` 后使用独立的临时 PostgreSQL 数据库执行集成测试；不提供时跳过需数据库的测试。不包含可直接运行的 Node Server、鉴权、SP Harness 实现、配置存储或生产路由；由后续的应用组合层提供，因此当前 Worker 函数尚不能独立连接真实 Agent。Dataset 不隶属于 Project 或用户，Catalog 的 Agent 列表必须由宿主注入，不在此处维护第二份 Agent 注册表。
