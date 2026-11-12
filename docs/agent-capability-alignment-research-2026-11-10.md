# SP1105 + UA1103fresh → 评估平台 Agent 能力对齐研究

研究日期：2026-11-10。本文是独立研究结论，不是实施计划、变更日志或发布确认。

本稿汇总六个主题子 Agent 和两个事实审计子 Agent 的研究，并补充主 Agent 的源码/hash/离线契约核查。第十三节起为 UA/SP 模型、Prompt、工具、机制、必要 API 的综合结论；前十二节详细记录 EP 公开边界、评估输入/证据/结果和恢复契约。范围排除 Web 应用、组件、样式和无关业务 API；模型可调用的 browser、文档样式编辑、Office visual read 和 Skill 内容不能按 UI 目录名称误排。

**本轮只新增本 Markdown；没有修改业务代码、manifest、配置或 AGENTS，没有安装、发布、部署、live 联调或付费模型调用。** 已执行源码/hash/引用校核、内存 AST 比较和实际安装包公开解析器的离线契约实验；没有运行完整测试套件。“已有测试”只说明测试源码和断言存在，不表示本轮运行通过。

## 综合结论与阅读导航

1. **迁移的是能力，不是分支。** 真正执行能力仍归 UA Runtime 和 SP Host；EP 只维护公开调用、材料、完整证据、结果和恢复。正文第十三至十七节是能力矩阵与边界，第十八节是验收。
2. **主要增量**是统一 Reminder 治理、受控 CodeMode state、FileSurface/Office/PDF/媒体、原生图片与模态、具体工具/Skill/Prompt/宿主接线。Provider、Tool Search、审批、Schedule、Memory、compaction 本体早已存在，不应重复重构。
3. **五个不能机械搬运的点**：alpha.32 不兼容 SAFE；源 Harness 不是目标契约超集；源 agents.patch 缺目标 OOM 强保护；新 state 工厂让未 opt-in 的 CodeMode-only Host 候选失去调用路由；UA 新文件命令所依赖的 Host 语义没有自动在 SP Space Port 等价实现。
4. **模型目录和配置准入也属于能力**：不能只升级 Runtime，遗漏新的模型键、图像/文件/视频模态、目录资格数据、retired-model 兼容和 intended patch；也不能以此绕过真实权限或结算。
5. **必要 API 要带，产品重构不必带。** Profile/资源目录/平台 Skill、可信余额及 Guard 服务链有实际依赖；Schedule/ChatDirectory/Memory 可保留目标真实 Port。普通 Chat 的渠道 setup 工具与“不迁 Web”的交集必须明确，不虚报已对齐。
6. **源 WIP 六个生产文件仍纳入**，但精确性质是说明文本/Prompt 去重，不是新增执行或 Schema。scratch、研究 proposal 和可 skip probe 不充当生产能力。

## 一、结论摘要

1. **能力执行面应对齐到 Eval SP，不应复制 Runtime 到 EP。** EP 的 `eval-runtime` 是评估编排器，实际 Agent 由独立部署的 SP 执行；EP Worker 通过服务认证的 HTTP/WebSocket 驱动普通 Eval Chat。升级模型、系统 Prompt、工具执行和 Runtime 机制，首先属于 SP/UA 的能力拥有者；只要公开契约保持，EP 不必理解或实现这些机制。注意：EP 锁文件已有 Runtime 的传递依赖，公共 Harness 也使用 Runtime 的公开 trajectory Schema；“不复制 Runtime”不是“依赖树绝不能出现 Runtime”。[E01][E02][E03][E04]
2. **源 SP 的 Runtime 新，不等于源 SP 的 Eval Harness 是目标的超集。** 源 SP `f99fb665…` 使用 Runtime `0.3.1-alpha.32`，但其 Harness 仍是单 Material、旧初始化回执、25 MB 文件限制和 combined resources；目标 SP `3696f184…` 已有多 Material、Evaluator Schema、95 MB 流式证据、Submission 固定读取、readiness/header/native/billing 分页和 partial 契约。整目录覆盖会倒退 EP 正在消费的边界。[S01][T01][T02][T03][S02]
3. **raw Pi 与 SAFE Pi 不是仅改版本号即可兼容的协议。** 源安装的 Runtime alpha.32 的严格 `pi-trajectory/v1` envelope 没有 `projection` 字段；目标 Harness 和 EP 均要求 `projection.kind:"safe"`。外层仍叫 `sp-pi-trajectory/v1`，record reference 也仍叫 `sp-pi-trajectory-record/v1`，不能据字符串相同推断兼容。源测试明确断言业务参数和测试 password 原样出现在资源与证据响应中。[S03][S04][T04][E05][E06]
4. **推荐保留 SAFE 公共语义，由 UA/SP 提供能力兼容版本；EP 不重写执行内核。** UA fresh 本身保留 SAFE，alpha.32 不是它的能力超集。删掉 EP 的 SAFE 检查、补造 `projection` 或降低既有控制均不属于本次迁移。raw-only 输出不是模型能力升级的前置条件。[E05][E06][E07][S03][T04]
5. **EP 特有能力不能以“排除无关 API”为由丢弃。** 初始化 Schema、原始 Subject 输入证据、完整 Chat 轨迹、Evaluator 独立 Workspace、结果 MCP、操作级费用分页、停止栅栏和恢复，都是评估正确性的必要依赖。相反，Web 编辑器升级、样式、Marketplace/推荐/分享等应用能力不构成本研究的迁移对象。[E08][E09][E10][E11][T05]
6. **Agent Config 的必要兼容是保留公共配置契约和 SP 的准入所有权，不是把模型目录复制到 EP。** EP 只从已发布的 `@springbrand/agent-contracts/agent-config` 使用默认值与 managed-MCP selector，并保留未知 setting 字段；源 SP 已没有这个独立入口/打包路径，直接替换目标 package 会破坏 EP 的公共依赖。Connector Toolkit 的 `kind:"connector_toolkit"` 不能被当成 managed MCP 重新分类。[E12][E13][T06][S05]
7. **Project branch、Run commit 是发布来源事实，不是按 Run 动态选择 Runtime 的路由器。** 目标 SP 的 `eval` 工作流以同一 `github.sha` 发布 API、Space、Agent；EP 新 Run 保存配置中的完整 commit，并在准入时校验 Project branch/active release。Worker 实际请求配置中的 Agent origin，不能仅凭已存 commit 宣称恢复时真的运行了旧源码。[E14][E15][T07][E03]

## 二、证据范围、基线和依赖矩阵

### 2.1 固定基线

| 对象 | 本地路径与固定 HEAD | 本轮核验范围 |
| --- | --- | --- |
| 源 SP（SP1105 mainport） | `/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105`；`f99fb6654f3cfd088f1e613d62d3c24b622c72bc` | `git rev-parse HEAD` 与源码；实际安装 Runtime 的 package/source；公开 Harness/Contracts/路由及测试 |
| 目标 SP eval | `/Users/apple/code/.worktrees/sp-eval-20261110`；`3696f184ac10a4916ce96c6caef5609ac82da697` | 固定源码、manifest、公开打包脚本、Eval 服务、测试与部署工作流；当前 checkout 为 detached HEAD |
| 目标 EP main | `/Users/apple/code/.worktrees/ep-main-20261110`；`e0b7e0417be3761f015a6bc815058eb1afb043bf` | 固定源码、manifest/lock、编排/Harness/结果/发布元数据与测试；当前 checkout 为 detached HEAD |
| 源 UA（UA1103fresh） | `/Users/apple/code/.worktrees/ua-prompt-governance-release-0.3.1-fresh-20261103`；`300b63a67c49ad24cc201601c3846e99af51cf46` | 已独立核验 HEAD、tracked dirty 和实际源码；manifest Runtime alpha.27；与 alpha.32 的精确比较见第十三节 |

源 SP 的 `git status --short` 还显示 `runtime/tools` 下 Action/Super Link 等六个 tracked 文件有既存改动，以及 `.scratch` 未跟踪研究文件。本文的核心公开边界文件不在该 dirty 集合；模型工具 dirty 内容不作为 `f99fb665…` 已提交事实。没有清理、覆盖或提交这些修改。对源码固定差异使用了 SP Git 对象间的 `git diff 3696f184… f99fb665… -- <明确路径>`。

分支名亦已复核：源 SP 是 `feat/prompt-governance-sp-main-port-20261105`，源 UA 是 `feat/prompt-governance-ua-release-0.3.1-20261103-fresh`；两个目标 worktree 均为上表固定 HEAD 的 detached checkout。

### 2.2 与本主题有关的依赖，而非全量迁移清单

| 依赖/能力 | 源 SP | 目标 SP eval | EP main 的消费事实 |
| --- | --- | --- | --- |
| Agent Runtime | Agent 与 agent-contracts 为 `0.3.1-alpha.32`；实际安装 package 亦为 alpha.32 | Agent alpha.15；agent-contracts alpha.9；eval-harness alpha.15 | API 无直接 Runtime 执行依赖；eval-harness alpha.9 传递依赖 Runtime alpha.15。锁文件也有 alpha.9，不能误称整个安装图只有一个 Runtime |
| Eval Harness | workspace `version:0.0.0, private:true`；依赖 workspace agent-contracts；旧服务面 | workspace `version:0.1.0-alpha.9, private:true`，有独立打包脚本 | API 精确 pin `@springbrand/eval-harness@0.1.0-alpha.9`，源码实际调用其公开 Schema/路径 builder |
| Agent Contracts | workspace `0.0.0`；没有 `./agent-config` export | workspace `0.0.0`；保留 `./agent-config`，独立产物仅暴露该入口 | API 精确 pin `0.1.0-alpha.0`；配置适配不应借机整体升级编辑器 |
| Space | `0.3.1-alpha.1` | `0.3.1-alpha.0` | EP 不直接驱动 SpaceDO；材料/证据经 SP Workspace 服务边界 |
| Super Link SDK | `0.1.2-alpha.1` | `0.1.0-alpha.4` | 运行与收费归 SP；EP 只消费权威费用事实，不能在 EP 调 SDK 另跑一次工具 |
| Pi / agents | Pi/chord/agent-core/ai/durable 为 `1.4.0`；`agents:0.30.0` | 对应版本相同 | 不据相同 Pi 版本推断 Host、trajectory export 或 Harness 兼容 |

矩阵证据：[S01][T01][E02][E04][T06]。两个目标 checkout 未安装 workspace 依赖，本轮不安装。另在原 EP 的 `.pnpm` 中找到真实 Runtime alpha.15，已与发布源码逐文件比较；这不表示新目标或线上正在运行该包。standalone Agent Config release 仅依赖 Zod，与 workspace 包自身依赖 alpha.9 是两件事。[T06]

## 三、EP 实际怎样调用执行 Agent 和评估 Agent

### 3.1 能力与评估编排的职责分界

```text
EP 固定 Project/Data/冻结 Agent Config 引用
  ├─ Execution → Subject Chat（SP）→ Submission → Workspace 产物 + 完整 Chat 轨迹
  │                                  └─ 操作级 native/usage/billing 资源事实
  └─ Evaluation → 独立 Evaluator Chat（SP）
          ├─ 自己的 Material + 输出 Schema
          ├─ 导入已冻结的 Subject evidence（manifest 最后）
          └─ submit_evaluation MCP → EP 接受/校验/保存

SP/UA：模型选择、模型请求、系统 Prompt、工具编译/执行、批准与无人值守、Runtime 机制
EP：样本/计划冻结、阶段编排、证据归档、结果接受、Metrics、幂等与恢复
```

这不是根据旧架构文档推测：EP Worker 的实际组合是 `createEvalRunResumer({plans, harness:createSpHarness(...), store, evidence, results})`；`eval-runtime` 的 dependencies 只有 eval-contracts、eval-dataset 和 Zod；Harness 端口公开 ensure/materialize/submit/wait/inspect/stop/restart/collect/export/import。不能把两边同名的 “runtime” 当成同一职责。[E01][E03]

**为什么不能把 Runtime 抄进 EP：**这会让 EP 另行承担 SP 已拥有的 Chat/Session、Workspace、操作幂等和 stop/delivery 状态，而 EP 现有 Run/Attempt 只负责记录远端工作及其证据。第二执行内核既不能替代 SP 的权威费用/凭据/资源准入，又会绕开唯一公开 seam，造成两份创建/停止/恢复事实。评估结果的校验与接受反过来也不应搬进 SP。这里的结论是职责与可信状态归属的推导，不是对复制实现作过 live 实验；保留公共 Harness/schema 依赖即可，不需要新 package 或私有 DO 访问。[E01][E03][E11][E16][T05][T08]

