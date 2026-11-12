# Agent 能力对齐：Runtime alpha.32 + raw 轨迹调研与实施计划草案

日期：2026-11-10。状态：**用户已授权实施，迁移进行中；尚未验证完成**。

前一调研轮由四个只读子 Agent 分查 SP 生产者与公开包、EP 消费者与历史数据、Agent Host 能力、发布与验证门槛，并追加定向复核；该轮未修改业务代码、依赖、锁文件、配置或数据库，未安装、打包、发布、部署或调用真实模型。用户现已授权启动迁移，以下新增实施约束与文件归属，不能把计划或代码改动视为验收完成。

## 当前实施约束与文件归属

- 所有代码写入、安装、测试和集成命令仅在 SP 目标 `/Users/apple/code/.worktrees/sp-eval-20261110` 与 EP 目标 `/Users/apple/code/.worktrees/ep-main-20261110` 运行；来源 SP/UA 只读参考，禁止修改原仓库、来源工作区和 `node_modules`。
- 精确消费已发布 Runtime `.32`，两类 Agent 都对齐，只保证新 Chat/Run，旧结果/归档不改写。没有 SAFE/raw 双栈、旧格式自动转换、兼容垫片、假实现、并行状态源或复制的内核。
- 使用现有 Module/公开 Interface 和基础设施；验证沿用第十节已审计划的 SDK/Harness、HTTP/WS、证据/生命周期、Metrics、Workspace/FileSurface、工具装配和必要业务接口接缝，逐个垂直切片 red→green。
- 子 Agent 不修改任何 manifest、lockfile、安全策略、中央 Host/启动配置，不安装依赖，不发布/部署/调用真实模型，不访问真实数据库或执行数据库清理，不删除既有文件，不添加或删除代码注释。必须退出的废弃文件交集成人汇总具体清单后确认；不以保留无用文件作为完成。
- 依赖、发行年龄、构建许可等安全门槛不得绕过。公开 Harness 发布、部署、真实模型回合、数据库破坏性测试及必要既有文件删除均另行确认。

| 子任务 | 独占写入范围 | 不得跨写 |
| --- | --- | --- |
| A SP raw/公共包 | SP `packages/eval-harness`、`packages/agent-contracts/src/trajectory*`、`packages/trajectory-plugin/src/adapter`、`apps/agent/src/telemetry`、`apps/agent/src/eval` 的相关源码、tests、现有 README | manifests、中央 `severn-agent.ts`、Host/工具/模型模块 |
| B EP wire/证据 | EP `apps/eval-api/src/sp`、`apps/eval-api/src/eval-management/trajectory*`、`packages/eval-runtime`、原生 fixtures/generator 及对应现有文档 | `eval-contracts`、`eval-metrics`、DB snapshots、manifests |
| C SP 模型/Prompt/Rule/Skill | SP `agent-contracts/src/model*`、`runtime/config/runtime-settings*`、`runtime/config/resource-loader/host*`、`runtime/host` 中 model-provider/reminder/rule/fact/plan-progress 等非中央模块、`runtime/skills`、`runtime/platform-skills*`、`chat/long-image-tiles*`、`chat/visitor-location*`、Pi-AI 输入补丁 | 中央 `runtime-host.ts`、`universal.ts`、API client、manifests |
| D SP 文件/Office/媒体 | SP `apps/agent/src/workspace`、`runtime/host/genoffice`、FileSurface engines/images tests、`runtime/host/chat-sandbox*`、`assets` 必要资源、Office 检查脚本、Agent Dockerfile、字体测试 | 中央 Host、工具装配、API、上游源码、manifests/配置 |
| E EP contracts/Metrics/SQL | EP `packages/eval-contracts`、`packages/eval-metrics`、`apps/eval-api/src/db/attempt-resources*` 及对应现有 README | HTTP wire/generator、其他 runtime/app 模块、manifests |
| F SP 工具/业务 Adapter | SP `runtime/config/tools/universal*`、`runtime/tools`、`runtime/config/agent-config*`、`runtime/config/resources*`、`agent-contracts/src/agent-chat-authoring*` 及聚焦 tests | HTTP client、API Models/routes、中央 Host、模型/Rule、manifests |
| G SP 必要 API/Guard | SP `apps/api` 中必要 Model/routes/迁移/聚焦 tests、`packages/contracts` 相关领域契约、Agent `src/api/http-client*`、`runtime/host/run-billing-context*` 与 Turn/billing/Guard 专用模块、`sessions/credit-wrapup*` | 中央 Host、工具/模型、生产数据、安全策略、manifests |
| 集成人 | 两仓所有 manifests/lockfiles；SP `runtime/host/runtime-host.ts`、`chat/severn-agent.ts`、Worker index/env/wrangler、`agents.patch`；交叉调用方、既有公共文档、必要类型消费方及最终验证 | 不替代所属包内核；其他 Agent 完成并交接前不并发改其文件 |

