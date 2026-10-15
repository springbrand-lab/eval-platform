# SP 按 commit 动态部署：开源方案与 GitHub CD 适配调研

调研日期：2026-10-15。GitHub stars 于 2026-10-15 07:05 UTC 读取公开 API，为当时快照。范围为只读调研；没有安装工具、触发 workflow 或部署云资源。本文是待验证的方案建议，不替换现有架构文档或构成已实施决策。

## 建议

先验证 **EP 部署登记表 + GitHub Actions + Pulumi + Wrangler**：EP 决定需要哪个版本并登记 Project 的绑定；GitHub CD 负责执行；Pulumi 管基础设施与状态；Wrangler 独占管理 SP 的 Worker、DO、Container 和 Worker Loader。EP 与 SP 独立发版，SP 新版本只创建新部署，不覆盖已有 Project 的部署。

首期在 workflow 中用官方 `pulumi/actions` 或 CLI 即可。Automation API 是后续程序化管理多个 stack 的可选 TypeScript SDK，可以在部署 job 中使用，不要求 EP HTTP 进程持有 Pulumi 引擎，也不要求新增常驻部署服务。[Pulumi 官方 GitHub Actions](https://www.pulumi.com/docs/iac/operations/continuous-delivery/github-actions/)、[Automation API](https://www.pulumi.com/docs/iac/concepts/automation-api/)

OpenTofu 是成熟度与开源社区规模相近的备选；Alchemy 对 Cloudflare 新能力的覆盖值得单独做 PoC，但当前 v2 明确为 beta，不能直接认定为生产方案。以下推荐均基于文档和源码适配分析，尚未用真实 SP 验证。[Alchemy README](https://github.com/alchemy-run/alchemy)

## 项目实际约束

- 当前 SP 横跨 AWS 的 Node API、Docker/ECR/EC2、PostgreSQL，以及 Cloudflare Agent/Space Workers、DO、R2、Sandbox Containers、Worker Loader，不能只用容器平台概括。[现有部署入口](../../../sp-platform/.github/workflows/deploy-dev.yml)、[AWS Compose](../../../sp-platform/infra/aws/deploy/compose.yaml)
- Space Worker 必须先于 Agent 就绪，Agent 的跨 Worker `SpaceDO` 绑定必须指向同一部署。当前 AWS 部署脚本只接受 `dev|production`，仍需增加参数化部署目标。[SP 部署 workflow](../../../sp-platform/.github/workflows/deploy-dev.yml)、[SP AWS 部署脚本](../../../sp-platform/infra/aws/deploy/deploy.sh)
- SP 已采用声明式 DO `exports`，不能为适配工具退回旧 `migrations`。Cloudflare 文档明确二者互斥，`exports` 创建 SQLite namespace 并管理其生命周期。[Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)、[DO class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
- 现有 EP 文档仍是一次 Eval 发布带一套 SP；API/Worker 启动参数和 Harness 也面向单一发布。动态部署需要正式修改这些契约，不能仅加一个 CD 文件。[当前部署方案](../eval-sp-deployment.md)、[Eval API README](../../apps/eval-api/README.md)
- Subject 产物和完整轨迹必须保留；EP 只使用 SP 的公开 Chat、Submission、Trajectory、Workspace 接口，不读取 SP DB、DO 或 R2。[包边界](../package-boundaries.md)

## GitHub 高星方案筛选

| 项目 | Stars 快照 | 开源范围 | 对当前 SP 的判断 |
| --- | ---: | --- | --- |
| [Pulumi](https://github.com/pulumi/pulumi) | 25,789 | Apache-2.0 核心 | 优先 PoC；跨云 IaC，可在现有 GitHub CD 执行 |
| [OpenTofu](https://github.com/opentofu/opentofu) | 30,502 | MPL-2.0 | 强备选；HCL/provider/远程 state，仍需 Wrangler 补齐 SP 云端运行面 |
| [SST](https://github.com/anomalyco/sst) | 26,354 | MIT | AWS/Cloudflare stage 体验好；现行 Worker 高层组件与 SP 的 `exports` 不直接一致 |
| [Alchemy](https://github.com/alchemy-run/alchemy) | 1,660 | Apache-2.0 | Cloudflare 新能力覆盖突出；v2 beta，低于“高星”门槛，作为专项候选 |
| [Coolify](https://github.com/coollabsio/coolify) | 62,997 | Apache-2.0 核心 | 可承接 Node API/数据库；原生容器部署不能覆盖完整 Cloudflare 运行面 |
| [Dokploy](https://github.com/Dokploy/dokploy) | 37,794 | `/proprietary` 外 Apache-2.0；该目录另行许可 | 同样适合 Docker 应用层，完整 SP 仍需外部 IaC/Wrangler |
| [Argo CD](https://github.com/argoproj/argo-cd) | 24,408 | Apache-2.0 | Kubernetes GitOps；SP 当前不是 Kubernetes，不能直接接管全部资源 |
| [Flux](https://github.com/fluxcd/flux2) | 8,444 | Apache-2.0 | 同属 Kubernetes 控制面；当前引入会增加平台前置条件 |
| [Atlantis](https://github.com/runatlantis/atlantis) | 9,324 | Apache-2.0 | 以 PR 驱动 IaC plan/apply；不是 EP 的 Project 环境登记系统 |
| [Terrakube](https://github.com/terrakube-io/terrakube) | 969 | Apache-2.0 | 可自托管 IaC 协作平台；当前已有 GitHub CD，首期收益不足以抵消新增控制面 |

Stars 与仓库许可证元数据来自 GitHub API：[Pulumi](https://api.github.com/repos/pulumi/pulumi)、[OpenTofu](https://api.github.com/repos/opentofu/opentofu)、[SST](https://api.github.com/repos/anomalyco/sst)、[Alchemy](https://api.github.com/repos/alchemy-run/alchemy)、[Coolify](https://api.github.com/repos/coollabsio/coolify)、[Dokploy](https://api.github.com/repos/Dokploy/dokploy)、[Argo CD](https://api.github.com/repos/argoproj/argo-cd)、[Flux](https://api.github.com/repos/fluxcd/flux2)、[Atlantis](https://api.github.com/repos/runatlantis/atlantis)、[Terrakube](https://api.github.com/repos/terrakube-io/terrakube)。Dokploy 的 API 返回 `NOASSERTION`，表内许可范围另按[实际 LICENSE](https://github.com/Dokploy/dokploy/blob/canary/LICENSE.MD)核实。

Coolify 官方定位为通过 SSH 管理服务器上的 Docker 工作负载；Dokploy 官方架构围绕 Docker、Swarm/Compose、Traefik。两者默认 PR preview 会跟随 PR 更新并在关闭/合并后清理，不能原样用于长期锁定 Project 的环境。此处判断是对默认功能的适配分析，并非声称平台不能调用扩展脚本。[Coolify 定位](https://coolify.io/docs/core/what-is-coolify)、[Coolify previews](https://coolify.io/docs/applications/deployments/preview-deployments)、[Dokploy 架构](https://docs.dokploy.com/docs/core/architecture)、[Dokploy previews](https://docs.dokploy.com/docs/core/applications/preview-deployments)

Argo CD 和 Flux 管理 Kubernetes 中的期望状态；即使引入 Kubernetes，Cloudflare 资源仍需要额外 controller、IaC 或部署 job。PR generator 默认跟踪 PR 也不等于长期 commit 部署登记。[Argo CD](https://github.com/argoproj/argo-cd)、[ApplicationSet PR generator](https://argo-cd.readthedocs.io/en/stable/operator-manual/applicationset/Generators-Pull-Request/)、[Flux](https://github.com/fluxcd/flux2)

## 四种 IaC 候选的具体适配

### Pulumi：首选验证基础设施管理

Automation API 可以创建/选择隔离 stack，运行 `preview/up/refresh/destroy` 并取得 outputs；其本身属于开源 IaC。底层仍调用 Pulumi CLI，runner 必须具备 CLI、语言运行时和 provider 插件。[概念](https://www.pulumi.com/docs/iac/concepts/automation-api/)、[运行要求](https://www.pulumi.com/docs/iac/guides/building-extending/automation-api/)

State 可以保存在自有 S3 等 DIY backend，具备锁和 checkpoint history；需要自己负责存储权限、加密和备份。Pulumi Cloud 的托管部署、组织 UI/API、RBAC、TTL/Review Stacks 是另一产品层，使用 OSS+GitHub Actions 不必购买或自托管该控制面。[State/backend](https://www.pulumi.com/docs/iac/concepts/state-and-backends/)、[Cloud 与 OSS 的区别](https://www.pulumi.com/docs/iac/guides/basics/pulumi-cloud-vs-oss/)

Cloudflare provider 当前已出现 `WorkerScript.exports` 和 `WorkerVersion.exports`，后者包含 SQLite DO 声明与 Container 关联。不能笼统说 Pulumi 不支持新 DO。问题在于完整 SP 所需能力仍有缺口：`WorkerVersion.containers` 的 `className` 只是关联元数据，并非镜像构建、推送及 ContainerApplication 全生命周期。[WorkerScript](https://www.pulumi.com/registry/packages/cloudflare/api-docs/workerscript/)、[WorkerVersion](https://www.pulumi.com/registry/packages/cloudflare/api-docs/workerversion/)

本次检查 Pulumi 当前 [provider schema](https://github.com/pulumi/pulumi-cloudflare/blob/master/provider/cmd/pulumi-resource-cloudflare/schema.json)，Worker binding 候选值未包含 `worker_loader`，也未找到 ContainerApplication 资源。上游 Cloudflare provider 的 [issue #7309](https://github.com/cloudflare/terraform-provider-cloudflare/issues/7309)报告 Worker Loader 被 schema 拒绝，对应 [PR #7310](https://github.com/cloudflare/terraform-provider-cloudflare/pull/7310)在调研时仍未合并。因此首期让 Wrangler 完整拥有 Worker 及其绑定，比混合修改同一 Worker 更容易保证一致性；这是一项工程建议，最终仍需用固定版本 provider 验证。

### OpenTofu：保留成熟 IaC 工作流的备选

OpenTofu 是通过 provider 管理多云资源的开源 IaC；plan/apply 和 JSON 输出适合 GitHub job。官方 `setup-opentofu` Action 可锁 CLI 版本，runner 内执行 CLI 即可，无需新增常驻服务。[工具定位](https://opentofu.org/docs/intro/)、[plan 自动化参数](https://opentofu.org/docs/cli/commands/plan/)、[官方 Action](https://github.com/opentofu/setup-opentofu)

不同部署必须使用独立 state；同凭据范围可用 workspace，不同账户或需要独立权限时应分 backend/配置。官方明确 workspace 不能代替凭据和访问控制隔离。远程 backend 的锁也只保护同一 state，不替代 EP 的业务去重。[Workspaces](https://opentofu.org/docs/language/state/workspaces/)、[State locking](https://opentofu.org/docs/language/state/locking/)

当前 Cloudflare provider 的 `workers_script` 已有 `exports`；同时上述 Worker Loader schema 问题直接发生于 OpenTofu+Cloudflare provider。检查当前 [workers_script schema](https://github.com/cloudflare/terraform-provider-cloudflare/blob/main/internal/services/workers_script/schema.go)、[worker_version schema](https://github.com/cloudflare/terraform-provider-cloudflare/blob/main/internal/services/worker_version/schema.go)及资源目录，没有取得完整 ContainerApplication 管理证据。建议同样采用 OpenTofu 管基础设施、Wrangler 管 Workers 的明确分工。[Provider 文档](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/workers_script)、[官方缺陷记录](https://github.com/cloudflare/terraform-provider-cloudflare/issues/7309)

相对 Pulumi 的取舍主要是 HCL/provider 工作方式与 TypeScript 组合方式，不是“是否能在 GitHub CD 使用”。若团队已维护大量 Terraform/OpenTofu module，优先复用既有体系是合理选择；本仓库主要使用 TypeScript，因而先试 Pulumi 的组合成本可能更低，此判断未做工时测量。

### SST：stage 清晰，但现行高层 Worker 组件需要绕行

`sst deploy --stage <id>` 会为不同 stage 命名并创建独立资源；state 可放 AWS/Cloudflare，部署会锁 state。AWS/Cloudflare 内置组件使用 Pulumi provider，必要时能直接使用低层 provider。[CLI/stage/锁](https://sst.dev/docs/reference/cli/)、[State](https://sst.dev/docs/state/)、[Components](https://sst.dev/docs/components/)

关键不匹配是：当前 `sst.cloudflare.Worker` 文档和[实现](https://github.com/anomalyco/sst/blob/dev/platform/src/components/cloudflare/worker.ts)以完整 `migrations` 历史管理 DO，未看到 `exports`、Containers 或 Worker Loader 的组件接口。绕过组件使用 raw provider 或 Wrangler 技术上可行，但会重新面对同一 provider 缺口，SST 的高层收益随之降低。[Worker 组件](https://sst.dev/docs/component/cloudflare/worker/)

SST 可在 GitHub Actions 调用 CLI，不依赖改用 SST Console 执行部署；如果将来 EP 的 AWS 应用部署也全面采用 SST，再统一工具更有价值。当前不建议仅为 SP 动态环境先迁移整个部署体系。[官方 Basics 中的 CI/CD](https://sst.dev/docs/basics/)

### Alchemy：Cloudflare 能力最值得实测，但 v2 仍是 beta

当前官方文档明确使用 DO 声明式 `exports`，支持跨 Worker DO 绑定、Container 镜像构建/推送与 ContainerApplication 集成，也提供 `WorkerLoader` binding。这些是本次候选中与 SP 特性最直接对应的文档证据。[DO exports](https://alchemy.run/cloudflare/compute/durable-objects/)、[跨 Worker DO](https://alchemy.run/cloudflare/compute/cross-worker-durable-object/)、[Containers](https://alchemy.run/cloudflare/compute/containers/)、[Worker Loader](https://alchemy.run/cloudflare/compute/worker-loader/)

无需把 SP 运行时代码改写成 Effect：官方支持把 `main` 指向普通 async fetch 模块或预构建 bundle，通过 `env` 配绑定。AWS 也有 EC2、ECS、RDS/Aurora 文档，因此它不是只能发布 Cloudflare 小应用。[普通 Workers](https://alchemy.run/cloudflare/compute/workers/#async-workers)、[EC2](https://alchemy.run/aws/compute/ec2/)、[ECS](https://alchemy.run/aws/compute/ecs/)、[RDS/Aurora](https://alchemy.run/aws/data/rds/)

State 支持 Cloudflare 自有 Worker+DO，也有 Postgres state；后者明确提供每个 `(stack, stage)` 的 session advisory lock。这里是部署工具自己的 state，不是 EP 获准读取 SP 的 DO 数据。GitHub Actions 有官方 CI 说明；默认 PR preview 生命周期仍需替换为按 deploymentId 部署和受控回收。[State Store](https://alchemy.run/state-store/)、[CI](https://alchemy.run/environments/ci/)、[官方 Action](https://github.com/alchemy-run/alchemy/blob/main/action.yml)

限制必须明确：当前 README 标注 v2 beta 并预告 breaking changes；v1 文档与 v2 不能混用。是否能不改 SP bundle 便正确部署 Sandbox、跨 Worker SpaceDO、全部既有 flags 和 DO 导出，需要真实 PoC。若采用，应锁定具体 Alchemy/CLI 版本、验证升级/中断恢复，再决定能否替代 Wrangler。[项目状态](https://github.com/alchemy-run/alchemy)、[v1 文档入口](https://v1.alchemy.run/)

## Cloudflare 能力核验摘要

| 能力 | Pulumi / OpenTofu 当前 provider | SST 高层 Worker 组件 | Alchemy 当前 v2 文档 |
| --- | --- | --- | --- |
| DO `exports` / SQLite | 已有相应 schema；需验固定版本实际部署 | 当前文档是旧 `migrations` 接口 | 明确支持 `exports` |
| 跨 Worker DO | binding 有 scriptName；需验 SpaceDO 路由 | 可低层组合，需验 | 有专门官方示例 |
| Container 完整生命周期 | 有 Worker 关联字段；未核实原生完整应用/镜像流程 | 未核实原生组件支持 | 明确包含构建、推送、应用/namespace 关联 |
| Worker Loader | 枚举缺口及未合并修复是当前阻塞证据 | 未核实原生支持 | 有专门官方接口 |
| 保持 SP 既有运行时代码 | 可上传预构建代码或让 Wrangler 发布 | 通常需组件/配置适配 | 支持普通 async / 预构建 bundle |

表中“未核实”不等于云平台不支持；它表示没有足够证据把该工具的现行版本当作无须补胶水的完整替代品。以上各项来源见四个候选小节；没有执行云端兼容性测试。

## 必须适配 GitHub CD 的执行架构

```text
EP 创建请求 → 锁定 SP full SHA → 部署登记表/持久队列
                               ├─ 已有 ready 部署：复用并绑定
                               └─ 缺少部署：dispatch GitHub workflow
                                                   ↓
                              现有 CodeBuild Actions runner
                              Pulumi → API/DB → Space → Agent → smoke
                                                   ↓
                              发布清单 + 状态/地址 + GitHub run ID
                                                   ↓
                              EP 校准 ready → 绑定 Project → 允许 Run
```

EP 发布只更新 EP；SP 的发布 job 按请求创建指定版本的部署，两者没有“先发 SP 再发 EP”的强制联动。可把 provision workflow 放在 SP 仓库，以便 SP 团队维护部署契约；EP 只调用它的稳定接口。这是建议的职责分工，当前未实现。

1. **输入分清两种 ref。** `workflow_dispatch.ref` 选择经过维护的部署 workflow 分支/tag；输入另带 `sourceCommit` 完整 SHA、`deploymentId`、配置/模板 digest。workflow 检出精确 SP SHA 后校验；不能运行到一半再次取分支 HEAD。按 GitHub 当前 `2026-03-10` API，dispatch 文档返回 workflow run 详情，可直接登记 run ID；旧 API 行为需要按所用版本适配。[GitHub workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
2. **沿用现有 runner。** SP 已用一次性 CodeBuild runner；在部署 job 准备固定版本 Node/pnpm、Pulumi 或 OpenTofu、Wrangler、Docker/buildx、AWS CLI 与 provider 插件，明确 CPU 架构、Docker 构建和推送能力、网络及私有仓库读取权限。[当前 workflow](../../../sp-platform/.github/workflows/deploy-dev.yml)、[Pulumi runner 要求](https://www.pulumi.com/docs/iac/guides/building-extending/automation-api/)
3. **认证按平台接。** AWS 沿用 GitHub OIDC 获取短期 role；Cloudflare 沿用受限 API token/account ID 的 CI 路径，Wrangler 有官方 GitHub Action。GitHub 的 `eval-provision` Environment 只是 secrets/权限/审核配置，并不等于某套实际 SP 环境，建议预先配置一个并复用；引用不存在的 Environment 会自动创建，但不会自动带上原环境的保护规则和 secrets。[AWS OIDC](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)、[Cloudflare GitHub CI](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)、[GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
4. **并发按 deploymentId。** EP 数据库先用唯一约束合并同版本请求，再用持久队列发送；workflow concurrency group 也用 deploymentId，并避免取消已在创建资源的 job。GitHub 默认 concurrency 只留一个 pending，后来的请求可替换 pending；即使 `cancel-in-progress: false` 也不能当作完整业务队列，新 `queue` 选项亦不能替代数据库事实。[GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
5. **结果可恢复。** 保存 workflow run ID/attempt，成功必须包含完整清单和真实 smoke 结果；通过回调加定期 reconciliation 补漏，不能把“dispatch 成功”当“SP 已就绪”。失败或取消后查询实际资源，再决定继续或回收，不能默认整套回滚、删除已被 Project 引用的资源。
6. **state 与清单持久化。** IaC state 放 S3/其他远程 backend；发布清单放长期存储并在 EP 保存摘要及位置。runner 本地盘只存临时文件；GitHub artifact 可用于诊断，保留期不能决定旧 Project 能否恢复。敏感配置仅保存 secret reference，清单不包含 token 正文。[Pulumi backends](https://www.pulumi.com/docs/iac/concepts/state-and-backends/)、[GitHub artifact retention](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)

## EP 仍需自己拥有的薄部署登记层

开源工具管理“云上有哪些资源”；EP 管理“这个 Project 永远连哪套 SP”。不能拿 Pulumi state、GitHub branch 或 PR preview 名称代替业务记录。建议至少持久化以下事实：

| 记录 | 必须保存 |
| --- | --- |
| 创建/准备请求 | 幂等键、首次解析的分支和 full SHA、不可变输入快照、准备进度/失败原因 |
| SP Deployment | deploymentId、复用 key、代码/config/template digest、API/Agent 地址、Space Worker 身份、secret references、资源身份、兼容契约、状态、CD run/attempt、清单位置 |
| Project / Run | Project 固定 deploymentId；Run 保存该 ID、实际 full SHA/清单摘要，观察/停止/恢复沿用同一部署 |
| 资源引用/保留策略 | 哪些 Project/Chat/Run/证据仍依赖该环境、是否允许回收、保留期和恢复条件 |

复用 key 建议覆盖 `repo + full SHA + deployment template digest + effective deployment config digest + account/region/isolation scope`。这里的配置指部署级运行配置，Project 的冻结 Agent Config 仍在目标 SP 内按用户和 Project 独立维护。同 commit 不一定可复用：不同 owner 隔离要求、凭据版本或关键运行配置会改变兼容性。分支仅作为来源标签；重试创建请求继续使用第一次解析的 SHA，不偷偷改用更新提交。

状态可以从 `requested → provisioning → verifying → ready` 开始，另有 `failed/degraded/retiring/deleted`。EP 唯一约束合并并发需求，后台有租约/重试/对账；版本 X 已绑定后拒绝原地变成 Y。分支后来指向 Y 时创建新部署，已有 Project 仍连接 X。正式绑定和首个 Run 必须等待就绪及用户/配置准备完成。

**代码 commit 锁定还不足以稳定部署。** SP 当前 Compose 的 `cloudflare/cloudflared:latest` 配 `pull_policy: always`，同 SHA 重新部署也可能拉到不同镜像。发布清单还应记录 API/Sandbox/sidecar 镜像 digest、Worker version IDs、依赖锁文件、Wrangler/provider/部署工具版本、compatibility date/flags、关键配置与部署模板摘要。建议同一个复用 key 只构建一次并长期保留 bundle/镜像，以 deploymentId 产生独立 Worker 身份及 namespace；换个版本标签但仍覆盖同名 Worker 无法满足要求。外部模型和 API 仍可能变化，版本稳定不代表 LLM 输出可完全重现。[当前 Compose](../../../sp-platform/infra/aws/deploy/compose.yaml)

每套部署至少保持独立的逻辑数据库及权限、DO namespace、R2 和 Worker 身份；物理 EC2/RDS 实例可按容量共享，但是否改成共享主机/数据库服务属于后续成本决策。同版本多个 Project 共享环境还会共享并发/配额压力，性能类评估需注明隔离级别。

“任务结束”不等于“环境可删”。第一阶段建议不做自动销毁；后续回收必须确认无活动 Run、无仍需访问的 Project/Chat/产物/完整轨迹，并验证归档/恢复路径。只保留 R2 或 DB 备份不足以承诺旧 Chat 可读，DO/Worker 身份和配套运行代码同样重要。

## 资源所有权与仓库边界

推荐 PoC 分工如下，避免 Pulumi 与 Wrangler 同时修改同一个 Worker：

| 层 | Owner | 输出 |
| --- | --- | --- |
| AWS API 承载、DB、IAM、ECR、DNS、R2 等明确纳管资源 | Pulumi stack | 资源 ID、地址、供 Worker 使用的配置 |
| Space/Agent Worker 代码、DO exports/namespace、Container、Worker Loader、全部 Worker bindings | Wrangler 和 SP 发布目标 | Worker/version/namespace/container IDs、SP endpoints |
| 部署工作顺序、失败对账、长期发布清单 | GitHub workflow + 仓库级 `deploy/` | 部署状态与可重试结果 |
| Project 绑定、复用/保留、Run 路由 | `apps/eval-api` 的应用服务/后台任务 | 固定 deploymentId 和目标 Harness |

R2 若交给 Pulumi 创建，Wrangler 只消费已有 bucket 名并绑定；任何资源只能有一个创建/删除 owner。Wrangler 部分同样需要清单登记和显式回收流程，不能误以为 `pulumi destroy` 会管理所有外部 Worker 资源。

保持现有四个共享包：部署流程属于仓库级 `deploy/`，EP 组合/持久化属于 `apps/eval-api`，`eval-runtime` 继续只编排评估并接收选好的 Harness。新增行为前先更新契约和包边界，不将云部署 SDK 塞进 Runtime。[现有边界](../package-boundaries.md)

还有两项业务能力不能靠 IaC 自动解决：一是 EP 登录与可编辑 Agent Config 现在绑定单一 SP，必须明确稳定身份入口、跨部署 owner 映射、通过 SP 正式接口导入冻结配置及相关依赖；二是 Worker、观察、停止/恢复均须按 deploymentId 路由。当前共享包还是 `link:`，GitHub job 还须解决可安装的版本契约，或显式检出匹配的 sibling SP；不允许用私有源码 import 替代发包。[Eval API README](../../apps/eval-api/README.md)、[共享包待办](../sp-package-publishing-todo.md)

## 最小 PoC 与通过标准

1. 先定义稳定 `provision/get-status/retire` 输入输出以及不含密钥的发布清单；实现一个 GitHub `workflow_dispatch` 部署目标，使用现有 CodeBuild runner，不改 EP 的发布流程。
2. 用 Pulumi 管最小独立 API/DB/R2/DNS 资源，用固定 Wrangler 发布同一 SHA 的 Space 和 Agent；保留 DO `exports`，验证 Sandbox 和 Loader。另一条隔离 PoC 可用 Alchemy v2 发布相同 bundle，对比缺口和状态恢复。
3. 两个 Project 同时请求 commit A，只生成一次部署并正确绑定；请求 B 得到另一部署。分支推进、EP 升级、CD 重跑后，A 的地址、代码版本、namespace 和已有 Chat 保持稳定。
4. 人为中断部署，验证重试/状态对账及不重复创建；取消不得删除被引用环境。一次性 runner 重建后仍能从远程 state 和持久清单恢复。
5. 跑通公开接口端到端：用户/冻结配置准备 → Subject → 全部产物与完整轨迹 → Evaluator → 指标；重新打开旧 Chat/Workspace/Submission，恢复未完成 Run。记录实际部署耗时、资源成本和配额，再决定自动回收设计。

到这一步才能确认工具组合可用于当前 SP。当前证据支持优先试 **GitHub Actions + Pulumi + Wrangler**；并不足以承诺任一候选可以开箱即用管理整套 SP。
