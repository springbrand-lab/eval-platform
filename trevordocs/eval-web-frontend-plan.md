# Eval Web 交互与实现方案

本文维护当前页面行为和验收口径。HTTP 字段与错误码以 [Eval HTTP 控制面](../docs/eval-http-api.md) 为准，Project 和 Runtime 语义以 [Project、Runtime 与 Metrics 设计](../docs/eval-project-redesign.md) 为准。部署环境变量和开发入口见 [eval-web README](../apps/eval-web/README.md)。

## 页面与职责

| 入口 | 行为 |
| --- | --- |
| 项目管理 | 创建项目、查看绑定快照、发起与停止 Run、删除项目、查看四层结果。 |
| 数据集 | 初始素材、初始上下文、Prompt 数据集、评分 Schema 四个子卡片。 |
| Agent | 通过 Eval API 管理 SP 公开的 Agent Config。 |
| 积分 | 查看服务账号积分与管理加积分记录。 |

浏览器只访问同源 Eval API 代理，不访问数据库、Bundle 目录或 SP Durable Object。所有业务数据属于固定的 Eval SP 服务账号；takt 身份仅用于访问控制和审计。

## 数据准备

初始素材和初始上下文使用各自的目录、接口及 Query key。两类包均支持 ZIP 导入，包和每个条目分别编辑平台上的名称、描述；错误按 ZIP 条目路径显示。创建或导入的响应未确认时，先刷新目录确认实际结果。

Prompt JSON/JSONL 文件每条提供 name、description、userPrompt、evalPrompt，Dataset 名称和描述在平台填写。导入后四个字段继续可编辑，Prompt 原文字节、额外业务 JSON 和未改资源引用保留。执行与评估素材分别跨包有序多选，同一角色不能重复；执行初始上下文单选，评估没有上下文选择器。

新建用例从所属 Dataset 进入，路径包含 Dataset ID；Data 创建与成员关联由一个 Store 事务完成，Web 不维护半完成状态。创建 Data 或 Dataset 的响应未确认时，刷新目录并阻止重复提交，返回所属目录核对；明确拒绝的请求可以修改后重新提交。

评分 Schema 是独立文件和平台元数据，没有 Bundle。内容不可变，Project 保存 ID 与摘要；目录软删除后，已有 Project 通过项目专属只读入口查看原 Schema，不能从新选择列表选中已删除项。

上传与选择上限只从 `GET /api/input-limits` 获取。严格 JSON 与 Data 输入校验复用 `eval-dataset` 公开入口，不在浏览器复制后端规则。

## 项目与运行

创建分为数据、采样次数、执行 Agent、评估与运行四步。支持多个 Dataset、每个 Dataset 的 Data 子集、默认及逐 Data 采样次数；共享 Data 去重。点击“创建并运行”才写入，之前取消不产生 Project、副本或 Run。首个 Run 可仅执行或执行加评估。

执行计划和 Data 快照在创建时确定。评估计划在首个带评估的 Run 前可以补填或整体替换，包括仅执行 Run 进行中；此后只读。页面通过可用动作表达语义，不增加“配置已固定、不可更改”的提示。

新 Run 支持仅执行、执行加评估、仅评估，范围可以是全部、Dataset、Sample 或 Sampling。选择 Sample 意味着它的全部 Sampling，Dataset 同理。执行重跑清空选中的旧评估，未选中执行与评估结果保留；仅评估保持执行结果。预览绑定操作和选择，迟到的旧预览不能恢复提交动作。提交结果未确认时保留完整请求体、固定目标和幂等键，原样重试。

停止确认捕获点击时的 Project/Run，不随最新活动指针改变目标；只支持全停。运行中的 Project 不能删除，删除统一软删除。

`useProject` 复用同一 Project Query 和已有 Run 序号。序号变化能够发现两次轮询间完成的短 Run；结果首次在 Project 读取后获取。运行中刷新 Metrics、评估和观察，结束后取消旧读取再刷新最终事实，同时刷新被后续 Run 改变成员的历史 Run 视图。

## Metrics

层级为 Project → Dataset → Sample → Sampling，每层都从该范围的原始事实计算，Web 不平均下层汇总。