表中路径相对对应目标仓库。写入前各子 Agent 仍须读完整匹配规则、Context 和包 README，检查真实调用方与所属共享包。跨归属需要先报告，不私自扩展；依赖/编译阻断必须原样报告，不能以 cast、空数据或禁用能力伪造完成。

本文覆盖《[SP1105 + UA1103fresh 能力研究](agent-capability-alignment-research-2026-11-10.md)》中“保留 SAFE、另发兼容 Runtime”的旧建议；原报告中的能力清单、源码事实和目标独有增强仍需使用。后续方向已明确：**消费已发布的 `@springbrand/agent-runtime@0.3.1-alpha.32`，SP eval 与 EP 配套移除 SAFE 原生轨迹投影，保留评估平台自身职责。**

需求问答已确认：**本轮只保证升级后新建的 Chat/Run；旧结果与已归档证据保留，不要求新系统恢复、续跑或补收旧运行。Runtime 精确锁定已发布的 `0.3.1-alpha.32`，本轮不通过后续 Runtime 版本补缺口。** 此确认不授权实施或处置旧数据。

Web 范围已确认：排除平台 Web 产品页面、组件和样式迁移，**保留 Agent 的网页浏览、制作、预览和部署工具**，原有权限与审批不变。

Prompt 与工具说明的验收口径已确认：**必要模型指导语义完整对齐，允许为 Eval 调整措辞和位置，不要求逐字一致，保留评估专用约束。** 只能通过已验证的公开接口承载，不修改 .32 安装包或仿造内核。

角色范围已确认：**执行 Agent、评估 Agent 两类都对齐**；保留各自配置、权限和评估职责，不自动扩大授权。

## 一、结论

可以按这个方向迁移，不需要整体合并分支，也不需要在 EP 复制 Runtime。实际工作包含两条相互依赖的主线：

1. **原生契约主线**：Runtime .32 → SP 接收和存储 raw → SP 公共 Harness → EP 字节验证、证据归档及 Metrics 消费。
2. **能力主线**：SP 的模型目录、Prompt、Reminder、Skill、工具装配、FileSurface、Office/PDF/媒体、执行守护及必要服务，适配到 .32 的公开接口。

当前不能仅改版本号：目标的 Agent/Harness 依赖 .15，而部分其他消费方仍依赖 .9；公开 `eval-harness` 的 alpha 标签当前为 `0.1.0-alpha.9`，其注册表依赖仍是 Runtime `.15`。目标 Harness 源码还明确要求 SAFE。因此需要新的公开 Harness 产物，并同步修改两侧消费路径。新 Harness 的版本号尚未确定、预留或获准发布。[^r1][^r2]

本次核查进一步确认四件不能混淆的事：

- `.32` 的原生记录没有 `projection`；带旧字段的记录会被严格 Schema 拒绝。
- EP 的 **body-free Metrics 投影和流式解释限额**不是上游 SAFE，仍有保留价值。
- 旧 SAFE 记录不是“删掉字段即可变 raw”；丢失的原值无法靠改标签恢复，既有 hash/reference 也不能被静默改写。
- 源分支自身还有工具注册和 Workspace 语义缺口；复制源文件不等于获得已验证能力。

## 二、基线与范围

### 2.1 工作区

| 角色 | 路径 | HEAD |
| --- | --- | --- |
| SP 目标 | `/Users/apple/code/.worktrees/sp-eval-20261110` | `3696f184ac10a4916ce96c6caef5609ac82da697` |
| EP 目标 | `/Users/apple/code/.worktrees/ep-main-20261110` | `e0b7e0417be3761f015a6bc815058eb1afb043bf` |
| SP 来源，只读参考 | `/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105` | `f99fb6654f3cfd088f1e613d62d3c24b622c72bc` |
| UA 来源，只读参考 | `/Users/apple/code/.worktrees/ua-prompt-governance-release-0.3.1-fresh-20261103` | `300b63a67c49ad24cc201601c3846e99af51cf46` |

来源含既存未提交改动，HEAD 不能代表全部研究输入。旧报告 §17.1 已区分 SP 工具说明变化、UA 三份 assistant 文案 WIP 与非生产研究材料，后续不能漏掉，也不能把文案变化说成新执行逻辑。

### 2.2 纳入与排除

纳入模型能力与选择政策、Provider/模态适配、Prompt/Reminder/Skill、模型可调用工具、执行治理、文件和文档能力，以及这些能力依赖的最小 API、存储、资源和绑定。模型可用的 browser、文档渲染、Workspace 工具不因名称涉及 Web 就被排除。

不迁组件、样式、Web 产品功能、编辑器整体、Marketplace、无关 API 或运营功能。公共类型变更引起的必要编译适配另行逐点证明，不以“版本统一”为由升级整套 UI 依赖。

既有 Provider、Tool Search、审批、TemporaryAgent、Schedule、Memory、compaction/watchdog 等基础不应重复重建；要验收具体增量和目标回归。完整能力矩阵沿用旧报告 §14—16。

## 三、raw 契约的准确含义

### 3.1 以 .32 公开契约为事实源

