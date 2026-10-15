# @eval-platform/eval-web

Eval 的内部管理界面：准备测试集与初始资源、上传评分格式、管理 Agent 配置、创建 Project、发起与停止 Run、查看四层指标与评委结果、只读观察 Agent 会话，以及管理服务账号积分。方案见 [Eval Web 前端技术方案](../../trevordocs/eval-web-frontend-plan.md)。

## 技术栈

与 sp-platform `apps/web` 对齐：React 19、Vite、TanStack Router（文件路由，生成 `src/routeTree.gen.ts`）、TanStack Query、Tailwind CSS v4、`@springbrand/http`（解析 Eval API 的 `{success, msg, errMsg, code}` 信封）、lucide-react、sonner。只读会话复用 SP 聊天页同一套渲染：`@springbrand/message-panel/cloud-os` 的 `CloudOsRoot` 与 `CloudOsChatMessages`（不传任何回调，审批禁用）。样式按该包的宿主要求接入：`src/styles/index.css` 中所有 `@import`（含 `tw-animate-css`、`streamdown/styles.css`、`cloud-os.css`）放在最前，并用显式 glob 把 `cloud-os` 源码与 streamdown 产物加入 `@source`。类型从 `@eval-platform/*` 包以 `import type` 引入，不打包运行时代码。

## 目录

- `src/routes/`：文件路由，只组装页面；`_authenticated` 布局负责登录守卫与侧边导航。
- `src/features/<模块>/`：页面、表单与领域组件。
- `src/api-sdk/`：每个领域一个文件，请求函数与 query key。
- `src/components/ui/`：自建基础组件；`src/styles/theme.css` 是设计令牌（浅色与 `html.dark` 深色）。
- `src/auth/`：接收 takt 交给 iframe 的登录 token，只保存在内存中。
- `worker/`：部署用的 Cloudflare Worker，托管静态资源并转发 `/api/*`。

## 登录与部署

与 takt 共用登录：takt 的 `/dashboard/eval` 用 iframe 打开本应用，iframe 发出 `eval:ready`，takt 只向本应用的来源回传 `{type: "takt:token", token}`。Worker 用这个 token 调用 takt 的 `/api/auth/me`，用户须有 `eval` 菜单（或是管理员）才放行；之后去掉 token，附上 `X-Eval-Web-Token` 与操作人 `X-Eval-Actor` 转发给 Eval API。页面响应带 `Content-Security-Policy: frame-ancestors`，只允许 takt 嵌入。

Worker 配置见 `wrangler.jsonc`：`TAKT_ORIGIN`、`TAKT_EVAL_MENU_ID`、`EVAL_API_ORIGIN`、`EVAL_WEB_ORIGIN`、`FRAME_ANCESTORS`，密钥 `EVAL_WEB_API_TOKEN`（与 Eval API 相同）。构建期变量写在 `.env.production`：`VITE_TAKT_ORIGIN`、`VITE_LANGFUSE_PROJECT_URL`。`pnpm --filter @eval-platform/eval-web deploy` 构建并部署。

## 本地开发

```bash
pnpm --filter @eval-platform/eval-web dev
```

在 `apps/eval-web/.env.local`（不提交）中设置：

- `VITE_DEV_AUTH=1`：跳过 takt，使用本地开发用户（只在开发构建中生效）。
- `EVAL_API_ORIGIN`：本地 Eval API，默认 `http://127.0.0.1:18788`；dev 代理转发 `/api` 时代替 Worker 附上 `Origin` 和操作人。
- `EVAL_WEB_ORIGIN`：须与 Eval API 的 `EVAL_WEB_ORIGIN` 相同，默认 `http://localhost:5176`。
- `EVAL_WEB_API_TOKEN`：仅当本地 Eval API 配置了同名令牌时需要。
- `VITE_LANGFUSE_PROJECT_URL`：Langfuse eval 项目地址，用于跳转到会话与分数。

`pnpm --filter @eval-platform/eval-web check` 检查页面与 Worker 的类型，`test` 运行组件、工具函数与 Worker 测试。
