# Eval Web 前端技术方案

> 状态：已实现，本地跑通（2026-10-15）；尚未部署。实施记录见第 13 节。
>
> 已确认的决定：
> - 前端架构参考 sp-platform `apps/web`。
> - 第一版做全部模块。
> - 组件基于 Tailwind 自建，视觉自行设计。
> - 部署为 Cloudflare Worker，域名 `evalrapp.springbrand.ai`。
> - 与 takt 共用登录，不新增 OAuth，以 iframe 嵌入 takt 使用。
> - Eval API 部署在 Eval SP 已有的 AWS 环境中。
> - 有 Eval 访问权限即可加积分，不另设权限。
> - 只读观察复用 SP 组件内嵌，并提供 Langfuse 链接。

## 1. 目标与边界

`apps/eval-web` 是 Eval 的内部管理界面，覆盖完整流程：准备测试集、创建 Project、发起与停止 Run、查看结果与指标、只读观察 Agent 会话、管理积分。

边界：

- **只调用 Eval API。** 浏览器不直接访问 Eval SP 的写接口和服务凭证，也不访问数据库。
- **API 契约以 [Eval HTTP 控制面](../docs/eval-http-api.md) 为准。** 数据接入流程见 [Dataset 层与 Web 接入说明](../docs/eval-dataset-web-handoff.md)。
- **用户身份只用于访问控制和审计，不决定数据归属。** Eval API 仍以固定的 Eval SP 服务账号运行，所有数据属于服务账号。
- **观察只读。** 不提供聊天、取消、审批等驱动 Agent 的操作。

## 2. 技术栈（对齐 sp-platform `apps/web`）

| 方面 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 19 + TypeScript | 同 SP |
| 构建 | Vite + `@vitejs/plugin-react` | 本地端口 `5176`，避开 SP 的 5175 |
| 路由 | `@tanstack/react-router`（文件路由，`@tanstack/router-plugin` 生成 `routeTree.gen.ts`） | 同 SP，`_authenticated` 布局路由做登录守卫 |
| 数据请求 | `@tanstack/react-query` | 同 SP：401/403 不重试，`staleTime` 10s，mutation 统一错误处理 |
| HTTP | `@springbrand/http` 的 `createHttpClient`（`envelope` 模式） | 与 Eval API 使用同一精确版本，统一解析 `{success, msg, errMsg, code}` |
| 类型 | `@eval-platform/eval-contracts`（工作区包） | 请求和响应类型直接复用，不在前端重复定义 |
| 校验 | `zod` | 表单校验；规则与后端一致的部分直接复用契约包里的 schema |
| 样式 | Tailwind CSS v4（`@tailwindcss/vite`） | 自建设计令牌，见第 7 节 |
| 组件辅助 | `clsx` + `tailwind-merge`、`lucide-react`、`sonner`（toast） | 同 SP |
| 观察组件 | `@springbrand/message-panel`、`@springbrand/chat-client`（npm 已发布） | 见第 6 节；轨迹和文件渲染组件需要 SP 发布，见第 10 节 |
| 测试 | `vitest` + `@testing-library/react` + `jsdom` | 同 SP |
| 部署 | Cloudflare Worker（`wrangler`）托管静态资源，Worker 兼做 BFF | 见第 3 节 |

不引入 `@springbrand/styles`、`@springbrand/gravel` 等 SP 设计包，也不引入 PostHog、Clarity 等分析统计。

## 3. 部署与登录

### 3.1 整体结构

```text
takt 页面中的 iframe（takt 通过 postMessage 交给它当前登录的 token）
  │  Authorization: Bearer <takt 登录 token>
  ▼
eval-web Worker（Cloudflare，域名如 evalrapp.springbrand.ai）
  ├─ 静态资源：dist/（SPA，not_found_handling = single-page-application）
  └─ /api/*：向 takt 校验 token 与 eval 菜单权限 → 转发到 Eval API（附 X-Eval-Web-Token 与操作人信息）
  ▼
Eval API（Node，部署在现有 EC2 的 compose 中，经 cloudflared tunnel 暴露）
  └─ Eval SP（eval 分支部署）、PostgreSQL、Langfuse
```