Subject 和每个 Evaluator 分开显示资源、费用、Token、缓存读取/写入、Agent/Attempt 时长、轨迹轮数、工具和模型调用的结果分类、各工具输入/返回长度，以及非工具轮和明确关联的 Token。工具长度是规范 JSON 的 UTF-8 字节数；缓存和 reasoning 不重复加到 total。未知、缺失、真实零及 coverage 保持区别。

均值、总体方差、中位数、最小值、最大值由 Metrics 统一返回。资源和调用次数按单 Agent（合并重启），工具长度和调用耗时按单次调用，Schema 数值按有效字段观察。分母 N 是有值数量，缺失不补零；N=0 为 null，N=1 方差为 0。方差显示平方单位，小的非零值使用有效数字或科学计数法。

JSON Schema 经后端编译为展示计划，返回字段标题、说明、数值统计、boolean/enum 分布、null、缺失及完整性。Web 消费这些结果，不另外遍历 Schema 产生评分规则。原始评估输出可直接查看；Langfuse 的 score/reason 只是可选派生投递，不替代 Schema 展示。

## 只读观察

Sampling 内的 Subject 和所有 Evaluator 都有各自的 Context、Workspace、Trajectory 入口。Context 复用 `@springbrand/message-panel/cloud-os`，不提供发消息、steer 或审批动作；Workspace 与轨迹通过 API 的 GET 代理读取。

轨迹按轮次、模型请求、工具调用、审批、交互、子 Agent、上下文和其他原始事件分类。工具类型筛选只作用于已加载事件；轨迹页的加载区间由单一 Query 缓存维护，历史分页和尾部刷新合并，跨多页的新尾部补齐到旧区间。统计只由 Metrics 负责。

## 前端基础设施

React 19、Vite、TanStack Router 和 Query 管理页面与数据。普通控件优先使用安装版本的 Dune 公开部件，表格在应用内组合 TanStack Table/Virtual；cell 是普通渲染回调，不因输入而改变组件身份。虚拟列表与固定表头使用 Dune 同一个公开滚动容器。领域组合留在对应 features 中。

API SDK 只处理业务路径、参数和共享类型；缓存、失效、提交状态和错误展示由 Feature 管理。请求使用 `@springbrand/http` 的统一客户端。失败保留 code、requestId、字段路径；只有 Worker 确认登录失效才触发重新登录，SP 服务故障不清除用户会话。

## 登录与部署

takt 把登录 token 通过受信来源的 postMessage 交给 iframe，前端只存内存。eval-web Worker 向 takt 校验权限后去掉 token，附服务间令牌和操作人转发 Eval API；页面通过 frame-ancestors 限制嵌入来源。开发登录开关仅在开发构建启用。

Eval API 和 Run Worker 使用独立进程，经 SP 公开 Chat、Submission、Trajectory、Workspace 接口工作；Web 不运行 Agent。共享包发布及精确版本升级的阻塞项见 [SP 包发布待办](../docs/sp-package-publishing-todo.md)。

## 验证与交付

组件回归覆盖四字段编辑及失败恢复、文件选择与读取取消、资源选择和 ZIP 提交反馈、Workspace 文件切换与轮询、缓存与轨迹分类、预览竞态、幂等重试、仅执行中的评估配置、固定停止目标、逐 Data 输入焦点、短 Run 和最终读取。创建回归经真实 HttpClient 验证未知响应后的目录重读与重复提交限制；PostgreSQL 集成验证 Data 创建关联完整回滚、来源软删除、Project 固定快照、局部重跑及计划锁定。Metrics 单独验证四层原始观察和有效 N。

Chrome 中已使用本地契约数据验收四个数据入口、项目向导与取消、逐条采样次数输入、四层统计及缓存、null 的有效 N、资源与 Schema 表单、上传后四字段保存刷新、Subject/Evaluator 独立只读 Context/Workspace/Trajectory，以及 HTML 预览和原始事件展开。这些验收不启动 SP Agent，也不代表跨部署联调通过。

当前本地全仓检查和带 PostgreSQL 的测试通过。使用的是 sibling SP 的公开包入口；npm 中旧版 eval-harness 尚不具备本次契约，需新版发布后完成干净安装、公开 ZIP 导入切换和跨项目联调，再完成发布验收。分支提交和推送不代表这些发布验证已经通过。
