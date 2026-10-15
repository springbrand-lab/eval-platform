# 待办：SP 共享包后续事项

`@springbrand/eval-harness` 已从 sp-platform `eval` 分支发布到 npm（`0.1.0-alpha.0`，dist-tag `alpha`），eval-api 以精确版本依赖，不再需要检出 sp-platform。`@springbrand/http` 同样直接来自 npm。

## 升级流程

1. 在 sp-platform 修改 `packages/eval-harness` 并合入 `eval` 分支（即 Eval SP 部署所用版本）。
2. 提升 `packages/eval-harness/package.json` 的版本，在该目录执行 `pnpm publish`（`prepack` 生成 `dist`，`publishConfig.exports` 指向构建产物）。
3. 在 eval-platform 中把 `apps/eval-api/package.json` 的版本改为新版本并更新 `pnpm-lock.yaml`。

## 剩余事项

- 在 `@springbrand/eval-harness` 中导出 Material 文件数上限与初始 Session 字符数上限常量（目前只写在 schema 与 `readEvalCanonicalContext` 内部）。eval-api 的 `limits.ts` 现以 `SP_MATERIAL_MAX_FILES`、`SP_SESSION_CONTENT_CHARS` 镜像这两个值，仅用于推导请求体上限；SP 导出后改为直接引用并删除镜像。
