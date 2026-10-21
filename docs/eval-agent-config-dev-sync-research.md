# Eval 与 dev AgentConfig 同步调研

首次调研：2026-10-20；约束更新：2026-10-21。本文是调研结论与待确认的设计建议，不代表接口已经实现或部署。

> **当前需求以第 12 节为准**：用户最新前提是 **dev、Eval 均未上线**；只做 **dev → Eval 导入缺失 Agent 及必要 Skill / Reference**。导入三类对象必须真正保留源 ID（Agent、Reference 为 UUID；Skill 保留现有 SkillId，不把平台字符串 ID 重编码为 UUID），不另造目标 ID 或改写依赖数组冒充统一。Eval 原生 Agent 必须隔离；不统一 owner、账号或凭据，不覆盖、不删除、不反向同步。

> **2026-10-21 明确约束**：不能改动 dev 数据；来源连接只使用已确认无写副作用的读取操作，所有导入写入只面向 Eval。Eval 增加内部来源字段，但页面不显示来源列、标签、筛选或来源编辑项，普通 Agent 展示不因来源而分区。

> **历史阅读提示**：第 1–11 节保留当时的源码事实、阶段性前提和方案演进。旧文“不复用 userAgentId”“新建目标 ID／重写 Skill、Reference ID”及导入后更新的建议已被第 12 节取代；“已部署”“数据库已对齐”不是本轮独立核验结果。未上线不等于空库，也不构成重置、迁移或清理数据的授权。

## 1. 结论

建议做成 **dev → Eval 的显式、单向配置导入/更新**：用户选择来源 Agent，预览配置差异、资源映射和不兼容项，确认后在 **Eval SP** 中创建或更新一份普通 AgentConfig。Project 继续使用自己创建的冻结副本，运行过程不读取 dev。

不要把 `EVAL_SP_API_ORIGIN` 改成 dev，不要同步两边数据库，不要直接复用 dev 的 `userAgentId`、账号或凭据。现有部署约定已经明确允许“通过公开接口显式导入”，但不允许实时共享配置；周期性自动同步属于需要另行确认的行为扩展。[E1] [E2]

有两个交付层次，不能混称：

- **受限配置同步**：复用两边现有公开 CRUD，同步目标契约支持的字段，依赖必须已经在 Eval 存在且通过核验；不兼容或缺失依赖就阻断。可以先做，不需要把 SP 运行逻辑搬到 Eval。
- **完整配置及依赖迁移**：还需要解决配置契约差异、原始配置导出、私有资源权限，以及 Skill 等依赖的不可变版本。现有分享/ZIP 接口不能直接满足。

第一版推荐前者，默认手动触发、不反向写 dev、不传播删除、不静默丢字段。完整迁移是后续能力，不应通过“导入成功但去掉部分能力”冒充完成。

## 2. 调研范围与证据基线

本次检查了 Eval 的部署、固定服务身份、AgentConfig CRUD/用途管理、资源代理、Project 冻结、Web 编辑器和相关测试，并读取了本机 `sp-platform` 的公开契约与实现作为一手证据。

| 来源 | 本次使用的版本 |
| --- | --- |
| eval-platform | 当前工作区，HEAD `8ea78f138fc893d51637b4ba96a7e19b19f73103`，分支 `fix/agent-config-crud` |
| SP dev | 本地远端跟踪引用 `origin/dev`，`23e90f5eb29f39c0f5c87cd5090e650f72e51699` |
| SP eval | 本地远端跟踪引用 `origin/eval`，`2990fba62f057152b79af3fc150c0c4ba8d93e8b` |
| Eval Web 编辑器 | 本地已安装的 `@springbrand/agent-config-editor@0.1.0-alpha.0` |

以“项目已经部署在 eval”为用户给定前提；没有访问线上环境、拉取远端新引用或核对线上发布 commit。因此下文的分支差异是上述源码版本的事实，不是对当前线上部署内容的断言。部署文档中的“尚未联调”等历史描述也不能用来否定用户提供的部署现状。

工作开始时 Eval 已有三处未提交修改：`AGENTS.md`、`apps/eval-api/src/agent-configs.test.ts`、`apps/eval-api/src/agent-purpose.ts`；本次不修改它们。SP 当前工作区也有正在进行的变更，关键跨分支结论使用上述固定 Git 对象，不把工作区修改当成 dev/eval 已发布事实。本次未读取本地秘密文件，也未执行配置同步、分享生成、数据库变更或部署。

## 3. 当前链路与应保持的职责

```text
当前：
Eval Web → Eval API → Eval SP AgentConfig 库
                       └→ Eval PostgreSQL：用途、Project 与冻结副本关系
Project 创建 → Eval SP 中的新冻结副本 → Run Worker → Eval SP 运行

建议新增：
dev SP 已授权配置 ──只读获取──→ Eval API 中的配置同步 Module
                                   ├→ 预览：契约/资源/权限/差异
                                   ├→ 确认：现有 AgentConfigService
                                   │          └→ Eval SP 普通配置
                                   └→ Eval PostgreSQL：同步来源、摘要和操作记录
```

配置正文仍由 Eval SP 承载；同步记录不是第二份可编辑配置库。同步不进入 `eval-runtime`，Run Worker 不获得 dev 凭据，Web 不直接请求 dev，不新增第五个共享包。[E1] [E2] [E3]

需要区分三个地址。SP 的部署源码中，dev SP API 为 `https://devrapi.springbrand.ai`，Eval SP API 为 `https://evalrapi.springbrand.ai`；本项目自己的 Eval API 则是 `https://evalapi.springbrand.ai`。不要把 Eval API 和 Eval SP API 混为一个地址。SP eval 的部分 `RUNTIME_ENV` 值仍然是 `dev`，不能据此判断存储是否隔离，必须核对实际 origin、数据库和 Worker 绑定。[S1] [E2]

## 4. 已确认的关键事实

### 4.1 同步来源首先是“哪个账号”，不是“哪个环境”

Eval API 启动时验证一个固定 Eval SP 服务账号，所有用户的请求都使用该账号；takt 用户只作为网关核验后的审计 actor，不会自动成为 dev SP 用户。[E2] [E4] [E10]

dev 的配置列表和详情按经过认证的用户归属读取，不是整个 dev 环境的全量目录。给一个新 dev 机器人账号签发会话，并不会使它能够读取其他用户的私有 AgentConfig。现有接口不能直接支撑“管理员一键同步 dev 所有人的配置”。[S2]

因此建议先接入一个经授权的 dev 配置库账号，并明确可导入的 Agent 白名单。若来源是多个个人账号，需要逐个授权，或者由 SP 提供正式的、受审计的导出授权能力；不要用数据库直读绕过所有权。导入到固定 Eval 账号还意味着数据可能对 Eval 使用者共同可见，不能只验证来源可读而忽略这一传播范围。

dev 来源会话和 Eval 服务会话必须分开。普通用户会话本身不能被当作“只读 scope”；第一版应通过来源 Adapter 的固定 origin、明确的只读操作白名单和独立凭据限制其用途，不给通用 SP 写客户端或任意 URL 代理能力。

### 4.2 CRUD 可以复用，但不能整行复制，也不能把 POST 当更新

Eval 已有 `list/get/create/update/delete` 的 SP HTTP Interface，通过 `/api/user-agent-configs` 访问当前配置库。[E3]

在所检查的 eval 版本中：

- 创建接受 `slug/name/description/setting`，不接受源行的 `id/user_id/revision/is_default/created_at` 等身份字段。
- 创建的幂等身份是**目标账号内的 slug**；同 slug 重放返回已有记录，不意味着配置内容被更新。
- 更新需要**目标配置自己的 revision**，旧 revision 返回冲突。dev revision 只是来源版本，不能拿它作为 Eval PATCH 的 revision。[S3] [S4]

应持久化来源与目标的身份映射，而不是按名称匹配。新目标使用保存下来的稳定导入 slug，例如 `eval-sync-<binding UUID>`，不能使用 `default` 或保留的 `eval-frozen-` 前缀。请求结果未知时用同一创建身份校准，并比较实际内容，不能每次重试生成新 slug。[E5] [S3] [S4]

### 4.3 dev 与 eval 的配置契约已经存在实质差异

| 内容 | 检查到的 dev | 检查到的 eval / 当前编辑器 |
| --- | --- | --- |
| `setting.authoring` | 支持 | 旧严格 Schema 不支持 |
| `setting.preferredSupplierIds` | 支持 | 旧严格 Schema 不支持 |
| `setting.referenceNotes` | 支持 | 旧严格 Schema 不支持 |
| 顶层 `avatar` | 支持 | 旧创建契约不支持 |
| 更新正文 | `revision` + `settingPatch` 等字段 | `revision` + 完整 `setting` |
| 读取元数据 | 有删除/来源等新元数据 | 仍包含 `setting_schema_version` 的旧契约 |

这些结论来自固定版本的契约源码，不是根据字段名字猜测。[S3] [S5] 本次还实际调用了当前编辑器的公开 `./draft` 导出：基线配置通过；分别加入上述三个 dev-only setting 字段都报 `unrecognized_keys`；更新 helper 仍生成 `setting`，没有 `settingPatch`。

不能依赖 Eval 当前 HTTP 客户端的宽松响应解析来解决兼容：它允许未知响应字段，不代表目标 SP 的写 Schema 或 Web 编辑器能保存这些内容。[E3] [E6]

两条可行路径：

1. **有限兼容**：声明允许导入的共同字段；遇到其他字段返回明确阻断或要求用户明确选择一个非等价的精简副本，禁止静默删字段。尤其不能把 `referenceNotes` 当成无关元数据丢掉。
2. **完整兼容**：由 SP 在所属公共契约处提供版本化导出/导入能力，配套发布 Eval 可消费的包，再升级目标 SP 和编辑器。不要直接合并整个 dev 分支来“顺手解决”，这会改变被评估的运行代码。

dev 中的 `@springbrand/agent-contracts` 是 private workspace package，不能假设 Eval 可以直接从 npm 安装其当前源码导出；应通过正式发布的公共包/HTTP 契约消费，不导入 sibling 私有文件。[S6] [E1]

### 4.4 dev 的分享与 ZIP 是公开快照，不是完整配置备份

上述 dev 版本已有创建分享、`GET /api/user-agent-configs/{id}/share.zip`、公开快照 resolve、token 导入和 ZIP 导入；上述 eval 版本没有这组分享契约和导入路由。[S7] [S8] [S17] [S18]

但公开快照具有以下明确限制：

- 只保留平台公开的 Skill/Action/Connector/Extension ID；私有 Skill、参考文件和 `referenceNotes`、MCP/Toolkit 选择等不进入可导入正文。
- ZIP 只有一个 `agent.json`，没有 Skill 包或 Reference 文件字节。
- 导入明确重建 `mcpServers: []`、`referenceFileIds: []`。
- 分享 token 用来源环境的签名 secret 校验；v2 还要查询来源数据库中的分享记录。不能把 dev token 原样交给 Eval 本地解析，更不能为此共享 JWT secret。
- **`GET share.zip` 也不是无副作用导出**：handler 先调用 `createAgentShare`，后者向分享表插入记录。不能把它放入“dev 完全只读”的自动同步路径。[S7] [S8] [S9]

可以把用户主动提供的公开分享作为“导入公开模板”的另一个入口：在来源环境 resolve 后验证快照，再经 Eval 的配置用途管理写入目标；或者使用经明确授权生成的 ZIP。必须展示省略清单，不能标成完整同步。即使补齐了原生 ZIP 导入，也仍然没有依赖内容迁移和持续同步绑定。