### 3.2 身份、Prompt 与初始化隔离

- **Subject**：先持久化 `subjectChatId`，剔除 `evalPrompt`、`evalInitialMaterials`，将 `data.userPrompt` 作为当前提交消息；它保留自己的 initial Session 与全部 Subject Materials。**Evaluator**：单独持久化 `chatId`，剔除 Subject prompt、Subject Materials 和 initial Session，将 `evalPrompt` 作为自己的 `userPrompt`，只带 `evalInitialMaterials`。这一隔离防止评估用提示/材料意外进入 Subject，以及 Subject 初始历史直接污染 Evaluator。[E08]
- ensure 发给 SP 的是 `chatId/role/framework/samplingId/projectId/{ownerUserId,userAgentId}/evaluationId?/runtime?`，不是 EP 重建的配置正文；收到的 Handle 必须与原身份完全一致。SP 的 bind 保存不可变创建事实；同 Chat 重复 ensure 是恢复，不允许静默重绑定。[E16][S06][T08]
- EP 具体 Harness 当前明确只运行 `framework:"sp"`；虽然上层类型包含 codex/cc，`requireSp()` 会在网络前拒绝其他框架。扩展这些框架不是本次模型/Prompt 对齐的顺带工作。[E17]
- 目标 `evalPromptSchema` 只拒绝纯空白并原样保留文本；源 `evalSubmitSchema.prompt` 使用 `.trim()`。系统 Prompt 的能力升级不能顺便改变数据集用户消息字节；原样 Prompt 是目标已测试的契约，不是 UI 样式细节。源初始化的 `data.userPrompt` 校验也使用 `.trim()`，不能当作行为等价实现。[T02][S02][T09]
- Evaluator 当前消息由 EP 拼入证据/Schema/结果说明，这是 EP 的业务 Prompt；SP 实际 `super.submitPrompt(input.prompt, {idempotencyKey})` 不负责生成评分规则。UA/SP 的系统 Prompt 改进不能覆盖 EP 的这些闭环说明。[E09][T05][S07]

### 3.3 稳定公开路由，而不是绑定 SP 内部 Inbox 实现

以下路径均相对 `C=/internal/v1/eval-harness/users/{ownerUserId}/chats/{chatId}`；属于有服务认证的公开集成契约，“internal” URL 前缀不等于可读取私有 DO。

| 公开面 | EP 的实际用途 | 需要保留的语义 |
| --- | --- | --- |
| `PUT C` | ensureAgent | 预分配 Chat、不可变 owner/Project/Sampling/role/Config 身份，重复返回同一 Handle |
| `POST C/initialization` | materializeInitialData | Session 导入 Chat，不造第二 Session store；按序多 Materials；Evaluator 专用输出 Schema；幂等回执 |
| `POST C/submissions` | submit/restart | `unattended:true`；同 key 原 Prompt；新 Attempt 才有新 key/Submission |
| `GET C/submissions/by-key/{key}` | 不确定提交校准 | 找回真实 Submission，不盲目再次投递 |
| `GET C/submissions/{submissionId}` | 已知 Submission 断线恢复 | 用已知 ID 校准；不是另一条新工作 |
| `WS C/submissions/{submissionId}/events` | 正常终态通知 | 状态观察，不暴露浏览器可写聊天 |
| `POST C/submissions/stop` | Run 停止 | 持久 stop latch，等待已接受输入，再中断工作 |
| `GET C/output?...` | Subject/Evaluator 输出 | 完整产物引用、轨迹引用；Evaluator 自己的原始结果文件 |
| `GET C/evidence/{artifacts,files,trajectory}` | 证据导出 | 终结 Submission 授权，完整 Chat 轨迹、冻结 watermark，非仅本次资源 |
| `GET C/evidence/trajectory/records/{ingestSeq}` | 大 record 字节 | 全部冻结引用参数、hash/length/identity/Chat 验证 |
| `PUT C/evidence/files?path=` | Evaluator evidence 导入 | 独立 Workspace、路径/hash/size 回执、manifest 最后、输入关闭后不可改 |
| `GET C/resources/by-key/{key}/{readiness,header,native-records,billing}` | Attempt 资源 | scope 固定、来源完整性、分页有界、明确 partial、独立费用权威 |

EP 调用证据：[E16][E17][E07][E18]；目标路由证据：[T03]。源 SP ensure 已经从 Inbox 接线迁至 API Chat directory + `provisionChat/listedSevernChat`，而目标服务经 Inbox transport 寻址。这个内部迁移本身不要求 EP 复制 Chat directory、导入私有 provision helper 或改 Subject/Evaluator 身份；应依赖表中的服务接口。[S06][T10]

## 四、源/目标公开契约的实质差异

### 4.1 Harness 比较：不能以源分支整体替换目标

| 契约 | 源 SP `f99fb665…` | 目标 SP `3696f184…` / EP 消费 | 研究判断 |
| --- | --- | --- | --- |
| 初始化 Materials | 单个 `{bundleId,materialId,files}` | 有序非空数组；逐项匹配 Data 引用、拒绝重复；回执 `materials[]` | 目标能力必须保留；EP 不能降成只上传第一个 Material |
| 初始化回执 | `{bundleId,manifestHash,target,rootPath}` | `{manifestHash,target,materials[],evaluationOutputSchemaPath?}` | EP 已用公开 result Schema 校验，源回执不兼容 |
| Evaluator Schema | 请求严格对象无 `evaluationOutputSchema` | Evaluator 必需，Subject 拒绝；固定 `/evaluation-output.schema.json` | 源会拒绝 EP 当前请求，不是可省略的无关 API |
| Prompt | submit `.trim().min(1)` | 只判非空白，原样保留 | 需保留目标数据语义 |
| canonical Session | 自定义基本 shape/role 校验，额外要求首条 user | Runtime 公开 `/canonical-context` 完整 native Schema，调用前校验 | 不能退回宽松 transcript parser；同时核对新 Runtime 公开 canonical 格式 |
| 证据准备 | 输入写入与提交没有目标的完整持久输入关闭契约 | 先初始化→文件→manifest→第一次 Submission；同输入队列串行；持久 inputsClosed | 模型执行前的评估可信输入保证必须保留 |
| 证据 ready gate | 最新 Submission 与全局 cleanup/terminal store fact | 指定 Submission terminal + 该 Submission/temporary Agents 的 delivery 证明 | 后续 Submission 不得错误阻塞已固定证据 |
| HTTP ready 错误 | 普通 EvalChatConflict 路径 | `409 EVIDENCE_NOT_READY` + Retry-After | EP 对机器码分类；不能只保留 HTTP 409 |
| 服务按 ID读 Submission | 源路由未提供 | 目标提供，EP 观察恢复实际调用 | 原 source 整块替换会让断线恢复失败 |
| 资源 | combined `/resources/by-key/{key}` | readiness + 小 header + native pages + paired API billing pages；有 partial 查询与截止点 | EP 明确不 fallback combined；源 HTTP 无这些后缀，不能作为当前消费者的 drop-in producer |
| 文件限制/传输 | 25,000,000；artifact/evidence write 先缓冲 bytes，部分经 RPC 值 | 95,000,000；流式读写，1 MB record chunks，4 MB JSON 页 | 不能只在 EP 提高/降低一个常量而忽略现有包和服务的协商一致性 |
| Action/Tool 费用 | 源只保留较旧资源 Schema/读法 | Header 区分 Action/Tool；Action 必有 actionId，model billing 不可冒充收费工具 | 费用口径与模型能力无关，但评估正确性不可退回 |

源码证据：源 `[S02][S07][S08][S09]`；目标 `[T02][T03][T05][T11][T12]`；EP `[E07][E18]`。这里“未提供”针对已读固定版本的完整 route match，不是对线上环境探测。

### 4.2 raw 与 SAFE：同一个 v1 字符串覆盖了不同信任语义

**已证事实：**

- 源实际安装 Runtime alpha.32 的 `TrajectoryRecord` 是 `{format,resource,parent?,record,ingestSeq?,submissionId,origin?}`；严格 Zod object 不接受旧 `projection`。本轮同时核对了 public export 实际指向的 `dist/trajectory/index.{js,d.ts}` 和 `contract.{js,d.ts}`，不是只看未被导出的包内源码。源 agent-contracts 的 native 验证调用该 `parseTrajectoryRecord()`，并要求外层拥有 ingestSeq。源 Harness 复用该 raw contract。[S03][S10]
- 目标 eval-harness 的 inline record 先经 Runtime public trajectory Schema，再额外要求 `record.projection?.kind === "safe"`。EP 的 browser-safe `PiTrajectoryRecord`、本地存储 guard、流式字节 scanner、final reply extractor 都继续要求 SAFE。大 record 通过 reference 绕过 inline 并不会绕过安全验证。[T04][E05][E06][E19]
- 源回归测试构造 Action input/result 和一个虚构 password，断言资源 JSON、evidence page 都包含这些完整值；这是“raw 如实外发”的正向测试，不是残留文档措辞。不能把 raw 称为“内容更全但与目标安全属性相同”。[S04]
- 两边外层 page/record-reference 格式常量相同，native record 格式也相同，但原始字节、hash、envelope 和允许内容不同。[S10][T04][E05]

**因此：**

1. 保留 alpha.9 只改 SP runtime 依赖并不足以解决 raw 差异；目标 Harness 内部 SAFE refine 和 EP scanner 都会拒绝 raw。
2. 改 EP public package 版本仍不足以解决本地存储 guard、Metrics compact input 和历史 evidence manifest/hash；所有这些属于一次公共格式/信任边界切换。
3. 给 raw 增添伪 SAFE 元数据会谎报来源策略，并改变原 bytes/hash；从 SAFE 删除字段来伪装 raw 同样不是原始证据。不能在 EP 偷做兼容转换。
4. 保留 SAFE 的兼容由 SP/UA 所有者提供；fresh 已有 policy、safe-value、带策略 exporter 和配套链路，具备真实源码基础。alpha.32 没有一个可随手开启的旧 export flag。
5. 接收 raw 是额外证据/隐私策略变更，不属于本次能力对齐授权。服务 token、同 Chat scope、hash 证明授权/完整性，不证明无秘密，不能据此放宽现有控制。

上述 1–3 是兼容结论，4–5 是推荐边界，尚未实现兼容发布。公开解析器的离线实验见第十三节。raw 完整轨迹也**不等于**捕获全部 Provider HTTP 请求/响应；不能把 Pi native 记录扩张为未证实的全模型 I/O。[S03][S04]

## 五、材料、完整证据与 Workspace 的不可退化契约

### 5.1 材料和 Session

EP 按 Project 冻结的 Material 引用解析文件，而不是读 Subject 可能编辑过的工作副本。Subject 初始化用自己的 Session/Materials；Evaluator 不导入初始 Session，先写自己的 Materials/Schema，再导入 Subject evidence。目标 SP 在初始化时强制 role/Schema/Session 约束，且 canonical history 经 Runtime 公共入口校验。**材料并非 UI 上传便利功能，而是模型能力复现的输入基础。**[E08][E18][T05][T11]

目标公开限制为每文件 5,000,000 bytes、初始化总计 20,000,000 bytes、每 Material 最多 500 文件；总计包含输出 Schema，Materials 与 Data 引用按序精确匹配，拒绝重复 Material/路径。EP 从公开包导入这些规则，不应再维护一套反向迁移的本地数值/Schema。[T02][E18]

### 5.2 证据完整性：Chat-wide 与 operation-scoped 必须分开

| 数据 | 正确范围 | 不能替换为 |
| --- | --- | --- |
| Subject evidence trajectory | 同 Chat 冻结 `throughSeq` 内的完整 native keyset，包括导入 Context、此前 Submissions、可信临时 Agent 记录 | 仅最后一次 Attempt，或前端截断的消息/调试页 |
| Attempt resource native/usage/billing | 当前 `chatId + idempotencyKey + submissionId` 与可证明父链的子工作；不混入导入历史和共享 evidence | 整个 Chat 的累计资源或根据消息估算的费用 |
| Evaluator final reply | 精确选中 Submission 自己最后一条合格 assistant；不取 Context、旧 Submission 或 child | “最后看到的一段文本” |
| Subject inputs | 原始不可变 Material bundles | 运行后 Workspace 的同名修改文件 |