- **Worker 作为 BFF（服务于前端的后端）。** Eval API 本身没有用户登录，所以不能直接暴露给浏览器。Worker 负责校验用户，再在服务端转发。浏览器只和 eval-web 同源通信，因此不需要 CORS。
- **Eval API 增加一层服务间校验。** 只接受带正确 `X-Eval-Web-Token`（Worker 与 Eval API 共享的密钥）的请求。Worker 同时转发 `X-Eval-Actor`（操作人 ID 与名字），用于审计日志和加积分记录。这需要后端配合改动，见第 10 节。
- **Eval API 和 Run Worker 的部署位置：** 放在 Eval SP 已建好的 AWS 环境里。在同一台 EC2 的 compose 中新增 `eval-platform` 的 API 和 Worker 两个服务，数据库在同一个 RDS 上单独建库，并通过 cloudflared tunnel 暴露给 eval-web Worker。部署细节另写方案，本文只约定接口。

### 3.2 登录：与 takt 共用

eval-web 不另做登录，也不新增 OAuth，直接沿用用户在 takt 的登录状态：

1. 用户先在 takt 用飞书登录。takt 把签发的 JWT 存在自己域名的 `localStorage['token']` 中，有效期 7 天。
2. takt 的 Eval 页面渲染 iframe。iframe 加载完成后，eval-web 向父窗口发送 `eval:ready`；takt 校验来源是 eval-web 的域名后，用 `postMessage` 回传 `{type: "takt:token", token}`。之后 token 更新或用户退出时，takt 会再次发送消息。
3. eval-web 只接受来源为 `TAKT_ORIGIN` 的消息，并把 token 保存在内存中（不落盘），之后每个 `/api/*` 请求都带 `Authorization: Bearer <token>`。
4. eval-web Worker 收到请求后，用这个 token 调用 takt 的 `GET /api/auth/me`。takt 返回用户信息和 `access.menuIds`，只有包含 `eval` 才放行。结果按 token 缓存 5 分钟，避免每个请求都访问 takt。
5. takt 返回 401，或用户没有 `eval` 权限时，Worker 返回 401 或 403。前端提示"请在 takt 中重新登录"，或"没有 Eval 访问权限，请联系管理员在 takt 中授权"。

这样设计的原因：

- **登录与授权都只在 takt 管理。** 能访问 Eval 的人由 takt 管理员通过菜单授权控制，eval-web 不维护用户和白名单。
- **不共享密钥。** eval-web 不持有 takt 的 `JWT_SECRET`，只通过 takt 自己的接口校验 token。takt 换密钥或调整权限逻辑，eval-web 都不用改。
- **不依赖 Cookie。** iframe 对 takt 来说是跨站页面，浏览器会拦截第三方 Cookie。token 通过 postMessage 交给 iframe，就不受这个限制。

需要注意：交给 iframe 的是完整的 takt token，所以 eval-web 只能在内存中保存它，绝不能写进日志或转发给 Eval API。Worker 只把校验后的用户 ID 和名字作为操作人转发。

**独立访问：** 直接打开 `evalrapp.springbrand.ai` 时没有 takt 的 token，页面会提示"请从 takt 打开"，并给出 takt 中 Eval 页面的链接。以后如果需要独立访问，再在 takt 增加跳转回传 token 的入口。

### 3.3 嵌入 takt（iframe）

- **takt 侧改动（小改，不涉及 OAuth）：**
  - 在 `packages/shared/menus.json` 增加 `eval` 菜单，管理员给需要的人授权。
  - 在 `App.tsx` 的 `/dashboard` 下增加 `/dashboard/eval` 路由，渲染 `<iframe src="https://evalrapp.springbrand.ai">`。
  - 这个页面响应 iframe 的 `eval:ready` 消息，把 `localStorage['token']` 回传给 iframe。目标来源必须固定为 eval-web 的域名，不能用 `*`。
- **eval-web 侧：**
  - Worker 对所有页面响应加上 `Content-Security-Policy: frame-ancestors https://takt.cuecue.cc http://localhost:5111`，不设置 `X-Frame-Options`。
  - 嵌入时隐藏 eval-web 自己的顶部栏，只保留侧边导航，避免和 takt 的外框重复。
  - takt 线上域名 `takt.cuecue.cc` 就是最终的嵌入位置。

### 3.4 本地开发

