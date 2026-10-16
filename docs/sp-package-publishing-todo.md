# SP 共享包接入与升级

Eval 使用下面四个 npm 包的精确版本，版本与完整性由消费方 `package.json` 和 `pnpm-lock.yaml` 固定。安装不依赖 sibling SP 仓库、私有 Workspace 包或本地 vendor 路径。

| 包 | 版本 | 消费方与公开入口 |
| --- | --- | --- |
| `@springbrand/eval-harness` | `0.1.0-alpha.3` | Eval API：初始化、证据路径、上限，以及 `inspectStrictZip`、`StrictZipError` 和 ZIP 类型 |
| `@springbrand/file-renderers` | `0.1.0-alpha.1` | Eval Web：文件解析、预览、`resource-path` 与格式 CSS Module |
| `@springbrand/contracts` | `0.1.0-alpha.0` | Eval HTTP 目录：SP 编辑器领域错误、删除阻挡详情 Schema |
| `@springbrand/agent-config-editor` | `0.1.0-alpha.0` | Eval Web：根入口、`client`、`draft` 与 `connector-authorization` |

SP 内部 `utils`、`resource`、`agent-contracts` 及 Runtime 公开 canonical 校验器的实现与声明由发布产物携带，不作为 Eval 的额外依赖。ZIP 的唯一公开入口是 eval-harness；Eval 不导入 SP utils。`file-renderers` 的安装依赖不引用 SP 仓库中的 `vendor/*.tgz`。

Web 的 Tailwind 扫描 `file-renderers/dist/**/*.js` 与 `agent-config-editor/dist/**/*.js`，不扫描 SP 源码。格式 CSS Module 由文件预览模块导入。React、React DOM、TanStack Query、HTTP 与 site-block 在 Vite 中去重，保持宿主 Context 和错误类一致。

本次原生上下文修复的待发布版本为 `@springbrand/agent-runtime@0.3.0-alpha.23`、`@springbrand/eval-harness@0.1.0-alpha.3`，均使用 `alpha` 标签。Runtime 先发，harness 后发；Eval 消费精确版本与已经验证的 tarball 校验值。发布已验证的原始 tarball，避免重新打包后字节变化导致完整性不匹配。修复不会改写已有 Project 快照。

## 升级与验证

1. 检查四个精确版本的 npm 产物：导出及其目标文件存在，JS 和声明均不导入 SP 私有包，依赖不包含 `workspace:`、`link:` 或仓库外的 `file:` 路径。
2. 更新消费方精确版本与锁文件。新发的这四个自有包在 `minimumReleaseAgeExclude` 中明确放行；不扩大到其他依赖。
3. 在 SP 仓库外的新目录执行 `pnpm install --frozen-lockfile`，不能复制或链接现有 `node_modules`。独立安装后运行 `pnpm check`、带 PostgreSQL 的全仓测试和 API/Web 构建，确认类型、运行时、预览资源及样式都来自发布产物。
4. 检查 Web 构建 CSS 包含共享 Agent 表单的工具类及文件预览的 CSS Module；开发模式还需强制重新预打包，验证实际预览模块及其动态依赖可作为浏览器 ESM 加载，不能只以服务启动和 HTTP 200 作为通过。保留预览包的资源转换，同时预打包其内层 CommonJS 依赖；不通过浏览器更改用户已验收的页面。
5. CI 沿用 `.github/actions/prepare-workspace` 的 frozen install。推送开发分支验证依赖与构建；部署仍只通过现有 main 流程，不随依赖升级单独启动 Agent 或改写项目。

素材与上下文共用只读文件清单和精确路径内容接口。目录来自导入后的 `InitialResourceFile` 路径；资源与运行 Workspace 使用同一公共文件解析、相对引用解析和预览实现。文件请求、解析、关联资源及 Blob URL 属于当前选择的取消生命周期。