EP 的实际 `trajectoryPages()` 明确不按当前 Submission 过滤 evidence，并先验证整页的 Chat/parent、顺序和冻结 cursor；resource collector 用相反的 operation scope + verified parent chain。测试也专门验证 Context/旧 Submission 保留在 evidence 而不进入资源快照。[E07][E18][E20]

Artifacts 始终是主证据，完整 trajectory 是必须收集的辅助证据，不能用更多调试事件替代缺失产物。现有 artifact 预算允许明确的 `excluded/too-large/limit` omission，但每一项必须进入 manifest；这不等于“全部文件实际归档”。完整 native trajectory 不能沿用这种静默省略策略：不完整 source、缺 terminal page、记录过大均拒绝 finalize。Evaluation 只消费已冻结 bundle，不依赖 Subject 继续运行或直接访问它的 Workspace，多个 Evaluator 因而能读取同一份 manifest/blob。[E01][E26][E27]

### 5.3 内容寻址、超大记录与导入屏障

- 完整页必须读至终结 `nextAfterSeq:null`；空首尾页也要固定 watermark。每个参考 record 的 exact UTF-8 JSON 必须验证全长、SHA-256、identity、ingestSeq、throughSeq、Chat/parent/SAFE 后，作为**单条** `{ingestSeq,record}` JSONL 写入；不能把 reference 占位符当作已收集完整轨迹。[E07][E06][E20]
- EP 新 evidence 是 schemaVersion 2 + `sp-pi-trajectory/v1`，按内容寻址、按记录边界分片；重试沿已存 cutoff/进度读取缺失内容。单 record 大于可导入单文件上限时显式失败，不截断、丢弃或跨行伪造。v1 历史包字节/引用不应重写，更不能把旧事件改名为 native。[E26][E21][E07]
- 当前 EP `spEvidenceLimits()` 取本地 evidence limit 与公开 SP 文件 limit 的较小值；导入前先检查所有计划文件，逐个核对 receipt，**manifest 最后**。即使文件并发上传，manifest 的出现才表示列表中的文件已就绪。[E17][E22]
- Workspace 固定分区：`/initial-materials/{bundleId}/{materialId}`（两个 ID 经公开 path builder 编码）、`/evidence/subject-inputs/...`、`/evidence/artifacts/...`、`/evidence/trajectory/events-000001.jsonl`、`/evidence/manifest.json`、`/evaluation-output.schema.json`、`/output/result.json`。原始输入/Schema/evidence 都不是 Subject produced artifacts。目标 SP 禁止首次 Submission 后继续导入，stop 也关闭输入。[T02][T05][T12][E22][E26]

## 六、结果提交、停止和恢复：不是 Runtime 移植的替代品

### 6.1 结果 MCP 与结果文件

EP 自己拥有 `/mcp/evaluation-results` 的 `submit_evaluation`：MCP Bearer 之外，还要求每个 evaluationId 对应的 HMAC submitToken；结果必须通过同一个 Metrics Schema validator。SP 只负责让配置中的 MCP 工具可被模型调用，不拥有 EP 的评分业务库。[E10][E23]

配置了 MCP 时，**只有已接受的 MCP 结果是权威**；结果文件或最终回复不能替代。未配置 MCP 时才按结果文件→最终回复解析的路径读取。EP Prompt 明确要求直接调用该工具，不经 codemode/执行工具绕行。[E09]

接受事务与 stop/replacement 共用 Project 锁：Subject 必须成功，Project 未删除，Evaluation 当前可用且有 Chat，仍属于未 stopped Run；相同结果可重放，不同结果冲突。接受、succeeded、revision 与资源恢复标记/既有队列唤醒一起保存。之后观察 socket 丢失或资源采集失败不能把已接受结果改成 Agent 失败。[E11]

Evaluator completed 却未交结果时，EP 使用已有 restart 预算创建同 Chat 的下一 Attempt，发送固定补交通知；不重新执行 Subject，不重复初始化或导入 evidence。这个机制不是 UA 的通用 auto-continue，不能被通用模型机制替掉。[E08][E09]

### 6.2 停止与恢复

- 正常终态通过 WebSocket；已知 Submission 的断线恢复按 ID 校准并有限重连；提交响应未知按原 key 查询，不能盲目新建 Chat 或重复工作。EP `restartAgent` 仍调用相同 submit service，只是生命周期生成新的 Attempt/key。[E16][E17][E24]
- SP target stop 先持久 latch，等待同一输入队列，再 `stopAllSubmissions`；`inputsClosed` 还禁止首次 Submission 后继续改证据。源 stop 虽有持久 latch，但只等 pending submissions，没有目标完整的输入串行屏障。不能因“源已支持 stop”就声称完全等价。[T05][T08][S07]
- evidence 收尾失败不代表 Agent 未完成：EP 保存原 Attempt 终态，只恢复证据/资源/持久化工作；结果采集或证据导出不能触发已完成 Subject 重跑。Attempt 资源读会保留失败/中断/取消和历次重启的事实。[E24][E21]
- `finalized` 不是 Submission terminal 的别名：目标还证明 native/business delivery、temporary Agent delivery 和 Action/Tool 费用完整性。等待超时后 partial 必须显式 opt-in，每页绑定 cutoff；来源变化或中途失败不能保存成“部分成功”。未完成账单不能补零。[T12][E18]

**结论：**即使模型层的恢复/提醒/工具能力升级成功，也不能据此宣称 EP 的 stop、结果提交和断点恢复闭环已经验收；这些跨服务持久化契约需要独立证明。

## 七、Agent Config 公共 Schema 的必要兼容

### 7.1 已经相同、无需在 EP 重造的部分

源/目标基本 setting 都含 `presetId/model/thinking/systemPrompt/toolPolicy/subagentNames/executionLevel/memoryDefaults/sandbox/skillIds/mcpServers/actionIds/referenceFileIds/connectorIds/extensionIds`，并已有 authoring、preferredSupplierIds、referenceNotes。模型名/系统 Prompt 是数据值而不是 EP 内置执行逻辑；两边 managed-MCP/Toolkit selector 的核心判别也相同。[S05][T13]

EP 冻结复制提交 `setting:source.setting`，普通读取用 loose structural guard，改 purpose 时通过对象展开保留 setting/未知字段。它只从 public canonical schema 读取四个 saved defaults，用于当前配置的幂等比较，**没有对所有历史 setting 应用完整 SP admission parse**。因此不能为了“对齐 Schema”把 EP 改成丢弃新字段的强制归一化器。[E12][E13]

### 7.2 真正需要保持的公共出口

- 目标 `./agent-config` re-export 原 schema/selectors，独立 release artifact 仅带这个 browser-safe 入口与 Zod；source package exports 已无此入口、source `agent.ts` 也没有目标同名 canonical normalizer。把源 package.json 或整个 agent-contracts 目录覆盖过去会破坏 EP API 的真实 import。[T06][S05][E12]
- `kind:"connector_toolkit"` 是 Toolkit，不进 managed MCP catalog purpose reconciliation。源/目标 selector 均用 `"kind" in selection` 区分；EP purpose 改写特意保留带 kind 的项。评估结果 MCP 只在 managed selections 中增删。[T13][E13]
- SP 仍拥有模型/plan 权限、资源资格、连接凭据与 Runtime 解析。若升级引入新的公开 setting 字段或默认值，应由 SP 拥有的公共 contract 明确定义与发布，EP 只做必要消费者兼容；不能从 SP 私有 Schema 文件跨仓 import，也不能以同 ID 代替语义一致。[E12][E01]

**建议：**保留目标已有 standalone contract 及其 release 验证能力，能力字段按拥有者演进；没有证据要求本主题同步 Web editor、UI、Marketplace 或完整 model catalog。源 model catalog 确有变化，但详细模型/权限矩阵应以其他同伴的原始源码研究补全，本文不替代。

## 八、部署 branch/commit：已有机制与未证明的部分

**已证：**

1. 目标 SP `.github/workflows/deploy-eval.yml` 是 `eval` 分支部署指针，只发布 API→Space→Agent，不发布 SP Web/Creation Page，三者都收到同一 `github.sha`；独立的 eval secrets/target/origins 在 workflow 中明确列出。[T07]
2. EP `Project.sourceBranch` 与 `Run.sourceCommit` 分开保存；`requireSourceCommit` 要求完整小写 40/64 位 hash；admission 把 release commit 写入 Run，SQL 准入核对 Project branch/current release commit；Sampling 没有 branch 切换职责。[E14][E15]
3. EP API 从 `EVAL_SP_SOURCE_BRANCH/EVAL_SP_SOURCE_COMMIT` 构造 release，部署渲染器要求它们存在；Run Worker 从 `EVAL_SP_AGENT_ORIGIN` 构造单一 Harness，没有按 `Run.sourceCommit` 生成动态服务地址。[E15][E03]

**未核实风险：**

- 工作流定义、环境声明和本地 HEAD 不证明实际部署到了这些 commit；本轮没有查询部署、健康接口、数据库或 Cloudflare 状态。
- Run 中保存旧 commit 是 provenance，并不自动保证后续恢复请求仍指向那个版本。持续升级同一 Agent origin、旧 DO 状态/trajectory checkpoints 与新 Runtime 的兼容，都还需要发布层的明确保证；不能用保存 hash 代替运行环境冻结。
- 对齐结果的来源必须是最终整合到目标 Eval 分支的实际 commit，不应把源 SP/UA 原始 HEAD、npm Runtime 包版本或当前工作树 dirty 内容直接当作 deployed commit。公开 standalone package 的发布版本与 SP 部署 SHA 也需分别记录。
- EP 当前发布工作流是 EP API/Web 的 CI/部署；其通过不等于上游 Eval SP 已完成发布。文档中的“一次发布目标架构”不能当作本轮已经执行的事实。[E25][T07]

## 九、哪些调整必需，哪些无需改变

这里的“必需”指要维持现有可观察契约的约束，不是文件修改步骤或实施排期。

| 归属 | 必须保持/有条件需要兼容 | 不需要、也不应迁入 |
| --- | --- | --- |
| SP/UA 执行面 | 模型与工具机制在拥有者升级；保留 Eval 无人值守、资源/证据观察、Workspace 读写公共 seam | EP 的 Dataset/Project/评分事实不迁入 SP；不为评估另造 Runtime |
| SP 公共 Harness | 保留目标多材料、Schema、输入栅栏、固定 Submission、分页费用与完整轨迹；明确 raw/SAFE 输出决策 | 源旧 Harness 不能整块覆盖；不回退 combined 大 JSON、不丢 temporary Agent 工作 |
| EP Harness adapter | 公共 wire 变化时同步消费；维持 scope/hash/byte/cursor/EOF/SAFE 校验；实质公共变化必须整体核对本地证据/资源输入链 | 不实现 Provider、tool compiler、Prompt hook、Runtime 调度/存储；不访问 DO SQLite/R2 私有布局 |
| EP 配置边界 | 保留 public `./agent-config`、未知字段、冻结快照与 Toolkit 分类；新增公开字段才做必要兼容 | 不复制 model catalog/模型准入；不把所有历史配置强制套新 admission；不升级 Web editor |
| EP 评估语义 | MCP 接受结果、材料/证据屏障、Artifacts 主证据、完整轨迹辅助、独立 execution/evaluation/pipeline | 不将结果提交变成 generic Runtime tool 的内置评分；不让最终回复取代已配置 MCP |
| 发布与 provenance | Project branch、Run 实际 deployed commit 与独立 Eval origins 真实一致 | 不按 Sampling 切分支、不把 dev/production 状态搬入 EP、不宣称本地 HEAD 就是线上 |

因此，**在目标公开语义保持不变的前提下，EP 的 Dataset、Execution/Evaluation 公共实体、Run admission、result MCP 协议、Metrics 归属和 DB 模型没有因模型/Prompt升级而天然必改的证据。** 这不等于承诺零修改：raw 输出、canonical context、公开 setting 的实质变化可要求局部消费者协调；必须由具体 contract 差异驱动，而不是为了版本号整齐升级全部应用。[E01][E08][E09][E14]

