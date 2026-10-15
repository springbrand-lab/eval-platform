# 评估证据解耦：先导出证据，再导入评委

> 状态：第 1–5 阶段已实现（2026-10-15），见第 10 节"实现记录"；第 6 阶段（第二种框架）未开始。目标是让被测 Agent 与评委 Agent 可以是任意框架，不依赖 Cloudflare Durable Object。

## 1. 背景：现在的耦合点

当前评委读取被测产物和轨迹的方式，依赖"两个 Agent 都在 SP、都用 SpaceDO"：

| 耦合点 | 现在的做法 | 代码位置 |
| --- | --- | --- |
| 评委的 Workspace | 评委是新 Chat，但 Workspace 绑定到被测的 SpaceDO（`evaluationWorkspace.subject`），原地读被测文件，只能写 `/evaluations/<evaluationId>/` | `eval-runtime/src/harness/model.ts` 的 `EvaluationWorkspaceBinding`；SP `severn-agent.ts`、`runtime-host.ts`、`workspace/chat-port.ts` |
| 被测轨迹 | eval-platform 调 `POST .../workspaces/{u}/{c}/trajectory`，SP 在被测 Chat 的 DO 里读 SQLite `trajectory_events`，写成共享 Workspace 的 `/evaluations/subject-trajectory.jsonl` | `Harness.materializeSubjectTrajectory`；SP `materializeEvalSubjectTrajectory` |
| 产物 | `output` 接口只返回路径清单；文件内容始终留在 SP，评委靠共享 SpaceDO 读取 | `collectExecution` |

问题：

- 被测或评委换成不在 Cloudflare 上的 Agent（或 `codex`、`cc` 等其他框架），无法共享 SpaceDO，也无法让 SP 在 DO 内部复制轨迹。
- 被测与评委必须是同一种框架、同一个部署。
- 评估依赖被测 Workspace 一直存在；被测 Workspace 被清理后无法重新评估。
- 评委写入的文件落在被测 Workspace 里，评估与被测状态混在一起。

## 2. 目标与原则

1. **证据与 Agent 运行时解耦。** 评估只依赖一份"证据包"，不依赖被测 Agent 在哪里运行。
2. **每种框架只实现导出和导入。** 被测侧的 Harness 负责把产物和轨迹导出成标准格式；评委侧的 Harness 负责把证据放进评委自己的 Space。
3. **评委是普通 Agent。** 评委有自己的 Chat 和自己的 Space，不绑定被测，读写范围就是自己的 Space。
4. **证据不可变、可复用。** 证据包按内容 hash 固化，一份证据可以被多次评估、被不同评委评估，结果可复现。
5. **eval-platform 只搬运，不解析。** 产物内容原样保存；轨迹只做格式归一，不做语义处理。

## 3. 总体架构

```text
被测 Agent（任意框架）            eval-platform                         评委 Agent（任意框架）
                                  ┌──────────────────────────────┐
Harness.exportEvidence  ───────>  │ 证据包 Evidence Bundle        │
  · 产物清单 + 逐个读取文件         │  manifest.json（路径/大小/hash）│
  · 轨迹（统一格式）               │  files/ 按 hash 去重存储        │
                                  │  trajectory.jsonl              │
                                  │ 存放：R2（或本地 Bundle 目录）   │
                                  └──────────────┬───────────────┘
                                                 │ Harness.importEvidence
                                                 v
                                   评委自己的 Space
                                     /evidence/manifest.json
                                     /evidence/artifacts/...（保持原路径）
                                     /evidence/trajectory.jsonl
                                     /output/result.json  ← 评委写结果
```

时序：

1. 被测执行结束（`collectExecution` 成功）后，eval-platform 调用被测 Harness 的 `exportEvidence`，写入证据包，并把证据包引用记到 Sampling 上。这一步属于执行阶段，失败按执行阶段的重试策略处理。
2. 评估开始时，eval-platform 为评委创建一个普通 Agent（不带 `evaluationWorkspace`），先导入初始素材和评分格式，再调用评委 Harness 的 `importEvidence` 把证据包放进评委 Space，然后提交评委提示词。
3. 评委结束后，`collectEvaluation` 从评委自己的 Space 读取结果文件，作为 `structuredOutput` 返回。

