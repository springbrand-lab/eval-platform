# 评委分数同步到 Langfuse Session

> 状态：已实现并在本地跑通（2026-10-15）。取代此前"Langfuse 优先、全部替换"的方案，该方案作废。

## 1. 范围

**只做一件事：** 评委打完分后，把分数写回 eval-platform 的评估记录，并同步为 Langfuse 上被测 Agent 那个 session 的分数。

**保持不变：**

- eval-platform 的数据库、测试集、项目配置、Run / Sampling / Evaluation 记录、Run Worker。
- 轨迹仍取自 SP（Chat DO 里的 `trajectory_events`，完整、不截断），并由 SP 写成评委 Workspace 中的 `/evaluations/subject-trajectory.jsonl`。
- Eval SP 自动把被测 Agent 和评委的 trace 上报到 Langfuse eval 项目。

## 2. 现状与缺口

| 环节 | 现状 |
| --- | --- |
| Eval SP | `eval` 分支部署的独立环境（`evalrapi` / `evalragent` / `evalworkspace`），代码与 dev 相同 |
| Langfuse session | SP 上报 trace 时 `langfuse.session.id` = Chat ID（`apps/agent/src/telemetry/severn-telemetry.ts`），所以**被测 Chat ID 就是 Langfuse session ID** |
| 评委输出 | 评委把结果写进 `/evaluations/<evaluationId>/result.json`，但 SP 的 `output` 接口只返回产物列表和轨迹引用 |
| eval-platform | `EvaluationAgentOutput` 已有 `score` / `reason` 字段，但 `harness-wire.ts` 的 `evaluationOutput` 不解析它们，评估记录里的分数一直为空 |
| Langfuse 分数 | 没有任何分数写入 |

## 3. 数据流

```text
评委 Agent 写 /evaluations/<evaluationId>/result.json
   │
   ▼
SP output 接口（role=evaluator）返回 result（result.json 的 JSON 内容）
   │
   ▼
eval-platform：按项目的评分格式（Output JSON Schema）校验
   │  ├─ 校验失败 / 文件缺失 → 评估记为 failed（不再静默缺分）
   │  └─ 通过 → 写入 EvaluationRecord.output（score、reason、result 原文）
   ▼
eval-platform：调用 Langfuse POST /api/public/scores
   sessionId = 被测 Chat ID（不填 traceId）
```

## 4. 改动

### 4.1 sp-platform（`zixian/eval-sp-api-20261014`，合入 `eval` 后部署）

1. 评委的 `output` 接口在 `status: succeeded` 时，读取 `/evaluations/<evaluationId>/result.json`，作为 `result` 字段（JSON）返回。
   - 文件缺失或不是合法 JSON：返回 `status: failed` 和明确的 `error`。
   - 大小设上限（如 1MB）。
2. 评委提示词里写明结果文件的固定路径，并要求按 `evaluation-output.schema.json` 输出。
3. `@springbrand/eval-harness` 契约同步加上 `result`。

### 4.2 eval-platform

1. **契约：** `EvaluationAgentOutput` 增加 `result`（评委原始 JSON）。`score` / `reason` 从 `result` 里取。
2. **评分格式约定：** 评委结果必须有顶层的 `score`（number），可选 `reason`（string）；其余字段原样保留在 `result` 里。这一约定在运行时检查，上传评分格式时暂不强制。
3. **解析与校验：** `harness-wire.ts` 解析 `result`；`evaluation.ts` 用项目的 Output JSON Schema（Ajv）校验，校验失败记为评估失败，可按重试策略重跑评委。
4. **Langfuse 同步**（新增一个小的 Langfuse 客户端，放在 eval-api 的适配层）：

   ```jsonc
   POST {LANGFUSE_BASE_URL}/api/public/scores   // Basic auth: public key / secret key
   {
     "id": "eval-score:<evaluationId>",        // 确定性 ID：重复同步是覆盖，不会产生重复分数
     "sessionId": "<被测 Chat ID>",
     "name": "judge-score",                    // 可按项目配置
     "value": <score>,
     "dataType": "NUMERIC",
     "comment": "<reason>",
     "environment": "<与 SP trace 的 langfuse.environment 一致>",
     "metadata": {
       "projectId": "...", "runId": "...", "samplingId": "...", "evaluationId": "...",
       "sampleId": "...", "evaluatorChatId": "...", "spSourceCommit": "..."
     }
   }
   ```

5. **同步失败的处理：** 分数先写入 eval-platform 的评估记录，再同步 Langfuse（429、5xx 和网络错误最多重试 3 次）。同步失败不影响评估结果，记录在评估的 `scoreSync`（`synced | failed`）中；`POST /api/projects/{projectId}/runs/{runId}/score-sync` 按 Run 补同步。
6. **配置：** `.env.eval` 增加 `LANGFUSE_BASE_URL`、`LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY`（eval 项目的 key，与 Eval SP 用的是同一个项目）和 `LANGFUSE_ENVIRONMENT=dev`（与 SP trace 的 environment 一致）。未配置时跳过同步，补同步接口返回 `503 SCORE_SYNC_UNCONFIGURED`。

## 5. 实施步骤

| 步骤 | 内容 | 完成标准 |
| --- | --- | --- |
| 1 | SP 评委 `output` 返回 `result`，更新 eval-harness 契约，部署 eval 环境 | 调 `output` 能拿到 `result.json` 的内容 |
| 2 | eval-platform 解析、校验 `result`，写入评估记录 | 本地跑 hello 用例，评估记录里有 score 和 reason |
| 3 | eval-platform 同步 Langfuse session 分数 | Langfuse eval 项目里，被测 Chat 对应的 session 上能看到 `judge-score` 和理由 |
| 4 | 同步失败重试与补同步接口、测试、文档 | `pnpm check` 和测试通过 |

## 6. 验证记录（2026-10-15）

- sp-platform `c4ae7e7e` 已部署到 eval 环境（`eval` 分支）。
- 本地对 hello 用例的采样跑独立评估：评估记录得到 `score: 10` 和理由，`scoreSync: synced`。
- Langfuse eval 项目里出现分数 `eval-score:<evaluationId>`：`judge-score = 10`，`sessionId` 等于被测 Chat ID，environment `dev`。
- 补同步接口对已同步的 Run 返回 `{synced: 0, failed: 0, skipped: 1}`。

## 7. 以后再考虑

- 多维度分数（每个 rubric 维度一个 Score）、规则断言分数、积分消耗作为 Score。
- 人工复核分数与评委分数对比（Langfuse 的标注队列）。
- 换用其他评委方式（例如本地 Agent）时，仍按同一结果格式写分。