已安装的公开 .32 包中，`TrajectoryRecord` 使用严格分支：执行记录有非空 `submissionId`、可省略或为 `execution` 的 `origin`；Context 记录则要求 `submissionId:null` 与 `origin:"context"` 成对。还有 SDK 定义的可选 `parent`、`ingestSeq` 和原生 conversation/entry。不能只删除 `projection.kind` 检查而忽略这些关系。[^r1]

Delivery 的 header 包括 identity、resource、recordType、nativeId、index、sha256、byteLength；binding 已没有旧 `exportPolicy`。需要撤掉 SAFE policy 接线，但继续验证 header 与实际字节的一致性。**index 一致性不是服务鉴权，也不能替代冻结的 parent/Submission 归属证明。**[^r1][^r3]

外层 `sp-pi-trajectory/v1`、单记录 reference 的格式名可以继续使用，但同名不代表与旧 SAFE 实现兼容。新记录应直接来自 .32 原生输出；不能在 EP 另造内核格式，不能给 raw 补伪 SAFE 标记，也不能把旧 SAFE 去字段后伪装成新记录。

### 3.2 移除和保留的边界

| 机制 | 计划 |
| --- | --- |
| Runtime SAFE export policy、原生记录 `projection`、SAFE 必需断言与主动投影 | 从新执行/交付链移除 |
| `projectTrajectoryForExport` 等公开函数的名称 | 看 .32 实际语义，不能因名字含 project 就机械删除 |
| 执行档位 `safe`、审批与无人值守政策 | 保留，和 SAFE 轨迹投影不是一回事 |
| 鉴权、owner/Chat/Submission、父子归属、hash、bytes、cursor、watermark、EOF | 保留并回归 |
| EP body-free Metrics、紧凑快照、Tool-call 哈希关联 | 保留，由 EP 自有模块适配 raw 输入 |
| 错误日志及外部观测的敏感字段治理 | 单独维持；迁 raw 不自动授权新增外部原始体日志 |
| 历史不可变证据和存量事实 | 不改写、不重标；读取能力按历史策略另验 |

raw 意味着原生工具参数、结果和其他原生值可以完整进入评估证据；不是采集任意 HTTP 认证信息或运行环境凭据。既有访问范围、保留策略及对外日志约束仍然存在。

### 3.3 新发现：同一个字符串可能不是同一种“省略”

EP scanner 自己用 `[CONTENT OMITTED]` 表示有限解释时未保留的内容；该路径目前限制解释字节数和块数。它与上游 SAFE 写入记录的 withholding marker 不同。证据传输路径仍按原始字节归档，有限解释只供 Metrics/reply 使用。[^r4]

raw 中模型可以真实输出同样的字符串。后续应以独立的截断/完整性事实区分“真实内容”和“本地未解释”，不能仅凭字面相等判为隐藏。也不能通过删除本地限额来解决碰撞，否则会丢失大记录内存保护。

Metrics 原来观测的是 SAFE 后的部分值，raw 下可能成为原始业务值；尤其输入/输出字节数的意义可能变化。建议评审新的 compact 事实版本/来源语义，保留旧事实的原义，不给旧数据回填 raw 标签。历史 compact 读取与新 raw wire 校验应分别处理。[^r5]

## 四、SP / EP 的具体迁移落点

### 4.1 公共模块和 SP 生产端

| 模块 | 后续修改方向 | 必须保留 |
| --- | --- | --- |
| SP `packages/agent-contracts/src/trajectory.ts` | 原生类型及 SAFE 断言适配 .32 | 目标 debug consumer 的现有分页职责；不照抄源的新调试产品 Interface |
| SP `packages/eval-harness/src/index.ts` | 复用 SDK 原生 Schema，去掉 SAFE refine，更新公开资源/页/reference 类型语义 | 多材料、Schema、partial/finalized、billing、已有 wire 路径 |
| SP `telemetry/severn-telemetry.ts` | binding/exportPolicy、raw 流接收和临时 Agent 转交适配 | 原生交付证明、重试和 durable ack |
| SP `telemetry/trajectory-store.ts` | header/index、存储索引事实、SQL 条件和白名单改为 raw | 目标流式 stage/chunks、identity 冲突、字节/hash、范围选择及大记录 reference |
| SP `telemetry/langfuse/native-projector.ts` 等消费者 | 核对 raw 输入与已删除 policy 的调用关系 | 独立的外部观测输出约束；不把新 raw 体顺带写入日志 |
| SP fixtures、worker tests、e2e 原生解析 | 使用真实 .32 公开出口生成 raw 样例 | 目标 Eval 和 OOM 的回归覆盖 |

目标 store 不是源 store 的旧副本，而是有更强的交付与评估保护。来源代码只用于对照，不整文件覆盖；尤其不能为了复用源的普通 parse 路径，把目标的大记录流式处理退回整条读入和复制。[^r3]

