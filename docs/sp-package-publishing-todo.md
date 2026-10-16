# SP 共享包发布与升级

当前控制面与 Worker 按精确版本从 npm 安装 `@springbrand/eval-harness`。npm 的 `0.1.0-alpha.0` 尚不具备本次合并后的契约；本地验证暂用 sibling SP 的公开包入口。不能把旧版包的安装成功当成本次发布验证。

## 新版公开内容

- 当前的多素材初始化、规范上下文、独立 Evaluator 证据导入及完整原始轨迹契约。
- Material 数量、单文件/初始化总量、上下文字符数等真实校验上限及相关公开 helper；Eval API 直接引用，Web 经 `GET /api/input-limits` 获取。
- 原始 Subject 输入、Artifact、Trajectory 证据路径及 Schema 固定路径 helper。
- 由 eval-harness 公开的 ZIP 工具：`inspectStrictZip`、`StrictZipError`、`StrictZipEntry`、`StrictZipEntryLimit`、`StrictZipErrorCode`。Eval API 不直接依赖 SP 的 utils 实现。

## 升级与交付

1. SP 发布与部署契约一致的新 npm 版本。
2. Eval API 升级精确版本，并将 ZIP 工具导入切换到 eval-harness；删除对 sibling utils 的本地验证依赖，不添加旧契约兼容分支。
3. 更新锁文件，检查发布包的类型与运行时 exports，使用干净环境进行 frozen install。
4. 运行全仓 check、带 PostgreSQL 的测试、API/Web 构建，以及与 sibling SP 的公开接口联调。
5. 复审通过的 main 合并和后续 Web/统计改动可先提交并推送当前分支；新版包、干净安装和跨项目联调完成前，不标记发布验证通过。

生产环境不保留本地 link 或 API 运行时的兼容回退。版本必须以实际 npm 发布结果为准。