### 4.5 普通 GET 也不一定是原始保存正文

dev 管理读取会经过 `projectUserAgentConfig`；其中 `restrictAgentConfig` 会根据账号套餐将不可用模型改成默认模型，并归一化 thinking。因此同一个保存 revision 的公开视图可能受账号权限变化影响。[S2] [S10]

第一版若复用普通 GET，应把来源定义为“当前账号可见的有效配置”，保存内容摘要，不能宣称是未经变换的原始数据库配置。若目标是忠实迁移保存正文，需要 SP 提供正式的 owner-scoped 原始配置导出 Interface，同时输出 Schema 版本和依赖版本；仍不应让 Eval 读 SP 数据库。

### 4.6 冻结 AgentConfig 不等于冻结所有依赖

现有 Project 创建会克隆配置，冻结副本正文包含原来的资源 ID；`AgentConfigSnapshot.body` 只是展示快照，Run 实际使用冻结副本引用。[E5] [E7]

SP 运行时则按这些 ID 解析**当前** Skill/Component/MCP 数据。普通 Skill 上传会按账号内不区分大小写的同名 Skill **原地覆盖、保留 ID、递增 revision**；Reference 也有替换当前文件、影响后续 Chat 的能力。[S11] [S12] [S13]

因此“只更新可编辑 Agent，不更新冻结副本”只能保证配置正文隔离，不能保证依赖隔离。例如旧 Project 冻结配置引用 Skill A；同步为了新配置上传同名 A 的新内容，旧 Project 之后创建的运行仍可能读到新 A。来源 Skill 变化也不一定改变 AgentConfig revision。

完整同步必须引入依赖内容摘要，并使用不会覆写旧选择的资源版本。Reference 可以导入为新记录；同名 Skill 的现有上传 Interface 不提供等价的不可变版本语义，不能靠普通上传假装解决。SP 需要提供正式的版本化/不可变资源导入与解析能力；通过改写 Skill 名称规避冲突会改变运行语义，只能作为用户明确接受的非等价副本。

## 5. 字段与依赖处理建议

以下是建议策略，不是已经实现的迁移规则。

| 配置/依赖 | 建议处理 | 第一版边界 |
| --- | --- | --- |
| 名称、描述、提示词、toolPolicy、memory/sandbox 等 | 按目标公共 Schema 原样转换，保留数组顺序和明确的空值语义 | 支持共同字段，不做文本替换或静默裁剪 |
| model、presetId、thinking | 检查目标模型目录、thinking 支持和 Eval 服务账号权限 | 不可用就阻断，不静默换模型 |
| subagentNames | 核对目标运行版本支持的名称 | 不是按名字递归复制其他 AgentConfig |
| 平台 Skill、Action、Connector、Extension | 核验目标存在、种类、状态和可取得的版本/内容摘要；必要时使用明确批准的映射 | 相同 ID 不自动证明内容相同；不自动安装、发布或更新目录 |
| 私有 Skill | 经授权导出文件清单与全部字节，再导入不可变目标版本 | 不存在可靠映射/不可变导入能力就阻断 |
| Reference | 读取授权文件，校验内容，上传到 Eval，创建新的 Reference 并替换配置中的 ID | 不复制 dev CDN URL 或调用目标原地替换影响旧记录 |
| 普通 managed MCP | 映射到已配置好的 Eval MCP，检查目标可用性与网络去向 | 不复制源账号的 token、OAuth、Cookie 或个人连接 |
| `kind: "connector_toolkit"` | 保留 kind；按 Toolkit 目录和目标连接权限验证 | 不能拿它的 `serverId` 去普通 MCP 目录判定有效性 |
| 评估结果 MCP | 根据目标 Eval 的用途规则加入/移除 canonical 服务 | 不沿用来源 dev 的 server ID、地址和鉴权 |
| 新契约字段 | 按版本化 Interface 处理 | 不支持时显式阻断 |

资源归属、模型限制、Toolkit 与普通 MCP 的区分都有现有契约支撑。[S10] [S14] [S15] Eval 的 `purpose` 是自己数据库的事实源，创建、编辑、冻结和 Project 角色检查应继续复用同一 `AgentConfigService`，不能在同步入口重新推导一套用途；来源没有 Eval purpose 时让用户明确选择，默认建议“执行 Agent”。选择“评估 Agent”时，目标结果 MCP 缺失或歧义就阻断。[E5] [E8]

文件传输只能沿公开文件 Interface 和受信内容地址进行，限制域名/路径、文件数、展开大小、超时与哈希；不能从配置里的任意 URL 抓文件，不能给 CDN 请求附带 SP 会话，也不能把源存储的私有访问权限搬到 Eval。

## 6. 建议的产品交互与 Module Interface

Agent 管理增加“从 dev 导入”，已建立绑定的 Agent 显示来源账号、来源版本、最近同步时间和“检查更新”。

一次操作：

1. 列出被授权来源账号中的可选 Agent；选择一个来源，而不是输入任意 URL。
2. 指定目标用途，选择新建或已建立的同步绑定；不能任意覆盖同名 Agent。
3. 生成预览：配置差异、Schema 兼容结果、依赖映射、遗漏/变更、目标本地修改冲突。
4. 用户确认后应用**预览中固定下来的快照**，成功时返回 Eval 配置 ID、来源 revision、摘要和结果。
5. 创建 Project 时仍走原有冻结流程；已有 Project 不改配置引用。

建议让配置同步成为 `apps/eval-api` 内的 deep Module，公开 Interface 只暴露：

```text
preview(sourceConnectionId, sourceUserAgentId, targetBindingId?, purpose)
    → planId + 固定来源版本/摘要 + diff + dependencyChecks + blockers

apply(planId, idempotencyKey)
    → created | updated | unchanged | conflict | outcome_unknown
```

`preview` 不能写入 SP。它可以持久化带权限保护的导入计划；`apply` 只应用该计划，不在确认后重新抓一份未经用户审阅的“最新配置”。预览的来源、目标 revision、目标依赖状态、配置转换规则和文件摘要都属于请求事实；计划过期或目标状态变化必须重新预览。

可以设计 `/api/agent-config-sync/sources/{sourceId}/agents`、`/previews`、`/apply` 等路由，但这些是**拟议入口**，当前不存在。实现前须先更新项目职责和 HTTP 契约，明确“显式导入”例外，不能直接修改现有所有 SP 请求的环境。[E1]

### 冲突与幂等语义

- **没有变化**：来源配置及依赖摘要未变，目标仍等于上次导入结果，返回 unchanged，不发 PATCH、不递增 revision。
- **有来源更新**：使用当前目标 revision 更新普通可编辑配置；来源 revision 只记为 provenance。
- **目标被本地编辑**：默认 conflict。用户可以保留本地修改或另建独立副本；第一版不做自动三方合并和强制覆盖。
- **来源删除/不可见**：保留目标与既有 Project，显示需核验的来源状态；401/403/超时不能被解释成删除。不传播删除，也不因一次列表缺失做清理。
- **并发点击**：同一绑定只允许一个 apply 取得本地执行权，相同 idempotencyKey 与请求指纹重放原操作，目标 SP revision 再做最终并发检查。
- **来源与依赖版本**：只比较 AgentConfig revision 不够；依赖必须有独立摘要。普通 GET 组合读取不能证明原子依赖快照，完整一致性导出要由 SP 所属 Module 提供，不能只在读前读后比较配置 revision 就宣称一致。
- **回退**：显式选择上一次已记录快照再走预览和 CAS，产生一次新写入；不篡改历史同步记录或已有 Project。

目标写入必须复用现有冻结保护、用途归一化和 SP 正式校验。不要为了接入原生分享导入而绕过 `AgentConfigService`，否则可能出现目标配置已创建、Eval purpose 缺失等不一致。[E5] [E8]

## 7. 持久化、失败恢复与部署

建议在 Eval PostgreSQL 保存两个应用侧记录，不保存凭据：

| 记录 | 主要事实 |
| --- | --- |
| 同步绑定 | Eval owner、固定来源连接标识、来源 owner/Agent ID、目标 Agent ID、purpose、最近成功的来源 revision/配置摘要/依赖摘要、目标 revision/内容摘要 |
| 导入计划与尝试记录 | plan ID、idempotencyKey/请求指纹、固定快照与资源 manifest、状态、目标创建 slug、前后版本、actor、时间和安全的失败原因 |

第一版可约束“一组 owner + 来源连接 + 来源 owner + 来源 Agent 只对应一个受管理目标”，并对 owner + 目标 Agent 加唯一约束，防止两个来源覆盖同一个目标。查询身份用类型列，快照/差异等可变结构才用 JSONB；不为尚不存在的查询堆索引。

SP 写入和 Eval 数据库提交不是一个事务。应先短事务记录意图、认领操作，再调用 SP，最后核验目标与用途并记成功；**不能持有 PostgreSQL 行锁等待网络**。创建响应丢失用持久化的同一 slug 找回并校验；更新响应丢失则读回 revision 和规范化内容校准。仍不能确定就保留 `outcome_unknown`，禁止换 key 重建或盲目补偿覆盖。写入 SP 成功但本地记录失败必须可恢复，不能展示为完成，也不能自动删除可能已被使用的资源。

对内容分别计算来源摘要、转换后的目标摘要和依赖摘要；不要把目标附加的评估结果 MCP、两边 revision、owner、时间戳混进同一比较而制造永久差异。对有语义的数组保留顺序。历史记录可保留受控快照作回溯，但配置编辑仍只发生在 Eval SP。

Project 冻结时还应保留它对应的成功导入记录身份，或者通过冻结时保存的来源 Eval 配置 ID/revision 与不可变同步记录关联；不能用绑定的“最近同步版本”解释所有历史 Project。本地再编辑过的目标不能继续标成与 dev 某版本完全等价。这些 provenance 可以保存在 Eval 应用侧关系中，不改变现有 Subject/Evaluator 的 `AgentConfigRef` 契约。

部署建议：

- dev 来源连接是独立、可选功能配置；未配置或来源不可用不影响 Eval API 启动、已有 Agent 列表和正常 Run。
- 来源 origin、预期来源 user ID、来源会话在服务端配置；启动或启用连接时经来源 `/api/auth/me` 验证身份，禁止客户端选择 owner 或覆盖 origin。
- 新凭据只发给执行同步的 Eval API 进程，不发给 Run Worker 或浏览器；当前部署脚本使用显式环境变量名单，新增值必须同步进入 API 的可选配置与部署名单，否则 Secrets Manager 加了值也不会进入容器。[E2] [E9]
- 不复用 `EVAL_SP_ADMIN_TOKEN`、Eval 服务会话或 JWT secret。默认关闭自动调度；后续定时检查复用同一预览/应用 Module，不把同步挂到每次 GET 或 Run 准入上。
- dev 认证过期只使来源连接不可用，不清除 takt 登录；日志记录 ID、版本、摘要、阶段与 request ID，不输出会话、文件正文或秘密。
- 源配置、SP 运行代码 commit 和资源内容版本分别记录；现有 `EVAL_SP_SOURCE_COMMIT` 继续表示实际 Eval SP 运行代码，不能改成 dev 配置来源 commit。[E2] [E7]

## 8. 可选路线与推荐顺序