- `vite` 的 dev server 把 `/api` 代理到本地 Eval API（`127.0.0.1:18788`），由代理注入 `X-Eval-Web-Token`。
- **本地登录：** 设置 `VITE_DEV_AUTH=1` 时跳过 takt 校验，使用固定的本地开发用户。这个开关只在开发构建中生效，生产构建中这段代码会被移除。
- 联调嵌入时，用 `wrangler dev` 运行完整的 Worker，并在本地 takt（`localhost:5111`）中打开 Eval 页面。

## 4. 目录结构（对齐 SP `apps/web/src`）

```text
apps/eval-web/
├── index.html
├── vite.config.ts             # react、tanstackRouter、tailwindcss；dev 代理 /api
├── wrangler.jsonc             # Worker 配置：assets、vars（只放公开值）、secrets 名称
├── worker/                    # BFF Worker（与 SPA 分开编译）
│   ├── index.ts               # 路由：/auth/*、/api/*、静态资源与安全响应头
│   ├── auth.ts                # 调用 takt /api/auth/me 校验 token 与 eval 菜单权限（带缓存）
│   └── proxy.ts               # 转发到 Eval API，注入服务令牌与操作人
└── src/
    ├── main.tsx               # QueryClient、Router、全局错误处理
    ├── routes/                # 文件路由（只负责组装页面，不写业务逻辑）
    │   ├── __root.tsx
    │   └── _authenticated/    # 登录守卫 + 布局
    │       ├── index.tsx                       # → /projects
    │       ├── projects/…                      # 见第 5 节路由表
    │       ├── datasets/…
    │       ├── resources/…
    │       ├── output-schemas/…
    │       ├── agents/…
    │       └── credits.tsx
    ├── api-sdk/               # 每个领域一个文件：请求函数 + queryKey
    │   ├── client.ts          # createHttpClient(envelope) + 鉴权头 + ApiError
    │   ├── projects-api.ts
    │   ├── runs-api.ts
    │   ├── results-api.ts
    │   ├── metrics-api.ts
    │   ├── datasets-api.ts
    │   ├── data-api.ts
    │   ├── bundles-api.ts
    │   ├── output-schemas-api.ts
    │   ├── agent-configs-api.ts
    │   ├── observations-api.ts
    │   └── credits-api.ts
    ├── features/              # 业务模块：页面、表单、领域组件、hooks
    │   ├── projects/  runs/  results/  metrics/  observation/
    │   ├── datasets/  resources/  output-schemas/  agents/  credits/
    │   └── errors/            # 错误页、错误码到中文提示的映射
    ├── components/
    │   ├── layout/            # 侧边导航、页头、面包屑、嵌入模式适配
    │   └── ui/                # 自建基础组件（第 7.3 节）
    ├── auth/                  # 接收 takt 的 postMessage token、内存保存、401/403 提示
    ├── lib/                   # 格式化（时间、积分、时长）、Langfuse 链接、轮询工具
    └── styles/                # index.css（Tailwind 入口）、theme.css（设计令牌）
```

约定（与 SP 一致）：

- 导入路径别名 `@/` 指向 `src/`。
- `routes/` 只负责组装页面，业务逻辑放在 `features/`。
- 组件测试和组件文件放在一起，命名为 `*.test.tsx`。
- `apps/eval-web/CONTEXT.md` 记录领域术语，`README.md` 记录启动、构建和部署方式。

## 5. 模块与页面

### 5.1 路由表