明确排除：组件样式和主题、Web 交互/工作台、共享编辑器版本升级、推荐/Marketplace/分享/普通首页、与模型运行无关的 API 产品变化、旧 evidence 或业务数据回填、直接 SP 存储操作、安装/发布/部署动作。鉴权、运行配置公开 seam、必要模型访问控制、Workspace/材料、native evidence 与权威收费接口虽位于 API/Host，不能因“API”标签就排除。

## 十、已有验证覆盖与当前缺口

以下均为**测试源码覆盖意图/断言**，不是本轮执行报告。

| 范围 | 已找到的 primary 测试 | 本轮结论 |
| --- | --- | --- |
| Prompt 原样与初始化 | 目标 `/Users/apple/code/.worktrees/sp-eval-20261110/packages/eval-harness/src/index.test.ts:96-122,194-261,285-338`；`apps/agent/src/eval/http.worker.test.ts:120,301,389,440` | 字节保留、多 Material/Schema、native Session 不能倒退 |
| 输入屏障、stop、独立 Workspace | 同目标 `apps/agent/src/eval/http.worker.test.ts:183,214,253,614` | 覆盖已接受上传与首 Submit/stop 排序、DO 重启后 admission 关闭、证据只导入 Evaluator |
| Submission/证据 ready | 同目标 `http.worker.test.ts:992,1152,1233` | 按指定 Submission、临时 Agent delivery、partial cutoff/finalized 分离已有测试 |
| 大原生证据 | 同目标 `http.worker.test.ts:1387,1669,1743`；EP `/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/sp/evidence.test.ts:99,175,216,268,329,409,420,516` | 5+ MiB/30+ MiB/41 MiB、完整字节验证、watermark 恢复与错误拒绝有覆盖，源的 25 MB 限制不可被忽略 |
| alpha.9 公开 wire | EP `apps/eval-api/src/sp/resource-pages.test.ts:136,159,190,211,243,378,466,508,579` | 测试公开 schema/builders、actionId、partial、禁止 model 伪 Action、禁止 combined fallback；不能据此证明部署服务同版 |
| WebSocket/停止 | EP `apps/eval-api/src/sp/harness.test.ts:148,163,416,433,445,505,1071,1090` | 服务认证、短 stop timeout、只校准同 Submission、断线恢复已有局部覆盖 |
| raw 外发差异 | 源 `/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/agent/src/eval/resources-stream.worker.test.ts:262-295` | 正向断言业务 input/result、虚构 password 未过滤；直接证实不能当 SAFE |
| Agent Config standalone release | 目标 `/Users/apple/code/.worktrees/sp-eval-20261110/packages/agent-contracts/scripts/pack-release.mjs:47-72` 与 package `test:release` | 这是 browser-safe 契约的独立发布边界；本轮未执行 pack/verify/install |

**仍缺乏的证明：**

- 新 Runtime/Host 整合后目标服务仍通过现有 Eval 契约测试，尤其输入队列、stop、temporary actor、native delivery 与完整 Context 捕获。
- 新 Runtime 与目标 Eval Harness alpha.9 / SAFE 栈的完整整合兼容；虽然 fresh 已有 SAFE 源码基础，没有一个“改 pin 后就能跑”的已验证结论。
- 当前固定整合版本的真实 SP→EP 服务认证、MCP/工具 discovery、材料/Schema→运行→完整证据→结果接受→资源结算→stop/recovery 闭环。
- 当前 PostgreSQL 的结果接受/CAS/分页资源事务与跨部署 wire 同步；旧 README 的孤立 PostgreSQL 回归叙述不能替代当前运行证据。
- 真实部署 commit、Runtime package provenance、独立 Eval API/Space/Agent 绑定一致，以及旧 Run 恢复的实际运行版本。
- 任意独立的未来证据安全语义变更及其权限/保留策略，不属于本轮授权；本次保留 SAFE，原 evidence 内容寻址与历史记录不暗中重写。

本轮未运行 `pnpm check`、Vitest、PostgreSQL、pack/install、浏览器或 live 冒烟；没有为研究安装依赖或启动服务。内存离线解析器实验不等于这些完整验收。仓库验证及串行重跑规则仍有效，没有放松断言或 timeout。

## 十一、证据索引（绝对路径与固定版本）

本节的 `[E…]`、`[T…]`、`[S…]` 是上文引用的源码定位，不是二手研究。除特意标为“安装包”的 S03 外，分别绑定 §2 的 EP、目标 SP、源 SP 固定 HEAD；行号按本轮读取工作树，核心文件不在既存 dirty 集合。

### EP

- **[E01]** `/Users/apple/code/.worktrees/ep-main-20261110/AGENTS.md:5-17`；`/Users/apple/code/.worktrees/ep-main-20261110/packages/eval-runtime/package.json:18-22`；`/Users/apple/code/.worktrees/ep-main-20261110/packages/eval-runtime/src/harness/model.ts:222-245`：独立性与 Harness 端口。
- **[E02]** `/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/package.json:17-38`：公开包精确 pin，无直接 Agent Runtime 执行依赖。
- **[E03]** `/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/run-worker-process.ts:40-67`；`/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/config/worker.ts:22-29`：Worker 真实组合与固定 origin。
- **[E04]** `/Users/apple/code/.worktrees/ep-main-20261110/pnpm-lock.yaml:2946-2964,9632-9636,9737-9739`：公开 Contracts/Harness 与 Runtime 传递依赖；不把锁文件误作安装确认。
- **[E05]** `/Users/apple/code/.worktrees/ep-main-20261110/packages/eval-contracts/src/native-trajectory.ts:8-29,64-97,154-179`：本地 SAFE storage/byte guard 与 parent/scope。
- **[E06]** `/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/sp/native-record-stream.ts:76-104,187-189,580-607`：byte scanner 严格 envelope 与 SAFE 核验。
- **[E07]** `/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/sp/harness.ts:335-455,647-674,894-921`：完整 Chat evidence、reference 传输、final reply 与原 JSONL。
- **[E08]** `/Users/apple/code/.worktrees/ep-main-20261110/packages/eval-runtime/src/runtime/execution.ts:255-274,308-314`；`/Users/apple/code/.worktrees/ep-main-20261110/packages/eval-runtime/src/runtime/evaluation.ts:184-252,305-327`：两角色数据隔离、持久身份、初始化→证据→提交与补交 Prompt。
- **[E09]** `/Users/apple/code/.worktrees/ep-main-20261110/packages/eval-runtime/src/runtime/results.ts:17-45,63-94`：结果 port、直接 MCP 指令、MCP 优先且无文件 fallback。
- **[E10]** `/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/evaluation-results/submission.ts:7-40`；`/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/evaluation-results/mcp.ts:39-72,93-111`：每 Evaluation token、同一 Schema validator、MCP Bearer。
- **[E11]** `/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/db/evaluation-submissions.ts:38-91`；`/Users/apple/code/.worktrees/ep-main-20261110/packages/eval-runtime/src/runtime/evaluation.ts:82-114,362-380`：Project lock、stop/replacement、幂等结果、revision 与资源队列原子接受；异步观察/旧 Attempt 写入不得覆盖已接受结果。
- **[E12]** `/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/agent-configs.ts:3,30,54-60,248-257`；`/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/sp/client.ts:45-49,98-102,181-192`：public Schema 默认值、冻结配置与宽松读取。
- **[E13]** `/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/agent-purpose.ts:1-16`；`/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/agent-configs.ts:204-245`：managed MCP purpose 与 Toolkit 保留。
- **[E14]** `/Users/apple/code/.worktrees/ep-main-20261110/packages/eval-contracts/src/model.ts:114-128,281-292`；`/Users/apple/code/.worktrees/ep-main-20261110/packages/eval-runtime/src/runtime/admission.ts:58-62,176-184`：Project branch / Run commit。
- **[E15]** `/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/db/runtime.ts:237-240`；`/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/config/api.ts:27-28,63-66`；`/Users/apple/code/.worktrees/ep-main-20261110/infra/aws/deploy/render-secrets.py:12-19`：active release 约束与部署元数据输入。
- **[E16]** `/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/sp/harness-wire.ts:16-39,58-119`；`/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/sp/harness.ts:498-517,543-627`：公开请求/回执 Schema、by-key/by-ID、stop 与 WebSocket。
- **[E17]** `/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/sp/harness.ts:109-112,150-153,553-645`：文件限制、SP-only、材料与提交。
- **[E18]** `/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/sp/harness.ts:566-591,676-855,858-876`：初始化、bounded resources、指纹/partial、原始 Subject materials。
- **[E19]** `/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/sp/harness-wire.ts:212-248`：SAFE 且精确 Submission 的 final reply 选择。
- **[E20]** `/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/sp/evidence.test.ts:99,175,216,268,329,409,420,572,606`；`/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/sp/resource-pages.test.ts:466-556`：大 record、完整范围、parent、冻结 cursor 的回归断言。
- **[E21]** `/Users/apple/code/.worktrees/ep-main-20261110/packages/eval-runtime/src/runtime/execution.ts:99-103,167,227-250,333-371`；`/Users/apple/code/.worktrees/ep-main-20261110/packages/eval-runtime/src/harness/model.ts:120-177,200-219`：证据 pin/progress 与不重跑的收尾路径。
- **[E22]** `/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/sp/harness.ts:924-998`：验证 manifest、所有文件预算、流式 hash/receipt、manifest 最后。
- **[E23]** `/Users/apple/code/.worktrees/ep-main-20261110/apps/eval-api/src/evaluation-results/mcp.ts:25-31,39-72`：模型可见工具参数和结果接受边界。
- **[E24]** `/Users/apple/code/.worktrees/ep-main-20261110/packages/eval-runtime/src/runtime/agent-lifecycle.ts:245-366,371-404,567-589,637-648`；`/Users/apple/code/.worktrees/ep-main-20261110/packages/eval-runtime/src/runtime/stop.ts:102-168,301-403`：Attempt、先保存终态、资源收尾、提交校准、停止。
- **[E25]** `/Users/apple/code/.worktrees/ep-main-20261110/.github/workflows/ci.yml:198-210,280-307`：EP 发布门禁/任务；`/Users/apple/code/.worktrees/ep-main-20261110/docs/eval-sp-deployment.md:3-23` 只作目标架构说明，不作已部署证明。
- **[E26]** `/Users/apple/code/.worktrees/ep-main-20261110/packages/eval-contracts/src/evidence.ts:4-25,43-69`；`/Users/apple/code/.worktrees/ep-main-20261110/packages/eval-contracts/src/evaluation-results-mcp.ts:1-2`：新 evidence v2、历史 v1 不可变、Subject inputs、显式 omission、固定 Workspace/工具路径。
- **[E27]** `/Users/apple/code/.worktrees/ep-main-20261110/packages/eval-runtime/src/harness/evidence.ts:60-80,139-150,187-196,352-455`：artifact omission、native 完整性门禁、必须收到终结页、按完整记录分片。

### 目标 SP eval