## 4. 证据包格式

### 4.1 manifest

```jsonc
{
  "schemaVersion": 1,
  "evidenceId": "sha256:<manifest 规范 JSON 的 hash>",
  "source": {
    "framework": "sp",                 // sp | codex | cc | ...
    "samplingId": "...",
    "agentRef": { "chatId": "...", "ownerUserId": "..." },   // 框架自己的定位信息，仅作溯源
    "exportedAt": "2026-10-15T10:00:00.000Z"
  },
  "artifacts": [
    { "path": "/index.html", "size": 209, "mediaType": "text/html", "sha256": "..." }
  ],
  "trajectory": {
    "format": "eval-trajectory/v1",
    "sha256": "...",
    "events": 42,
    "complete": true                   // 框架保证是完整轨迹；否则为 false 并写明原因
  },
  "omitted": [
    { "path": "/node_modules", "reason": "excluded" },
    { "path": "/big.bin", "reason": "too-large" }
  ]
}
```

- `artifacts` 只列被测产出的文件，排除用户上传、初始素材、`/userspace` 等（沿用 SP 现有产物清单的排除规则，由各框架 adapter 实现）。
- 文件内容按 sha256 去重存储；manifest 是证据包的唯一入口，`evidenceId` 由 manifest 内容决定。
- 超出上限或被排除的文件写入 `omitted`，不静默丢弃，评委可以据此判断证据是否完整。

### 4.2 统一轨迹格式 `eval-trajectory/v1`

每行一个事件，字段取各框架的公共部分，原始事件保留在 `raw` 中：

```jsonc
{
  "seq": 1,
  "at": "2026-10-15T10:00:01.000Z",
  "type": "user-message | assistant-message | tool-call | tool-result | approval | question | error | usage",
  "submissionId": "...",
  "operationId": "...",                // 可选，用于关联 tool-call 与 tool-result
  "content": { ... },                  // 按 type 的规范字段
  "raw": { ... }                       // 框架原始事件，原样保留
}
```

- 各框架 adapter 负责把自己的事件映射到这个格式；映射不了的事件类型也要保留在 `raw` 里，`type` 记为 `other`。
- SP 的映射来源是 `trajectory_events`（完整、不截断），而不是 Langfuse。
- 框架拿不到完整轨迹时，可以退而从 Langfuse 按 session 拼接，此时 `complete: false`，并注明可能截断。

### 4.3 存储位置

- **首选 R2**：eval 环境专用桶，key 前缀 `evidence/<evidenceId>/manifest.json`、`evidence/blobs/<sha256>`、`evidence/<evidenceId>/trajectory.jsonl`。
- 本地开发可以用现有 `EVAL_BUNDLE_DIR` 下的 `evidence/` 目录，接口相同。
- eval-platform 数据库只记录引用：`Sampling.evidence = { evidenceId, manifestSha256, exportedAt }`。

## 5. Harness 接口变更

`packages/eval-runtime/src/harness/model.ts`：

```ts
/** Reads one exported artifact's bytes as a stream. */
export type EvidenceFileReader = (path: string) => Promise<ReadableStream<Uint8Array>>;

export interface ExportEvidenceInput {
  readonly handle: AgentHandle;
  readonly limits: EvidenceLimits;
  readonly runtime?: HarnessRuntimeOptions;
}

export interface ExportedEvidence {
  readonly artifacts: readonly EvidenceArtifact[];      // path, size, mediaType
  readonly omitted: readonly EvidenceOmission[];
  readonly readFile: EvidenceFileReader;
  /** Normalized events in order; the adapter pages through its source. */
  readonly trajectory: AsyncIterable<TrajectoryEvent>;
  readonly trajectoryComplete: boolean;
}

export interface ImportEvidenceInput {
  readonly handle: AgentHandle;                         // the Evaluator
  readonly idempotencyKey: string;
  readonly evidence: EvidenceBundleReader;              // manifest + blob reader from the store
  readonly root: "/evidence";
  readonly runtime?: HarnessRuntimeOptions;
}

export interface Harness {
  // ...existing members
  exportEvidence(input: ExportEvidenceInput): Promise<ExportedEvidence>;
  importEvidence(input: ImportEvidenceInput): Promise<void>;
}
```