| 路由 | 页面 | 主要接口 |
| --- | --- | --- |
| `/projects` | Project 列表 | `GET /api/projects` |
| `/projects/new` | 新建 Project（分步表单） | `GET /api/datasets`、`/api/data`、`/api/agents`、`/api/evaluation-output-schemas`；`POST /api/projects` |
| `/projects/$projectId` | Project 总览：指标、当前 Run、计划 | `GET /api/projects/{id}`、`/api/metrics/projects/{id}`、`/runs/current` |
| `/projects/$projectId/runs/new` | 发起 Run：选择操作和范围 → 预览 → 提交 | `POST …/runs/preview`、`POST …/runs` |
| `/projects/$projectId/runs/$runId` | Run 详情：进度、评估列表、停止、分数补同步 | `GET …/runs/{runId}`、`…/evaluations`、`POST …/stop`、`…/score-sync` |
| `/projects/$projectId/evaluation-plan` | 补填或替换评估计划（锁定后只读） | `PUT …/evaluation-plan` |
| `/projects/$projectId/datasets/$datasetId` | 测试集维度的指标 | `GET /api/metrics/projects/{id}/datasets/{datasetId}` |
| `/projects/$projectId/samples/$projectSampleId` | 用例维度：各次采样 | `GET …/samples/{projectSampleId}` |
| `/projects/$projectId/samplings/$samplingId` | 单次采样详情：产物、资源、评委结果 | `GET …/samplings/{samplingId}`（指标）、`/api/samplings/{id}`、`/api/samplings/{id}/evaluations` |
| `/projects/$projectId/samplings/$samplingId/observe` | 被测 Agent 只读观察 | `GET …/samplings/{id}/observation` + 观察数据（第 6 节） |
| `/projects/$projectId/evaluations/$evaluationId/observe` | 评委只读观察 | `GET …/evaluations/{id}/observation` |
| `/datasets` | 测试集列表、导入（JSON/YAML、提示词 JSON/JSONL） | `GET/POST /api/datasets`、`/import`、`/prompt-import` |
| `/datasets/$datasetId` | 测试集详情：用例列表、加入或移出、导出、编辑 | `/api/datasets/{id}`、`/data`、`/export` |
| `/data/$dataId` | 用例编辑：`userPrompt`、`evalPrompt`、业务字段、初始资源绑定 | `GET/PUT /api/data/{id}`、`PATCH …/initial-resources` |
| `/resources` | Bundle 列表 | `GET/POST /api/bundles` |
| `/resources/$bundleId` | Bundle 详情：素材（多文件上传）、初始会话（JSON/JSONL） | `/api/bundles/{id}/materials`、`/sessions` |
| `/output-schemas` | 评分格式列表、上传 | `GET/POST /api/evaluation-output-schemas` |
| `/output-schemas/$outputSchemaId` | 评分格式详情：Schema 查看、编辑名称和说明 | `GET/PATCH/DELETE …/{id}` |
| `/agents` | Agent 配置列表（冻结副本不在列表中） | `GET /api/agent-configs` |
| `/agents/new`、`/agents/$id` | Agent 配置编辑（冻结副本只读） | `POST/PATCH/DELETE /api/agent-configs` |
| `/credits` | 余额、加积分、加积分记录 | `GET /api/credits`、`GET/POST /api/credits/grants` |

侧边导航分组：
- **评测：** Project
- **数据：** 测试集、初始资源、评分格式
- **配置：** Agent
- **账户：** 积分

### 5.2 各模块要点

- **新建 Project（四步表单）：**
  1. 基本信息与测试集：可选全部用例或部分用例，同一用例只算一次。
  2. 每条用例的采样次数：先设默认值，再按用例覆盖。
  3. 被测 Agent 与执行并发。
  4. 可选的评估计划：评委 Agent、评估并发、评分格式；还要选首个 Run 的操作类型。

  提交时生成 `idempotencyKey`，存在表单状态里，重试时复用同一个 key。成功后跳到 Project 总览。用例总数超过 `RUN_TARGET_IDS` 时，在前端提前提示。
- **发起 Run：** 先调 `preview`，展示会替换多少采样、新增多少、评估多少，以及计划摘要。确认后，把预览返回的 `targets` 原样提交。预览之后计划被改过，会返回 `PROJECT_PLAN_CHANGED`，提示用户重新预览。
- **Run 进度：** 接口不推送，所以当前 Run 未结束时，用 react-query 的 `refetchInterval` 每 5 秒刷新一次，页面不可见时暂停。结束后停止轮询，并刷新指标。停止操作要二次确认，确认框写明"已在执行的 Agent 会被中断"。
- **结果与指标：** 四层逐级下钻（Project → 测试集 → 用例 → 采样），每层顶部是汇总卡片，下面是表格。
  - 评委结果展示 `score` 和 `reason`、原始 `structuredOutput`（JSON 查看器）、Schema 校验状态（来自 Metrics 的 `valid`、`invalid`、`unavailable`），以及 Langfuse 同步状态。
  - 有同步失败的分数时，Run 详情页显示"补同步"按钮。