- **[T01]** `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/package.json:24-43`；`/Users/apple/code/.worktrees/sp-eval-20261110/packages/agent-contracts/package.json:6-40`；`/Users/apple/code/.worktrees/sp-eval-20261110/packages/eval-harness/package.json:1-19`：依赖与版本。
- **[T02]** `/Users/apple/code/.worktrees/sp-eval-20261110/packages/eval-harness/src/index.ts:19-49,66-145,346-367`：Prompt、Materials、Schema、初始化回执与路径 builder。
- **[T03]** `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/src/eval/routes.ts:5-63,78-85`：完整 route match，Submission pin 与所有资源后缀。
- **[T04]** `/Users/apple/code/.worktrees/sp-eval-20261110/packages/eval-harness/src/index.ts:406-409,447-495,572-605`：SAFE record、reference/JSONL 预算与 page。
- **[T05]** `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/src/chat/severn-agent.ts:439-481,517-579,908`：角色/Schema/Session、Context delivery binding、输入队列、manifest、stop 与指定 Submission ready gate。
- **[T06]** `/Users/apple/code/.worktrees/sp-eval-20261110/packages/agent-contracts/src/agent-config.ts:1-36`；`/Users/apple/code/.worktrees/sp-eval-20261110/packages/agent-contracts/scripts/pack-release.mjs:47-72`：公共 standalone 契约与仅 Zod 的 release metadata。
- **[T07]** `/Users/apple/code/.worktrees/sp-eval-20261110/.github/workflows/deploy-eval.yml:3-7,18-55,64-71`：eval branch、同 commit、独立发布目标与 smoke 的有限覆盖。
- **[T08]** `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/src/eval/chat-state.ts:28-39,64-98,117-145`：不可变绑定、初始化回执、resource cutoff、stop/input closure。
- **[T09]** `/Users/apple/code/.worktrees/sp-eval-20261110/packages/eval-harness/src/index.test.ts:96-122`：Prompt 原样正/负断言。
- **[T10]** `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/src/eval/http.ts:77-110,119-160`：拒绝 browser Origin、service token、Inbox transport、service routes。
- **[T11]** `/Users/apple/code/.worktrees/sp-eval-20261110/packages/eval-harness/src/canonical-context.ts:1-23`：Runtime public canonical Schema 与 Eval carrier 限制。
- **[T12]** `/Users/apple/code/.worktrees/sp-eval-20261110/packages/eval-harness/src/index.ts:524-548,679-708,740-845,886-909`；`/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/src/eval/evidence.ts:12-25`；`/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/src/eval/http-errors.ts:11-32`：费用/partial/路径/非产物输入/ready code。
- **[T13]** `/Users/apple/code/.worktrees/sp-eval-20261110/packages/agent-contracts/src/agent.ts:105-133,194-203`；`/Users/apple/code/.worktrees/sp-eval-20261110/packages/agent-contracts/src/mcp.ts:17-47`：setting/canonical defaults、managed-MCP vs Toolkit。

### 源 SP mainport / 实际安装 Runtime

- **[S01]** `/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/agent/package.json:25-43`；`/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/packages/agent-contracts/package.json:6-42`；`/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/packages/eval-harness/package.json:1-17`。
- **[S02]** `/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/packages/eval-harness/src/index.ts:18-76,188-222,288-310`：单 Material、trim、旧 context parser、25 MB。
- **[S03]** **安装包** `/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/agent/node_modules/@springbrand/agent-runtime/package.json:1-4,19-27`；`/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/agent/node_modules/@springbrand/agent-runtime/dist/trajectory/index.js:1-10`；`/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/agent/node_modules/@springbrand/agent-runtime/dist/trajectory/contract.js:10-43`；`/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/agent/node_modules/@springbrand/agent-runtime/dist/trajectory/contract.d.ts:17-25`；`/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/agent/node_modules/@springbrand/agent-runtime/src/trajectory/contract.ts:14-65`：实际 alpha.32 的 public export、声明与实现一致，strict raw envelope 没有 projection。
- **[S04]** `/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/agent/src/eval/resources-stream.worker.test.ts:262-295`：raw 参数/结果/测试 password 原样外发断言。
- **[S05]** `/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/packages/agent-contracts/package.json:6-29`；`/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/packages/agent-contracts/src/agent.ts:136-168,208-213`；同包 `/src/mcp.ts:17-47`：无 standalone agent-config export、setting 主体与 Toolkit 判别。
- **[S06]** `/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/agent/src/eval/chats.ts:19-86`；`/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/agent/src/eval/chat-state.ts:30-41`：API directory 寻址/ensure 与不可变 binding。
- **[S07]** `/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/agent/src/chat/severn-agent.ts:487-538,584-652,688-744`：旧初始化回执、submit、stop、latest Submission gate、旧文件/RPC路径。
- **[S08]** `/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/agent/src/eval/http.ts:27-44,62-85,87-164`：源完整 service route 分支、buffered file、缺少分页/按 ID查询。
- **[S09]** `/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/packages/eval-harness/src/index.ts:99-165,325-336`；`/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/agent/src/eval/evidence.ts:10-23`：旧资源/路径契约与产物排除范围。
- **[S10]** `/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/packages/agent-contracts/src/trajectory.ts:1-37,101-118,154-158,229-238`：相同外层格式名、25 MB 参考上限、raw parser 与 native identity。

## 十二、研究边界说明

已先读取 EP AGENTS、包边界、research/read-only 技能/命令和相关包 README，源/目标 SP AGENTS、规则索引及适用的接口/错误/跨包规则；源 agent-contracts 当前不存在 README，未为此创建文件或安装任何东西。先用指定 `code_search` 探索，再以精确源码、固定 commit 差异和测试断言追踪；旧研究文档仅作导航，没有替代当前结论。

本轮以本地源码、固定 Git 对象、实际安装包、测试断言和内存契约实验为证；唯一仓库写入是本研究文件。没有读取密钥文件或访问线上账户。

以下跨主题研究不会消除两个公共阻断点：**raw/SAFE 不兼容，以及源 Harness 不包含目标已有 Eval 契约。**

## 十三、真实基线与版本谱系：已完成的实证校正

### 13.1 alpha.15 不再用 alpha.17 或 Host import 代理

原 EP 已安装包根目录为：

`/Users/apple/code/eval-platform/node_modules/.pnpm/@springbrand+agent-runtime@0.3.1-alpha.15_@ai-sdk+provider@4.0.34_@aws-sdk+credential-p_c281752c0be3b0958ca2c38a3cb1ea86/node_modules/@springbrand/agent-runtime`

它的 **194 个 production src 文件**与 UA 发布提交 `0b709ace497f66e800699c60a7f5c8effc8f753c` 逐文件 SHA-256 比较，**差异为零**。排除 tests、probe、缓存后的路径/hash 清单指纹为 `6d041244613881ff96795caa6a17d20f085aa88ce2db9bcb0f099701bf9d1fe5`。因此以下“已有/新增”以真实 .15 对比 fresh，而非拿 Host 无 import 推测内核能力缺失。这不证明新目标已安装、tarball 全字节相同或实际部署状态。

### 13.2 fresh 与已安装 alpha.32 的精确差异

fresh 当前 tracked production src **248 文件**，alpha.32 **246 文件**，不同路径仅 **20 个**，不是整个 Runtime 不同。路径为：

```text
config/assembler.ts
harness/trajectory.ts
session/trajectory-delivery.ts
telemetry/contract.ts
tools/assistant/{ask-user,followups,plan}.ts
tools/runtime/compiler.ts
trajectory/{bookkeeping,contract,errors,export,identity,index,
  observation-delivery,observation-projection,policy,ports,safe-value,stream}.ts
```

其中 `policy.ts/safe-value.ts` 为 fresh 独有；三个 assistant 文件 **HEAD 与 alpha.32 相同，当前 WIP 不同**。其余 production 文件匹配。fresh 清单指纹 `98914eb9f028d9abc573ef3994c475ad574e8b846f36a672fe2e56c761bc354a`；alpha.32 为 `39db352f2ebf713376c072bf1b96b480c3c9462c6be9bd521d41f4703fe51205`。这是读取快照，不是 release/deployment 证明。

实际动态导入两个安装包的 public `./trajectory` export，使用 EP `fixtures/pi-native-public-v1.json` 的原生 SAFE fixture，Node assertions 确认：**.15 接受 SAFE；.32 拒绝同一记录；移除 projection 后 .32 接受 envelope shape；两者 format 仍相同。** 无网络/模型/数据库调用。移除标记仅为结构实验，绝非允许的证据转换方法。

### 13.3 目标已经具备，不应包装成新增的能力

| 能力 | .15 → fresh 的确证 | 迁移判断 |
| --- | --- | --- |
| 七种 Provider protocol | openai-chat、OpenRouter messages/chat/responses、Anthropic、Google、Codex 已有，集合相同 | 不重建 Provider 框架 |
| model-client 传输/路由/structured output helper | `packages/model-client/src` 对发布基准无 diff；只变 manifest/CHANGELOG | 不能因 0.1.0→0.1.1-alpha.0 宣称获得全新协议 |
| model metadata / thinkingLevelMap | 现有校验、构造与复制逻辑未变 | 已具备；SP catalog 的模态变化另算 |
| strict、参数正常化与外部 Schema opt-out | assistant strict-preferred、Messages beta、外部 `constrainedSampling:false` 已有；Pi patch 的 JSON composite/optional empty 处理也已在 target | 迁具体工具修正，保留已有正常化和执行前校验，不新增一套全局严格模式 |
| Provider Tool Search | Messages/Responses 的 search/defer payload、冲突校验早已存在 | 新增的是 native search facts、web_search deferral、保留候选 deferral 的修正 |
| structured output | 三种 OpenRouter output 映射已有 | 增量是与 request supplements / transforms 的正确组合，不是新 output 协议 |
| compaction | 已启用；阈值/最近 token 公式未改 | 回归已有能力；不能称 fresh 才能压缩 |
| stall watchdog / recovery budget | 240,000 ms、分类和有界恢复预算已有且未改 | 不作为新增功能 |
| TemporaryAgent 本体 | coordinator/runner/core/approvals 逐字节未变，四槽 FIFO/取消/权限已有 | 只迁 Workspace/PDF/结果能力增量，不重造协调器 |
| 持久审批/interaction | repository、first-decision-wins、暂停恢复、effect gate 模块未变 | 保留目标持久审批，不混同临时 Agent pending Map |
| Schedule / Memory 本体 | schedule 核心、set_context、cold-memory/context assembly 等无 diff | 保留目标 DO/Inbox Port；工具说明等具体增量另迁 |
| prerequisite / unattended | 合同、持久前置交互、fresh recheck、无人值守拒绝机制已有，关键模块无 diff | 新增的是 SP Super Link 接线/门控，不是新 Runtime 审批架构 |

精确源码索引见第十九节 [U10]；这些判断使用固定 Git 对象和完整模块 diff，不是行数相同推断。

## 十四、真正需要对齐的模型、Prompt、工具和机制

### 14.1 必须纳入的能力矩阵

| 能力 | 源增量 / 目标缺口 | 最小拥有者与必要配套 |
| --- | --- | --- |
| SP 系统 Prompt | 旧大段内联→行为/检索/Workspace/Output 分区、资源不可信 JSON、用户自定义说明降权 | SP `runtime-settings.ts`；与 Skill/Reminder/工具说明成组适配，不能新旧简单叠加。[H01] |
| Reminder 统一规则机制 | 新增 binding/factory/fingerprint、事件消费中心、native facts、permanent/temporary 挂载 | UA Runtime + SP Host factories；不是七段文本拼 system。[U02][H02] |
| 七条 SP rules | UTC、original-user-source、Action usage、execute 纠错、plan-progress、low-credit、location | 全部纳入模型行为账；按真实来源/余额/位置条件注入，不能因“业务”悄悄删除。[H02] |
| Skill 资源 | selected Skills 已有；新增 Host 六项 built-ins、平台 scope 绑定和装配 | 保留 catalog/懒加载/activate_skill/transform；aesthetic-design 文本属于模型能力，不迁 UI 实现。[H03] |
| Tool Surface 政策 | 源 immediate 更少，更多 deferred；渠道/定时/配置工具门控变化 | 最终 snapshot、原生 ToolRegistration、Provider payload 三处对账，不以工厂文件存在代替注册。[H04] |
| assistant 工具 | ask_user 已提交的扁平契约、fileRequest、normalizer；plan/followup 行为与 WIP 说明 | UA `tools/assistant`；WIP 仅文本，不冒称新执行逻辑。[U05] |
| CodeMode 受控 state | 替换旧 Shell/`tools.*`，不是单调增加方法 | state registry/discovery/eligibility + Host candidates 逐项迁移；退役调用不能继续诱导模型。[U06] |
| FileSurface | 文本/Office/PDF read/search/edit、原生 options/operations、分页/locator、版本 fence/CAS | UA 通用机制 + SP 格式引擎 + Space 原子能力；不能普通 write 冒充 CAS。[U07][H05] |
| Workspace Host 语义 | UA 新增统一 mutation queue、稳定 ls cursor、完整树 cp/mv 预检/验证、scope/R2 版本保护 | 不能只搬 Runtime 的命令说明；SP ChatWorkspacePort/Space 的实际行为有未对齐项，详见 14.5。[U12][H16] |
| Office 文档/visual | 目标无 GenOffice；源提供四格式引擎、浏览器页渲染、字体资产 | DOCX/XLSX/PPTX/PDF 的编辑/样式/创建/可视读取属于 Agent；worker bundle/WASM/manifest/font/license 必须配套，不迁 Web renderer UI。[H06] |
| 图片/音视频 | CF Images + Host ffmpeg mediaReader、图片/帧/字幕、预算/引擎门控 | IMAGES、字体、媒体 module、真实 image-capability；缺能力返回 unavailable，不伪报支持。[U08] |
| 模型输入/输出图像 | SP catalog 模态、长图切片、Pi file-part patch；原生图片结果上限 1→6 MiB | catalog/附件入口/provider 投影/patch/预算链成组迁；不截图片或改成文本 spill。[H07][U09] |
| PDF 页文本 | 新增 read_pdf_pages、read 的受信 PDF 分支、preparePdfText | 专用 Host-only Sandbox/poppler/部署 gate，与 FileSurface PDF 编辑分开验证。[U08] |
| Action 四工具 | 英文 literal search、limit 8→20、当前 Turn schema、execution 状态读取、capabilityId | Tool 行为/WIP 说明纳入；底层 discovery/execution API 已相同，复用目标收费 receipt，不搬 Marketplace。[H09] |
| Super Link 五工具 | scope reconcile、父 Session 共享、host-owned auth、prerequisite/headless、非幂等状态读取 | SDK .1.2-alpha.1、Host binding、Runtime 既有 gate、最小 connector contract；外部服务协议需验，不伪造 ready。[H10] |
| 模型 browser 工具 | 旧 screenshot/console→统一 browser observe/navigate/act/read/screenshot/pdf/upload 等 | BROWSER/flag/primary/来源门控；与 Runtime browser_execute 和 Office renderer 分开。[H11] |
| Agent 配置工具 | get_agent_config/list_agent_resources/propose_agent_config | Profile/资源目录/patch validation；Eval binding lock 不注册 proposal，不带编辑器卡片或绕过客户端确认。[H12] |
| 余额/执行 Guard/收尾 | low-credit、预留/阈值/停止、terminal release、专门 wrap-up 模型调用 | 影响模型执行/输出，不能整块排除；可信账本事实与 API 链详见下一节，不带账务 UI。[H13] |
| 渠道模型能力 | 来源提示/Skill/发送/历史/发布、无交互策略；普通 Chat 另有 channel_connections | 模型可见部分按真实条件保留；接入管理网页不迁。普通 Chat setup 的 UI 耦合是明确未决项，不能假成功。[A06] |
| 目标可靠性/证据 | source 缺 target OOM 强保护，Harness 还较旧 | 保留 target OOM、SAFE、临时 Agent 证明、多 Material/Schema/stop/input/finalized/分页；不整块覆盖。[H14] |