`agent-contracts/trajectory` 的工作区职责与 standalone `./agent-config` 发行产物也不同。后者目前只发布配置契约，不因 trajectory 变化就必须新增一次 Agent Config 发布。若未来公共 Schema 归并改变 Harness 声明依赖，必须验证 tarball 的 JS 和声明都能在独立消费方解析，不能泄漏私有 workspace import。[^r2][^r6]

### 4.2 EP 消费链，包含 SQL 而非只有 TypeScript

| 模块 | 已定位的 SAFE 假设 | 后续工作 |
| --- | --- | --- |
| `packages/eval-contracts/src/native-trajectory.ts` | `PiTrajectoryRecord.projection`、`isSafePiTrajectoryRecord`、entry/page guards | 新输入按 .32 语义验证；完整原生定义以公开契约为准 |
| `apps/eval-api/src/sp/native-record-stream.ts` | envelope 必需 projection、required paths、SAFE reducedRecord | 调整流式验证及有限解释，保留 hash/bytes/EOF 和内存上界 |
| `sp/harness-wire.ts`、`sp/harness.ts` | 二次 SAFE gate、finalReply、reference 字节入口 | 适配新公开 Harness，保留精确 Submission 的回复选择 |
| `sp/observation.ts`、`eval-management/trajectory.ts` | 管理侧 record 下载和逐页 SAFE guard | 同步 raw 校验及授权范围，不能只修后台 collector |
| `packages/eval-metrics/src/aggregation/*` | SAFE 入口、旧 marker、compact 中复制 projection | 生成 body-free raw 事实，明确版本和缺失/歧义语义 |
| `apps/eval-api/src/db/attempt-resources.ts` | SQL 对 `record.projection.kind='safe'` 的筛选、compact/Tool inventory 谓词 | 适配新事实与所需历史读取；保持事务、CAS 和权威账单源 |
| `packages/eval-runtime` 的资源/证据模块、公共 fixtures | native entry 验证及旧样例 | 跟随公开消费 Interface，保留进度 pin 和完整归档 |

EP 仍通过公开 Chat/Submission/Trajectory/Workspace 接缝接入 SP。原始资源记录在验证后转成 body-free compact facts，不能因为取消 SAFE 就改为把大原生体再存一份 PostgreSQL/R2 资源快照。完整原始轨迹留在证据 JSONL；两者用途不同。[^r4][^r5][^r7]

Evaluator 应把 raw 证据作为待分析内容，而非新的系统指令或受信任 Rule 事实；证据内容与资源元数据的防注入同属 Prompt 验收范围。

Action/Tool 实际费用仍来自 SP 权威 receipts，模型费用仍来自 usage/settlement，不从 raw Tool 参数、状态轮询、模型目录单价或时间差反推。`tck2_` 等关联键、唯一 Call/Result 对应、未知/歧义状态和合法零值要保留；原始 Tool Call ID 不应被顺带持久化到紧凑指标中。

## 五、Agent 能力切片，不能只做 raw

| 切片 | 迁移内容及验收重点 |
| --- | --- |
| 模型与 Provider | 新 catalog、计划/选择验证、旧模型兼容、image/file/video 模态、协议与请求映射；不把 catalog 单价当已结算费用 |
| Prompt | 分区治理、工具发现、资源元数据防注入、Workspace/输出指导；消除新旧说明矛盾 |
| Reminder | 原始输入、request preparing、native commit/facts、permanent/temporary、deadline/cutoff、取消和恢复；业务 Rule 留在 SP，不另建持久化 Rule 调度器 |
| 七条 SP Rule | 时间、原始来源、Action、execute 纠错、计划进度、低余额、位置；依赖真实可信事实，而不是静态伪提示 |
| Skill | 平台/内置内容、catalog、懒加载和激活；模型使用的 aesthetic-design 指令在范围内，Web 组件实现不在 |
| CodeMode / tools | `state` schema/discovery、候选准入、真实装配路由、权限、审批、deferred/幂等/状态；不恢复隐式 Shell 或 `tools.*` |
| Workspace / FileSurface | 显式注入 FileSurface，版本、CAS、搜索/分页、作用域；目录 cursor 和 cp/mv 真实语义另验 |
| Office/PDF/媒体 | SP GenOffice engine/renderer、WASM/字体及许可、图片/音视频、PDF text/visual、临时 Agent 的隔离 Sandbox 和清理 |
| Browser / Action / Super Link | 模型工具的公开契约、说明、账号授权、会话与资源生命周期；不夹带无关 Web 产品迁移 |
| 执行守护 | 准入、reservation/guard/release/wrap-up，与独立低余额提醒分开；保留 Schedule/Memory/compaction/临时 Agent/OOM 回归 |

Host 的核心参考是来源 `runtime/config/tools/universal.ts`、`resource-loader/host.ts` 和 `runtime/host/runtime-host.ts`，但保留目标 Eval binding、retained bootstrap 和软删除后已准入执行的语义。UA Worker 没有 SP 的 GenOffice engines，不能把 UA Host 整体覆盖到 SP。[^r8]