- **测试集与用例：** 导入失败时，逐条展示后端返回的 `errors`。用例编辑器中的 `userPrompt` 和 `evalPrompt` 用多行文本框，业务字段用 JSON 编辑框，保存前做 JSON 校验。
- **初始资源：** 素材支持拖入目录、保留相对路径，在浏览器中转成 base64 后上传。单个文件和总大小的上限与后端 `limits.ts` 一致，在前端提前拦截。
- **评分格式：** 上传后用 JSON 查看器展示 Schema，并提示约定：评委结果需要有数字类型的 `score`，可以有 `reason`。已被 Project 引用的评分格式，删除时会返回冲突，需提示用户。
- **Agent 配置：** 表单字段与 SP `user-agent-configs` 的接口格式一致。冻结副本显示锁定标记，不能编辑和删除。
- **积分：**
  - 余额卡片。
  - 加积分表单：数量、备注、自动生成的幂等键。
  - 加积分记录表。
  - 不另设权限，有 Eval 访问权限的人都可以加积分。当前操作人由 Worker 写入备注前缀（如 `[张三]`），便于审计。

### 5.3 通用行为

- **错误处理：** `api-sdk/client.ts` 把失败的响应转成 `ApiError {status, code, errMsg, errors}`。`features/errors/messages.ts` 把 `http-errors.ts` 中的每个错误码映射为中文提示，未知错误码直接显示 `errMsg`。表单校验错误（422）显示在对应字段旁边。
- **列表：** 当前接口都不分页，返回全部数据，所以前端做本地筛选、排序和虚拟滚动。数据量大的列表（用例、采样）在超过 500 行时启用虚拟滚动。
- **加载与空状态：** 加载时用骨架屏。每个列表都要有空状态，并给出下一步操作的入口，例如"还没有测试集，导入一个"。
- **危险操作：** 删除和停止都要二次确认，确认框写明影响范围。
- **语言：** 第一版只做中文。界面文案集中放在各模块的 `copy.ts` 中，以后需要时再接入多语言。

## 6. 只读观察与 Langfuse 链接

### 6.1 观察页

观察页按 `AgentObservationRef`（`role`、`ownerUserId`、`chatId`、`state`）展示，分三个标签页：

| 标签 | 内容 | 组件 | 数据来源 |
| --- | --- | --- | --- |
| 会话 | 消息流（只读） | `@springbrand/message-panel`（npm） | Eval SP 的 Chat 历史 |
| 工作区 | 文件树 + 文件预览 | 自建文件树；预览复用 SP 的 `file-renderers` | Eval SP 的 Workspace 文件接口 |
| 轨迹 | 时间线：模型调用、工具调用、审批、提问 | 复用 SP 的 `trajectory-plugin` | Eval SP 的 trajectory 接口 |

- **数据经 Eval API 代理。** 浏览器不能持有服务账号会话，所以需要在 Eval API 增加只读代理接口（第 10 节）：`GET /api/projects/{id}/samplings/{samplingId}/observation/{messages|files|file|trajectory}`，评委同理。Eval API 用服务会话请求 Eval SP，只转发 GET 请求，并限制只能访问该 Project 的 Chat。
- **状态处理：** `state` 为 `not-started` 时显示"尚未开始"。未结束的 Chat 每 5 秒刷新一次。
- **SP 包的发布：** `@springbrand/file-renderers` 和 `@springbrand/trajectory-plugin` 目前只是 SP 工作区里的包，没有发布到 npm，需要像 eval-harness 一样发布（第 10 节）。发布之前：
  - 轨迹页先用自建的简单时间线，直接渲染遥测事件 JSON；
  - 文件预览先支持文本、代码、图片和 HTML 源码。

### 6.2 Langfuse 链接

- **配置：** `VITE_LANGFUSE_PROJECT_URL`，例如 `https://us.cloud.langfuse.com/project/<projectId>`，在构建时注入。
- **被测会话：** `{base}/sessions/{subjectChatId}`。这是分数所在的 session，在采样详情、评估列表和观察页顶部都提供入口。
- **评委会话：** `{base}/sessions/{evaluatorChatId}`。
- **单条分数：** 在评估详情中显示分数 ID `eval-score:{evaluationId}`，并链接到对应的 session。
- 链接都在新标签页打开（`target="_blank" rel="noopener"`）。在 takt 的 iframe 中也一样。