模型还有两个较小但真实的增量：web_search 辅助模型改为 `deepseek/deepseek-v4.1-flash-1017`；请求 payload composition 保证调用者 transforms、structured output、路由、request-only supplements 正确组合。这些归模型选择/请求语义，不要误称新协议或新 watchdog。[U10]

### 14.2 Reminder 的真实语义，避免第二套持久化系统

新增的是统一规则中心，不是首次能 beforeRequest：.15 已有原生 hooks。

- admission 生产 `host.original-user`；真实 native commit 生产 `pi.entry.committed`；请求生产 `pi.request.preparing`，包含真实 attempt/cutoff/ingress/toolSearch facts。
- 受信规则 pin metadata/fingerprint；accepted event 先持久化再消费，同 fingerprint 串行 lane、不同 consumer 可并行；包含 null 的完成结果先提交再 ready。
- collect 负责冻结/选择/等待，不是到 collect 才派发事件；共享 deadline 最多 60 秒，late result 不跨 cutoff 进入以后请求。
- permanent 原始输入后缀/ContextEdit 与 temporary provider-only supplement 分离；临时 XML 不进入 canonical history。
- **不保存 Consumer class state，不做 Rule cursor/lease/recovery replay。** native private Docs 保存事件/完成结果/诊断；awake center 释放 scope 不等于 dispose；休眠后 class 从构造器开始。不能移植成每条 rule 一套持久 Map 或新恢复调度器。[U02]
- SP execute 纠错必须连 `observeExecuteUsage` 事件生产、consumer、mount 一起迁；CodeMode 外层 `{code:string}` 通过不代表字符串内 `state.read` 参数合法。已有内部校验与原始失败反馈不能丢。

七条业务规则全部是能力范围，但事实可能不存在：位置只接受可信 `request.cf`，服务/定时入口用 null；低余额接受真实较新 account version；不能为使规则“跑起来”造位置、补零余额或重计 UI 文本。

### 14.3 固定 Tool 名字与新 state 的精确边界

Runtime 固定工具工厂仍包括：

| 组 | 名字 / 变化 |
| --- | --- |
| assistant/memory | ask_user、suggest_followups、update_plan、set_context；ask_user 的 responseType 题型改为 question/options/multiSelect/required + 顶层 fileRequest |
| 检索/时间/扩展 | web_search、web_fetch、get_time、list_extensions；按宿主/策略条件装配 |
| 执行 | execute、browser_execute；不要与 SP Host 的 browser 混称 |
| Workspace | read/write/edit/list/find/grep/delete、restore_workspace_revision；新增 read_pdf_pages |
| Sandbox | sandbox_exec/start_process/process_logs/stop_process/publish_files（均带 sandbox_ 前缀） |
| Schedule | schedule/list_schedules/update_schedule/pause_schedule/resume_schedule/cancel_schedule；可选 list_user_agents/change_schedule_agent |
| subagent | fanout/extract/dispatch_background；不是新增一个名为 temporary_agent 的 Tool。SP 两侧均禁 fanout/dispatch_background |
| Skill | fresh 仅注册 activate_skill；旧 read_skill_resource/run_skill_script/materialize_skill_resource 不再作为原生工具或 state 方法暴露 |

上述是工厂集合，**不是任意一个 Chat 最终全部可用**；动态 MCP/Connector/Extension 名字不可能由此静态穷尽。

fresh `state` 实际注册：

- 基本 discovery：`state.schema`。
- Workspace read/write：`state.ls`、`state.tar`；read 模式 tar 只允许 list。
- Workspace write：再加 `cp/mv/rm/mkdir`。
- 有 FileSurface：再加 `read/search`；可编辑 write 模式再加 `edit`。
- 额外候选必须显式 `codeModeNamespace:"state"` 且通过 eligibility；要求 safe，不能嵌套绕过 approval/confirmation/interaction/prerequisite/unattended 等治理。
- 旧完整 Shell `readFile/readFileBytes/readFilePage/readJson/...`、旧 `tools.foo` 均不自动注册；没有自动 `state.list`，也不把所有工具简单换前缀。旧 .15 的 writeFileBytes 也早已被 adapter 隐藏。[U06]

**已证注册缺口：**source SP `platform-tools.ts` 的 `materialize_url` 和 `deploy_workspace_preview` 仍是 `exposureMode:"codemode"` 且没有 namespace；fresh assembler 不把它们当 Direct，factory 又只安装显式 state candidates。故确定的静态注册链不会给它们可调用路由。source 安装 .32 同样有这一 factory 行为。**不能把这两项列为已接通的源能力；后续须确认有意退出还是遗漏迁移，并用最终 snapshot/调用验收补齐，不能绕过 eligibility。** target 的旧 inspect_workspace_file 也须与 FileSurface 替换语义对账。[U11]

### 14.4 SP 模型目录、旧配置兼容与 SDK patch

**Runtime 的 metadata 机制已有，不代表 SP 目录数据没变。** 两固定提交都恰有 11 个 preset ID，source 并非新增 11 个模型；具体变化如下：

| preset / 项目 | target → source |
| --- | --- |
| deepseek-flash-balanced | providerModel 改为 `deepseek/deepseek-v4.1-flash-1017`；text→text+image；runtime cost metadata 更新 |
| gpt-6-astra / gpt-6-sol / gpt-6-luna | 去掉 debugOnly；text→text+image+file |
| kimi-k3 | 去掉 debugOnly；text→text+image+video；cost metadata 更新 |
| glm-5-3-flashx / glm-5-3-flash | 去掉 debugOnly；text→text+image+video；后者 cost metadata 更新 |
| glm-5-3-prime | 去掉 debugOnly；仍为 text，不能伪称具备视频 |
| qwen3-8-max-prime | 去掉 debugOnly；text→text+image+video |
| claude-opus-max | requiredPlan 从 pro 改为 free；不是所有 target 模型原来都仅支持 text |
| gemini-flash-fast | cacheRead cost metadata 更新；原有输入模态不是本轮新增 |
| ModelAccessPlan | `free/plus/pro` 增加 `max`，需要 owning shared schema / 准入事实兼容 |
| retired providerModel | 旧 DeepSeek model key 映射回原 preset 以识别历史配置；Runtime/白名单仍采用目录当前 providerModel |

这些是模型选择、资格和请求输入的相关变更，不能被归为无关 Web/API；但迁移应在 SP owning contract/Model 演进，**不能在 EP 或 adapter 跳过权限检查，也不把 requiredPlan=free 误称模型调用免费**。真实权益政策和账单仍归权威服务，runtime cost metadata 不替代费用 receipt。若后续涉及实际权益政策调整，应明确确认该行为，而不是顺带搬订阅产品。[H07][A03]

SDK patch 有两个必须分开的事实：

- `patches/@earendil-works__pi-ai@1.4.0.patch` 在 source 比 target **新增 22 行**：Responses 将 URL file parts 映射为 image_url 或 input_file.file_url。已有 JSON 编码 object/array 正常化、可选空值处理、`Value.Convert` 前校验准备是两侧共享的旧 patch，必须保留，不能冒称 fresh 首次增加。
- `patches/agents.patch` 的 source/target 差异**只有删除 target 237 行 OOM 增强**。它不是上述参数正常化的文件；应保留 target pre-arm/durable executing key/同 execution fencing/seal-on-wake 和回归测试，不能整文件替换。[H07][H14]

### 14.5 UA Worker Host 的十二个生产路径：不能只审 Runtime

发布基准至 fresh 的 `worker/src` 共变更 **20 个路径：12 个生产、8 个测试**，不是只有 UI 改动。这些 Host 能力也属于两源合并后的对齐范围：

| UA Host 增量 | 对 SP 的落点/边界 |
| --- | --- |
| Inbox 上同一 Shell Workspace 的 FileSurface 版本/CAS、R2 指针失效、临时角色 scope、Session/Agent 归属复核 | 语义必须保持；SP 已有 Space 原生 contentVersion/CAS，不能把 UA 针对 `cf_workspace_default` 的私有 SQL/trigger 直接复制到 SP 或 EP，不能另造第二文件存储 |
| readFileStream、readDirPage、统一 mutation queue、durable cursor、失败写入也使目录 revision 失效 | 必须在真实 Port 验证，不能把可选接口没实现等同于拥有相同能力 |
| cp/mv 的 100 MiB 预检、完整子树分页、dest/basename 语义、冲突/重叠/符号链接防护、验证完复制再删源、精确部分失败提示 | 属模型可见命令与数据完整性；应在拥有文件操作的包/现有 Host 边界适配和测试，不在 EP 写复制算法 |
| 独立 Host PDF parser 身份、primary/temporary/subagent 接线、admission/cleanup | SP source 已有 `destroyChatSandbox` 同时销毁 shell/PDF，以及 subagent PDF reader，不能漏掉清理和真实临时角色边界 |

**新增确认的行为差距，不只是理论测试建议：**

- UA `workspace-file-commands.ts` 的 state.cp/mv 说明明确承诺“所有后代先预检、目标已有目录时使用 dest/basename、移动先验证复制再移除源”。
- SP source `ChatWorkspacePort.cp` 对同空间直接调用 Space cp；mv 直接调用 Space mv。已安装 Space alpha.1 原始实现先 `rm(to)`，然后复制行或更新路径；没有实现上述统一预检/目标目录语义。跨空间 copy 也不是先完成整个子树预检再写。
- source `ChatWorkspacePort` 没有 `readDirPage` 方法，Runtime facade 也仅在底层已有该方法时转发，不会合成它；Runtime 可以降级 offset-only + warning，但**不能把这种降级当作已具备 UA Host 稳定目录 cursor**。
- 因而即使 Runtime/Space 版本升级成功，这组 Host 行为也**不能直接判为对齐**；存在同路径/重叠树/目标覆盖等数据完整性风险，需先做隔离回归复现再修 owning package/Port。本轮没有运行实际复制、移动或删除，不声称观察过真实数据损失。[U12][H16]