Space `.alpha.1`、Super Link SDK `0.1.2-alpha.1`、PDF/font/media 依赖是来源基线和候选输入，不是“全部直接安装”的指令；未来要按实际公开 Interface 和资源需要确定精确版本。固定 `.32` 也意味着：UA 三份未发布 assistant 文案不能靠修改安装包带入。按已确认的语义完整对齐口径审查现有公开扩展点；无法合法承载的必要指导应明确列为阻断，不能暗中忽略、改版本或绕过包职责。

### 5.1 两个源工具确实尚未进入 state 路由

来源 `materialize_url` 与 `deploy_workspace_preview` 都是 CodeMode-only，但没有 `codeModeNamespace:"state"`；.32 factory 仅为显式 state candidates 建立相应调用路由，且不安装旧 Shell/`tools.*`。候选源码存在不能计作能力已可用。[^r9]

可评审方向是直接暴露为原生工具，或经准入审查后 opt in state。两者会影响模型可见面及治理，不能机械补 namespace、降低审批或改风险档位来制造“可调用”。用户已确认保留 Agent 建站/预览/部署能力，因此不能以退役相关工具代替接线，也不能静默漏迁后宣布全部对齐。

### 5.2 Workspace 的具体差距及不能夸大的保证

`.32 state.ls` 的 cursor 是**目录变更检测，不是快照**；有 `readDirPage` 才有相应检测，没有时会走 offset/警告路径。计划不能把它描述为事务快照或 MVCC。应核实 SP/Space 的分页排序、cursor 范围、过期/变化拒绝及无静默遗漏。[^r10]

`state.cp/mv` 的模型说明承诺子树预检、既有目标目录的 basename 语义、单文件上限，以及 move 在复制验证后才开始移除源；同时明确允许部分失败，并非原子操作。Runtime 委托 `WorkspacePort` 执行，SP 的 `ChatWorkspacePort` 路由到 Space；目前尚未证明 Space `.alpha.1` 与 SP 的跨空间路径共同满足全部承诺。[^r10]

因此后续应先查已发布 Space 实现和行为测试，缺失的通用文件语义由相应 Runtime/Space 所属模块修复，SP 只承担其身份/空间路由适配。不能在 EP 复制文件系统，也不能在 SP 偷补一份上游内核。若必须改 Runtime 内核而 .32 没有扩展点，那就是与“精确锁 .32”的真实冲突，需回到版本/范围决策。

### 5.3 必要服务，不等于整个 API 产品迁移

后续重点核对 Profile/可选资源、配置 intended patch、平台 Skill 的实际内容、已结算余额与 guard admission/release/wrap-up，以及 Super Link/连接状态的最小接口。优先复用现有 Config/Resource/账务模块，只有证实需要的新持久事实才进入独立 schema/migration 任务。[^r11]

普通 Chat 也可能注册 `channel_connections`，因此“不迁 Web”与“返回真实 setup seam”存在交集。需要确定是否提供现有可用的账号操作入口或缩小该工具适用范围，不能返回空数据/假 URL 冒充完整能力。原有 Action API、Schedule Port、Memory 等可复用处不随源做产品级重构。

## 六、目标增强的不可退化验收基线

- 多 Material、Evaluator Schema、原始 Prompt 保真和规范初始 Session。
- 初始化幂等、证据/输入关闭屏障、stop 屏障、指定 Submission 恢复、软删除后已准入执行的保留读取。
- Subject 产物为主证据，完整 Chat 轨迹为支持证据；operation-scoped 资源不能误替代 full-Chat 证据。
- 大记录 reference/字节流、页字节预算、JSONL 按完整记录分片、固定 throughSeq、resume、EOF 与全部文件/manifest hash。
- partial opt-in、finalized/readiness、权威 model/Action/Tool 账单分页与最终指纹复查。
- 临时 Agent 的冻结 parent、子 Context 归属、完整交付及业务事件收尾证明。
- EP 资源下载预算、CAS/事务原子快照、取消时物理清理和 slot 生命周期、结果 MCP 接受后的恢复/分数同步。
- 目标 OOM durable executing key、风险前预置 strike、fencing 和 wake 后封停。来源较短的 `agents.patch` 不能整份覆盖；Pi 文件输入/参数兼容补丁也需逐项对照。[^r12]

## 七、建议实施顺序与未来分工

以下为已授权的实施分解；子任务的启动不代表任何阶段已完成，完成状态取决于实际产物和验证：

