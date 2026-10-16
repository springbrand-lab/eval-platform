# @eval-platform/eval-web

Eval 的内部管理界面：准备测试集与初始资源、上传评分格式、管理 Agent 配置、创建 Project、发起与停止 Run、查看四层指标与评委结果、只读观察 Agent 会话，以及管理服务账号积分。方案见 [Eval Web 前端技术方案](../../trevordocs/eval-web-frontend-plan.md)。

## 技术栈

与 sp-platform `apps/web` 对齐：React 19、Vite、TanStack Router（文件路由，生成 `src/routeTree.gen.ts`）、TanStack Query、Tailwind CSS v4、`@springbrand/http`（解析 Eval API 的 `{success, msg, errMsg, code}` 信封）、lucide-react、sonner。只读会话复用 SP 聊天页同一套渲染：`@springbrand/message-panel/cloud-os` 的 `CloudOsRoot` 与 `CloudOsChatMessages`（不传任何回调，审批禁用）。样式按该包的宿主要求接入：`src/styles/index.css` 中所有 `@import`（含 `tw-animate-css`、`streamdown/styles.css`、`cloud-os.css`）放在最前，并用显式 glob 把 `cloud-os` 源码与 streamdown 产物加入 `@source`。领域类型从 `@eval-platform/*` 包以 `import type` 引入。

Agent 新建与编辑直接复用 SP 同一份 `@springbrand/agent-config-editor`：行为、完整系统提示词、模型/思考强度、能力选择和排序、Skill/Reference 管理与预览。宿主只负责默认模板、当前用户、保存、revision 冲突、冻结副本只读及导航；不再提供 Slug 或配置 JSON 输入框。创建会话持有固定 Slug，失败重试通过 SP 创建重放校准；后台读取失败保留草稿。公共资源客户端经 `/api/agent-library` 访问当前 Eval SP，配置写入仍走 `/api/agent-configs`。错误由 Eval 目录解码，保留经过校验的 SP 编辑器领域码和删除阻挡详情。详见 [编辑器对齐](../../docs/agent-config-editor-alignment.md)。

Data 表单与 Schema 上传复用 `eval-dataset` 公开的严格 JSON 解析和输入校验；这些运行时入口随 Web 打包。上传与 Project 选择上限只从 API 的 `GET /api/input-limits` 读取，没有浏览器数值副本。

文本导入共用 `useTextImport` 草稿：从文件选择/拖入事件开始清空旧内容，仅接受最新选择的提取与读取；手动编辑接管草稿，关闭窗口销毁草稿。FileDropzone 复用 `react-dropzone` 的校验与 `file-selector` 的公开提取接口，选择信号覆盖提取到解码的完整生命周期。读取中或失败时不能提交。创建、导入的响应未确认时刷新目录，先核对新增条目再提交，避免重复创建。

ZIP 与素材上传也等待 FileDropzone 的文件提取结束后再提交；单文件替换仅接受最新选择，多文件素材保留各次选择的累加结果。

初始素材、初始上下文的文件读取共用 `bundles-api.ts` 的 `getResource`、`listFiles`、`getFile`；目录投影从 `eval-contracts` 的 `InitialResourceFile` 引入。Query key 包含资源种类、包、资源和文件路径，内容请求接受取消信号，路径作为 query 参数原样传递。格式预览的发布依赖与接入待办见 [SP 共享包发布与升级](../../docs/sp-package-publishing-todo.md)。

素材、上下文名称进入 `/resources/$kind/$bundleId/$resourceId` 的只读目录页。资源与运行 Workspace 共用目录导航和 `@springbrand/file-renderers` 的格式选择、解析、预览、源码及下载；Web 仅负责鉴权文件读取、请求取消与 Blob URL 生命周期。文件夹和 ZIP 导入后的路径使用同一目录投影。HTML/CSS/图片等相对引用由公共 `rendererResourcePath` 统一解析，只读取当前资源根目录内的文件；Web 不另行解码链接。

`file-renderers`、`agent-config-editor` 使用 npm 精确版本，Tailwind 扫描它们发布后的 `dist/**/*.js`；格式自身的 CSS Module 由包内 JS 导入。Vite 对 React、React DOM、TanStack Query、HTTP 和 site-block 去重，避免产生第二份 Context 或错误类。依赖接入与独立安装验证见 [SP 共享包接入与升级](../../docs/sp-package-publishing-todo.md)。

从 Dataset 新建用例使用 `/datasets/$datasetId/data/new`，页面始终有明确的数据集归属，只调用一次 `POST /api/data?datasetId=...`，创建与关联由 API 原子提交；页面不持有“已创建、未关联”的补偿状态。创建响应未确认时刷新目录并阻止重复提交，再返回 Dataset 核对。