删除（迁移完成后）：

- `EvaluationWorkspaceBinding`、`SubjectWorkspaceRef`、`AgentHandle.evaluationWorkspace`、`EnsureAgentInput.evaluationWorkspace`
- `Harness.materializeSubjectTrajectory` 与 `SubjectTrajectoryMaterializationInput`

新增一个存储端口（eval-runtime 定义，eval-api 实现 R2/本地目录两种）：

```ts
export interface EvidenceStore {
  /** Writes blobs by hash, then the manifest; returns the existing bundle when the manifest already exists. */
  save(input: { readonly samplingId: string; readonly evidence: ExportedEvidence; readonly limits: EvidenceLimits }): Promise<EvidenceRef>;
  open(ref: EvidenceRef): Promise<EvidenceBundleReader>;
}
```

## 6. 各侧改动

### 6.1 eval-platform

| 位置 | 改动 |
| --- | --- |
| `eval-contracts` | `EvidenceRef`、manifest、`TrajectoryEvent` 类型；`Sampling.evidence`；`TrajectoryRef` 改为指向证据包内的轨迹 |
| `eval-runtime` 执行阶段 | `collectExecution` 成功后调用 `exportEvidence` + `EvidenceStore.save`，引用写入 Sampling；导出失败按执行阶段重试，最终失败则该 Sampling 不可评估 |
| `eval-runtime` 评估阶段 | 评委不再带 `evaluationWorkspace`；`prepare` 中依次：初始素材 + 评分格式 → `importEvidence`；删除 `materializeSubjectTrajectory` 调用 |
| `eval-api` | 实现 `EvidenceStore`（R2 与本地目录）；SP Harness adapter 实现 `exportEvidence` / `importEvidence`；配置 R2 凭证与桶名 |
| 评委提示词 | 由 eval-platform 统一追加：证据在 `/evidence/`，清单在 `/evidence/manifest.json`，结果写到 `/output/result.json` 并遵循评分格式 |
| Metrics / Langfuse 分数 | 不变：仍读 `structuredOutput`，分数仍挂在被测 Chat 的 Langfuse session 上 |

### 6.2 sp-platform（eval-harness 服务接口）

新增导出接口（服务 token 鉴权，只读）：

| 接口 | 用途 |
| --- | --- |
| `GET .../users/{u}/chats/{c}/evidence/artifacts` | 产物清单（沿用现有遍历与排除规则），含 size、mediaType |
| `GET .../users/{u}/chats/{c}/evidence/files?path=` | 流式读取单个产物文件 |
| `GET .../users/{u}/chats/{c}/evidence/trajectory?afterSeq=&limit=` | 分页读取完整 `trajectory_events`（复用 `TrajectoryStore.readPage`，改为正序游标） |

导入沿用现有 `initialization` 接口写入评委自己的 Workspace，但需要：

- 支持大文件：改为"先申请上传，再按文件流式写入"（或 R2 预签名 URL，由 SP 侧从 R2 拉取），突破当前约 20MB 的请求体上限；
- 支持目标根目录 `/evidence`，与初始素材目录分开。

评委结果：`output` 接口读取评委自己 Workspace 中的结果文件，作为 `structuredOutput: {path, content, contentHash}` 原样返回。

迁移完成后删除：评委 Chat 的 `evaluationWorkspace` 绑定、`/evaluations/<id>/` 写入限制、`POST .../workspaces/{u}/{c}/trajectory`。

### 6.3 其他框架（codex、cc 及以后的 Agent）

只要实现两件事即可接入：

1. **导出**：列出并读取工作目录中的产物；把自己的执行记录映射成 `eval-trajectory/v1`（拿不到完整轨迹时标记 `complete: false`）。
2. **导入**：把证据包文件写进自己的工作目录 `/evidence/`。

被测和评委可以是不同框架，例如被测用 SP、评委用本地 Agent。

## 7. 大小与性能