| 阶段 | 交付 | 依赖 / 出口 |
| --- | --- | --- |
| P0 契约冻结 | raw 公共语义、完整性基线、历史切换选择、预期测试接缝 | 不把未决历史策略藏在实现里 |
| P1 公共包 | SP 共享契约及 Harness 源码适配 .32；目标专项 fixture | 定义生产/消费双方唯一的公开事实源 |
| P2 SP raw | Runtime binding、交付、存储/索引、分页/reference 与临时 Agent | 保留目标增强，不覆盖旧字节 |
| P3 EP raw | wire/scanner/reply/evidence/管理下载、Metrics/SQL/compact 版本 | 可与 P2 并行设计和实现，不能用旧 .9 假验收 |
| H1 Host 行为 | 模型、Prompt、Reminder、Skill、最小配置/事实服务 | 与 P1 的公开 ABI 对齐 |
| H2 工具/文件 | CodeMode 路由、Workspace/FileSurface、文档/媒体/browser/Super Link | 真实上游语义和资源就绪，不用假桩充数 |
| P4 本地产物验证 | Harness pack、离线独立 consumer、声明与 exports/依赖检查 | 检验含 .32 的实际 tarball，不等于已发布 |
| P5 公开消费 | 经明确批准发布新 Harness，EP 精确 pin/lock 与独立安装 | 发行年龄/构建安全门槛未满足时停止并上报 |
| P6 综合验收 | 两仓聚焦/适用完整检查、独立 PG、部署后的真实闭环 | 部署及真实模型调用另行授权 |

P3 的代码准备不必等 npm 发布才开始，但正式依赖与独立消费验收必须等待真实公开产物。临时 tarball 可用于隔离的公共产物验证，不把 SP 私有源或仓库外 `file:` 变成业务依赖。

未来可分成：A 公共包与 SP trajectory，B EP wire/证据，C 模型/Prompt/Reminder/Skill，D 工具/FileSurface/资源，E EP Metrics/SQL，F 只读契约/回归审计。各自按具体文件划分；`runtime-host.ts`、`universal.ts`、`severn-agent.ts`、公共文档、环境入口、manifest/lockfile 等交叉点由集成人单独持有。C/D 不同时写中央 Host 文件，B/E 不同时改公共 native 类型。来源工作区不作为改写或重置对象。

## 八、历史与切换：已确认只保证新 Chat、新 Run

| 数据/状态 | 建议 | 尚需确认 |
| --- | --- | --- |
| 新 Chat + 新 Run | 作为本轮 .32/raw 闭环的验收范围 | 用户已确认；尚未实施或验收 |
| 已冻结旧证据 bytes/manifest/hash | 保持不变、保留既有归档访问范围 | 新应用各读取入口是否需要旧格式语义消费，不能承诺全兼容 |
| 已存 body-free compact facts | 可设计版本化存储读取，不引入 live SAFE 原生解码器 | 新旧指标语义及聚合的可比性，兼容测试 |
| 旧 Chat、未收集 Attempt、已 pin 的分页/JSONL 进度 | 不要求新栈续跑、恢复或补收；上线准备可评估在原栈先行收尾 | 切换时旧在飞工作的处置另定，不作为本轮历史兼容功能要求 |
| raw 期间新产生的数据 | 不能直接交还旧 SAFE 消费栈恢复 | 回滚须与数据代际一起设计 |

仅“新 Run”未必足够：若复用含旧 SAFE 行的 Chat，后续全 Chat 证据仍会遇到旧数据。必须同时核查 Chat、进行中的交付/outbox 和已保存的 evidence pin。

本计划不默认增加 SAFE/raw union，不通过 optional projection 放宽新公开入口，不清空表、删旧文件、重标旧 bundle、重置 Attempt 或改变已接受分数。需要历史恢复时单独界定范围和验收。

若完整权威 Pi 源仍在，未来也许可以研究独立 raw 再导出；但当前未证明原始数据完整，也没有已验证的“已 ack 历史记录重新导出”功能。它不是从 SAFE 字节恢复原值，更不能作为当前现成功能。

`EVIDENCE_SCHEMA_VERSION` 是否改变应由 manifest 结构/语义变化决定，不能因为新内容 hash 不同就机械升版本。现有格式名不区分两代内容，实际切换必须依赖版本锁定、来源/发布事实和明确准入，而不是猜测兼容。

## 九、发布与安装前置

1. **Runtime .32 已发布**：注册表时间为 `2026-11-10T08:44:02.017Z`；本轮不会重发或改包。
2. **新 Harness 必须按公共产物验证**：源码 → pack → 独立声明/运行 smoke → 获准发布 → EP 精确消费。检查实际 tarball 的 Runtime 依赖确为 .32，公开 partial/billing/Action receipt 和 canonical-context 能力不回退。当前 alpha.9 不是 raw 迁移完成的证明。[^r2][^r6]
3. **依赖年龄是门槛，不是本轮改造项**：SP 已有 Runtime 包名豁免；EP 目前只有 `.15` 精确例外。没有执行安装，不能断言具体环境必然失败；若新传递依赖被现有策略阻挡，应报告并按既有政策等待/处理，不通过扩大例外、改构建许可或绕过检查来完成迁移。[^r13]
4. **不全量拉最新 UI 包**：消费既有 .32、发布工作区 Harness，与再发布上游 Runtime/Space 是不同操作。若后者触发 SP 的批量 alpha 更新流程，先核对影响；全量脚本会触及 UI 且可能破坏精确 .32，执行前必须解决范围冲突，不能擅自跳过流程或夹带升级。[^r14]
5. **不要无依据统一所有 pin**：Agent、Harness、原生 Schema 执行消费方要对齐 .32；e2e 的真实 trajectory parser 也要适配。Web type-only 使用按实际编译结果评估，不能仅为整齐做产品迁移。
6. **部署已有独立流水线**：SP eval 的工作流按同一 source SHA 部署 API → Space Worker → Agent，不发布 Web/Creation Page；其 smoke 只有 API ready 和 Agent 根路径状态，不能当作真实 Eval Run 成功。EP 与 SP 仍是独立发布系统。[^r15]

