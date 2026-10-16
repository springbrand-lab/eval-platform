# SP 共享包发布与升级

当前控制面与 Worker 按精确版本从 npm 安装 `@springbrand/eval-harness`。npm 的 `0.1.0-alpha.0` 尚不具备本次合并后的契约；本地验证暂用 sibling SP 的公开包入口。不能把旧版包的安装成功当成本次发布验证。

## 新版公开内容

- 当前的多素材初始化、规范上下文、独立 Evaluator 证据导入及完整原始轨迹契约。
- Material 数量、单文件/初始化总量、上下文字符数等真实校验上限及相关公开 helper；Eval API 直接引用，Web 经 `GET /api/input-limits` 获取。
- 原始 Subject 输入、Artifact、Trajectory 证据路径及 Schema 固定路径 helper。
- 由 eval-harness 公开的 ZIP 工具：`inspectStrictZip`、`StrictZipError`、`StrictZipEntry`、`StrictZipEntryLimit`、`StrictZipErrorCode`。Eval API 不直接依赖 SP 的 utils 实现。
- 发布 `@springbrand/file-renderers` 的公开文件预览入口：`contracts`、`format`、`preview-content`、`preview-host`、`preview-surface`。Eval Web 负责目录、鉴权读取、取消请求和资源内相对路径解析，文件格式解析与只读渲染由共享包负责。
- `file-renderers` 的 `@silurus/ooxml` 当前引用仓库内 `vendor/*.tgz`；发布包必须包含可安装的依赖，不能让消费者依赖 SP 本地文件。`workspace:*` 依赖也必须在发布时解析到真实公开版本。

## 升级与交付

1. SP 发布与部署契约一致的新 npm 版本。
2. Eval API 升级精确版本，并将 ZIP 工具导入切换到 eval-harness；删除对 sibling utils 的本地验证依赖，不添加旧契约兼容分支。
3. 更新锁文件，检查发布包的类型与运行时 exports，使用干净环境进行 frozen install。
4. 运行全仓 check、带 PostgreSQL 的测试、API/Web 构建，以及与 sibling SP 的公开接口联调。
5. 复审通过的 main 合并和后续 Web/统计改动可先提交并推送当前分支；新版包、干净安装和跨项目联调完成前，不标记发布验证通过。

生产环境不保留本地 link 或 API 运行时的兼容回退。版本必须以实际 npm 发布结果为准。

## 资源目录预览接入

已完成素材、上下文共用的只读文件清单与精确路径内容接口，以及 Web SDK。使用已有 Bundle 内容，不复制文件、目录索引或预览状态。

`file-renderers` 发布后继续完成以下页面工作，当前不以临时自制预览代替共享实现：

1. 素材、上下文名称使用链接进入 `/resources/$kind/$bundleId/$resourceId`；目录页的编辑、删除仍是独立操作。
2. 左侧由文件清单生成目录树，右侧展示选中文件；上下文按现有规范文件展示 JSON/JSONL。目录来自导入后的资源路径，不声称重建原 ZIP。
3. 通过公开 `parseFile`、`FileRendererPreview` 等入口进行只读预览；同一资源内的 HTML/CSS/图片等相对引用由宿主通过同一已鉴权内容接口解析。链接不能越过资源根目录；不读取 SP 私有实现或存储。
4. 文件请求、解析、相对资源读取、Blob URL 共用当前选择的取消生命周期；切换资源、文件或卸载时清理，旧响应不能回填。保留源码切换与原文件下载，预览失败可重试。
5. 使用真实发布版本和锁文件验证干净安装，完成素材与上下文的目录点击、图片/文本/HTML 相对资源、JSON/JSONL、失败重试及切换取消的测试和浏览器验收，再标记页面交付。