| 项 | 建议默认值 | 说明 |
| --- | --- | --- |
| 单文件上限 | 50MB | 超出写入 `omitted` |
| 证据包总量上限 | 500MB | 超出按路径排序截断并写入 `omitted` |
| 文件数上限 | 20,000 | 与 SP 现有遍历上限一致 |
| 默认排除 | `node_modules/`、`.git/`、缓存目录 | 可在执行计划中覆盖 |
| 轨迹 | 不设条数上限，分页导出 | 单事件原样保存 |

- 文件按 hash 去重：同一被测结果多次评估只存一份；不同 Sampling 的相同文件也只存一份。
- 导出与导入都是流式，eval-platform 进程内不整体缓冲大文件。
- 导入使用幂等键 `evidence:<evidenceId>:<evaluationId>`，重试不会重复写入。

## 8. 迁移步骤

| 阶段 | 内容 | 完成标准 |
| --- | --- | --- |
| 1. 契约 | eval-contracts 增加证据包与轨迹格式；eval-runtime 增加 `EvidenceStore` 和 Harness 新方法（旧方法暂留） | 类型与单元测试通过 |
| 2. SP 导出 | eval-harness 新增三个导出接口并部署到 eval 环境 | 能导出 hello 用例的产物与完整轨迹 |
| 3. 固化 | 执行阶段导出并保存证据包（本地目录与 R2） | 每个成功的 Sampling 都有 `evidence` 引用，manifest 与文件 hash 一致 |
| 4. 导入与评委独立 | SP 支持大文件导入到 `/evidence`；评委不再绑定被测 Workspace，结果从评委自己的 Space 读取 | hello 用例端到端跑通，评委看不到被测 Workspace，只看到 `/evidence` |
| 5. 清理 | 删除 `evaluationWorkspace` 绑定、`materializeSubjectTrajectory`、SP 轨迹复制接口和 `/evaluations` 写入限制；更新文档 | 代码中不再有共享 SpaceDO 的路径 |
| 6. 第二种框架 | 选一个非 Cloudflare 的 Agent 实现导出/导入 | 被测与评委使用不同框架完成一次评估 |

已有的 Sampling（没有证据包）：迁移期间仍可用旧方式评估；或提供一次性补导出命令，被测 Workspace 仍存在时补齐证据包。

## 9. 风险与待决

- **存储成本**：每个 Sampling 多一份产物副本。通过 hash 去重、排除规则和保留期（例如证据包保留 90 天）控制。
- **导出时机**：被测 Workspace 在执行结束后可能还被修改（例如用户手动操作）。导出放在执行阶段结束时立即进行，并以 hash 固化，之后的修改不影响评估。
- **轨迹归一的取舍**：统一格式便于评委和 Metrics 通用处理，但各框架事件差异大；用 `raw` 保底，避免信息丢失。
- **评委读取方式**：本方案采用"推送"（eval-platform 在评委初始化时写入）。证据特别大、评委只需读一部分时，可以以后增加"拉取"模式：给评委一个只读工具或签名 URL 按需下载。
- **R2 凭证**：eval-platform 需要 eval 环境桶的读写凭证，放在 `.env.eval`，不提交。

## 10. 实现记录（2026-10-15）

eval-platform 在 `main`（`b57ff44`），sp-platform 在 `eval` 分支（`035318f0`）；原 `zixian/eval-sp-api-20261014` 已合入 `eval` 并删除，后续 SP 改动直接在 `eval` 上进行。