## 十、未来验收矩阵

所有测试均为计划；本轮未编写或执行。实施前需确认测试接缝：SDK/公共 Harness、SP 服务 HTTP/WS、EP Harness/证据/生命周期、Metrics 公共输入输出、Runtime 最终工具面、Workspace/FileSurface 和必要业务接口。

| 接缝 | 核心案例 | 所需环境 |
| --- | --- | --- |
| SDK/公开包 | raw 生成与解析；执行/Context 分支；旧 projection 和非法原生字段拒绝；公开声明独立可消费 | 既有公开依赖、隔离离线 consumer |
| SP delivery/store | raw 参数/结果保真；header/index/hash/bytes/identity 冲突；失败不 ack；临时 parent/Context | workerd 与目标 DO tests |
| EP scanner/证据 | inline/ref、UTF-8/转义跨 chunk、超页大记录、截断/EOF/篡改/错 scope；完整 JSONL 与原字节 hash | 无外网测试 + SP fixture |
| 有限解释 | raw 字面 `[CONTENT OMITTED]` 不是本地截断；大 body 不全量驻留；未解释值不造零/完整性 | 无外网回归 |
| 分页/资源 | 冻结 watermark、resume、空尾页、billing 指纹、partial/finalized 变化、取消与 slot 清理 | mock HTTP + workerd，后续实际服务 |
| Eval 业务 | 多材料/Schema/原 Prompt、输入与 stop 屏障、指定 Submission、MCP 接受、漏分恢复/补收 | 两仓专项 tests，事务部分独立 PG |
| Metrics/SQL | body-free、新旧事实版本、Tool-call 哈希与唯一关联、真实 duration/零值/未知、费用权威源 | 单测 + 独立 PG |
| 模型/Prompt | catalog/旧选择、模态、真实 Provider 请求、资源防注入、Skill 与 Reminder 时序/取消 | payload fixture + workerd；真实接受需另验 |
| 工具/治理 | 最终装配可见且可调用；两个候选的实际路由；审批/无人值守/状态/幂等不放宽 | 装配测试 + workerd；必要的真实受控回合 |
| 文件/媒体 | CAS 冲突、分页变更检测、cp/mv 预检与部分失败/源保护、Office/PDF、资产/字体、临时 Sandbox 清理 | 包所属 tests、workerd/容器/相应绑定 |
| 守护/恢复 | Credit Guard 与低余额分离；Schedule/Memory/compaction；OOM pre-arm/fencing/wake 保护 | 专项故障与恢复测试 |
| 跨部署闭环 | 新 Chat/Run → 执行 → 完整 raw 证据 → 评估导入 → 结果/费用/stop/recovery | 明确获准的部署及真实模型 |

验证分层不能替代：类型检查通过不等于原生 Workerd 或 Provider 成功；没有 PostgreSQL 的测试跳过不能计为事务验证通过；CI ready smoke 不能计为模型闭环。保留既有超时和断言，资源争用通过串行/限制 workers 处理，而不是放松测试。

PG fixtures 可能清表/重置测试库，未来必须先核实隔离目标及操作许可，不能仅因设置了 `DATABASE_URL` 就运行。打包、安装、测试、发布、部署和真实模型回合均应单独记录结果，不把一个阶段的成功外推到下一阶段。

## 十一、进入实施前的待确认项与停止条件

**产品/范围已确认事项及后续执行门槛：**

已确认本轮只保证新 Chat/Run，旧结果及归档证据保留，不要求旧运行恢复、续跑或补收；Runtime 精确锁定已发布 .32；Agent 浏览、建站、预览和部署工具保留；Prompt/工具说明按必要指导语义完整对齐，不要求逐字一致；执行 Agent 与评估 Agent 两类都对齐，各自约束和授权不变。旧在飞工作在发布时如何收尾，仍属于上线准备而非历史兼容开发。固定 .32 下无法通过既有公开接口补齐的内核差异应单列为阻断，不能自行改包、仿造内核或改用后续版本。

1. 若后续技术核查证实连接 setup 确需新增产品入口，再就真实新增范围确认，不预先扩展 Web 产品。
2. 是否授权后续真正进入实现；新 Harness 发布、部署及真实模型调用仍有各自独立的审批点。

**技术实施前需收敛，但不要求用户逐个选择代码细节的事项：**

- Workspace 目录/cp/mv 的真实保证由现有 Space/Host 满足到哪一步，缺失应由哪个所属模块补齐。
- 公开包声明与 canonical-context 的 .32 兼容、compact 新事实版本及历史存储读取、有限解释的 typed omission 语义。
- 包安全门槛、资产/许可/引擎/绑定就绪、实际编译影响和必要最小 API。