## 7. 视觉设计（参考 Langfuse）

定位：内部数据工具，信息密度优先。色彩与组件风格参考 Langfuse（`langfuse/langfuse` 的 `web/src/styles/globals.css`）。

### 7.1 设计令牌（`styles/theme.css`）

- **中性灰为主：** 浅色用 zinc 灰阶，深色用完全中性的灰（饱和度 0，没有偏蓝）。
- **主按钮：** 浅色下为近黑（zinc-900），深色下为近白（90%）。
- **没有强调色：** 选中、焦点和链接都用中性色。选中靠深色描边和浅底，链接靠下划线（`.link`）。整个界面只有状态色和品牌标志带色相。
- **深色层级：**

  | 层 | 亮度 |
  | --- | --- |
  | 侧边栏 | 4% |
  | 页面 | 6% |
  | 卡片 | 7.5% |
  | 浅底（表头、分段控件） | 11.6% |
  | 边框 | 16% |

  正文用 76% 的灰，标题和数值用 91%，靠层级而不是纯白来拉开对比。
- **状态色：** 成功、警告、危险、信息各用一对"浅底 + 深字"，深色下改为"暗底 + 亮字"，取值与 Langfuse 相同。
- **字体：** Inter，等宽字体用 Geist Mono。字重只用 400 和 600。圆角为卡片 8px、控件 6px。

令牌名：`bg`、`sidebar`、`surface`、`surface-muted`、`surface-hover`、`surface-code`、`border`、`border-strong`、`input`，`text-strong`、`text`、`text-secondary`、`text-muted`、`text-faint`，`primary`、`primary-fg`、`accent`、`accent-soft`、`link`，以及 `success`、`warning`、`danger`、`info` 和各自的 `-soft`。

### 7.2 布局与交互

- **侧边栏：** 宽 224px，可以折叠成 56px。选中项用灰底加粗，不用彩色。底部是浅色、深色、跟随系统三段式主题切换。
- **页头：** 吸顶，带底部分隔线。包含面包屑、标题、状态标签和操作区。
- **页头操作：** 只放主要操作（主按钮放最右）。导出、删除等收进"⋯"菜单（`ActionMenu`），危险项标红并单独分组。
- **长表单：** 底部固定操作栏，删除在左（描边危险样式），保存在右。
- **选择方式：** 互斥选项用选项卡片（`RadioCard`）；范围、视图切换用分段控件（`Tabs`）。
- **列表：** 表头不加底色，行悬停高亮，名称列加粗。
- **指标卡：** 按屏宽 2/3/6 列排布，大数字用紧凑格式（如 338K），说明最多两行。
- **进度：** 进行中的 Run 用分段进度条加图例，显示成功、进行中、排队、失败的数量。
- **采样详情：** 全部内容在一页展开，评委结果在最前，其后是被测 Agent 和评委 Agent；JSON 默认完全展开。页头直接进入被测会话、评委会话和 Langfuse。
- **深色模式：** 跟随系统变化。toast 和观察页的会话渲染（cloud-os）跟随页面主题。cloud-os 自带暖灰色的浅色主题和偏紫的深色主题（色相 285），在 Eval 里把它的中性面、线条和文字映射到 Eval 的灰阶。
- **文案：** 列表页没有副标题，卡片不加描述；只在确认对话框说明后果，在字段提示里说明约束；措辞简短。
- **观察页：** 全高布局，分段标签在页头右侧，会话直接铺满页头以下的区域。

### 7.3 组件：能用现成库的都用库

| 用途 | 来源 |
| --- | --- |
| 对话框、确认框 | Radix `Dialog`、`AlertDialog` |
| 下拉菜单（"⋯" 操作） | Radix `DropdownMenu` |
| 下拉选择 | Radix `Select` |
| 复选框、单选卡片 | Radix `Checkbox`、`RadioGroup` |
| 分段控件 | Radix `Tabs` |
| 提示 | Radix `Tooltip` |
| 表格 | TanStack Table（排序、搜索、选择） |
| 长列表 | 超过 100 行时用 TanStack Virtual 虚拟滚动 |
| 文件和文件夹拖放 | react-dropzone |
| JSON 查看 | react-json-view-lite |
| 会话 | SP 的 `@springbrand/message-panel/cloud-os` |
| toast | sonner |

