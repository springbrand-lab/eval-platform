# 本次 Eval 联调库恢复

本次已确认可以丢弃 Eval 联调数据，使用临时手动工作流 `rebuild-eval-once.yml`。只允许 `main`，输入库名必须是 `eval-platform`，镜像必须是 main 历史中已构建的完整 commit SHA。执行通过现有 OIDC / SSM 通道，并与普通部署共用 `deploy-api` 并发锁。

先校验实际连接的库名、角色、地址和端口；停止 Eval API 和 Run Worker；用 PostgreSQL 官方客户端将数据库及共享 Bundle 卷备份到 EC2 的 `/opt/eval-platform/production/backups/` 私有目录。备份可读取且校验和生成后，确认没有其他数据库连接、活动 Run 任务或额外业务 schema，再在事务内重建 Eval 自己的 `public`、`drizzle`、`pgboss` schema。发出重建命令前失败会恢复原容器；命令发出后任何失败（包括提交结果未知）都保留备份并停止部署。

重建删除 Eval 的项目、数据集、运行结果、资源目录和队列。保留数据库与角色、原 Bundle 文件，不操作 SP 数据库、Agent Config、Chat、Workspace、DO 或 R2。随后复用现有迁移入口、启动服务、读取四个数据目录，并通过正式上传接口创建和验证 `fixtures/eval-demo` 中的演示数据。备份和凭据不上传 GitHub。

恢复验证成功后删除临时工作流、SQL 和重建脚本分支，再 push 清理提交；保留演示数据源与带认证的目录冒烟检查。