| 位置 | 内容 |
| --- | --- |
| `eval-contracts/src/evidence.ts` | `EvidenceBundleRef`、`EvidenceManifest`、`TrajectoryEvent`、`EvidenceLimits` 与 `DEFAULT_EVIDENCE_LIMITS`、`/evidence` 与 `/output/result.json` 路径常量；`Sampling.evidence`、`ExecutionOutput.evidence` |
| `eval-runtime/src/harness/model.ts` | `Harness.exportEvidence` / `importEvidence`、`EvidenceStore`；删除 `EvaluationWorkspaceBinding`、`SubjectWorkspaceRef`、`materializeSubjectTrajectory`，评委只带 `evaluationId` |
| `eval-runtime/src/harness/evidence.ts` | `applyEvidenceLimits`；`createEvidenceStore(blobStore)` 负责证据包格式（blob 去重、manifest、`evidenceId`、打开时校验 hash），应用只提供 `EvidenceBlobStore` |
| `eval-runtime` 执行 / 评估阶段 | 执行整体成功后导出并固化，导出走执行阶段的收集重试，最终失败则 Sampling 失败且不可评估；评估要求 `sampling.evidence`，`prepare` 中先初始素材与评分格式，再 `importEvidence`；评委提示词由 eval-platform 追加 |
| `eval-api/src/sp/` | SP Harness 实现导出（分页轨迹、映射为 `eval-trajectory/v1`）与导入（manifest 最后写入）；`trajectory.ts` 负责 SP 事件映射 |
| `eval-api/src/evidence/` | R2（S3 接口 + SigV4，无新依赖）与本地 `EVAL_BUNDLE_DIR/evidence/` 两种 blob 存储；Worker 环境变量 `EVAL_EVIDENCE_R2_*` |
| sp-platform `packages/eval-harness` | `evaluationId` 取代 `evaluationWorkspace`；证据 wire 类型；结果路径 `EVAL_RESULT_PATH = /output/result.json` |
| sp-platform `apps/agent` | 三个导出接口与一个导入接口；`TrajectoryStore.readAfter` 正序游标；删除评委绑定被测 SpaceDO、`/evaluations` 写入限制、轨迹复制接口和 `workspace-binding.ts`，并回退 Workspace / runtime-host / subagent / action-tools 中为共享 Workspace 加的代码 |

与草稿的差异：

- **类型名**：Sampling 上的引用叫 `EvidenceBundleRef`，因为 contracts 里已有表示评委证据引用的 `EvidenceRef`。
- **单文件上限 25MB**（草稿 50MB）：SP 每个文件经一次 Durable Object RPC 传递，RPC 消息约 32MiB 上限；SP 导出、导入接口都按 25MB 拒绝（413）。
- **轨迹也按 hash 存为 blob**：`evidence/blobs/<sha256>`，由 manifest 的 `trajectory.sha256` 指向；`evidenceId` 依赖轨迹 hash，无法事先放在 `evidence/<evidenceId>/trajectory.jsonl`。manifest 目录用 `evidenceId` 的 hex 部分。
- **导入方式**：没有沿用 `initialization` 接口，而是新增 `PUT .../evidence/files?path=`，每个文件单独请求、带 `X-Eval-Content-Sha256`，SP 校验 hash 后写入 `/evidence/<path>`，相同内容重复写入为空操作；manifest 最后写入，表示其列出的文件已全部就位。幂等键 `evidence:<evidenceId>:<evaluationId>` 只在 eval-platform 侧使用。
- **缓冲**：本地存储全程流式（临时文件 + hash + link）；R2 与 SP 导入按单文件缓冲（受 25MB 限制），R2 上传的轨迹 blob 也整体缓冲。
- **排除规则**不可在执行计划中覆盖，暂用 `DEFAULT_EVIDENCE_LIMITS`（`EvalRunResumerDependencies.evidenceLimits` 可在组装时替换）。
- **旧 Sampling**：没有证据包的 Sampling 评估时直接失败（"sampling has no evidence bundle"），未提供补导出命令。

验证记录（2026-10-15）：

- sp-platform `035318f0` 合入 `eval` 分支（快进），`deploy-eval` 部署成功（API、Space Worker、Agent、smoke）。
- 证据包存入 Eval SP 已有的 `sp-platform-content-eval-enam` 桶（`evidence/` 前缀），使用 Eval SP API 的同一把 R2 key，没有新建桶。
- 本地新建 `eval_evidence` 库（原 `eval` 库是重构前的 schema，保留未动），重建 hello 用例并跑 pipeline：Run 成功；Sampling 带 `evidence` 引用，manifest 列出 `/index.html`（217 字节），轨迹 13 条、`complete: true`；评委在自己的 Space 读取 `/evidence/manifest.json` 与产物后写 `/output/result.json`，得分 10，Langfuse 分数 `synced`；评委产物只有 `/output/result.json`。

未完成：补导出命令、第 6 阶段。