| 路线 | 能解决什么 | 主要限制 | 建议 |
| --- | --- | --- | --- |
| 现有 CRUD + 显式预检 | 已授权账号的共同字段、目标已有依赖的单向同步 | 原始正文/新字段/私有资源版本不足 | 第一版 |
| dev 公开分享/ZIP 桥接 | 用户主动提供的公开 Agent 模板 | 有省略；不是完整迁移；目标需正式接入 | 可选辅助入口 |
| SP 版本化完整导出/导入 | 原始配置、依赖 manifest 与不可变资源版本 | 需要 SP 契约和资源版本能力配合 | 完整方案 |
| 数据库同步/复制 `user_agents` | 表面上复制行 | 身份、依赖、凭据、版本与职责都不成立 | 不采用 |
| 运行时直接引用 dev 配置 | 看起来没有导入步骤 | 破坏隔离和运行可恢复性，依赖 dev 在线状态 | 不采用 |
| 双向同步 | 两边都能编辑 | 冲突、所有权、删除传播和凭据处理复杂 | 第一版不做 |

SP 现有 `db:sync:dev` 也不是可复用的 dev→Eval 配置同步工具：它硬性只写 local，处理公开 catalog 表，并明确排除用户上传的 Skill；不应移除环境保护改成写 Eval。[S16]

落地顺序建议是：先确认来源账号与内容传播范围；定义共同字段/阻断规则和同步契约；实现手动预览、稳定身份导入、冲突与恢复；最后再按实际需要补 SP 原始快照/不可变资源能力和定时同步。所有阶段都保持运行留在 Eval。

## 9. 验收要点与本次验证

实现后的 focused tests 至少覆盖：

1. 首次导入获得新 Eval owner/ID；重复导入不重复创建；同名不同来源不覆盖。
2. 来源更新、来源不变、目标本地修改、过期预览和目标 revision 竞争。
3. 配置 revision 不变但 Skill/Reference 内容改变时仍检测为依赖变化；旧资源不能被同步原地覆盖。
4. dev-only 字段、不可用模型、缺失目录资源明确阻断，不能静默减少 Agent 能力。
5. Toolkit 保留 kind、不按 managed MCP 校验；评估结果 MCP 使用 Eval 的规范绑定。
6. 冻结副本不可更新；已有 Project 继续引用原副本；完整模式还要验证依赖字节不漂移。
7. dev 断连/401 不影响既有运行；来源删除不删除目标；不泄露私有源配置给未授权操作者。
8. SP 请求成功但响应丢失、Eval DB 写入失败、并发 apply 都可校准，不重复创建或误报成功。
9. 文件只走受信公开路径，校验字节与大小，不访问 DO/私有数据库、不将凭据发给 CDN。
10. 端到端运行时的 Chat、Submission、Workspace、计费和证据读取仍全部位于 Eval，并继续收集执行 Agent 产物和完整轨迹。

本次已运行：

```text
pnpm --filter @eval-platform/eval-api exec vitest run \
  src/agent-configs.test.ts src/agent-library.test.ts \
  src/sp/client.test.ts src/config/api.test.ts
```

结果：4 个文件、49 个测试通过。另经 Node 调用已安装编辑器的公开 `./draft` Interface，5 组检查通过：旧契约基线、三个新字段分别拒绝、旧 PATCH 形状。这些只验证现有行为，不是新同步功能的测试。

本次只新增调研文档，没有修改实现；没有运行全仓检查、PostgreSQL 集成测试或线上端到端验收。

## 10. 实施前需要产品确认的三件事

1. **来源范围**：一个共享 dev 配置库账号，还是多个个人账号/全环境？后两者需要额外授权设计，不能用新服务账号直接读全量。
2. **完整度**：先支持共同字段 + 已存在依赖，还是必须完整迁移私有 Skill、Reference、MCP 等？后者必须把 SP 契约/资源版本能力作为前置工作。
3. **编辑权**：导入目标是否允许本地编辑？建议允许，但默认遇到本地修改就冲突；若要无人值守自动更新，应明确哪些目标由 dev 单向管理，仍不传播删除。

默认建议：**一个经授权的 dev 配置库、手动单向同步、严格预检、允许本地编辑但不覆盖冲突**。

## 11. 需求收敛：仅新增 Agent 与依赖的一键导入

本节以用户确认“数据库已对齐”为前提，不重新开展数据库同步，不实现已有 Agent 的更新。补充检查时，Eval HEAD 已是 `0717bf9167009680476cf5aac9dd37d1eb312de9`，本地 SP `origin/dev` 为 `9c4158f5daa09dc7c0862a8c1a6710e19666611b`。没有访问数据库或线上文件来独立核验其数据状态；文件可读性和写契约仍在导入预检中校验。

### 11.1 页面按钮

入口放在 Agent 管理列表页右上角、“新建 Agent”旁边，不放进某一条 Agent 的编辑表单。该位置已有 `PageHeader.actions`；弹窗可复用项目自己的 `Dialog size="lg"`。[N1] [N2]

```text
Agent 管理                         [从 dev 同步] [新建 Agent]

┌ 从 dev 同步 Agent · 仅新增 ───────────────────────────┐
│ 只新增 Eval 尚未拥有的 Agent；自动导入所需 Skill 和资料。│
│ 不覆盖已有 Agent、Skill 或 Reference。                │
│                                                      │
│ 来源：已配置的 dev 账号                               │
│ 待新增 N 个 Agent · 已存在 M 个                       │
│ 所需 Skill：新增 S1 / 复用 S2                         │
│ 参考资料：新增 R1 / 复用 R2                            │
│                                                      │
│ [全选可导入项]                                       │
│ □ Agent 名称   用途       Skills   Reference   状态    │
│ □ …            执行 Agent    …        …       可导入  │
│ □ …            执行 Agent    …        …       需处理  │
│                                                      │
│ 需处理项展开显示具体原因，不减少能力后冒充导入成功。     │
│                           [取消] [一键导入所选 N 项]   │
└──────────────────────────────────────────────────────┘
```

图中数字为占位符，不是当前数据统计。默认勾选所有通过预检的缺失 Agent；已存在项仅进入统计或可展开清单。零缺失时显示“Eval 已包含所有可同步 Agent”，确认按钮禁用。一个确认动作自动处理所有依赖，不要求用户逐个导出 ZIP、上传文件或手工改资源 ID。

导入时同一弹窗切换为进度视图：`准备文件 → 导入 Skill → 导入 Reference → 创建 Agent → 完成`，展示资源数、字节进度和逐 Agent 结果。任务在后台持久化，关弹窗不表示取消；重新打开能恢复观察。结果区分别显示新增、跳过、失败和需处理项，可只重试失败项；不把部分失败显示成全部成功。

成功后刷新 `agentKeys.all`，同时刷新公共编辑器的 Skill、Reference 查询缓存，避免刚导入的依赖在选择器中缺失；缓存 key 和导入后 invalidate 的模式已经存在。[N3] [N4]

### 11.2 “Eval 没有”的精确定义

不能按名称判断。按以下顺序识别：

1. 数据已经同步过且两边保留相同 Agent ID：目标必须属于当前 Eval owner、仍可选择且不是冻结副本。
2. 曾由本功能导入：查持久化的来源身份映射，来源键包含环境连接、来源 owner、来源 Agent ID；目标通常是新生成的 Eval ID。
3. 创建响应曾丢失：用持久化的确定性导入 slug 校准，再核验 owner 和内容，不重复创建。
4. 以上均未命中，才算缺失。同名但不同来源只提示重名，不覆盖，也不把它误当成已同步。

来源默认排除平台 Default Agent、已删除/归档项和 `eval-frozen-` 副本。已有映射指向已删除或不可选择目标时显示“需处理”，不自动复活用户删除的配置。判定依赖完整分页结果，不能只读前一页资源就认定缺失。

### 11.3 只搬选中 Agent 的依赖

先对所选缺失 Agent 的 `skillIds`、`referenceFileIds` 求并集；只迁移该集合，不把整个 Skill/Reference 库搬过去。多个 Agent 引用同一个来源资源时只处理一次。

| 对象 | 已在 Eval 可用且一致 | Eval 缺失 | 已存在但不一致 |
| --- | --- | --- | --- |
| Agent | 跳过，绝不更新 | 依赖准备完毕后创建普通配置 | 不以同名覆盖；显示来源/身份冲突 |
| Skill | 核对可见性、运行名称、完整包内容后复用 | 读完整文件清单与原始字节，保留路径和 SKILL.md，生成包并安全创建 | 同名内容不同则阻断关联 Agent，不覆盖、不擅自改名 |
| Reference | 内容、文件名、类型、状态等语义元数据一致才复用 | 读取原始字节，上传 Eval 附件，再创建 Eval Reference | 创建独立记录；若现有 Interface 无法表达独立记录，则阻断，不改已有文件 |

Skill 的摘要应基于规范化的“路径 + 文件大小 + 每文件 SHA-256”清单，不以 ZIP 压缩结果判断等价；Reference 既核对字节，也核对会影响工作区文件表现的元数据。文件内容通过公开文件地址读取，不直接访问 SP 的 R2/数据库，也不把 dev 文件 URL 当作 Eval 已有文件。

现有公开 Interface 已提供 Skill 文件清单/上传、附件上传和 Reference 创建；Reference 应走“上传目标附件 → 创建目标 Reference”，而不是把源 URL 放进目标正文。[E3] [N4] [N5] [N6]

在所有依赖就绪后建立 `sourceSkillId → targetSkillId`、`sourceReferenceId → targetReferenceId` 映射，重写配置的相应数组，再通过 `AgentConfigService.create` 创建 Agent、保存用途并核验结果。不能创建一个暂时缺依赖的 Agent，再让前端逐步补齐。

用途默认“执行 Agent”，弹窗可批量改为“评估 Agent”；不从当前列表筛选条件推断用途。评估用途仍绑定 Eval 自己的结果提交 MCP。Action、Extension、Connector Toolkit 等已对齐的平台选择只验证后复用；普通用户 MCP 缺少目标有效绑定时阻断该 Agent，不复制凭据，也不静默移除选择。

### 11.4 必须补的最小能力：Skill 的原子 create-only

当前 Skill 上传会在事务中查找同名 Skill，然后调用 replace；只在 Eval 先查询一次“没有同名 Skill”不能保证不覆盖，因为另一请求可能在检查后抢先创建。[N5]

建议在目标 SP 的既有 Skill 上传 Interface 增加可选模式，例如拟议的 `POST /api/skills?mode=create_only`：

- 普通编辑器不传参数时保留原有行为。
- 导入模式在 SP 所属 Model 内利用现有名称唯一约束，原子地只插入、不替换；同名竞争返回 409。
- 导入方遇到 409 后只读核验已有内容：完全一致就复用，否则将关联 Agent 标为依赖冲突。
- 超时后用持久化的资源意图和内容摘要校准，不再调用普通 upsert 作为“重试”。

这不需要把导入逻辑搬进 SP，也不要求重新对齐数据库；它只是在现有公共写 Interface 上提供“保证不覆盖”的语义。在这个保证补齐前，不能声称仅靠普通上传接口就能安全一键导入所有 Skill。

### 11.5 后端执行形态

建议使用同一个导入 Module 的“检查/确认”两阶段 Interface，而不是一个长时间运行的同步 HTTP 请求。以下均为拟议路由：

| 路由 | 行为 |
| --- | --- |
| `POST /api/agent-config-sync/previews` | 创建检查任务，返回 202 和 `syncId`；后台读取来源、核对目标、固定配置和文件 manifest，不写 SP |
| `GET /api/agent-config-sync/{syncId}` | 返回检查结果、可选 Agent、依赖计数、进度和逐项结果 |
| `POST /api/agent-config-sync/{syncId}/apply` | 提交所选 Agent 和幂等键，应用已检查的快照，返回 202 |

检查阶段可以将已授权文件暂存到带容量和过期限制的 Eval 临时目录，避免大文件核验卡住网页请求。预览过期、来源快照不完整或目标依赖已变化时重新检查；不能在用户确认后换成另一版来源内容。

