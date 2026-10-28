# EP 适配 SP 原生 Pi 轨迹：调研与定稿方案

> **历史调研（方案 A，不是当前实现）：**以下 `alpha.6`、旧
> `sp-trajectory/v1` 事件还原与无截止点兼容描述保留为当时的方案记录。
> 当前 EP 新运行使用已安装的公开 `@springbrand/eval-harness@0.1.0-alpha.7`
> SAFE Pi 原生页，见 [cutover 与 parity gate](pi-native-eval-cutover.md)；
> alpha.7 仍缺 `allowPartial` 的公开请求/路径契约，不可声称可上线。

调研基线：EP `origin/main` `cb26d1b`；SP 改造分支从 SP `origin/eval` `0542a5a4` 拉出，目标 Runtime 为 `@springbrand/agent-runtime@0.3.1-alpha.5`。EP 侧改动已在本分支实现，见文末“实现状态”。

## 结论

采用 **方案 A：兼容格式 + 固定截止点**。

- SP 内部改存 UA 原生 `pi-trajectory/v1` 记录，但对 EP 的 `/resources` 与 `/evidence/trajectory` 继续输出由原生记录还原的旧 `UniversalTelemetryEvent`，格式仍为 `sp-trajectory/v1`。
- SP 在证据页上**可选追加** `format` 与 `cursor: { throughSeq }`；EP 用它固定导出范围，并在续传时校验不变。
- EP Metrics、最终回复解析、证据存储结构和数据库均不改。

方案 B（EP 直接解析原生记录）暂不做：需要新的 harness 契约、重写最终回复和 Metrics 解释器；原生事件条目不带正文，工具输入/输出长度、thinking/content 判定只能降级，除非仍依赖 SP 还原，因此收益不抵成本。

## EP 现状（证据）

| 消费点 | 位置 | 方案 A 下的状态 |
| --- | --- | --- |
| 证据轨迹分页 | `apps/eval-api/src/sp/harness.ts:285-322` | 只按 `afterSeq` 翻页，**无固定截止点**：需改 |
| 证据页解析 | `apps/eval-api/src/sp/harness-wire.ts:201-206` | `z.object` 会丢掉新增字段：需加可选字段 |
| 证据格式 | `apps/eval-api/src/sp/harness.ts:517-523` | 写死 `sp-trajectory/v1`：改为取响应 `format`，缺省仍为该值 |
| 续传进度 | `packages/eval-contracts/src/evidence.ts:104-115`；`packages/eval-runtime/src/harness/evidence.ts:176-197` | 只存 `afterSeq`：需存格式与截止点 |
| 资源快照/就绪 | `apps/eval-api/src/sp/harness-wire.ts:156-195`；`packages/eval-runtime/src/runtime/resources.ts:24-54` | 适配层先剥离未知字段，Runtime 再严格校验；计数必须为非负数字。**不改**，由 SP 保证 |
| 最终回复 | `apps/eval-api/src/sp/harness-wire.ts:208-225` | 依赖 `turn.finished.payload.output.content`：**不改**，由 SP 保证还原完整 |
| Metrics | `packages/eval-metrics/src/aggregation/resource-facts.ts:88-127`、`resource-telemetry.ts` | 依赖 `eventId + resource.sessionId` 及旧事件类型：**不改** |
| 数据库 | `apps/eval-api/src/db/schema.ts:403-418` | 快照与进度均为 JSON：**无迁移** |

## 截止点语义

`throughSeq` 不是下一页游标 `nextAfterSeq`：

1. 首页不带 `throughSeq`，SP 返回首页数据和当时固定的 `cursor.throughSeq`。
2. 后续页带同一个 `throughSeq`，SP 只返回 `ingestSeq <= throughSeq` 的事件；`nextAfterSeq` 仍用于翻页。
3. EP 在首页后把 `format` 和 `cursor` 写入 `EvidenceExportProgress.trajectory`，与已存分片一起持久化；续传沿用保存值。
4. 任一页返回的 `cursor` 或 `format` 与保存值不同，判为不可重试的证据完整性错误，不能拼接。
5. 旧进度没有 `cursor`，或旧 SP 不返回 `cursor` 时，沿用现在的无截止点行为，保证混版可用；不要把旧进度重新标成新格式。

## EP 改动清单

1. `apps/eval-api/src/sp/harness-wire.ts`：证据页接受可选 `format`、`cursor.throughSeq`（正安全整数）；校验 `nextAfterSeq <= throughSeq`、事件 `ingestSeq <= throughSeq`。
2. `apps/eval-api/src/sp/harness.ts`：翻页携带固定 `throughSeq`；`trajectoryFormat` 取首页 `format`，缺省 `sp-trajectory/v1`；导出暴露 `trajectoryCursor`。
3. `packages/eval-runtime/src/harness/model.ts`、`packages/eval-contracts/src/evidence.ts`：`ExportedEvidence` 增加可选 `trajectoryCursor`；进度增加可选 `format`、`cursor`。
4. `packages/eval-runtime/src/harness/evidence.ts`：首次保存冻结、续传校验；不一致时报完整性错误。清单格式写入实际格式。
5. 测试：`apps/eval-api/src/sp/harness.test.ts`、`evidence.test.ts`（固定截止点、续传、旧 SP 无 cursor、cursor 变化拒绝）；`packages/eval-runtime/src/harness/evidence.test.ts`（旧进度续传、新进度锁定）。
6. 文档：`docs/eval-sp-harness-protocol.md` 与 `docs/package-boundaries.md` 的证据导出段落补充截止点语义。

