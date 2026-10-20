# @eval-platform/eval-web

Eval 的内部管理界面：准备测试集与初始资源、上传评估结果格式、管理 Agent 配置、创建 Project、发起与停止 Run、查看四层指标与评估 Agent 结果、只读观察 Agent 会话，以及管理服务账号积分。方案见 [Eval Web 前端技术方案](../../trevordocs/eval-web-frontend-plan.md)。

## 技术栈

与 sp-platform `apps/web` 对齐：React 19、Vite、TanStack Router（文件路由，生成 `src/routeTree.gen.ts`）、TanStack Query、Tailwind CSS v4、`@springbrand/http`（解析 Eval API 的 `{success, msg, errMsg, code}` 信封）、lucide-react、sonner。只读会话复用 SP 聊天页同一套渲染：`@springbrand/message-panel/cloud-os` 的 `CloudOsRoot` 与 `CloudOsChatMessages`（不传任何回调，审批禁用）。样式按该包的宿主要求接入：`src/styles/index.css` 中所有 `@import`（含 `tw-animate-css`、`streamdown/styles.css`、`cloud-os.css`）放在最前，并用显式 glob 把 `cloud-os` 源码与 streamdown 产物加入 `@source`。领域类型从 `@eval-platform/*` 包以 `import type` 引入。

统一 HTTP 客户端的 `maxResponseBytes` 使用 SDK 接受的最大值 `Number.MAX_SAFE_INTEGER`，支持读取超过 SDK 默认 10 MiB 上限的完整采样详情及其他 API 响应。

Eval 目录删除及数据集成员变更的成功响应为 `204 No Content`，使用现有 HTTP SDK 的 `json` 模式接收空结果，不按成功信封解析；共享编辑器的 Skill/参考资料删除保留其原有成功结果，不改公共协议。错误仍由同一 Eval 错误目录解码，连接中断不能当作删除成功，也不自动重发写请求。

所有用户可操作的删除共用 `delete-confirmation.ts`：响应不确定时，通过同一 HTTP SDK 最多只读确认 10 次，首次立即查询，后续复用 contracts 的 `IDEMPOTENT_RETRY_POLICY` / `idempotentRetryBackoffMs()`，从 250ms 指数退避、上限 10s，不另写配置或退避算法；确认已删立即沿用正常成功提示。Project、Dataset、Data、Agent Config、评估结果格式、素材/对话包及其中资源，仅接受各自明确的 HTTP 404 领域码；数据集成员移除须确认全部指定 Data ID 都已不在成员列表；Skill 使用 selected 查询确认 deleted 状态，参考资料通过其详情确认不存在。仍存在或瞬态读取失败可继续确认；权限、认证、取消、无关 404 等不可重试读取错误立即结束。未确认或预算耗尽均保留原删除错误，绝不重复 DELETE。正常成功不增加查询。共享编辑器的临时上传附件回收不属于用户删除入口，且没有已开放的读取契约，仍由共享模块自行清理，不伪造确认结果。

Agent 新建与编辑直接复用 SP 同一份 `@springbrand/agent-config-editor`：行为、完整系统提示词、模型/思考强度、能力选择和排序、Skill/Reference 管理与预览。模型名称、可用性和每个模型支持的思考档位始终来自当前 Eval SP 的公开模型目录，Agent 管理列表也复用同一目录映射展示，不维护本地模型枚举。宿主只负责默认模板、当前用户、保存、revision 冲突、冻结副本只读及导航；不再提供 Slug 或配置 JSON 输入框。创建会话持有固定 Slug，失败重试通过 SP 创建重放校准；后台读取失败保留草稿。公共资源客户端经 `/api/agent-library` 访问当前 Eval SP，配置写入仍走 `/api/agent-configs`。错误由 Eval 目录解码，保留经过校验的 SP 编辑器领域码和删除阻挡详情。详见 [编辑器对齐](../../docs/agent-config-editor-alignment.md)。

Agent 创建时选择“执行 Agent”或“评估 Agent”，用途由 Eval 统一记录，管理页可按用途筛选，也可在编辑时切换。切换为评估 Agent 时自动绑定评估结果 MCP，切回执行 Agent 时自动移除该绑定。用途信息读取失败或 MCP 目录无法完成 reconciliation 时，管理页阻断列表并提示重试，不显示用途未知的配置。新建 Project 的执行 Agent 和评估计划的评估 Agent 分别只请求对应用途，API 也会再次校验用途，不能依赖浏览器筛选绕过。