已有 pg-boss 基础可复用，但使用独立的 `eval-agent-imports` 队列和导入消费者，不塞进 `eval-runs`，不让 Agent 运行进程获得 dev 会话。[N7] 导入消费者和 API 仍属于 `apps/eval-api`，不新增 workspace 包。

持久化任务和逐资源映射：`来源连接/owner/种类/来源 ID → 目标 ID + 内容摘要 + 写入回执`。同一 Eval owner 的导入任务串行或受同一数据库租约协调；目标原子 create-only 和名称唯一约束处理其他入口的并发。已有对象不更新、不删除；重试先检查已完成回执，成功资源保留复用。

失败按依赖影响范围隔离：Skill A 失败，只阻断依赖 A 的 Agent，其他独立 Agent 可以继续。成功写入资源但 Agent 创建失败时保留资源映射供重试，明确报告留下的资源，不自动删除。Agent 创建或用途落库结果未知时保留待校准状态，不展示成功，也不换新身份重建。

### 11.6 实施范围与剩余配置

需要改动的是 Agent 列表入口/导入弹窗/SDK、Eval API 导入 Module 与任务/映射持久化、独立队列消费者，以及目标 SP Skill 上传的 create-only 契约与 focused tests。初版不做已有 Agent 更新、资源覆盖、自动删除、定时同步、双向同步或全库搬迁。

来源账号是唯一还需要落实的连接配置：使用固定的、被授权读取目标 Agent 与私有依赖的 dev 身份，不能因为数据库对齐就假设 Eval 会话能读 dev。浏览器只调用 Eval API，不提交凭据或任意 owner/origin；导入数据归属 Eval 当前服务账号。本节是设计补充，没有实现按钮、执行导入或更改部署。

## 12. 本轮收敛：统一 ID 的仅新增导入与 Eval 原生隔离

### 12.1 当前范围、前提与证据

**用户前提**：dev、Eval 均未上线。本轮只研究手动触发的 dev → Eval 缺失 Agent 导入，以及这些 Agent 必须的 Skill / Reference；Eval 可以有 dev 没有的原生 Agent。不做已有对象更新、删除传播、双向同步、全库搬迁、资源改名或 namespace 大迁移。未来扩展更新须另行设计并获批准，不能借“同步”按钮顺带开放。

**用户硬约束（2026-10-21）**：dev 数据不可变更，不能在 dev 创建分享记录、上传文件、补来源标记、更新/删除配置或复活对象。来源 Adapter 只暴露经核实无写副作用的读取能力，不因 HTTP 方法叫 GET 就认定只读；例如历史分析中的分享 ZIP 生成不能用于这条链路。写客户端固定连接 Eval，来源字段只写 Eval 内部元数据，不增加页面来源列、标签、筛选或可编辑表单项。

本节整合三个只读报告：身份/来源域模型（`511d29e1`）、SP 资源导入原子性（`2d876ceb`）、UI 与异步工作流（`794c92f3`）。报告由主 agent 转交，关键结论再用本机固定 Git 对象核对。以下明确区分 **【事实】现有源码行为**、**【推荐】拟议设计**、**【待确认】尚未获批准的选择**，不把报告中的建议当成用户授权。

| 本地仓库 | 本轮固定对象 | 证据含义 |
| --- | --- | --- |
| `/Users/apple/code/eval-platform` | `0717bf9167009680476cf5aac9dd37d1eb312de9` | Eval API、用途表、冻结、管理页与队列源码 |
| `/Users/apple/code/sp-platform` | `316b3ec1299e5350604d229b42d18290db4aa61c` | 本机检出 HEAD 的 SP 契约、Model 与编辑器源码；不声称已合入 dev / eval |
| SP 本地跟踪引用 | `origin/dev = 9c4158f5daa09dc7c0862a8c1a6710e19666611b`；`origin/eval = 2990fba62f057152b79af3fc150c0c4ba8d93e8b` | 仅记录有效引用解析结果，不代表发布状态，也不据此推断人为回退 |

本轮未联网、fetch、读取秘密或访问数据库，未执行导入、重置、迁移、部署或线上验证。后文 `U` 系列引文均按上表固定 SHA 核验：SP 路径相对 SP 仓根，Eval 本地链接相对本文；原有 `E/S/N` 引文仍属于前面的历史基线。没有“未上线所以无存量”的假设，既存记录、软删除记录和不明来源对象都必须被安全处理。

### 12.2 统一 ID 与隔离不变量

**【推荐，按本轮明确要求约束实现】**

1. **真正同 ID**：对导入的可编辑 Agent、用户 Skill、Reference，严格满足 `sourceId === targetId`，相关 `skillIds`、`referenceFileIds` 保留原 ID 与语义顺序。Agent 与 Reference 按已有 UUID 边界校验；Skill 的公开契约实际是长度 1–255 的稳定字符串，用户上传通常生成 UUID，但平台 Skill 不必是 UUID，不能一律换号。[U1] [U2] [U24] [U25]
2. **身份不统一权限**：目标 owner 只来自目标认证，仍是 Eval 服务账号；来源 owner 只是来源与审计事实。不得复制 dev 的 `user_id`、Session、MCP token、OAuth 或个人连接，也不要求两边账号 ID 相同。现有 Eval 请求作用域已经由固定服务身份注入。[U22]
3. **来源持久化，不按集合猜测**：Eval 新建 Agent 时内部记录 `eval_native`；本功能创建且有合法导入证据时内部记录 `dev_import`。历史缺记录在内部保留未登记状态，既不能归入 Eval 自建，也不能因 ID 在 dev 出现就归入 dev 导入；这些来源值不展示给页面。dev 后续删除、不可见或断连不改变既有来源；同 ID 同内容的预存对象也不自动“收编”。
4. **原生 Eval 对象不参与源侧对齐**：不覆盖、删除、改 ID、重标来源或反向导出为同步写入。原生对象碰巧与源 ID 冲突时，阻断该导入，不把它当成缺失对象，不用另一个 UUID 绕过冲突。
5. **仅新增不是更新协议**：已导入 Agent 的来源内容变化、目标本地变化或依赖漂移都只报告，不发 PATCH、replace 或复活请求。新 Agent 所需依赖若同 ID 但内容不一致，阻断依赖它的 Agent，不能因为“ID 已统一”而直接复用。
6. **冻结副本是另一对象**：Project 冻结继续新建 Eval UUID 和 `eval-frozen-` 副本，保留来源可编辑 Agent 的引用快照；不能把 `sourceAgentId` 当作冻结副本 ID。这与可编辑对象跨环境同 ID 不冲突，现有 `freeze()` 就是克隆新 SP 配置。[U17]
7. **不擅改本地编辑行为**：延续前轮“导入 Agent 可本地编辑”的默认建议；来源不随编辑改变，当前目标摘要偏离导入时的 `appliedTargetDigest` 则在内部记录本地修改状态，不加来源徽标。仅新增流程永不覆盖它。需要长期独立演进时，推荐用户显式创建新 ID、内部来源为 Eval 的独立 fork，而不是强制将现有导入项变只读或自动 fork。
8. **不声称冻结了全部依赖**：普通 Skill 上传仍可替换同名资源，Reference 也能替换当前内容指针；仅保护导入通道，不能保证其他本地编辑入口永不改变后续 Run 的资源内容。永久只读或完整依赖版本冻结属于另需确认的能力，不能在本轮暗中改变现有编辑语义。[U6] [U23]

平台 Skill、Action、Extension、Connector 等目录对象只核验目标同 ID、种类、可用性和内容/版本，不用用户导入凭据把平台对象改成用户对象。缺失或不一致的目录能力先阻断，不把本功能扩大为目录发布或重建。

### 12.3 来源、owner、purpose 与版本分别建模

| 维度 | 【推荐】记录与约束 | 不能混用的概念 |
| --- | --- | --- |
| 对象身份 | `resourceKind + id`；导入绑定中源、目标 ID 必须相等 | 名称、slug、摘要、revision 都不是另一个身份 |
| 来源身份 | 服务端固定的部署 namespace / connection ID、经认证的来源 owner、资源种类与源 ID；凭据轮换不重建来源 | 不能仅用 `RUNTIME_ENV`、Git branch、当前 dev 成员集合或 URL 文本猜来源 |
| 目标归属 | 由目标认证得到的 Eval owner，所有查询、任务、绑定按该 owner 限定 | 不把来源 owner 写成目标 owner；跨 owner 同 ID 冲突也不换号 |
| Eval 用途 | 现有 `execution` / `evaluation`，用户显式选择，默认建议“执行 Agent” | 来源不是用途；dev 导入既可用于执行，也可用于评估 |
| 配置版本 | 分记来源实际提供的 `sourceRevision` 与目标 `targetRevision` | 两边 revision 不要求相等，不用源 revision 发目标 CAS |
| 内容证据 | `sourceDigest`、经用途等目标规则归一化后的 `appliedTargetDigest`，以及独立依赖 manifest / 摘要 | 同 ID 不证明内容等价；同摘要也不证明来源；无公开 revision 的资源不虚构 revision |

**【事实】** Eval 的 `eval_agent_config_purposes` 是 owner + Agent ID 的用途事实源，并非来源表；管理页当前也是用途筛选。[U18] [U19] **【推荐】** Eval 增加内部来源字段及必要导入证据，不向普通列表/编辑表单提供来源展示字段，不新增第二份可编辑配置正文，不改变 `AgentPurpose`、`AgentOption`、`AgentConfigRef` 或 Subject/Evaluator 公共契约。用途归一化、冻结保护与角色校验继续由现有 AgentConfig 所属服务统一拥有，不能在导入入口复制一套。

来源连接必须固定到被授权账号及可传播到 Eval 共享账号的范围，认证核对 source owner。导入弹窗可以选择服务端授权清单中的来源用户，服务端解析其连接及 source owner；浏览器不能提交任意 owner/origin 取得越权读取能力。普通 managed MCP 只验证或显式绑定目标有效连接，不迁移凭据；评估用途使用 Eval 自己的结果提交 MCP。`kind: "connector_toolkit"` 仍按 Toolkit 验证和保留，不能当普通 MCP catalog ID 过滤掉。来源字段 unsupported、模型/连接不可用时阻断，不静默删能力。

### 12.4 导入生命周期矩阵

下表是**推荐行为**，不是已经存在的状态机；“缺失”按真实 ID 与持久记录判断，不按名称或只读到的一页列表判断。SP 导入端还必须最终检查列表不可见的占用、墓碑及并发竞争，Eval 不因此直读 SP 库。

| 来源 / 目标情形 | 本轮动作 | 保留与结果 |
| --- | --- | --- |
| 来源可读、可导入，目标确无同 ID、历史绑定或墓碑 | 预检所选依赖闭包，依赖就绪后按源 ID 创建 Agent | 记回执、来源、用途后才完成 |
| 有合法既往导入证据，同 ID、内容/语义一致且可新选 | Agent 跳过；必要依赖可复用 | 不写 SP、不递增 revision，不改来源 |
| 已导入 Agent 的源 revision / 内容已变 | 跳过该既有 Agent，提示“来源已变化” | 不更新目标；不提供“强制同步” |
| 已导入目标被本地编辑 | 跳过并标记本地修改 | 不覆盖，不抹掉原导入证据 |
| 新 Agent 依赖同 ID 但内容、名称语义或可用状态已不同 | 阻断受影响的 Agent | 不替换该资源；其他独立闭包可继续 |
| 目标同 ID 是 Eval 自建，或来源未登记/无合法导入证据 | 不是缺失；显示身份/来源需处理 | 保留已有来源；同内容也不自动登记为 dev |
| 绑定指向已删除、停用或不可选择的目标；或同 ID 属于其他 owner | 阻断、待核验 | 不复活、不抢占、不换新 ID |
| dev 删除、归档、取消授权或不再列出已导入对象 | 保留 Eval 对象与 Project | 记录来源当前不可用/已移除，不传播删除 |
| dev 超时、401/403、列表分页不完整 | 预览不可确认，不应用 | 不当成零缺失、来源删除或 Eval 自建证明 |
| Eval 原生 Agent 在 dev 中不存在 | 完全不进入导入写集 | 原有配置、用途、编辑与 Project 行为不变 |
| Default Agent、冻结副本或保留 slug | 不作为普通导入候选 | 不绕过默认配置/冻结保护 |