## SP 侧必须保证（EP 不改的前提）

- `/resources` 和证据页仍输出旧事件：`eventId`、`type`、`operationId`、`occurredAt`、`resource.sessionId`、`submissionId` 稳定；同一事件跨快照内容一致。
- 就绪计数始终为非负数字；不可确认时置 `stateUnreadable: true`，不要输出 `null`。
- `turn.finished` 的回答文本、工具的 Action `executionId` 能从原生记录完整还原。
- 截止点生效后，后续页不再返回更大的 `ingestSeq`。
- `@springbrand/eval-harness` 作为契约唯一来源：先在 SP 增加可选 `format`、`cursor` 字段与 `throughSeq` 查询，发布新 alpha，再升级 EP（已升级到 `0.1.0-alpha.6`，`apps/eval-api/package.json:24`）。

## 发布顺序与混版

1. SP 先发布新增字段（可选、向后兼容）。旧 EP 会丢弃这些字段，行为与现在相同。
2. 发布 `eval-harness` 新 alpha。
3. EP 升级依赖并启用固定截止点。新 EP 连旧 SP 时缺省为无截止点、`sp-trajectory/v1`。

## 验证

```bash
pnpm check
pnpm -r --no-bail test   # 无 DATABASE_URL 时跳过 PostgreSQL 集成测试
```

另需一次 SP 新分支与 EP 的联调：执行完成后导出证据、中途续传、资源快照入库与 Metrics 统计，与旧格式结果比对。

## 实现状态

EP 侧已按方案 A 实现（基于 `cb26d1b`）：

- `apps/eval-api/src/sp/harness-wire.ts`：证据页解析可选 `format`（非空字符串）与 `cursor.throughSeq`（正安全整数），带 `cursor` 时校验每个事件 `ingestSeq <= throughSeq`、非空 `nextAfterSeq <= throughSeq`。依赖已升级到 `@springbrand/eval-harness@0.1.0-alpha.6`：页面类型基于包内 `EvalEvidenceTrajectoryPage`，缺省格式取包内 `EVAL_TRAJECTORY_FORMAT`。EP 仍保留自己的页面 schema：原地校验原始事件、不复制；并接受任意声明的 `format`，让格式变化由固定点校验报错，而不是被当作无法解析的页面。
- `apps/eval-api/src/sp/harness.ts`：新导出在 `exportEvidence` 中读取首页（不带 `throughSeq`）来固定格式（缺省 `sp-trajectory/v1`）与 `trajectoryCursor`，首页缓存给第一次 `readTrajectory(0)` 复用，不重复请求；后续页查询携带 `throughSeq`；任一页 `format` 或（已固定时）`cursor` 不同即不可重试 `SpHarnessError`。SP 未返回 `cursor` 时不发送 `throughSeq`，行为与原来一致。Harness 内部的 `ResolvedTrajectoryPin`（契约 `EvidenceTrajectoryPin` 补齐缺省格式）由 `resolveTrajectoryPin` 生成。
- 续传接缝：`ExportEvidenceInput.trajectory`（契约 `EvidenceTrajectoryPin {format?, cursor?}`）。Runtime（`packages/eval-runtime/src/runtime/execution.ts`）有已存进度时用 `evidenceTrajectoryPinOf(progress.trajectory)` 传回，Harness 按该固定点读取、不再重新固定；旧进度传 `{}`，按无截止点、`sp-trajectory/v1` 续读，并忽略新 SP 返回的 `cursor`。
- `packages/eval-contracts/src/evidence.ts`：新增 `EvidenceTrajectoryCursor`、`EvidenceTrajectoryPin` 与唯一复制函数 `evidenceTrajectoryPinOf`（字段表以 `satisfies` 约束，新增固定点字段未登记即编译失败）；`EvidenceExportProgress.trajectory` 可选 `format`、`cursor`。`packages/eval-runtime/src/harness/model.ts`：`ExportedEvidence.trajectoryCursor?`。
- `packages/eval-runtime/src/harness/evidence.ts`：新进度首存即写入 `format` 与 `cursor`（`pinOfExportedEvidence`），分片进度经 `evidenceTrajectoryPinOf` 保留；续传时 `format`（已存时）或 `cursor` 不一致抛 `EvidenceIntegrityError`；旧进度不补写字段；manifest 格式取已存 `format`，否则取导出实际格式。
- 固定窗口：新固定点在 `EvidenceStore.resume()` 首次持久化进度后才生效；此前不调用 `readFile`/`readTrajectory`、不存任何文件、分片或 manifest。首存失败时固定点随导出对象丢弃，下一轮无进度、重新固定，无残留（测试覆盖，代码无需改动）。
- 测试：`packages/eval-contracts/src/index.test.ts`、`apps/eval-api/src/sp/harness.test.ts`、`apps/eval-api/src/sp/evidence.test.ts`、`packages/eval-runtime/src/harness/evidence.test.ts`、`packages/eval-runtime/src/runtime/index.test.ts`。
- 文档：`docs/eval-sp-harness-protocol.md`（“Pinned evidence trajectory”）、`docs/package-boundaries.md` 证据导出段落、`packages/eval-runtime/README.md`、`packages/eval-contracts/README.md`。
- 未改：Metrics、最终回复解析、资源就绪 schema、数据库 schema/迁移。

待办：SP 新分支（`trevor/eval-ua-native-trajectory`）与 EP 联调（中途续传、截止点后新增事件不入包、旧进度续传）。
