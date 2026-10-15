# 待办：发布 SP 共享包并切换为版本依赖

状态：待处理。当前为本地联调阶段，eval-platform 通过 `link:` 直接依赖 sp-platform 工作区中的两个 private 包。

## 现状

| 包 | sp-platform 源码 | eval-platform 消费方 | 用途 |
| --- | --- | --- | --- |
| `@springbrand/eval-harness` | `packages/eval-harness` | `apps/eval-api` | Eval SP 服务路由、`X-Eval-Service-Token` 头、请求 schema、Submission 回执、Session 规范化校验和 Material 路径规则的唯一定义 |

依赖写法为 `link:../../../sp-platform/packages/<name>`，要求 sp-platform 检出在 eval-platform 的同级目录 `../sp-platform`，并已在 sp-platform 根目录执行过 `pnpm install`（被链接包从自身目录解析 `zod` 等依赖）。

`@springbrand/http` 已公开发布到 npm，eval-api 直接锁定与 sp-platform 相同的精确版本，不在本待办范围内。

## 影响

- 未检出 sp-platform 的环境无法解析 `@springbrand/eval-harness`，`check`/`test` 会失败。
- GitHub Actions `test.yml` 的 `api` 作业因此用仓库 Secret `SP_PLATFORM_TOKEN`（对私有仓库 `springbrand-lab/sp-platform` 有 Contents 只读权限的 token）检出其 `eval` 分支，移到 `../sp-platform`，再执行 `pnpm --filter @springbrand/eval-harness install --frozen-lockfile --prod` 安装被链接包自身的依赖。缺少该 Secret 时作业会在第一步给出明确错误。
- eval-platform 跟随 sp-platform 工作区当前检出的分支内容；契约变化不会通过版本号显式体现。

## 后续任务

1. 在 sp-platform 中去掉这两个包的 `private: true`，补齐构建产物与 `exports`/类型入口，按 `@springbrand/http` 的流程发布到 npm（或内部 registry）。
2. 在 `@springbrand/eval-harness` 中导出 Material 文件数上限与初始 Session 字符数上限常量（目前只写在 schema 与 `readEvalCanonicalContext` 内部）。eval-api 的 `limits.ts` 现以 `SP_MATERIAL_MAX_FILES`、`SP_SESSION_CONTENT_CHARS` 镜像这两个值，仅用于推导请求体上限；SP 导出后改为直接引用并删除镜像。
3. 发布版本满足依赖发布时长要求后，在 eval-platform 中把 `link:` 依赖替换为精确版本号，并更新 `pnpm-lock.yaml`。
4. 删除本文件，并移除 README、`apps/eval-api/README.md` 中关于同级目录检出的说明。
5. 删除 `test.yml` `api` 作业中的 sp-platform 检出与安装步骤，确认 CI 不再需要 sp-platform 检出即可通过 `pnpm check` 与 `pnpm test`，然后删除 `SP_PLATFORM_TOKEN` Secret。