### 12.5 同名异 ID、同内容异 ID 与复用规则

**【推荐】第一版阻断身份或唯一约束冲突，不自动合并或改名。** 名称和内容用于发现冲突、检查等价，不替代身份；尤其不能把源数组改成一个“内容一样”的 Eval 资源 ID。不同 ID 代表不同逻辑对象，若目标约束允许，可以保留源 ID 独立创建，不需要为了“去重”阻止本来合法的缺失对象导入。

| 相遇情形 | 本轮规则 |
| --- | --- |
| 同 ID、同内容、owner/状态正确，且有合法导入回执/绑定 | 可重放或复用；仍核验当前内容，回执不是永久无漂移证明 |
| 同 ID、同内容，但目标是原生或来源不明 | 不自动认领来源；既有 Agent 不算待新增，必需依赖默认列为需处理 |
| 同 ID、内容不同，或种类/owner 不符 | 冲突，不覆盖、不再生成 UUID，不把不同 revision 当成同一内容 |
| Agent 同名异 ID | 按不同对象处理；源 ID 缺失且约束通过即可独立创建，预览提示重名，采用确定性导入 slug，不覆盖 Eval 同名配置 |
| 用户 Skill 同名异 ID，内容不同或相同 | 现有 owner + 运行名称唯一约束冲突，阻断关联 Agent；不 alias、不自动改 `SKILL.md` 运行名、不扩大 namespace |
| Reference 同名或同内容异 ID | 不合并身份；按源 ID 创建独立 Reference，使用该 ID 作为内容发布 salt，目标约束和授权必须通过 |
| 相同内容异 ID 的一般规则 | 不能借数组重写复用另一逻辑对象；保留各自 ID，按所属对象的真实约束决定独立创建还是冲突 |
| 需要修改既有对象 ID、认领旧来源或放宽 Skill 名称约束 | 不属于仅新增导入，须另行明确审计、迁移或 namespace 方案，不能作为自动去重手段 |
| 物理文件内容相同 | 只允许在 blob/对象存储层去重，不合并库记录、owner、来源或资源 ID |

**【事实】** Agent 的 owner + slug 唯一索引连软删除记录也保留占用；用户 Skill 的 `owner + lower(name)` 唯一约束只覆盖未删除行，且用户 Skill 的 slug 等于 ID；Reference 的 `content_key` 全局唯一。[U5] [U7] [U8] [U12] 因此不能把所有“同名异 ID”都当成相同约束冲突。第一版不做 Skill namespace 大迁移；Agent 和 Reference 可以按原 ID 独立创建，不等于合并或收编任何 Eval 既有对象。

### 12.6 最小公共 SP 导入契约：指定 ID、原子插入、绝不覆写

**【事实】现有普通创建路径不足以承诺统一 ID：**

| 对象 / 路径 | 固定版本源码行为 | 本轮缺口 |
| --- | --- | --- |
| SP Agent 普通 create | 严格输入只有 slug/name/description/setting；Model 内 `createId()`，按 owner + slug 返回既有行。[U3] [U4] | 不能指定源 UUID，slug 重放也不能证明完整 payload 相同 |
| SP Skill 普通上传 | 生成新 ID；同名则 replace；名称唯一竞争失败后重试仍可能 replace。[U6] | “先查没有再上传”不安全，不能作为导入重试 |
| SP Reference 普通 create | 内部生成 ID；content key 冲突会 `onConflictDoUpdate` 清除 `deleted_at`。[U11] | 会合并身份或复活记录，不是 create-only |
| Eval `AgentConfigService.create` | 调普通 SP create；用途保存失败时尝试删除已创建配置。[U16] | 不能原样复用为可恢复导入，否则 ID 与不自动删除约束均不成立 |

**【推荐】** 第 11.4 节“只补 Skill create-only”的范围已经不够。由 SP 各自所属 Model / 公共契约增加三个通用导入操作，普通 CRUD 和上传语义不变；它们不是 Eval 专用业务，也不把 Eval 任务、purpose 或运行逻辑搬进 SP。以下路由与字段仅为拟议：

| 拟议公共路由 | 必要输入与边界 |
| --- | --- |
| `POST /api/skills/imports` | `skillId` + ZIP + 稳定导入键；按现有 SkillId Schema 校验，保留文件路径与运行名；面向被授权的用户 Skill，不发布平台目录 |
| `POST /api/user-references/imports` | `referenceId` + 已上传到目标的临时 `publicAttachment` + 稳定导入键；不接受 dev URL 充当目标附件 |
| `POST /api/user-agent-configs/imports` | `id` + slug/name/description/setting + `importKey`；slug 可为确定性 `import-<sourceAgentId>`，只作为目标创建身份，不改显示名或替代真实 ID |

三类都需明确同一套幂等/请求指纹与回执语义，owner 只能取目标认证。服务端自己解析 Schema、校验文件并计算摘要，不能相信客户端声称的 owner/hash。返回至少含真实 ID、已提交操作回执、请求指纹与是否重放；不能只有“上传成功”。全局 ID 命中其他 owner 时只返回安全的冲突结果，不泄露该行的正文、内容摘要、版本或所有者；读回校准和回执查询同样受目标 owner 限定。

推荐的每资源写入顺序：

1. **先准备字节，不持数据库锁等文件 I/O**。只走来源已证明只读的配置/文件 Interface 和受信地址；完整读取所选 Agent 必需依赖，限制域名、路径、展开大小、文件数、超时，校验原始字节，不向 CDN 附带 SP 会话。Skill manifest 按路径、大小、每文件 SHA-256 及语义元数据规范化，Reference 核对字节、文件名、media type、大小和状态；ZIP 压缩字节不作为等价标准。摘要算法须版本化，不能假定自定义 manifest 摘要天然等于 SP 的 `content_hash`。
2. **由目标 SP 发布不可变内容，再做短事务插入**。Skill 已有 `users/{targetOwner}/skills/{sourceSkillId}/versions/{contentHash}` 内容路径，以及检查既有字节、写后读回的发布 helper；新导入操作应在事务外使用，不沿用普通上传事务中发布再 replace 的流程。[U9] [U10] Reference 已有 `promoteUserReferenceFile(..., identitySalt)`，按 owner、名称、类型、大小、SHA-256、salt 派生内容 key，`putIfAbsent` 后读回验哈希；可使用源 Reference ID 作 salt，避免不同逻辑 ID 只能落在同一 content key 上。[U13] **salt 是内容地址材料，不是另造目标 Reference 身份，库行 ID 仍等于源 ID。**
3. **原子 insert-only**。在 SP 所属 Model 内短事务插入指定 ID 的行，并原子记录该操作的回执；PK、owner/slug、Skill 名称、content key、导入键等竞争全部按已知约束返回可识别的 409。严禁 replace、`onConflictDoUpdate`、清除 `deleted_at`，也不能捕获唯一冲突后降级普通上传。内容已发布但行插入失败时可以留下不可变 blob，不改任何既有库记录。
4. **只重放有证据的同一操作**。同导入键、同请求指纹、同 ID/owner、目标仍有效且内容匹配，并有合法持久回执才是 replay；内容不同、身份占用、已删除/停用或无回执不能假装成功。Agent 写入仍通过原有目标模型/资源选择校验；现有校验会检查 Skill 可选性、重复运行名及 Reference 归属/总大小，新导入还应明确拒绝禁用 Reference，而不是静默遗漏。[U14] [U15]
5. **不承诺跨对象或跨库事务**。单对象行与其回执的原子性，不等于 Skill、Reference、Agent、Eval purpose 一起提交。指定 ID 的基础插入可复用现有列与唯一索引，但可靠回执/来源恢复是否需补 SP 持久结构须另审。Agent 已有 owner + `import_key` 唯一约束可复用，却不等于三类完整回执，更不证明 dev 来源；不能同时承诺“零 schema 变更”与“任意故障下来源都可证明”。[U5]

Eval 导入应扩展现有 AgentConfig 所属服务的导入操作，共用用途归一化、冻结保护和目标验证，不复制一套服务，也不绕到资源通用转发表直接创建 Agent。新操作不能继承普通 create 的自动删除补偿；普通 create 的原有行为不在本轮擅改范围内。[U16] [U28]

这里的“删除补偿”具体指：普通创建先在 **Eval SP** 建配置，再在 **Eval PostgreSQL** 保存执行/评估用途；后一步失败，现有代码会尝试删除前一步返回的配置。它不是删除 dev 数据。导入则需要保留已确认写入的 Eval 对象和任务进度，等用途/来源记录恢复后补齐；结果不明时先查回执，不能因为一次本地数据库失败就删除已导入对象，或重建另一个 ID。所谓扩展所属服务，只是在现有 Agent 管理模块中增加导入操作，复用规则，区分失败处理。

### 12.7 UI：只增加导入入口，不展示来源

**【事实】** 当前 `agents-page.tsx` 的 `PageHeader.actions` 只有“新建 Agent”，现有 tabs 是全部/执行 Agent/评估 Agent；这不是来源分类。[U19]

**【推荐】**

- 在“新建 Agent”旁增加“从 dev 导入”，沿用第 11 节列表级弹窗位置，文案明确“同 ID、仅新增、不覆盖”。保留现有用途筛选和 Agent 列表，不加来源列、标签、筛选、分区或编辑项；不能把 `AgentPurpose` 扩成来源枚举。
- 来源只保存在 Eval 内部字段和导入证据中，用于隔离、幂等及恢复，不塞进 SP setting、前端可编辑正文或普通列表 DTO。dev 断连不影响已知内部来源，未登记不影响既有合法用途事实。只有可证明由本任务新建、尚未收尾的对象才按导入中/待校准暂不进入新 Project 可选项，不能靠首次读取自动补 purpose 就冒充完成；不得仅凭一个待校准意图就隐藏或锁住同 ID 的原生/未登记预存项。
- 弹窗列出源 ID、名称、目标存在状态、用途、必要资源新增/复用数与阻断原因；只默认勾选通过预检的缺失 Agent。用途显式选择，默认建议“执行 Agent”，不从当前列表 tab 或来源标签推断。零可导入、未配置来源、来源不可用、冲突必须区别展示，不能把授权/分页失败显示成“全部已同步”。
- 一个确认动作执行依赖闭包；任务视图区分检查、文件准备、Skill、Reference、Agent、用途/回执收尾，以及新增、跳过、失败、需处理和结果待校准。关闭弹窗不取消任务，重开按任务 ID 恢复；轮询只读任务状态，不自动重放写请求。不减少配置能力冒充成功，部分失败不显示全成功。
- 完成后刷新 `agentKeys.all`、任务状态，以及公共编辑器的 Skill、Reference 查询缓存；不新增来源展示查询或来源筛选缓存。核对实际消费版本的公开 `skillQueryKeys`、`userReferenceQueryKeys`，不另造不兼容 key。相关公开 keys 与 Eval Agent keys 已存在。[U20] [U26] [U27]