此外，UA fresh 自己的 Worker Host 明确 **不加载 GenOffice document engines**，Office/PDF 在该装配下仅可按文件名搜索；SP source 才提供四格式引擎/visual renderer。**不能用 UA Host 整体覆盖 SP Host，否则反而退化 Office 能力。** 应组合 UA 通用机制/隔离保障和 SP 已有的文档引擎，而不是假设一个来源是另一个的超集。

UA Shell Host 的 FileSurface publish 上限为 8 MiB，是该宿主的真实约束，不应机械当成 SP 的统一上限。Runtime 文件/结果、各宿主发布、Space 与 Eval evidence 的限制分别验收；不能把不同层的数值混为一个“支持最大文件大小”。

## 十五、必要 API 与可保留的目标 Port：精确边界

### 15.1 需要补齐的最小服务契约

| 接口/事实 | 目标情况 | 必要 owner、数据/部署含义 |
| --- | --- | --- |
| 平台 Skill 按 scope 读取 | 缺；source 失败会空集降级，Chat 正常不代表 Skill 已对齐 | `platform-skill` contract/model + 独立受服务认证保护的读取 route；需要真实平台绑定表/数据及 R2 内容，不搬整个 channel router。源 DDL 混在 0065，不照搬整份迁移。[A01] |
| Agent Config Profile | 缺；source 读取失败会让整组 chat-authoring 工具消失 | agent-contracts Profile + owner-scoped Model/route；现有 revision/default/deleted 可复用，通常无新表，不用简化 DO binding 冒充。[A02] |
| selectable-resources | 缺；Eval 即使不允许 proposal，仍可 get/list | Supplier/独立 Action/Skill/Toolkit/Reference 五类真实授权目录；通常复用已有表；独立 Action 要 `api_supplier_id IS NULL`，Toolkit 不重分类。[A02] |
| revision + intended settingPatch | HTTP 部分已有，语义不全同 | Host 只发预期 patch；Model 保留合法旧模型选择/effort，无关编辑不强制写回 effective fallback，新选模型仍按 plan 准入；目标 retained-bootstrap 公共 seam 保留。[A03] |
| settlement accountAfter | 已有 version/availableUnits，缺 source reader 要求的 reservedUnits | 用真实 Credit Core debit/replay 投影补充；已有 reserved_after/预留能力，单补真实字段通常无新表；不能写死 reservedUnits=0。[A04] |
| admitTurn Guard/precharge | 目标只有 account/model 基本准入 | 独立迁 Guard settings/policy/Turn reservation + Host 可重入上下文加列；账本留 API，不做 DO 假账本。源 0074 需按依赖摘取，不迁账务产品整树。[A04] |
| releaseTurn + TTL 释放 | 缺新 endpoint | 与真实预留/幂等/owner/run/事务一致，terminal 与 guard stop 均要闭合；maintenance 必须有人真实调，单造 expire endpoint 不足。[A04] |
| writeTurnWrapup | 缺 | guard-stopped 后专门模型摘要与一次性 API 持久化，需 reservation wrap-up 列（源 0075）；不迁显示 UI，也不能说它已自动进入模型历史/评估轨迹。[A04] |
| recordTurnActual | 缺；本身是预测诊断，不直接提供模型能力 | source terminal await 是硬依赖；若排除诊断，要明确连 capture/callback 收敛，不能留 404 或伪实现，也不能因此关掉真正 Guard/release。[A04] |

low-credit 与 Guard 是不同口径：前者用 `available + 全部 reserved`，后者用 `available + 本 Turn precharge`。提示 `<50` 的规则不要求先迁运营后台；完整 Guard 仍是独立模型执行机制，不能偷偷剔除。source 默认 guard 关闭/observe/空模型集不等于部署数据库也如此；本轮没有读任何环境 DB。

Action discovery/execution entrypoint、action-discovery models 和公共 contract 在两固定提交间无 diff，target 已有 HTTP client。只为新 Tool 描述/limit/status 行为不需要重写服务。[H09]

Super Link 既有 SP connector list/authorize-attempt/status/disconnect API 可复用；新增 prerequisite 本身通常不要求新 SP 表，但需要真实 SDK/operation auth、Session revision/scope/父 Session、交互合同和完成后 fresh recheck。target/source Agent 与 API 的 SDK 升级必须协调；外部服务是否返回所需字段尚未 live 验证。[H10]

### 15.2 不必为能力对齐同步的产品存储重构

| 能力 | 可保留的目标实现 | 不应被强制带入 |
| --- | --- | --- |
| Schedule | 目标 RuntimeSchedulePort + DO confirmation/commit/list/pause/resume/cancel、Agent/plan 准入与 terminal complete | PostgreSQL scheduler、agent_tasks、API dispatch/events 的整套产品；只有选择该 dispatch 架构时才是必要依赖 |
| Chat directory | Inbox DO 的 title/activity/assistant-response 投影，Severn 仍为事实源 | API directory/Recents SQL、事件流、Web 列表 |
| Runtime Memory | 目标 Inbox ownership + runtimeKey/sessionId/label 的真实持久 Port；保持临时 Agent 正确父身份 | Severn SQLite 的存储搬迁/第二份 memory state；两边 memory Port 文件无 diff |

这些是真实等价 Port，不是占位 shim；保留后仍需验证与新 Runtime 的 identity/terminal/confirmation 契约。[A05]

### 15.3 渠道与“不迁 Web”的交集：明确未决，不假装成功

source 在 **`!channel` 普通 Chat** 注册 `channel_connections`；它读取连接并返回真实 Channels setup 页面，提醒不要在 Chat 索要凭据。target 没有同等 API、channel_accounts 数据和已证明可用的 setup 页面。不能误归“只有 IM Chat”，不能返回空列表/无效 URL 冒充能力。

后续需明确评估环境采用何种真实渠道 setup seam；未具备时明确 unavailable，不能声称这项完整对齐。Feishu/Telegram 发送/历史/发布和 headless Super Link 则按真实 channel 注册；普通 EP service Chat 不虚构 IM 身份。配置 proposal 的 Eval 禁用是源自身 `bindingLock:"eval"` 规则，可直接保留，不是迁移者擅删工具。[A06][H12]

## 十六、文件、媒体、浏览器的资产和权限条件

### 16.1 直接依赖差异与真实包，不以版本号代替合同

| 拥有者/依赖 | target 或 UA 发布基准 → source | 必要含义 |
| --- | --- | --- |
| SP Agent Runtime | alpha.15 → 安装 alpha.32 | source 事实，不是建议盲升；需要“fresh 已核实能力 + SAFE”的真实兼容发布，不能仅依据 fresh manifest alpha.27 猜已发布字节 |
| SP Space | alpha.0 → alpha.1 | 已读取实际安装 alpha.1 的 public `src`：DO 的 capabilities/条件写/ordered listing 确实接到 backend；仍须并发/Worker 契约验收。[H08] |
| SP Agent/API Super Link SDK | 0.1.0-alpha.4 → 0.1.2-alpha.1 | scope/revision/auth contract 协调，远端部署兼容尚未 live 验证 |
| SP `@embedpdf/pdfium` | 无 → 2.15.1 | PDF 引擎与 WASM |
| SP `harfbuzzjs` | 无 → 0.10.3 | 字体子集/文档引擎能力 |
| SP `linkedom` | 无 → 0.18.14 | 文档 worker 所需 DOM 能力 |
| UA Runtime `@ffmpeg/core` | 无 → 0.12.10 | 正式 Host mediaReader 的依赖，与未跟踪 CodeMode probe 分开 |
| UA devDependency `fflate` | 无 → 0.8.3 | 测试/开发依赖，不能误记为生产 Runtime 必需库 |
| SP `@springbrand/trajectory-plugin` | workspace 依赖 → source 删除 | source 转 raw 相关边界不能照搬；target 的证据/资源 caller 与 owning contract 必须保留验证，不自动复制这项删除 |
| Pi / agents 与 patch | 两侧仍为 1.4.0 / 0.30.0 | 版本相同不代表 patch 相同；具体增删见 14.4 |

这张表来自固定 manifest 的精确比较，不是安装/发布指令；本轮没有查询新库发布时间或改依赖安全门禁。正式升级需按仓库流程核查安全窗口、先预览变更范围，再经授权发布/升级；不能为了绕过安全门禁修改策略。其余未改的传输/Cloudflare 库不应包装为新依赖。[H15]

### 16.2 资产、绑定与条件可用性

- Source GenOffice 四格式 worker manifests 和三种 Office render manifests 均 pin `9563f3e2ddd06426a71e4f36ea2d26292af645a2`，state clean，后者逐项记录 script/font/WASM hash/size。worker bundle/WASM/render assets/font/license/NOTICE/check 脚本必须配套；不能只有 TypeScript 工厂。[H06]
- Source root/local/dev/eval/production 都配置 `BROWSER_AGENT_ENABLED:"1"`；target 无该变量，但已有旧 screenshot/console 工具，因此不是“target 无浏览器能力”。新 browser 还要求 primary、非 channel、非 scheduled、绑定/授权和后续 Tool Policy。[H11]
- Office visual 使用 BROWSER **不受上述模型 browser flag 门控**；关闭浏览器工具不能顺手删渲染能力。还需 ASSETS、IMAGES、字体公开只读路由、WASM modules、Sandbox/poppler 等部署条件。
- Space .0→.1 的需要是 ordered versioned listing/content-version CAS；source 明确拒绝 metadata-only CAS 降级。不能旧 write API 外加一个假 version 冒充原子 Office 编辑。
- `ffmpeg-core-codemode.probe.test.ts` 是未跟踪、依赖 scratch 工件、可 skip 的 Dynamic Worker 内 ffmpeg 研究，不等于已发布 Host mediaReader；不作为实现完成证据，不随迁 `.scratch`。

## 十七、未提交内容精确账与推荐优先级

### 17.1 WIP 不能漏，也不能夸大

| 来源 | 生产/测试 | 确证 |
| --- | --- | --- |
| UA | assistant ask-user/followups/plan 三文件；index.test.ts | 三个生产文件去掉 description 后 AST 与 HEAD 完全相同：只有模型说明文本变化，无新 parser/Schema shape/执行/settlement。ask_user 扁平契约/plan normalizer 是已提交增量，不是 WIP 才有。测试 +194/−21，覆盖 Schema 不变量、非空描述、已有默认/状态 normalizer |
| SP | capability-tools.ts、super-link guidance.ts/index.ts；三个配套测试 | Capability 生产 diff 也仅 description；SL 压缩说明、selected metadata 指向 search catalog、去掉重复 toolkitSummary 常驻 Prompt。六文件合计 +359/−58，不是新授权或 SDK 能力 |

SP tracked diff 快照 SHA-256 为 `80d4ba79bae66bf0a88acb6728d911d859d4d30468b8ed8b0b7d4b8046aaa68b`。来源未清理/提交/覆盖；UA 另有七份 tracked 规则/架构/knowledge 文档与未跟踪研究/probe，不当作发布内容。

### 17.2 依赖关系与阻断项

| 优先级 | 研究结论 | 不能采用的捷径 |
| --- | --- | --- |
| P0 | 固定能力源码/WIP、保留 SAFE；保护 target Harness/agent-config/import/export/OOM；解决 CodeMode-only 失路由及新文件命令与 Host 实现不一致 | 盲 pin .32、整包/整文件覆盖、删 SAFE/approval/CAS 校验 |
| P1 | 上游 Runtime/Space 兼容版本 + FileSurface/媒体/资产/绑定 + SP Prompt/Skill/Reminder/具体模型 Tool 接线 | 在 EP 复制 Runtime、编辑 node_modules、只迁描述不迁执行/事实/资源 |
| P1 | 最小 Profile/目录/Skill/API 与 Guard/结算事实闭环 | 638 个 API 文件全迁、硬编码空 Skill/余额/授权/虚构状态 |
| P2 | 渠道 setup 的真实 seam、选定 DO Port 兼容、目标公开包发布/部署版本协调 | 强制搬所有 scheduler/directory/memory 产品重构，或以 Web 排除为由静默删模型工具 |
| 验收 | 先聚焦离线/Worker/合同，再经授权真实 turn 与完整 EP 闭环 | 仅凭编译/启动/工厂存在/npm 版本宣称能力对齐 |