Data 表单与 Schema 上传复用 `eval-dataset` 公开的严格 JSON 解析和输入校验；这些运行时入口随 Web 打包。上传与 Project 选择上限只从 API 的 `GET /api/input-limits` 读取，没有浏览器数值副本。

文本导入共用 `useTextImport` 草稿：从文件选择/拖入事件开始清空旧内容，仅接受最新选择的提取与读取；手动编辑接管草稿，关闭窗口销毁草稿。FileDropzone 复用 `react-dropzone` 的校验与 `file-selector` 的公开提取接口，选择信号覆盖提取到解码的完整生命周期。读取中或失败时不能提交。创建、导入的响应未确认时刷新目录，先核对新增条目再提交，避免重复创建。

数据集入口直接显示列表，侧栏“资源”分组直接提供输入素材、初始对话和评估结果格式三个菜单，不设资源库中转页。新建数据集仅填写名称与可选说明；完整文件可从列表导入。详情统一添加、批量导入和关联已有用例，并可带入当前数据集创建项目。编辑用例保留来源导航、提示共享引用与项目快照隔离，并保护未保存草稿。资源选择按条目展示，支持原地创建和预览；Bundle 仅作为资源分组。评估结果格式在项目评估配置中选择或新建，展示字段说明和示例，技术 Schema 默认折叠。

批量添加用例通过 `POST /api/datasets/{datasetId}/data/import` 一次提交 JSON/JSONL 用例列表，服务端复用严格解析并在单个事务中创建全部用例及关联；不修改现有用例和项目快照。响应不明时阻止重复提交并返回目录核对。

评估结果格式使用「新建评估结果格式」入口，在表单中切换导入与手动创建。导入只显示名称、说明与文件上传，保留完整 JSON Schema，不提供粘贴或查看原始 JSON 的入口；手动创建以字段列表生成 draft 2020-12 对象 Schema，支持数值、整数、文本、布尔、必填、数值范围及字段说明。禁止将复杂导入 Schema 有损转换到简单字段编辑器，两种方式各保留独立内容草稿，共用名称与说明；生成预览默认折叠。创建仍调用原有不可变评估结果格式目录接口，由服务端完成 Schema 校验；不改评估和统计口径。

新建项目默认以空状态展示测试数据范围，主动点击“添加数据集”后以内联的「测试集分组 → 缩进用例行」选择器展示；不使用外层弹出选择器。已有选择时保持选择器可见；各测试集默认展开，可独立折叠，折叠不清除选择。整组选中、半选、搜索保留选择和共享用例去重沿用现有语义；逐条勾满时只改变父项显示状态，不把显式用例 ID 改成动态的整组选取。Run 的层级选择器保持原有展开方式。

ZIP 与素材上传也等待 FileDropzone 的文件提取结束后再提交；单文件替换仅接受最新选择，多文件素材保留各次选择的累加结果。

输入素材、初始对话的文件读取共用 `bundles-api.ts` 的 `getResource`、`listFiles`、`getFile`；目录投影从 `eval-contracts` 的 `InitialResourceFile` 引入。Query key 包含资源种类、包、资源和文件路径，内容请求接受取消信号，路径作为 query 参数原样传递。格式预览的发布依赖与验证流程见 [SP 共享包接入与升级](../../docs/sp-package-publishing-todo.md)。

资源选择器与 Bundle 详情共用资源列表缓存，缓存保存 API 返回的完整记录；选择器通过 Query 的 `select` 生成选项，不把 `{id, name}` 展示投影写回共享缓存。访问页面的先后顺序不影响资源 ID、描述或格式。

素材、上下文名称进入 `/resources/$kind/$bundleId/$resourceId` 的只读目录页。资源与运行 Workspace 共用目录导航和 `@springbrand/file-renderers` 的格式选择、解析、预览、源码及下载；Web 仅负责鉴权文件读取、请求取消与 Blob URL 生命周期。文件夹和 ZIP 导入后的路径使用同一目录投影。HTML/CSS/图片等相对引用由公共 `rendererResourcePath` 统一解析，只读取当前资源根目录内的文件；HTML 预览还只读取页面所在目录及其子目录（网站根），上级目录的引用不读取；Web 不另行解码链接，并遵守渲染器传入的剩余字节预算（`maxBytes`）。