### 12.8 任务、幂等、回执与跨库恢复

**【推荐】** 延续第 11.5 节 `preview → apply → GET task` 的异步 Interface，返回 202 与稳定任务 ID；不是在按钮请求中完成长时间下载。预览只读取 SP，可在 Eval 持久化受保护计划，原始字节暂存于受容量、权限、过期时间限制的 `EVAL_BUNDLE_DIR/imports`。计划绑定已校验的配置、每个依赖 manifest/字节、Schema/转换版本与目标用途，确认后不暗换成另一份“最新”内容；过期、不完整或目标前提已变须重检。普通多次 GET 的组合不宣称是同一数据库时点的原子源快照，若要求该保证，须由 SP 正式导出契约提供。

| Eval 应用侧持久事实（表名待实现设计） | 最小职责 |
| --- | --- |
| 来源登记 / `import_bindings` | 目标 owner、种类、同 ID、明确原生创建或导入来源、固定来源键、合法回执关联；覆盖原生 Agent 创建，不从列表差集回填来源 |
| `tasks` / 预览与 apply 请求 | actor、目标 owner、固定计划、选中集合、purpose、幂等键、请求指纹、计划期限与阶段；不是第二份可编辑配置库 |
| 逐资源意图与结果 | 在远端写前保存 ID、预期 payload/依赖摘要、导入键；写后存目标 revision、回执、已验证摘要、错误及依赖影响范围 |
| 持久认领 / CAS / 租约 | 多进程认领与过期恢复，同 owner 导入写集协调；不把进程内锁或队列 `singletonKey` 说成全局 owner 租约 |

指纹绑定来源 namespace/owner、目标 owner、种类/源 ID、固定内容/依赖摘要、Schema/转换版本、选中集合及用途；源配置摘要与目标用途/MCP 归一化后的摘要分别记录，数组顺序按语义保留。相同幂等键与相同指纹重放原任务，不同指纹返回冲突；更换任务 ID 不能绕开同源/同 ID 约束。

复用 pg-boss 基础设施，但使用独立 `eval-agent-imports` 队列和独立导入 consumer，仍属于 `apps/eval-api`，不新增 workspace、不塞入 `eval-runs`。API/导入进程按职责最小下发来源凭据，Run Worker 不获得 dev token。来源连接是可选功能配置，未配置只禁用导入，不使普通 Eval API/Run 启动失败，更不能加入 API 必需配置名单。现有队列确有事务内投递能力，但 `singletonKey = runId` 只证明该 Run 的队列去重，不证明导入已有 owner 租约。[U21]

| 故障 / 竞争点 | 恢复规则 |
| --- | --- |
| 预览完成后目标被创建、编辑或删除 | SP 原子约束与内容前提兜底，转冲突/重检，不使用旧“目标缺失”结论覆盖 |
| 某依赖失败 | 只阻断依赖它的 Agent，其他独立闭包继续；成功依赖保留供同意图重试 |
| SP 写成功但响应丢失 | 用原导入键/ID查询公开持久回执与目标事实；可证同一操作才推进，不换 ID 或新建 key 重试 |
| SP 成功但 Eval 来源/用途落库失败 | 原意图保留，进入收尾/待校准，重试本地提交并核验目标；不自动删除已创建资源 |
| 只有“同 ID 同摘要”，拿不到合法回执/来源证据 | 保留 `outcome_unknown` 或来源未登记，不能把内容相同升级成来源已证明；阻断本次导入的继续写入/成功判定，不收编或改动预存对象 |
| API/consumer 崩溃、任务重复投递 | 任务/意图与入队尽量同一 Eval 事务；持久认领/CAS/租约恢复，逐项先查回执，目标唯一约束为最终防线 |

SP 与 Eval PostgreSQL 不能伪装成一个事务，也不持 Eval 行锁等待 SP/对象存储网络。推荐 SP 将“指定 ID 的 insert + 操作回执”原子提交，并提供目标 owner 范围的公开回执查询；回执再与 Eval 写前意图绑定，才能证明受信导入操作，而非仅信浏览器的来源声明。若只交付无持久回执的最小插入路径，必须接受部分故障无法自动定案的边界，不能宣称完整恢复。成功资源、未知结果及留下的资源均需如实报告，不以自动删除补偿掩盖部分成功。

### 12.9 精炼实施顺序

以下是**推荐实施顺序，不是本轮修改或部署授权**：

1. 确认来源授权范围、稳定部署身份、导出视图与回执方案；进入实现前先在所属现有边界/公共 HTTP 契约中落定行为，本研究不新建 ADR/CONTEXT。
2. 先补 SP 三类指定 ID、create-only、冲突和持久回执契约及 focused tests，公开发布/升级必要契约包；普通创建、上传、编辑语义保持原样，不先做可降级为新 UUID 的按钮。
3. 在 Eval AgentConfig 所属服务接入导入操作；建立原生来源登记、同 ID 绑定、任务/意图、幂等与可恢复收尾，防止来源事实靠当前 dev 列表推导。
4. 做严格预检、必要依赖并集、字节/manifest 固化、受限暂存和独立队列 consumer；只有依赖与目标授权都就绪才创建 Agent，不直接调用 SP 私有库/DO。
5. 最后接列表级导入入口、用途选择、任务恢复与缓存刷新；来源字段仅内部使用，保留现有页面筛选、编辑和 Project 冻结路径。
6. 在明确授权的测试环境验证并发与故障恢复，再做完整 Eval 运行验证；不因两边未上线就执行 reset、批量换 ID 或未经授权迁移。

### 12.10 尚待确认的选择与默认边界

- **来源授权与传播范围**：具体 dev 账号、Agent 范围及私有依赖读取授权仍需确认；固定 Eval 账号的共享可见性也要获准。不能用一个新账号、DB 对齐或相同 UUID 推导已有授权。
- **源导出语义**：采用公开有效配置视图，还是要求原始保存正文与原子源快照？后者需 SP 正式导出能力。默认不宣称普通 GET 具有额外保证，契约不兼容直接阻断。
- **持久回执的最低交付**：推荐 SP 原子持久回执作为可靠恢复前置；若只接受最小插入能力，必须明确 `outcome_unknown` 的人工核验出口。需要哪些增量表/列由所属实现评审决定，不预先承诺零迁移，更无重置授权。
- **既存来源不明及唯一约束冲突**：是否以后允许人工审计登记旧来源，或调整 Skill 名称唯一规则，尚未批准。当前不自动收编、alias、改资源名或做 namespace/身份大迁移；Agent / Reference 在现有约束允许时按源 ID 独立创建，不能借此改动既有对象。异 ID alias 不是本方案的退路。
- **编辑策略**：当前推荐继续允许导入 Agent 本地编辑、保留来源并标漂移；独立 Eval fork 是显式隔离出口。若要求导入项/资源永久只读或完整依赖版本冻结，应另行确认范围和公共契约，不在本轮改变已有编辑行为。

### 12.11 验证矩阵与本轮验证边界

| 实现后需验证的维度 | 必须成立的结果 |
| --- | --- |
| 三类 ID 与平台 Skill 字符串 ID | 源、目标 ID 完全一致；依赖数组无 alias 重写；平台非 UUID Skill 不被换号 |
| 原生 Eval 与来源未登记存量 | 新建即内部登记；旧行不被推断为原生/dev；源删除、断连或同 ID 同 hash 不改变来源；不展示来源字段 |
| owner / 权限隔离 | 来源不可越权读；目标 owner 来自认证；跨 owner ID 占用阻断；无凭据搬迁、浏览器指定 origin/owner 或 CDN 会话泄漏 |
| 同名 / 同内容异 ID | Agent / Reference 按原 ID 独立创建且不覆盖旧对象；Skill 名称约束冲突明确阻断，无 alias、改名或 namespace 迁移；blob 去重不合并逻辑身份 |
| 同 ID 内容漂移 | 已有 Agent 不更新；必要依赖不同则阻断新 Agent；本地编辑仍可进行且可见漂移 |
| 墓碑、停用、保留 slug 与冻结副本 | 不复活、不抢占、不回退 UUID；冻结仍是新的 Eval ID |
| 与普通上传/编辑并发 | 指定 ID 插入竞争可识别；导入不调用 replace；普通入口原有行为无意外改变，不能只测先查再写 |
| 内容完整与防覆写 | 全部文件/路径/元数据摘要匹配，目标内容读回校验；Reference salt 不改变库行 ID；导入失败不改旧资源 |
| 幂等与回执 | 同 key 同指纹重放原结果；不同指纹冲突；同内容无来源证据不能当 replay |
| 响应丢失、跨库失败与进程崩溃 | 写前意图、SP 回执、用途/来源收尾可恢复；未知结果不报成功、不换 ID、不自动删除 |
| 部分失败与任务并发 | 依赖闭包隔离；成功资源可复用；多 consumer 靠持久认领与目标约束，不靠内存锁或 `singletonKey` 冒充全局租约 |
| UI 与用途 | 页面只新增导入入口，不出现来源列/标签/筛选/编辑项；缺来源凭据不影响普通列表/运行；关弹窗可恢复；刷新 Agent/资源缓存，有创建证据的导入半成品不进入新选项，原生对象不被误拦 |
| dev 数据只读 | 来源客户端不提供业务写操作；不创建分享记录、不上传/改配置/删除/复活；所有导入写请求的目标 API 都固定为 Eval |
| 来源用户范围 | 先选已授权 dev 用户，只列该用户 Agent；任务与预览绑定来源用户；切换用户清空未提交选择，越权 user key 被拒绝；平台 Skill 不误归为所选用户私有对象 |
| Eval 运行边界 | Project/Chat/Submission/Workspace 仍全在 Eval；产物和完整轨迹收集不变，原生 Agent 与已有 Project 不受导入影响 |

本轮只写本研究文档并做本地引用、固定 Git 对象、Markdown 结构/围栏及空白校验，不运行功能实现、数据库或端到端验收。第 9 节的历史测试结果不代表这些新导入契约已被测试。实现时仍须遵循仓库的 `pnpm check`，再在明确提供的测试 `DATABASE_URL` 下运行 `pnpm -r --no-bail test`；本轮没有连接数据库或读取该值。

### 12.12 Skill / Reference 数据改造与按来源用户导入

**本轮明确采用的设计方向**：三类资源都纳入 Eval 侧来源与导入回执管理，不只记录 Agent。导入弹窗先按 dev 来源用户收窄范围，再选择缺失 Agent；不把整个 dev 环境或所选用户的全部 Skill / Reference 库列出来。

**【事实】现有资源已区分所有者，不需要重新发明 user 归属字段：**

| 对象 | 当前所在 SP 业务表 | 已有 owner | 本轮不能混淆的事实 |
| --- | --- | --- | --- |
| Agent | `user_agents` | `user_id` | 源 owner 与导入后目标 owner 不必相同。[U5] |
| 用户 Skill | `components`，`kind = skill` | `owner_user_id` | 平台 Skill 的 owner 为空，不能因某用户选用了它就当成该用户上传的资源。[U7] |
| Reference | `user_reference_files` | `user_id` | 详情和列表原本就按 owner 读取。[U12] [V3] |

**【推荐】数据库改造分成两类，不再笼统承诺“现有字段都够用”：**