SP 两固定末态共有 2,126 文件差异（API 638、Web 565、Agent 468），不是迁移文件清单。`@springbrand/*` 在 owning package 演进；以后发布需用户授权，并遵守目标根目录 alpha 升级工作流，不为 pnpm 单版本而强迫 UI 全升级。

## 十八、验证清单与当前未证明的内容

1. **来源/包**：HEAD+WIP 指纹、实际 Runtime exports、SAFE、Space CAS、SDK contract、GenOffice bundle/manifest/license、patch 能力分别固定。
2. **模型请求**：保留既有协议/reasoning/Tool Search；验证新 supplement composition/模态/图片 replay、search model/deferral，外部 Schema 原样。
3. **机制**：admission/attempt/cutoff/native ownership、facts、permanent/temporary、deadline/cancel/late result、awake center 与休眠恢复；不造持久 Consumer state。
4. **工具面**：先断言最终候选与 native ToolRegistration/Provider payload，再调用；重点 materialize_url/deploy_workspace_preview、Skill helpers 退出、assistant/Action/SuperLink、Eval lock/无人值守。
5. **文件/部署**：四格式读写/样式/visual、文本与文档 cursor/CAS、稳定 ls 分页、完整子树/目标目录/同路径/重叠/部分失败 cp/mv、临时 scope、独立 PDF container/cleanup、图片/视频/音频、6 MiB native image、BROWSER/IMAGES/ASSETS/WASM/字体绑定。
6. **最小 API/数据**：真实平台 Skill binding/R2、owner-scoped Profile/目录、模型旧选择/新准入、settlement reservedUnits、Guard/release/TTL/wrap-up；不因降级成功启动掩盖缺能力。
7. **目标回归**：OOM reset/seal/fencing、多 Material/Schema、原样 Prompt、input/stop latch、临时 Agent delivery、95 MB 流/引用/hash/throughSeq、费用分页与 receipt。
8. **闭环**：执行 Agent 材料→模型/工具→产物+完整 SAFE trajectory→评估 Agent 独立 Workspace/Schema→结果 MCP 接受→资源收尾；断线/by-key/by-ID、停止、证据补收/补评分不重跑 Subject。

实施时复用源 UA 的 provider/assistant/CodeMode/FileSurface/media/compiler/reminder/trajectory 测试，SP 的 native/workerd Reminder/模型模态/FileSurface/Browser/Action/SuperLink/Office 检查，以及目标 Eval/EP 已有回归。EP 标准是 `pnpm check` 后接有真实本地 DATABASE_URL 的递归测试；无数据库会 skip 集成，不能称全部通过。并发 harness 耗时争用按 AGENTS 串行重跑，不能放宽断言。UA 的完整真实 turn、审批/子 Agent/产物路径和 live 模型 smoke 仍是实施验收，不是本轮完成。

**本轮未证明**：任何部署实际 commit/绑定、平台 Skill 线上数据、Guard 启用政策/TTL maintenance、SDK 远端协议、渠道 setup 可用页面、选定整合版本的真实模型/Office/browser/审批/EP 全链路成功。它们均保留为后续明确验收项；没有把未知记为成功或零费用。

## 十九、综合能力部分的 primary 源码索引

前缀均可机械展开：`UA=/Users/apple/code/.worktrees/ua-prompt-governance-release-0.3.1-fresh-20261103`；`SP=/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105`；`TARGET=/Users/apple/code/.worktrees/sp-eval-20261110`。固定 HEAD 见第二节，assistant/SL/Capability 的 WIP 明确见第十七节。

- **[U02]** UA `packages/agent-runtime/src/harness/{event-rule-router,reminder-rule-runtime,request-reminder-repository,host-prompt,permanent-reminders,prompt-reminder,reminder-facts}.ts`、`src/submission/admission.ts`、`src/models/request-supplements.ts`：事件/原生持久化/请求挂载。
- **[U05]** UA `packages/agent-runtime/src/tools/assistant/{ask-user,followups,plan,index.test}.ts`：已提交契约及 WIP，HEAD/AST/安装 .32 比对。
- **[U06]** UA `packages/agent-runtime/src/tools/codemode/{adapter,state-functions,state-candidates,file-surface-tools,workspace-file-commands,tar-workspace}.ts`：注册/discovery/权限；重点 adapter:360-399、state-candidates:45-74。
- **[U07]** UA `packages/agent-runtime/src/file-surface/{index,office-engine}.ts`、`src/adapter/cloudflare/workspace/file-surface-store.ts`：引擎合同/通用验证/版本 store。
- **[U08]** UA `packages/agent-runtime/src/adapter/cloudflare/media/{reader,images}.ts`、`src/file-surface/{ffmpeg-reader,media-policy}.ts`、`src/adapter/cloudflare/sandbox/pdf-text.ts`、`src/tools/workspace/pdf.ts`。
- **[U09]** UA `packages/agent-runtime/src/tools/runtime/compiler.ts:103-138,159-192`、`src/context/memory/budget/gate.ts`、`src/models/index.ts:970-985`：预算/模态。
- **[U10]** UA 基准 `0b709ace…` 与 HEAD `300b63a…` 的 `src/models/{index,openrouter/messages,openrouter/openai}.ts`、`src/config/{ports,harness-runtime}.ts`、`src/harness/governance.ts`、`src/tools/runtime/{prerequisite-contracts,prerequisite-gate,prerequisites,decision-gate}.ts`、`src/tools/subagent/temporary/{core,coordinator,runner,approvals}.ts`、`src/schedule/`、`src/tools/assistant/memory.ts`、`src/context/assembly.ts`；model-client/src 无 diff。相对 src 均为 packages/agent-runtime/src。
- **[U11]** UA `packages/agent-runtime/src/config/assembler.ts:279-319` 与 `src/tools/codemode/adapter.ts:360-399`；SP `apps/agent/src/runtime/tools/platform-tools.ts:192-198,292-299`：候选存在却无执行路由的静态证据。
- **[U12]** UA `worker/src/roles/{inbox.ts,universal-agent-config/backends/runtime-host.ts,universal-agent-config/tools/temporary.ts,universal-agent-config/tools/universal.ts}`、`worker/src/runtime-host/resources/{file-surface-workspace,workspace-mutations,workspace-mutations.test}.ts`、`worker/src/runtime-host/sandbox/destroy-session.ts`、`worker/src/runtime-host/subagents/subagent-do.ts`；Runtime `workspace-file-commands.ts:270-350`。测试记录预检、1001 子项、稳定 cursor、部分失败不误报和源保护；本轮只读。
- **[H01]** SP `apps/agent/src/runtime/config/runtime-settings.ts:13-39,64-73,83-128,149-168` 与 TARGET 同文件。
- **[H02]** SP `apps/agent/src/runtime/host/reminder-rules.ts:13-55`、七个 consumer/`reminder-support.ts`、`execute-usage-guidance.ts`、`config/resource-loader/host.ts`。
- **[H03]** SP `apps/agent/src/runtime/skills/index.ts:25-39`、`skills/aesthetic-design/root.ts:8-28`、`runtime/platform-skills.ts`、`config/resource-loader/host.ts:70-90,160-174`。
- **[H04]** SP `apps/agent/src/runtime/config/tools/universal.ts:49-89,102-172,187-258,275-278`：surface/prepare/gating。
- **[H05]** SP `apps/agent/src/runtime/host/runtime-host.ts:254-306`、`apps/agent/src/workspace/index.ts:115-150`：装配与拒绝伪 CAS。
- **[H06]** SP `apps/agent/src/runtime/host/genoffice/{engines,assets}.ts`、各格式 worker manifests、`apps/agent/assets/genoffice/render/*manifest.json`、`apps/agent/scripts/check-office-worker.mjs`；engine worker test:64-68 验证 DOCX setFont。
- **[H07]** SP `packages/agent-contracts/src/model.ts`、`apps/agent/src/chat/long-image-tiles.ts`、`src/runtime/host/model-provider.ts`、`patches/@earendil-works__pi-ai@1.4.0.patch`。
- **[H08]** SP 实际安装的 `apps/agent/node_modules/@springbrand/space/package.json`、`src/space/durable-object.ts:698-736`、`src/space/space-files.ts:840-878,990-1020`（src 相对该安装包）；UA `packages/space/src` 为 owning source；不是只看 Host import 推测支持。
- **[H09]** SP `apps/agent/src/runtime/tools/capability-tools.ts:24-29,102-137,173-216,246`；两提交 `apps/api/src/{action-discovery-entrypoint,action-execution-entrypoint}.ts`、models/action-discovery、agent-contracts/action-discovery 无 diff。
- **[H10]** SP `apps/agent/src/runtime/tools/super-link/{index,session,prerequisite,guidance}.ts`、`packages/contracts/src/connectors.ts`；TARGET `apps/api/src/routes/connector/connector.routes.ts:17-25`。
- **[H11]** SP `apps/agent/wrangler.jsonc:77,134,203,267,334`、`src/runtime/tools/browser/wiring.ts:21-35`、`config/tools/universal.ts:187-196`；TARGET universal:146-157。
- **[H12]** SP `apps/agent/src/runtime/tools/agent-config-tools.ts:285-339`、`runtime/config/agent-config.ts`、`host/runtime-host.ts:312-315`、`packages/agent-contracts/src/agent-chat-authoring.ts`。
- **[H13]** SP `apps/agent/src/runtime/host/{runtime-host,run-billing-context,low-credit-reminder}.ts`、`sessions/credit-wrapup.ts`、`src/api/http-client.ts`。
- **[H14]** TARGET `patches/agents.patch:43-279`、`apps/agent/src/alarm-memory-limit-breaker.worker.test.ts:8-17,69-118,130-143`；SP 同 patch 无该段、无该 Worker test；固定提交 patch diff 仅删除这 237 行。
- **[H15]** SP/TARGET `apps/agent/package.json`、`apps/api/package.json`；UA `packages/agent-runtime/package.json`、`packages/space/package.json` 的发布基准/HEAD 精确比较；安装 Space public exports 见 H08。
- **[H16]** SP `apps/agent/src/workspace/chat-port.ts:159-227`（完整文件无 readDirPage）、实际安装 Space `src/space/space-files.ts:1047-1105`（相对 H08 安装包）、`apps/agent/src/runtime/host/chat-sandbox.ts:16-35`、`runtime/subagent.ts:27-35`、`chat/severn-agent.ts:1839-1868`；UA `packages/agent-runtime/src/adapter/cloudflare/workspace/scoped-workspace.ts:427-462` 只条件转发 readDirPage：Host 行为和 PDF cleanup 的对应事实。
- **[A01]** SP `packages/contracts/src/platform-skill.ts:9-15,58-74`、`apps/api/src/models/platform-skill/{index,schema}.ts`、`routes/internal/channel-internal.ts:84-85`、migrations-postgres/0065_channels.sql 的平台绑定部分。
- **[A02]** SP `apps/api/src/routes/internal/agent-config.{routes,handlers}.ts`、`models/user-agent-config/{index,selectable-resources}.ts`、`models/action/action-access.ts:250-256`；TARGET profile/目录出口缺失。
- **[A03]** SP `apps/api/src/models/user-agent-config/{index,selection-validation,validate-setting}.ts`、`apps/agent/src/runtime/config/agent-config.ts:214-225`；TARGET API service:85-100 已有 settingPatch，Model index:408-414 无 existingModelSelection。
- **[A04]** SP `apps/api/src/routes/internal/internal.index.ts:76-126`、`billing-entrypoint.ts`、`models/billing/{index,turn-wrapup,turn-prediction,turn-guard-settings}.ts`、migrations-postgres/0074_wild_maximus.sql、0075_shiny_nico_minoru.sql；TARGET billing/index:755-773、credit-account/index:413-473,639-699。
- **[A05]** TARGET `apps/agent/src/scheduling/{port,scheduler-agent}.ts`、`src/inbox/chat-directory-projection.ts:14-50`、`inbox/index.ts:625-644`、`inbox/store.ts:397-420,468-475`；SP `scheduling/port.ts:48-145`、`chat/{chat-directory-projection,severn-runtime-memory}.ts`。
- **[A06]** SP `apps/agent/src/runtime/config/tools/universal.ts:199-221`、`tools/channel-setup/index.ts:6-41`、`packages/contracts/src/channels.ts:575-593`、`apps/api/src/models/channel/agent-connections.ts:20-45`、`routes/internal/channel-internal.ts:87-90`。