任何必须的能力没有真实执行路径、缺少引擎、权限无法证明、包产物不能独立消费、固定 .32 与所需内核修复冲突，或旧数据切换没有获准处置方式，都应显式记录为未完成/阻断。不能用永久禁用、假桩或放宽校验来宣布能力对齐。

## 十二、关键源码索引

以下为本轮结论的 primary 依据；旧报告 §19 继续提供更完整的模型、Prompt、工具和资源索引。既有说明中 alpha.7/SAFE 的历史段落并不代表当前计划目标，后续实施时应在所属文档一起更新。

[^r1]: `/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/agent/node_modules/@springbrand/agent-runtime/src/trajectory/contract.ts:16-70`；`/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/agent/node_modules/@springbrand/agent-runtime/src/trajectory/ports.ts:55-110`。这是已安装公开 .32 包源码，不是要求导入私有路径。
[^r2]: `/Users/apple/code/.worktrees/sp-eval-20261110/packages/eval-harness/src/index.ts:439-495`；同包 `package.json:16-20`。另有本轮注册表只读查询：Harness alpha 标签为 .9、其依赖 Runtime .15，Runtime .32 的发布时间如第九节；未执行安装。
[^r3]: `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/src/telemetry/trajectory-store.ts:50-95`、`733-890`、`1029-1076`；`/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/src/telemetry/severn-telemetry.ts`；`/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/src/telemetry/langfuse/native-projector.ts`。
[^r4]: `/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/sp/native-record-stream.ts:52-107`、`234-350`、`662-707`；`/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/sp/harness-wire.ts:178-248`。
[^r5]: `/Users/apple/code/.worktrees/ep-main-20261110/packages/eval-metrics/src/aggregation/compact-resources.ts:10-60`；`/Users/apple/code/.worktrees/ep-main-20261110/packages/eval-metrics/src/aggregation/native-record-facts.ts:17-106`；`/Users/apple/code/.worktrees/ep-main-20261110/packages/eval-metrics/src/aggregation/resource-facts.ts:132-181`；`/Users/apple/code/.worktrees/ep-main-20261110/packages/eval-metrics/src/aggregation/resource-telemetry.ts:78-86`。
[^r6]: `/Users/apple/code/.worktrees/sp-eval-20261110/packages/eval-harness/scripts/pack-release.mjs`；`/Users/apple/code/.worktrees/sp-eval-20261110/packages/eval-harness/scripts/verify-release.mjs`；`/Users/apple/code/.worktrees/sp-eval-20261110/packages/agent-contracts/scripts/pack-release.mjs:47-72`。
[^r7]: `/Users/apple/code/.worktrees/ep-main-20261110/packages/eval-contracts/src/native-trajectory.ts:18-98`、`169-182`；`/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/db/attempt-resources.ts:250-352`；`/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/sp/observation.ts:126-229`；`/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/eval-management/trajectory.ts:33-119`。
[^r8]: `/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/agent/src/runtime/config/tools/universal.ts:91-258`；`/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/agent/src/runtime/config/resource-loader/host.ts:42-145`；`/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/agent/src/runtime/host/runtime-host.ts:253-316`。
[^r9]: `/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/agent/src/runtime/tools/platform-tools.ts:186-205`、`285-300`；`/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/agent/node_modules/@springbrand/agent-runtime/src/tools/codemode/adapter.ts:348-410`。
[^r10]: `/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/agent/node_modules/@springbrand/agent-runtime/src/tools/codemode/workspace-file-commands.ts:270-370`；`/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/agent/src/workspace/chat-port.ts:159-228`。
[^r11]: `/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/api/src/routes/internal/agent-config.routes.ts:39-123`；`/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/api/src/routes/internal/channel-internal.ts:84-90`；`/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/api/src/routes/internal/internal.index.ts:76-128`；`/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/agent/src/runtime/host/reminder-rules.ts:16-54`。
[^r12]: `/Users/apple/code/.worktrees/sp-eval-20261110/patches/agents.patch:73-215`、`229-265`；`/Users/apple/code/.worktrees/ep-main-20261110/docs/eval-sp-harness-protocol.md`；`/Users/apple/code/.worktrees/ep-main-20261110/docs/package-boundaries.md`；`/Users/apple/code/.worktrees/ep-main-20261110/docs/pi-native-eval-cutover.md`。
[^r13]: `/Users/apple/code/.worktrees/ep-main-20261110/pnpm-workspace.yaml:7-26`；`/Users/apple/code/.worktrees/sp-eval-20261110/pnpm-workspace.yaml:80-121`。
[^r14]: `/Users/apple/code/.worktrees/sp-eval-20261110/scripts/update-springbrand-packages.mjs:82-115`。
[^r15]: `/Users/apple/code/.worktrees/sp-eval-20261110/.github/workflows/deploy-eval.yml:1-71`。