1. **Eval 应用数据库的来源元数据迁移**。建议用一张统一的资源来源表覆盖 Agent / Skill / Reference，而不是给三个既有业务表重复放一整套来源字段。按 `(eval_owner_user_id, resource_kind, resource_id)` 定位对象，保存内部 `origin`、`source_connection_id`、`source_user_id`、来源/目标摘要及合法回执关联。`resource_id` 就是保留的原 ID，不另存可替换身份的目标 alias；Skill ID 用现有稳定字符串类型。原生创建按真实来源登记，历史未知行仍保留未登记状态。字段不出现在普通 Agent 列表或编辑表单中。
2. **目标 Eval SP 的导入操作与持久回执**。Skill、Reference 和 Agent 都需要指定 ID 的 create-only 操作；现有主键、owner 与内容字段大多能复用，但可靠回执需要所属 SP Model 内与 insert 原子提交的持久结构。可以共用目标 SP 的导入回执表，不必每类再造一套；该结构不能与另一个数据库中的 Eval 任务表假装同一事务。仍需实际迁移设计，不称“只有按钮改造”。

两类迁移和数据写入都只能针对明确的 Eval 目标，不对 dev 执行迁移、回填来源或批量改数据。Eval 不直接修改 SP 业务表，仍由目标 SP 正式导入 Interface 落库。`source_user_id` 是另一部署中的来源标识，不应外键到 Eval SP 用户表，更不意味着复制 dev 用户和权限。

**【推荐】导入弹窗交互：**

```text
从 dev 导入
dev 用户     [搜索 / 选择已授权用户]
搜索 Agent   [名称或说明]
             [只看未导入]

选择 Agent → 检查所选依赖 → 一键导入
```

- 多个可选用户时，未选用户不拉全量 Agent；只有一个授权来源用户时可预选。一次预览/任务只绑定一个来源用户，避免“全环境全选”。
- Agent 列表使用有界分页和搜索，例如默认 20 项；选择器也只返回必要的用户标识与名称/邮箱，不转发后台用户搜索中的积分等无关资料。这里的用户选择是本次导入范围，不是普通页面展示来源字段。
- 用户改变时清空尚未提交的选择与预览，旧预览不能替换来源用户后继续 apply；已经确认运行的任务保留原 scope，不跟随弹窗变化。幂等指纹包含来源连接、source user、目标 owner 与固定选择。
- 先按用户列 Agent 元数据，选择完成后才为所选 Agent 的依赖并集生成文件 manifest / 暂存字节。不下载该用户全部 Skill、Reference，更不下载所有候选用户的资源。
- 分页选择明确“本页全选”和跨页固定的选中集合，不能把当前页当成整个来源用户的全部对象，或因一页没有缺失项就显示“全部已同步”。

**【事实与权限缺口】** 当前普通 Agent、Skill、Reference 读取从认证会话取 `user.id`，不是任意 `userId` 查询；选择其他用户不等于已有跨用户读取权。[V1] [V3] [V4] SP 已有管理员用户搜索，但它只是查用户，不能因此推导管理员会话可通过普通配置接口读取该用户的私有 Agent / Skill / Reference。[V2]

因此第一版来源选项应来自已授权连接/用户清单：使用对应用户的已有授权读取能力，或者由 SP 提供明确授权且无写副作用的只读导出能力；不能做用户冒充、创建新 dev 会话、修改角色或直连 dev 数据库作为隐式前置。当前 Agent 列表还是 owner 下的数组契约，真正的源端搜索/分页并未现成提供；大规模使用时需要增加只读检索契约，不能把先拉全量再切片宣传成后端分页。[U25] [V1]

**目标 user 与来源 user 必须区分**：本期按来源 dev user 控制候选范围，目标仍沿用当前固定 Eval SP 服务账号，不悄悄改成每个人一个 Eval owner；当前请求中间件明确固定该身份。[U22] 如果 dev 用户 A/B 各有一个同名不同 ID 的私有 Skill，两者导入到同一个 Eval owner 仍可能触发现有名称唯一约束。按来源用户分页和增加 `source_user_id` 不会消除该冲突；第一版明确阻断，不覆盖或改名。若未来要求目标也按用户彻底隔离，需单独设计 Eval 身份、凭据、owner 路由与运行权限，不是一个隐藏字段能完成。

本节为调研设计补充，未修改三类业务表、用户权限、接口实现或部署，未对任何数据库执行操作。

## 13. 实施落地与启用边界

已按本次确认的“同 ID、单向仅新增、dev 只读”实现跨仓代码：

- Agent 页面新增“从 dev 导入”，先选择授权源用户，再搜索和分页选择 Agent；预览依赖与冲突后显式确认。关闭、刷新或重新进入页面只按任务定位指针 GET 恢复，不自动重发导入。
- SP 的公共导出/导入 schemas 位于 `@springbrand/agent-contracts/agent-config-export` 和 `@springbrand/agent-contracts/agent-config-import`；Model 负责只读快照与 create-only 原子回执，不引入 Eval 用途或任务数据。
- Eval 统一记录三类资源的内部来源、任务、写前意图与回执；普通 Agent DTO、列表和编辑器不增加来源列、标签或筛选。未有可靠证据的旧对象不自动认领。
- 独立 import Worker 使用冻结快照和完整文件哈希；来源只发 GET，目标写入前检查专用导入能力。Task/enqueue 同事务，preview/apply 使用分开的稳定队列键；响应不确定或本地收尾失败保留远端对象，按原身份核验后继续。
- 普通新建仍调用原 SP create，不依赖导入开关。只有 `X-Agent-Config-Created: true` 才登记新的 `eval_native`；slug 重放或旧 SP 缺失 header 不作为新建证据。
- SP 在只读导出投影中统一补齐合法缺省字段，再冻结来源配置和目标摘要；目标写入、重放也复用同一公共规范化规则，不在写成功后放宽相等比较。来源业务数据不变。
- Action、Connector Component、Extension 的所选依赖并集提供 `{kind,id,fingerprint}` 公开定义证据；目标只读查询和创建事务分别复核，回执也核验当前定义。缺证据或版本不一致时阻断对应根，不发布目录、不迁移凭据。Connector 证据不代表对远端 MCP 动态行为的冻结。
- 已知回执 409 保留为冲突；单个路径异常只阻断依赖它的根；停用来源不影响原 owner 只读查看持久化任务。用户搜索先输入非空名称或邮箱，API 在本地拒绝空查询，不向来源发无效请求。

启用前仍须完成运维验收：源端专用 token 与明确用户范围、目标 Eval 服务账号允许列表、目标 SP 回执接口，以及独立 Eval 内容域名/bucket 绑定。迁移文件已生成，但本次没有执行数据库迁移、部署或真实导入；也没有配置真实凭据或修改 dev 数据。完整部署条件见 [Eval SP 部署说明](eval-sp-deployment.md)。

源快照要求全部所选对象可读；若源对象本身已失效或越权，整批检查失败而不静默省略。完整快照内的目标能力、文件或资源冲突则在任务中按依赖关系阻断对应 Agent。需要扩充的 CDN 来源只能经运维审查固定配置，不能由浏览器或导出内容自行授权。

## 14. Review 修复验证记录

本节记录前 7 类 Review 问题的修复验证，保持源只读、目标 create-only、固定 Eval owner 与普通新建隔离。验证基于两个仓库的未提交工作区，不代表已发布；追加的附件并发修复结果见第 15 节：

- 两仓 `pnpm check` 通过。Eval 全量测试 1,745 通过、107 跳过；未提供 `DATABASE_URL`，不把跳过用例算作数据库验收。
- SP `agent-contracts` 107 通过；API 653 通过、536 跳过，另有 5 个既有充值 mock 失败（缺少 `c.get`），不是导出/导入失败。
- 扩大到 SP 全仓后，另发现 Creation 1 个、Web 22 个失败；已在 `git archive HEAD` 的临时隔离副本中使用同一套已安装依赖复现，未修改这些业务及测试。全仓因此仍非全绿。
- SP AWS 部署预检 8/8、Eval 部署凭据隔离 7/7 通过。`AGENT_CONFIG_EXPORT_TOKEN` 只注入 SP API；Eval 的来源凭据只供 API/import Worker，Run Worker 不获得来源凭据。
- 离线串联 SP 实际公共导出 Schema、Eval source adapter、Eval target adapter、SP 实际导入 Schema 通过：缺省字段进入冻结配置前已规范化，所选能力证据随请求原样保留；使用内存假传输，无真实 HTTP 或数据库操作。
- 两仓 tracked/new-file 空白检查通过。未执行真实数据库迁移、并发/断点恢复验收、域名/R2 绑定验证、部署、包发布或真实导入；临时基线副本已清理，既有工作区未回退。

## 15. Attachment 并发与幂等收敛

补充检查发现：普通附件上传以 `head` 判空后调用无条件 `put`，不能保证两个并发请求不会互相覆盖。Reference 导入也调用此公开上传入口，因此应在上传 Module 修复既有的不可变对象约束，而不是在 Eval 加锁、换 ID 或另建上传路径。

- 原子创建唯一使用 SP 现有 `ObjectStore.putIfAbsent`；R2 和内存适配器分别负责条件写入的原子性，不另造锁或状态表，不保留 `head → put` 的兼容分支。
- 上传 Module 继续负责字节准入和身份校验。条件创建未写入时，只有现存对象的 owner、附件 ID、名称、规范 MIME、大小及字节 SHA-256 全部一致，才是同一次上传的幂等重放。元数据缺失、不匹配或此时对象已消失均返回冲突，不补写、不覆盖。
- HTTP 沿用共享错误目录的 `409 REQUEST_CONFLICT`。Eval 在已有目标错误翻译处保留结构化的确定性冲突；未知 409、非标准响应、鉴权和网络故障不被伪装成已知冲突，也不据此宣称成功。
- 新增测试面已获确认：公开附件上传入口验证不同内容竞争、同内容并发重试和后续重放；Eval target adapter 验证上传冲突及未知故障的区分。测试使用既有内存存储/假传输，不访问真实 R2 或数据库。

这项收敛不改变 Reference 身份、导入回执、普通附件删除规则或来源权限，也不引入新的领域名词、Schema、迁移及后台恢复状态。它让现有基础设施承担其已声明的契约，而不是给导入调用者增加一个补丁。

追加验证：并发 HTTP 回归先复现两个 `200`，修复后稳定为 `200 + 409`，并保留胜出文件；SP 上传/存储/Reference 内容聚焦测试 33/33 通过。一个旧 Reference 测试的内部写入次数断言已替换为重放前后内容、元数据及对象数量不变的行为断言。

两仓 `pnpm check` 通过；Eval 全量 1,755 通过、107 跳过。SP 全量 API 670 通过、536 跳过，仅剩第 14 节已知的 5 个充值 mock 失败。独立只读复核未发现阻塞项。真实 R2 条件写入、PostgreSQL 并发恢复及部署域名仍未实测，未执行任何真实环境操作。

## 16. 既有 CI 接线补齐

没有新增工作流、触发条件或部署步骤；合并、手动触发及发布仍由操作者负责。

- Eval 既有 `api` job 增加一次性的 PostgreSQL 17 服务，唯一 `DATABASE_URL` 指向该 job 的本地服务。测试命令显式派生 `EVAL_IMPORT_TEST_DATABASE_URL`，同时运行常规数据库测试和导入事务/租约/队列测试；缺少地址直接失败，不默默跳过。测试继续通过现有 helper 创建、迁移及销毁自己的随机数据库。
- 同一个 Eval job 运行既有 `pnpm test:deployment`；任一步失败都会使 `api` job 失败，现有 API 部署成功依赖不变。`infra/aws/deploy/**` 已被现有改动检测归到 API，不需另设检测或门禁状态。
- SP 既有 API 测试 job 已有 PostgreSQL 服务与部署预检，只补上从测试 `DATABASE_URL` 显式派生的 `SP_IMPORT_TEST_DATABASE_URL`。保留专用导入测试的 loopback 限制及本地 opt-in，不从 `.env`、业务连接或真实凭据兜底。SP 的该测试工作流仍为原有的手动触发，不承诺自动 merge gate。
- 离线验证通过：两份 YAML 可解析、29 个 shell 块语法有效；触发条件及非 API job 未改变；数据库地址缺失/为空会失败，专用导入地址正确派生。改动检测测试 Eval 8/8、SP 10/10，部署检查 Eval 7/7、SP 8/8 通过。