创建项目仅在“创建并运行”时提交；此前取消只返回项目管理。Run 预览与其操作、选择范围绑定，选择改变后旧响应不能恢复可提交的预览。创建与 Run 提交都捕获完整请求；结果未确认时保持该请求和幂等键，允许原样重试，不能编辑后误启动另一组目标。仅执行的 Run 进行中仍可填写或修改评估计划；首次带评估的 Run 后沿用 API 返回的只读计划。

项目页面共用 `useProject` 的可见页轮询和 Run 结束刷新。使用 API 的既有 Run 序号发现两次轮询间完成的短 Run；结果首次在 Project 读取完成后获取。运行期间四层 Metrics 与评估同步状态轮询，结束后取消尚未完成的旧读取，再统一刷新最终 Metrics、评估记录和只读观察数据；各页不另存一份“运行中”状态。每个 Subject/Evaluator 的会话入口绑定该 Agent 自己的观察地址。

## 目录

- `src/routes/`：文件路由，只组装页面；`_authenticated` 布局负责登录守卫与侧边导航。
- `src/features/<模块>/`：页面、表单与领域组件。
- `src/api-sdk/`：每个领域一个文件，请求函数与 query key。
- `src/components/ui/`：自建基础组件；`src/styles/theme.css` 是设计令牌（浅色与 `html.dark` 深色）。
- `src/auth/`：接收 takt 交给 iframe 的登录 token，只保存在内存中。
- `worker/`：部署用的 Cloudflare Worker，托管静态资源并转发 `/api/*`。

## 登录与部署

与 takt 共用登录：takt 的 `/dashboard/eval` 用 iframe 打开本应用，iframe 发出 `eval:ready`，takt 只向本应用的来源回传 `{type: "takt:token", token}`。Worker 用这个 token 调用 takt 的 `/api/auth/me`，用户须有 `eval` 菜单（或是管理员）才放行；之后去掉 token，附上 `X-Eval-Web-Token` 与操作人 `X-Eval-Actor` 转发给 Eval API。页面响应带 `Content-Security-Policy: frame-ancestors`，只允许 takt 嵌入。

Worker 配置见 `wrangler.jsonc`：`TAKT_ORIGIN`、`TAKT_EVAL_MENU_ID`、`EVAL_API_ORIGIN`、`EVAL_WEB_ORIGIN`、`FRAME_ANCESTORS`，密钥 `EVAL_WEB_API_TOKEN`（与 Eval API 相同）。构建期变量写在 `.env.production`：`VITE_TAKT_ORIGIN`、`VITE_LANGFUSE_PROJECT_URL`。`pnpm --filter @eval-platform/eval-web deploy` 构建并部署；推送到 `main` 时由 `.github/workflows/ci.yml` 在 eval-web 测试通过后自动部署。

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

四层 Metrics 和采样内每个 Agent 共用 Token 展示：模型名称加总量、缓存读取、缓存写入、输入、输出、推理六项指标，不使用“全部模型”和模型明细的重复表格。资源完整性集中在“资源完整性”一处展示，数值和分布不重复放状态标签；未获得的值仍不按零展示。总量直接使用 Metrics 结果，不重复加上缓存或推理 Token。

资源与轨迹按 Agent 分开，四层与采样 Agent 详情复用一套投影：轮数、模型请求、工具调用的成功/失败/取消/进行中/未知次数，按工具类型的调用/返回长度与耗时，非工具轮数及明确关联的 Token，以及资源诊断。长度以规范 JSON 的 UTF-8 字节计，不转换为 Token；时长展示累计、均值、范围与有效/缺失数量，不当成并行批次的墙钟时间。

只读 Trajectory 按轮次、模型请求、工具调用、审批、交互、子 Agent、上下文分类，并保留其他原始事件。工具类型筛选只作用于已加载事件；轮数等统计始终来自 Metrics。Query 缓存保存一个已加载区间，历史分页与运行中刷新原子合并；新尾页跨过多页时补齐到旧区间，已加载历史不会被滚动窗口替换。Run 结束时再刷新观察数据。

Workspace 只保存选中的路径，节点取当前目录树。Query 只缓存原文件 Blob，解码、解析和关联资源属于当前选择的取消生命周期，切换文件或已知版本时旧读取不能回填新预览；读取失败可重试，关联资源失败也可通过重新加载文件重试。每次选中验证当前文件，运行中沿用统一轮询周期读取，结束由 Project 统一刷新，不以可选的 mtime 或 size 推断内容未改变。HTML 视图在同一路径更新时保留用户的源码/预览选择。下载链接按 Blob 生命周期创建和释放。

聚合数值显示均值、总体方差、中位数和范围，均使用 Metrics 返回值。资源分布在“均值、方差、中位数与范围”展开，消耗/轮数/工具次数的单位是单 Agent；工具长度/操作耗时按单次调用，Schema 数值按字段观察值。每项保留自己的有效 N 和缺失数量，不重复展示模型分布；小的非零方差使用有效数字或科学计数法，不显示为零。方差单位为原单位的平方。