Radix 通过 `radix-ui` 包引入，按 shadcn/ui 的写法套用我们的设计令牌。

只自己写的几类：
- 没有逻辑的样式组件：`Button`、`Badge`、`Card`、`Input`、`Textarea`、`Field`、`MetricCard`、`ScoreBar`、`ProgressBar`、`Stepper`、`EmptyState`、`Notice`；
- 页面骨架：`PageHeader`、`AppShell`。

可访问性：交互可以全部用键盘完成，焦点环用强调色；状态同时显示文字和颜色。

## 8. 配置与环境

| 名称 | 位置 | 说明 |
| --- | --- | --- |
| `VITE_LANGFUSE_PROJECT_URL` | `wrangler.jsonc` vars，构建时注入 | Langfuse eval 项目地址 |
| `VITE_DEV_AUTH` | 仅本地 `.env.local` | 跳过 takt 授权 |
| `TAKT_ORIGIN` | Worker vars，同时构建时注入前端 | `https://takt.cuecue.cc`；校验 token 的接口地址，也是前端唯一接受 postMessage 的来源 |
| `TAKT_EVAL_MENU_ID` | Worker vars | `eval` |
| `EVAL_API_ORIGIN` | Worker vars | Eval API 的 tunnel 地址 |
| `EVAL_WEB_API_TOKEN` | Worker secret | 作为 `X-Eval-Web-Token` 发给 Eval API |
| `FRAME_ANCESTORS` | Worker vars | `https://takt.cuecue.cc` 等允许嵌入 eval-web 的来源 |

前端在构建时通过 `VITE_TAKT_ORIGIN` 拿到 `TAKT_ORIGIN`。

Eval API 的 `EVAL_WEB_ORIGIN` 设置为 eval-web 的域名。Worker 转发请求时带上同一个 `Origin`，以满足 Eval API 现有的来源校验。

## 9. 测试与质量

- **单元测试：** 覆盖 `api-sdk` 的响应解析和错误映射、`auth` 的 token 接收（只接受 takt 来源的消息、token 更新与退出、401/403 提示）、Langfuse 链接拼接、表单校验。
- **组件测试：** 覆盖新建 Project 的分步表单、发起 Run 的预览和提交、Run 进度轮询的启停、`StatusBadge`、`DataTable`。
- **Worker 测试：** 覆盖无 token 或 takt 拒绝时返回 401、没有 `eval` 菜单时返回 403、校验结果缓存、转发时附加服务令牌和操作人且不转发 takt token、`frame-ancestors` 响应头。
- **CI：** `pnpm check` 和 `pnpm -r test` 已经包含 eval-web，构建步骤增加 `vite build`。
- **验收：** 在本地完整跑通 hello 用例。流程：导入测试集 → 新建 Project → 执行 + 评估 → 查看评委分数 → 打开观察页 → 跳到 Langfuse session 看到分数。

## 10. 依赖的配合改动

| 位置 | 改动 | 阻塞的功能 |
| --- | --- | --- |
| **takt** | 增加 `eval` 菜单、`/dashboard/eval` 的 iframe 页面，以及向 iframe 回传登录 token 的 postMessage（不涉及 OAuth） | 登录、嵌入 |
| **Eval API** | 校验 `X-Eval-Web-Token`，记录 `X-Eval-Actor` | 部署上线 |
| **Eval API** | 观察数据的只读代理接口（会话、文件列表和内容、轨迹） | 观察页 |
| **Eval API** | 部署到 Eval SP 已有的 AWS 环境：同一台 EC2 的 compose、同一个 RDS 上的独立库、tunnel 域名 | 部署上线 |
| **sp-platform** | 发布 `@springbrand/file-renderers`、`@springbrand/trajectory-plugin`（以及 eval-harness） | 观察页的完整文件预览和轨迹组件 |
| **Eval SP** | 只读观察的服务端访问控制（[接口需求](../docs/sp-eval-api-requirements.md) 中已列出） | 观察页 |

## 11. 实施阶段