`file-renderers`、`agent-config-editor` 使用 npm 精确版本，Tailwind 扫描它们发布后的 `dist/**/*.js`；格式自身的 CSS Module 由包内 JS 导入。`file-renderers` 是包含资源 URL、CSS 和 Worker 的 ESM 包，开发时不参与依赖预打包，由 Vite 标准资源流水线处理；其包含 CommonJS 的依赖链仍显式参与预打包，按 [Vite 的嵌套依赖配置](https://vite.dev/config/dep-optimization-options.html#optimizedeps-exclude)转换，不能把原始 CommonJS 交给浏览器。Vite 对 React、React DOM、TanStack Query、HTTP 和 site-block 去重，避免产生第二份 Context 或错误类。依赖接入与独立安装验证见 [SP 共享包接入与升级](../../docs/sp-package-publishing-todo.md)。

从 Dataset 新建用例使用 `/datasets/$datasetId/data/new`，页面始终有明确的数据集归属，只调用一次 `POST /api/data?datasetId=...`，创建与关联由 API 原子提交；页面不持有“已创建、未关联”的补偿状态。创建响应未确认时刷新目录并阻止重复提交，再返回 Dataset 核对。

创建项目仅在“创建并运行”时提交；此前取消只返回项目管理。Run 预览与其操作、选择范围绑定，选择改变后旧响应不能恢复可提交的预览。创建与 Run 提交都捕获完整请求；结果未确认时保持该请求和幂等键，允许原样重试，不能编辑后误启动另一组目标。仅执行的 Run 进行中仍可填写或修改评估计划；首次带评估的 Run 后沿用 API 返回的只读计划。

选择器复用 Dune Popover、Collapsible 与既有 Checkbox：新建项目按测试集/用例勾选，采样次数按测试集分组、按共享 Data ID 同步；Run 按项目/测试集/用例/已有采样展开，沿用支持组合的 selector。父级全选包含下级，部分选择显示半选；搜索与折叠不丢失选择，实际去重和执行数量仍由服务端预览决定。采样按展开用例读取，浮层内控件同样遵守冻结提交状态。

项目页面共用 `useProject` 的可见页轮询和 Run 结束刷新。使用 API 的既有 Run 序号发现两次轮询间完成的短 Run；结果首次在 Project 读取完成后获取。运行期间四层 Metrics 与评估同步状态轮询，结束后取消尚未完成的旧读取，再统一刷新最终 Metrics、评估记录和只读观察数据；各页不另存一份“运行中”状态。每个 Subject/Evaluator 的会话入口绑定该 Agent 自己的观察地址。采样详情「资源统计」的尝试明细中，已采集资源的 Attempt 可下载其原始资源快照（API 流式返回的原样 JSON）。

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

四层 Metrics 和采样内每个 Agent 共用 Token 展示：模型名称、总量、缓存读取、缓存写入、输入、输出、推理和缓存命中率，不使用“全部模型”和模型明细的重复表格。资源完整性集中在“资源完整性”一处展示，数值和分布不重复放状态标签；未获得的值仍不按零展示。总量和缓存命中率直接使用 Metrics 结果，不重复加上缓存或推理 Token。

资源与轨迹按 Agent 分开，四层与采样 Agent 详情复用一套投影。执行/评估阶段状态直接使用各自的 Sampling/Evaluation 状态；Turn、模型请求、工具调用以及思考步骤/内容步骤的成功/失败/取消/未闭合/未知是底层遥测操作统计，不作为 Agent 阶段状态。按工具类型展示调用/返回长度与耗时；每个 `generation` operation 是一个模型 Step，Step 自身或所属 Turn 的输出含 `thinking`/`signature` 标记时计入思考步骤，含 `content` 标记时计入内容步骤，并分别汇总命中 Step 的 Token。一个 Turn 可以包含多个 Step，一个 Step 可以同时命中两类，数量不要求加总为 Turn 总数；Token 也可能重叠。长度以规范 JSON 的 UTF-8 字节计，不转换为 Token；时长展示累计、均值、范围与有效/缺失数量，不当成并行批次的墙钟时间。

只读 Trajectory 按轮次、模型请求、工具调用、审批、交互、子 Agent、上下文分类，并保留其他原始事件。工具类型筛选只作用于已加载事件；轮数等统计始终来自 Metrics。Query 缓存保存一个已加载区间，历史分页与运行中刷新原子合并；新尾页跨过多页时补齐到旧区间，已加载历史不会被滚动窗口替换。Run 结束时再刷新观察数据。

Workspace 只保存选中的路径，节点取当前目录树。Query 只缓存原文件 Blob，解码、解析和关联资源属于当前选择的取消生命周期，切换文件或已知版本时旧读取不能回填新预览；读取失败可重试，关联资源失败也可通过重新加载文件重试。每次选中验证当前文件，运行中沿用统一轮询周期读取，结束由 Project 统一刷新，不以可选的 mtime 或 size 推断内容未改变。HTML 视图在同一路径更新时保留用户的源码/预览选择。下载链接按 Blob 生命周期创建和释放。

聚合数值均使用 Metrics 返回值。资源区域中的执行与评估 Agent 独立折叠；展开后先看总览，再通过费用、Token、操作次数和耗时选择卡查看分项详细数据。消耗/轮数/工具次数的分布按单 Agent，工具长度/操作耗时按单次调用，Agent/Attempt 耗时和 Schema 数值各按自己的观察单位。共用统计表默认显示均值、中位数、最小—最大、标准差、有效 N 与缺失，累计值按需单列。每项保留自己的有效 N，不重复展示模型分布；标准差与指标使用相同基础单位。


项目结果工作台：ProjectOverview 额外返回去重的 projectSamples 行及每行当前 samplingIds，沿用同一事实快照和 Metrics 聚合口径，不由前端合计子层统计。默认是当前有效采样及评估结果，非历史运行总和；指定运行的范围仍由 runIds 控制。Web 将数据集作为筛选，按用例聚合、展开采样，单次采样直接打开结果抽屉；运行记录与配置分开展示。采样详情和抽屉共用结果组件，评估内容与产物优先、技术统计按需展开，文件预览复用已有只读 Workspace API 和公共渲染器，不读取 SP 私有存储。

项目结果列表默认展示评估结果格式投影的全部可统计指标，逐项显示字段名称和值，不隐式生成总分；可筛选单个指标。多份有效观察按各字段分别展示均值、范围和有效数量，缺失不补零；文本理由和证据保留在采样结果中。

评估指标概览面向结论优先展示有效、无效和未获得结果，以及每个指标的主结论（数值均值或主导分类及占比）；范围、方差、路径等技术统计默认折叠，缺失和部分覆盖明确提示。

用例结果使用 site-block 的语义 Table，父用例与展开采样共用同一列组；指标名称只在表头显示，每项独立右对齐。默认紧凑行高，重复采样显示均值与范围/有效数量，无有效观察显示破折号；仅异常状态追加提示，宽表在容器内横向滚动。


手动重新收集结果：POST /api/projects/{projectId}/samplings/{samplingId}/collect 与 /evaluations/{evaluationId}/collect 返回 202 {runId, queued}。仅接受归属匹配、最后 Attempt 为 completed 且有 Chat/Submission 的失败阶段；已成功为幂等无操作，重复待收集请求不重复入队，项目忙或 Run 已停止时拒绝。API 在 Project 行锁内设置 retrying + collectionPending，并原子提交原 Run 队列任务。Worker 只读取已有输出，不创建或重启 Agent/Attempt；执行侧必须归档产物和完整轨迹，评估侧保存原始结果并沿用校验和同步。失败清除待收集标记并保留错误，支持再次补收。补收执行不自动启动之前已取消的评估。当前运行查询允许旧 Run 因补收重新活跃，runSequence 仍是最大创建序号。

阶段进度按完整阶段状态显示，而不只看 status：`evidencePending` 显示“执行 Agent 已完成 · 整理证据中”（评估侧为“评估 Agent 已完成 · 整理证据中”），`collectionPending` 显示“补收结果中”，`observationPending` 显示“确认 Agent 状态中”，`resourcesPending` 在任意状态下显示“补采资源中”；其余进行中阶段仍为“执行中/评估中”，计数口径不变。资源完整性旁按 `collections` 明确提示“资源采集失败 N 个”“N 个资源尚未采集”“N 个资源快照未定稿，数值可能不完整”和补采中的数量，数值本身仍只在确实无数据时显示“未获得”。最后 Attempt 已完成且该 Agent 资源存在失败、未采集或未定稿快照时，结果卡提供“重新采集资源”，以 `{ "target": "resources" }` 调用同一 collect 接口，只补采资源，不重新运行 Agent；“重新收集结果”同样显式发送 `{ "target": "output" }`。采样详情页在 Sampling 带有 `evidenceExport` 时显示证据导出进度：当前轮次（上限 5 轮）、已存产物与执行输入数量、轨迹分段是否读完、未纳入证据的文件数和最近错误；导出失败时提示进度已保留，重新收集执行结果会从断点继续。

采样详情采用紧凑的结果工作区：桌面将评分/理由与文件预览并列，小屏堆叠；标量评分横排，长说明在可聚焦区域内滚动且保留全文。证据选择与执行产物共用右侧单一预览，查询仍按 Agent 身份隔离。采样只保留结果、执行过程、评估过程、资源统计一层导航；进入过程直接显示对应会话，原始轨迹在独立抽屉查看。重新执行与重新评估分别进入预选对应操作的运行确认页，不直接启动任务。独立页与抽屉共用同一结果组件，结果补收和运行契约不变。

Run 详情与采样页共用 compact PageHeader；首屏用一行运行摘要和评估列表承载主要信息。评估指标、两个 Agent 的资源统计、运行标识分别默认折叠，保留完整明细与错误提示。

项目结果以评估指标卡、整体结果行、用例行、采样行对照同一组指标，积分与 Agent 累计耗时就近展示；缺失数据不当零值。异常和缺失摘要可直接筛选用例（包括部分采样缺失），点击时清除其他范围筛选。项目结果页分别展示两类 Agent 的总览和分项选择卡，分项内包含资源、调用、耗时和分布统计；窄屏纵向排列，宽屏双列。采样详情仍保留单次资源明细。整体结果始终覆盖项目当前结果，不随列表筛选改变。

Agent 编辑页保留共享编辑器的所有表单与保存行为，以 `.agent-editor-layout` 限定宿主样式：取消嵌套页面的窄列、重复标题和分组卡片边框，名称和用途独立置顶，工作指令直接编辑并占主栏，运行设置占右侧辅栏，能力选择以三列排列，保存栏保持可见。样式依赖当前固定版本的 form/fieldset 结构及 data-agent-* 区域标识；升级共享编辑器时需复核布局。MCP 只读清单与表单使用相同宽度。

共享 Agent 编辑器当前没有语言参数；本项目通过 pnpm patchedDependencies 固定中文文案补丁（patches/@springbrand__agent-config-editor@0.1.0-alpha.0.patch）。覆盖编辑页、选择器、技能/资料管理、操作反馈与无障碍标签。Thinking 只翻译显示名称，原始枚举与模型、能力标识、用户内容保持不变；升级包版本时需迁移补丁并运行编辑器测试。外部服务返回的用户资源名称和原始错误内容不做字符串替换。

MCP 保留标准名称 `MCP Server`。共享编辑器补丁提供可选 `supplementaryContent` 插槽，用来在同一个 fieldset、保存栏之前展示既有 MCP 配置元数据；用户自选 MCP 不在该入口编辑。评估结果 MCP 是 Eval 管理的用途绑定例外：选择“评估 Agent”时按固定 URL 自动加入，选择“执行 Agent”时移除，保存前由 API 再次校验唯一启用且 Bearer 鉴权的服务。只读清单与其他配置共用宽度与分隔线，避免保存栏把 MCP 信息隔在表单之外。

能力为空时保留名称和添加/管理入口，不渲染空内容或折叠箭头；选择后仍走共享编辑器原有条目列表。独立 MCP 配置不计入外部应用连接数量。中等窗口能力入口双列、宽屏三列，避免重复空状态撑长页面。