本次只验证配置、命令与已有离线测试；没有启动容器、连接数据库或触发 GitHub Actions。新增 PostgreSQL 服务及数据库测试的真实执行结果，须由操作者合并/触发后确认，不能用上述离线通过代替。真实 R2 和内容域名验收仍是独立的运维事项。

## 一手来源索引

Eval 链接指向本次检查的工作区文件；SP 链接固定到本次检查的 commit，避免被本机其他分支或未提交修改混淆。

[E1]: ../docs/eval-sp-deployment.md
[E2]: ../apps/eval-api/README.md
[E3]: ../apps/eval-api/src/sp/client.ts
[E4]: ../apps/eval-api/src/middlewares/service-account.ts
[E5]: ../apps/eval-api/src/agent-configs.ts
[E6]: https://github.com/springbrand-lab/sp-platform/blob/2990fba62f057152b79af3fc150c0c4ba8d93e8b/packages/agent-config-editor/src/agent-draft.ts
[E7]: ../packages/eval-contracts/src/project.ts
[E8]: ../docs/agent-config-editor-alignment.md
[E9]: ../infra/aws/deploy/deploy.sh
[E10]: ../apps/eval-api/src/middlewares/web-gateway.ts
[S1]: https://github.com/springbrand-lab/sp-platform/blob/2990fba62f057152b79af3fc150c0c4ba8d93e8b/apps/api/node.config.jsonc
[S2]: https://github.com/springbrand-lab/sp-platform/blob/23e90f5eb29f39c0f5c87cd5090e650f72e51699/apps/api/src/routes/user-agent-config/user-agent-config.handlers.ts#L51-L109
[S3]: https://github.com/springbrand-lab/sp-platform/blob/2990fba62f057152b79af3fc150c0c4ba8d93e8b/packages/agent-contracts/src/agent.ts#L216-L254
[S4]: https://github.com/springbrand-lab/sp-platform/blob/2990fba62f057152b79af3fc150c0c4ba8d93e8b/apps/api/src/models/user-agent-config/index.ts#L264-L407
[S5]: https://github.com/springbrand-lab/sp-platform/blob/23e90f5eb29f39c0f5c87cd5090e650f72e51699/packages/agent-contracts/src/agent.ts
[S6]: https://github.com/springbrand-lab/sp-platform/blob/23e90f5eb29f39c0f5c87cd5090e650f72e51699/packages/agent-contracts/package.json
[S7]: https://github.com/springbrand-lab/sp-platform/blob/23e90f5eb29f39c0f5c87cd5090e650f72e51699/packages/agent-contracts/src/agent-share.ts
[S8]: https://github.com/springbrand-lab/sp-platform/blob/23e90f5eb29f39c0f5c87cd5090e650f72e51699/apps/api/src/models/user-agent-config/share.ts
[S9]: https://github.com/springbrand-lab/sp-platform/blob/23e90f5eb29f39c0f5c87cd5090e650f72e51699/apps/api/src/routes/user-agent-config/user-agent-config.handlers.ts#L244-L265
[S10]: https://github.com/springbrand-lab/sp-platform/blob/23e90f5eb29f39c0f5c87cd5090e650f72e51699/apps/api/src/models/user-agent-config/validate-setting.ts
[S11]: https://github.com/springbrand-lab/sp-platform/blob/2990fba62f057152b79af3fc150c0c4ba8d93e8b/apps/api/src/models/user-agent-config/runtime-input.ts
[S12]: https://github.com/springbrand-lab/sp-platform/blob/2990fba62f057152b79af3fc150c0c4ba8d93e8b/apps/api/src/models/skill/management.ts#L172-L202
[S13]: https://github.com/springbrand-lab/sp-platform/blob/2990fba62f057152b79af3fc150c0c4ba8d93e8b/apps/api/src/models/user-reference/index.ts#L129-L190
[S14]: https://github.com/springbrand-lab/sp-platform/blob/2990fba62f057152b79af3fc150c0c4ba8d93e8b/apps/api/src/models/user-agent-config/selection-validation.ts
[S15]: https://github.com/springbrand-lab/sp-platform/blob/2990fba62f057152b79af3fc150c0c4ba8d93e8b/packages/agent-contracts/src/mcp.ts
[S16]: https://github.com/springbrand-lab/sp-platform/blob/2990fba62f057152b79af3fc150c0c4ba8d93e8b/apps/api/src/node/sync-dev-catalog-data.ts#L15-L119
[S17]: https://github.com/springbrand-lab/sp-platform/blob/23e90f5eb29f39c0f5c87cd5090e650f72e51699/apps/api/src/routes/public-agent-share/public-agent-share.routes.ts
[S18]: https://github.com/springbrand-lab/sp-platform/blob/2990fba62f057152b79af3fc150c0c4ba8d93e8b/apps/api/src/routes/user-agent-config/user-agent-config.routes.ts
[N1]: ../apps/eval-web/src/features/agents/agents-page.tsx
[N2]: ../apps/eval-web/src/components/ui/dialog.tsx
[N3]: ../apps/eval-web/src/api-sdk/agent-configs-api.ts
[N4]: ../apps/eval-api/src/sp/agent-library.ts
[N5]: https://github.com/springbrand-lab/sp-platform/blob/9c4158f5daa09dc7c0862a8c1a6710e19666611b/apps/api/src/models/skill/management.ts#L232-L263
[N6]: https://github.com/springbrand-lab/sp-platform/blob/9c4158f5daa09dc7c0862a8c1a6710e19666611b/apps/api/src/models/user-reference/index.ts#L53-L90
[N7]: ../apps/eval-api/src/run-worker-queue.ts

[U1]: https://github.com/springbrand-lab/sp-platform/blob/316b3ec1299e5350604d229b42d18290db4aa61c/packages/agent-contracts/src/selection.ts#L3-L8
[U2]: https://github.com/springbrand-lab/sp-platform/blob/316b3ec1299e5350604d229b42d18290db4aa61c/packages/agent-contracts/src/skill.ts#L10-L16
[U3]: https://github.com/springbrand-lab/sp-platform/blob/316b3ec1299e5350604d229b42d18290db4aa61c/packages/agent-contracts/src/agent.ts#L239-L257
[U4]: https://github.com/springbrand-lab/sp-platform/blob/316b3ec1299e5350604d229b42d18290db4aa61c/apps/api/src/models/user-agent-config/index.ts#L301-L347
[U5]: https://github.com/springbrand-lab/sp-platform/blob/316b3ec1299e5350604d229b42d18290db4aa61c/apps/api/src/models/user-agent-config/schema.ts#L18-L70
[U6]: https://github.com/springbrand-lab/sp-platform/blob/316b3ec1299e5350604d229b42d18290db4aa61c/apps/api/src/models/skill/management.ts#L172-L203
[U7]: https://github.com/springbrand-lab/sp-platform/blob/316b3ec1299e5350604d229b42d18290db4aa61c/apps/api/src/models/component/schema.ts#L23-L65
[U8]: https://github.com/springbrand-lab/sp-platform/blob/316b3ec1299e5350604d229b42d18290db4aa61c/apps/api/src/models/component/skill-store.ts#L158-L193
[U9]: https://github.com/springbrand-lab/sp-platform/blob/316b3ec1299e5350604d229b42d18290db4aa61c/apps/api/src/models/component/content.ts#L85-L88
[U10]: https://github.com/springbrand-lab/sp-platform/blob/316b3ec1299e5350604d229b42d18290db4aa61c/apps/api/src/models/component/content.ts#L181-L206
[U11]: https://github.com/springbrand-lab/sp-platform/blob/316b3ec1299e5350604d229b42d18290db4aa61c/apps/api/src/models/user-reference/index.ts#L48-L85
[U12]: https://github.com/springbrand-lab/sp-platform/blob/316b3ec1299e5350604d229b42d18290db4aa61c/apps/api/src/models/user-reference/schema.ts#L6-L23
[U13]: https://github.com/springbrand-lab/sp-platform/blob/316b3ec1299e5350604d229b42d18290db4aa61c/apps/api/src/models/user-reference/content.ts#L16-L58
[U14]: https://github.com/springbrand-lab/sp-platform/blob/316b3ec1299e5350604d229b42d18290db4aa61c/apps/api/src/models/user-agent-config/selection-validation.ts#L34-L87
[U15]: https://github.com/springbrand-lab/sp-platform/blob/316b3ec1299e5350604d229b42d18290db4aa61c/apps/api/src/models/user-agent-config/selection-validation.ts#L128-L167
[U16]: ../apps/eval-api/src/agent-configs.ts#L228-L246
[U17]: ../apps/eval-api/src/agent-configs.ts#L301-L328
[U18]: ../apps/eval-api/src/db/schema.ts#L71-L83
[U19]: ../apps/eval-web/src/features/agents/agents-page.tsx#L16-L99
[U20]: ../apps/eval-web/src/api-sdk/agent-configs-api.ts#L5-L23
[U21]: ../apps/eval-api/src/run-worker-queue.ts#L6-L78
[U22]: ../apps/eval-api/src/middlewares/service-account.ts#L4-L18
[U23]: https://github.com/springbrand-lab/sp-platform/blob/316b3ec1299e5350604d229b42d18290db4aa61c/apps/api/src/models/user-reference/index.ts#L163-L190
[U24]: https://github.com/springbrand-lab/sp-platform/blob/316b3ec1299e5350604d229b42d18290db4aa61c/packages/contracts/src/user-reference.ts#L4-L13
[U25]: https://github.com/springbrand-lab/sp-platform/blob/316b3ec1299e5350604d229b42d18290db4aa61c/apps/api/src/routes/user-agent-config/user-agent-config.routes.ts#L14-L24
[U26]: https://github.com/springbrand-lab/sp-platform/blob/316b3ec1299e5350604d229b42d18290db4aa61c/packages/agent-config-editor/src/client/skills.ts#L9-L17
[U27]: https://github.com/springbrand-lab/sp-platform/blob/316b3ec1299e5350604d229b42d18290db4aa61c/packages/agent-config-editor/src/client/references.ts#L7-L10
[U28]: ../apps/eval-api/src/sp/agent-library.ts#L1-L29
[V1]: https://github.com/springbrand-lab/sp-platform/blob/316b3ec1299e5350604d229b42d18290db4aa61c/apps/api/src/routes/user-agent-config/user-agent-config.handlers.ts#L20-L26
[V2]: https://github.com/springbrand-lab/sp-platform/blob/316b3ec1299e5350604d229b42d18290db4aa61c/apps/api/src/routes/admin/admin.routes.ts#L27-L43
[V3]: https://github.com/springbrand-lab/sp-platform/blob/316b3ec1299e5350604d229b42d18290db4aa61c/apps/api/src/models/user-reference/index.ts#L87-L124
[V4]: https://github.com/springbrand-lab/sp-platform/blob/316b3ec1299e5350604d229b42d18290db4aa61c/apps/api/src/models/skill/management.ts#L76-L105