| 阶段 | 内容 | 完成标准 |
| --- | --- | --- |
| **1. 骨架** | Vite、TanStack Router、Query、Tailwind 主题、布局、`api-sdk/client`、错误映射、本地开发登录、积分页 | 本地打开页面，能看到余额并加积分 |
| **2. 数据准备** | 测试集（导入、导出、编辑）、用例编辑、初始资源、评分格式、Agent 配置 | 不用 curl，在界面上完成全部数据准备 |
| **3. 评测流程** | 新建 Project、评估计划、发起 Run（预览、提交）、Run 进度、停止、分数补同步 | 在界面上跑通 hello 用例的执行 + 评估 |
| **4. 结果** | 四层指标、采样详情、评委结果、Langfuse 链接 | 在界面上看到分数，并跳转到 Langfuse 查看 |
| **5. 观察** | 只读观察页（先用简化版轨迹和文件预览，SP 包发布后替换） | 能查看被测和评委的会话、工作区、轨迹 |
| **6. 上线与嵌入** | Worker BFF、takt token 校验、Eval API 部署、iframe 嵌入与 token 回传、`frame-ancestors` | 有 `eval` 权限的用户在 takt 中打开 Eval 菜单即可直接使用 |

阶段 1–4 只依赖本地的 Eval API，可以先做。阶段 5 和 6 依赖第 10 节中各方的配合改动。

## 12. 已确认（2026-10-15）

1. **域名：** eval-web 使用 `evalrapp.springbrand.ai`。
2. **登录：** 与 takt 共用登录，不新增 OAuth。takt 通过 postMessage 把登录 token 交给 iframe，eval-web Worker 通过 takt 的 `/api/auth/me` 校验 token 和 `eval` 菜单权限。takt 侧只需增加菜单、iframe 页面和 token 回传。
3. **Eval API 部署：** 与 Eval SP 共用已建好的 AWS 环境（同一台 EC2 的 compose、同一个 RDS 上的独立库）。
4. **积分权限：** 不单独设权限。有 Eval 访问权限即可加积分，操作人记录在备注中。

## 13. 实施记录（2026-10-15）

**已完成（本地）：**

- eval-web 全部模块与第 5 节的路由；第 7 节的设计令牌、浅色/深色主题与基础组件。
- Worker BFF（`apps/eval-web/worker/`）：向 takt `/api/auth/me` 校验 token 与 `eval` 菜单（管理员直接放行，结果缓存 5 分钟），转发时去掉 takt token，附上 `X-Eval-Web-Token` 与 `X-Eval-Actor`；页面响应只允许 takt 嵌入。
- Eval API：`EVAL_WEB_API_TOKEN` 网关、操作人写入加积分备注、观察数据只读代理（会话、工作区树、文件、轨迹）。
- takt：本地分支 `feat/eval-embed`（`fc3a4e5`），新增 `eval` 菜单、`/dashboard/eval` iframe 页面与 token 回传，未推送。
- 本地联调：在界面上完成上传评分格式 → 导入提示词测试集 → 新建 Project 并执行 + 评估 → Run 详情（分数 10、已同步 Langfuse）→ 采样详情 → 被测与评委的会话、工作区、轨迹 → 预览新 Run。

**与方案的差异：**

- 表格用 TanStack Table，超过 100 行时用 TanStack Virtual 虚拟滚动。
- 会话复用 SP 聊天页同一套渲染（`@springbrand/message-panel/cloud-os` 的 `CloudOsChatMessages`，按包的宿主要求接入 Tailwind 与 CSS）；文件预览和轨迹使用自建的简单版本（文本/代码、图片、沙箱中预览 HTML；事件时间线），等 SP 发布 `file-renderers`、`trajectory-plugin` 后再替换。
- 只读观察请求以 `EVAL_SP_TRUSTED_ORIGIN`（Eval SP 已信任的 `https://devrapp.springbrand.ai`）为 Origin，由 Eval API 服务端发出，不需要修改 Eval SP 的 CORS 配置。
- 评委不再绑定被测工作区（见 `evaluation-evidence-decoupling.md`），观察页按证据包方式说明。

**未完成：**

- 部署：Eval API 与 Run Worker 上 AWS、eval-web Worker 与域名、生产环境的 `EVAL_WEB_API_TOKEN` 与 Langfuse 地址。
- takt 分支的推送与上线、在 takt 中授权 `eval` 菜单。
- SP 发布 `file-renderers`、`trajectory-plugin` 后替换简化版预览。
