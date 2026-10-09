# @eval-platform/eval-api

内部评估控制面的数据库组合层：PostgreSQL `DatasetStore`、`RuntimeStore`、Project/Sample Catalog 与只读 `MetricsSource`。连接池由宿主注入；迁移位于 `migrations-postgres/`，用 `pnpm --filter @eval-platform/eval-api db:migrate` 应用（需 `DATABASE_URL`）。

`src/db/client.ts`、`schema.ts` 定义与 SP 一致的 Drizzle/`pg` 注入边界和表结构；`src/db/dataset.ts` 实现全局共享 Dataset/Data 及事务导入；`src/db/catalog.ts` 管理属于用户的 Project 和指向 Data 的 Sample；`src/db/runtime.ts` 原子写入 Run/Sampling/Evaluation 和有效配置；`src/db/metrics.ts` 在单个只读、一致性事务中投影四层展示所需的原始事实。Run 当前状态复用 Runtime 公共投影，不在数据库存第二份。初始 Session/素材只存外部引用，Agent 工作区和完整轨迹只保留 Runtime 原始引用；数据迁移不触碰 SP DO。

测试设置 `DATABASE_URL` 后使用独立的临时 PostgreSQL 数据库执行集成测试；不提供时跳过需数据库的测试。不包含 HTTP Server、鉴权、SP Harness 实现、配置存储或生产路由；由后续的应用组合层提供。Dataset 不隶属于 Project 或用户，Catalog 的 Agent 列表必须由宿主注入，不在此处维护第二份 Agent 注册表。
