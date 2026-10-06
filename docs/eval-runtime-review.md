# eval-runtime 评审记录

> 评审对象：`packages/eval-runtime`
>
> 记录日期：2026-10-06
>
> 记录性质：记录讨论中已经确认的问题及当前处理状态；未标注为“已处理”的问题仍属于后续工作。

## 评审共识

- 现有顶层包划分不需要重拆：`eval-contracts`、`eval-dataset`、`eval-runtime`、`eval-metrics`。
- `eval-runtime` 的核心流程已经成立，后续重点是合理修正和真实 SP 接入，不是重新设计整个 Runtime。
- Dataset 和 SP Submission 完全无关。Dataset 只保存可复用的输入数据；Submission、Agent、产物、轨迹和评估结果全部属于 Runtime。
- `Data/Sample` 是静态输入；`Sampling` 是一次实际运行实例。同一个 Sample 可以产生多个 Sampling，但不应该把静态输入内容重复持久化到每个 Sampling。
- Subject 产物是主要证据，完整 Trajectory 是辅助证据。
- 不复制 SP Runtime 内核，不访问 SP 私有实现和 Durable Object 内部存储，只通过 SP 的公开 Harness 边界接入。
- SP 真实接口、真正的 RuntimeStore 持久化、Agent 恢复/重启、超时、取消和推送丢失处理属于生产化接入与可靠性完善；它们不是核心 Runtime 流程的阻塞项。

## 已确认问题

### R-01：收集产物失败会重新执行 Agent（已处理）

**历史现象**

Subject 或 Evaluation 的 Submission 已经成功，但后续 `collectExecution()` 或 `collectEvaluation()` 失败时，生命周期会进入重试。由于已有 Submission，下一轮会调用 `restartAgent()`，重新投递任务。

相关位置：`packages/eval-runtime/src/runtime/agent-lifecycle.ts:230`、`packages/eval-runtime/src/runtime/agent-lifecycle.ts:248`。

**大白话**

Agent 已经把任务做完了，只是 Runtime 没把结果拿回来。现在的行为却是让 Agent 再做一遍，而不是继续收集原来的结果。

**影响**

- Subject 可能被重复执行；
- 产生重复成本和重复副作用；
- 后一次执行可能覆盖前一次执行的证据；
- 重试次数被错误地消耗在“收集失败”上。

**已落实**

`packages/eval-runtime/src/runtime/agent-lifecycle.ts` 现在按生命周期阶段处理：

- `RetryOperation` 明确区分 `submission`、`status`、`collection` 和 `restart`；
- Submission 响应不确定时，按本次操作的幂等键校准，重试提交也复用同一个幂等键；
- 状态确认失败只按 `status` 决策，永远不会直接进入 `restartAgent()`；
- 产物/轨迹收集失败只按 `collection` 决策，始终复用已完成的 Agent；
- 只有收到明确的终态失败，才构造 `ConfirmedSubmissionFailure` 并按 `restart` 决策；
- 默认控制器只定义确认失败后的重启策略，状态确认和收集策略由注入的控制器决定，避免提前固化尚未确定的次数和退避规则。

---

### R-02：重启请求响应丢失时，可能重复重启同一个 Agent（已处理）

**历史现象**

重启请求的幂等键包含 attempt 次数：

```text
execution:<samplingId>:restart:1
execution:<samplingId>:restart:2
```

相关位置：`packages/eval-runtime/src/runtime/agent-lifecycle.ts:208-224`。

**大白话**

第一次 `restartAgent()` 请求可能已经被 SP 接受，但 Runtime 没收到响应。下一轮重试使用了新的幂等键，SP 会把它当成一个新的重启请求。

**影响**

- 同一个 Sampling 可能被重复重启；
- 同一个 Chat/Workspace 可能收到多次重启消息；
- 原请求和新请求的结果会变得难以判断。

**已落实**

- `submitWithReconciliation()` 为一次重启操作固定一个幂等键；
- 响应丢失时调用 `inspectAgentOperation({ handle, idempotencyKey })`，只查询本次操作；
- 查询不到或查询失败时，重复调用复用原幂等键；
- 只有按原幂等键查到该次重启明确失败后，下一次有意发起的新重启才使用新的 attempt/key；
- 不再提供不带操作身份的 `inspectAgent()` 校准路径。

进程崩溃后的跨进程恢复仍依赖后续持久化的操作状态，不在本次 Runtime 核心实现范围内。

---

### R-03：一个 `Sampling.status` 同时表示执行阶段和评估阶段（已处理）

**现象**

Subject 执行成功后，`Sampling.status` 是 `succeeded`。调用 `evaluate()` 时，`resetEvaluation()` 又把同一个状态改回 `queued`，评估完成后再改为 `succeeded`。

相关位置：`packages/eval-runtime/src/runtime/index.ts:431-448`。

**大白话**

看到 `queued` 或 `succeeded` 时，外部不知道它表示：

- Subject 还没执行；
- Subject 已经完成、正在等待评估；
- Evaluation Agent 正在运行；
- 还是评估已经完成。

**影响**

- 执行状态和评估状态互相覆盖；
- 查询方无法判断下一步该做什么；
- Pipeline 需要靠额外特判解释状态；
- 恢复和重试无法只针对某一个阶段。

**正确原则**

执行和评估要有独立的阶段状态。Sampling 可以作为聚合对象，但不能用一个状态字段同时承载两个阶段的生命周期。

**已落实**

- `Sampling.execution` 和可选的 `Sampling.evaluation` 分别保存执行、评估阶段状态；两者共用 `SamplingStatus`。
- 两个阶段都按 `queued → starting → running → retrying → succeeded/failed/cancelled` 流转，避免为评估另造一套状态类型。
- 未请求评估时保持 `evaluation === undefined`，不引入额外的“尚未评估”状态。
- 执行和评估分别写入各自阶段；评估失败不会覆盖执行成功状态，Run 聚合时按当前阶段读取对应状态。
- `packages/eval-runtime/src/runtime/index.test.ts` 覆盖仅执行、评估成功、评估失败三种状态隔离场景。

---

### R-04：创建 Agent 的响应丢失时，会重复创建 Agent（已处理）

**现象**

`startAgent()` 请求已经在 SP 侧创建成功，但返回 `AgentHandle` 时网络断开。Runtime 本地没有 `handle`，下一轮会再次调用 `startAgent()`。

相关位置：`packages/eval-runtime/src/runtime/agent-lifecycle.ts:190-197`。

**大白话**

SP 里已经有第一个 Agent 了，Runtime 不知道，于是又创建第二个。后续任务使用第二个 Agent，第一个 Agent 变成没人管理的孤儿。

**影响**

- 可能多启动一个 Agent；
- 第一个 Agent 可能继续占资源或执行；
- 一个 Sampling 对应多个 Chat/Workspace；
- 后续产物和轨迹归属不清楚。

**正确原则**

创建 Agent 也需要稳定的创建身份：

- 使用 `stage + samplingId` 等稳定键幂等创建；或
- 创建响应丢失时，可以按该身份查询并复用已有 Agent；
- 不能因为本地没拿到响应就直接重新创建。

**已落实**

- Runtime 在创建执行或评估 Agent 前先分配并持久化该阶段的 `submissionId`，把它作为 SP Chat/Agent 的稳定身份。
- Harness 改为 `ensureAgent()` 语义：同一身份重复或并发调用必须返回同一个 Agent，不能再次创建；这与 SP `Inbox.createChat(..., chatId)` → `lifecycle.ensure()` 的方案一致。
- 创建响应丢失后的重试保留完全相同的身份和创建参数；它使用 `creation` 重试操作，不增加 Sampling、执行/评估 attempt，也不使用新的 Agent 重启键。
- Runtime 校验返回的 Agent Handle 必须匹配请求身份；身份冲突或错误绑定不可重试。
- `packages/eval-runtime/src/runtime/index.test.ts` 覆盖创建响应丢失后复用同一身份的场景。

---

### R-05：Run 和 Sampling 的创建/准备不是原子操作（已处理）

**现象**

`start()` 和 `pipeline()` 先批量创建 Sampling，再创建 Run：

```text
createSampling(...)
createRun(...)
```

相关位置：`packages/eval-runtime/src/runtime/index.ts:285-290`。

`evaluate()` 则先重置并写回 Sampling，再创建新的 Run，相关位置是 `packages/eval-runtime/src/runtime/index.ts:140-157`。

**大白话**

- 创建 Sampling 成功、创建 Run 失败，会留下没有 Run 管理的孤儿 Sampling；
- 批量创建 Sampling 时中途失败，会留下半批数据；
- `evaluate()` 先把旧评估清掉，之后创建 Run 失败，会变成旧结果没了、新任务也没有。

**影响**

- 持久化数据不完整；
- 运行恢复时不知道这些 Sampling 属于哪次操作；
- 评估准备动作可能已经发生，但没有对应的 Run 记录。

**正确原则**

Run、Sampling 和评估准备需要有明确的一致性边界：

- 优先使用同一事务/聚合写入；或
- 使用可恢复的准备-提交流程；或
- 使用明确的补偿和清理机制。

不能继续依赖“先写一部分，后面大概率成功”。

**已落实**

- `RuntimeStore` 提供语义化的 `createRunWithSamplings()`，`start()`、`pipeline()` 和 `evaluate()` 都通过一次 Store 操作创建 Run 与 Sampling；Runtime 不再分别调用 `createSampling()` 和 `createRun()`。
- `pipeline()` 的评估准备通过 `prepareEvaluationSamplings()` 批量提交，避免逐条重置评估状态。
- `evaluate()` 先在内存中构造新的评估状态，再与新的评估 Run 一起原子写入；写入失败时，旧评估结果保持不变。
- Store 实现必须在自己的单一持久化边界内使用 PostgreSQL/DO SQLite 事务；事务内不执行 Harness、网络或其他外部调用。
- 语义化写入按 Run/Sampling 身份保持可重试，具体幂等和唯一约束由 Store 实现负责；跨存储场景不伪造分布式事务，改用持久化操作记录和补偿恢复。
- `packages/eval-runtime/src/runtime/index.test.ts` 覆盖评估准备原子提交失败时保留旧结果的场景。

---

### R-06：Pipeline 中一个 Subject 失败会阻塞所有成功 Subject 的评估（已处理）

**现象**

`runPipeline()` 只要发现一个执行结果不是 `succeeded`，就直接返回：

```ts
if (executedRecords.some(({ sampling }) => sampling.status !== "succeeded")) {
  return;
}
```

相关位置：`packages/eval-runtime/src/runtime/index.ts:341-349`。

**大白话**

10 个 Sampling 执行时，9 个成功、1 个失败。现在 9 个已经有产物和轨迹的 Sampling 也不会进入 Evaluation Agent，最后没有评分。

**影响**

- 成功样本的结果被浪费；
- 一个样本故障扩大成整批评估缺失；
- 不符合 Sampling 彼此独立的模型；
- 后续重试时无法只处理失败样本和未评估样本。

**正确原则**

- 成功的 Sampling 继续进入评估；
- 失败的 Sampling 保留失败状态；
- Run 只汇总结果，不阻断其他 Sampling 的独立生命周期。

**已落实**

- Pipeline 执行完成后只筛选 `execution.status === "succeeded"` 的 Sampling 进入评估。
- 执行失败的 Sampling 不启动评估 Agent，保留执行失败，`evaluation` 不创建。
- Run 聚合会等待仍在执行或评估中的 Sampling 完成后再判定最终失败，避免提前结束 Pipeline。
- 只有全部可评估 Sampling 完成后，执行失败或评估失败才会让整个 Pipeline Run 最终为 `failed`。
- `packages/eval-runtime/src/runtime/index.test.ts` 覆盖“部分执行成功、部分执行失败仍继续评估”的场景。

---

### R-07：Run 不应该维护一份独立的权威状态（已处理）

**现象**

Run 有自己的 `status`，Runtime 又根据 Sampling 状态不断聚合和更新它。相关位置包括：

- `packages/eval-runtime/src/runtime/store.ts:13-15`；
- `packages/eval-runtime/src/runtime/index.ts:392-408`；
- `packages/eval-runtime/src/runtime/index.ts:452-470`。

**大白话**

真正执行的是 Sampling，Run 只是把一批 Sampling 绑在一起的容器和查询句柄。但现在 Sampling 有状态，Run 又保存一份聚合状态，形成两份真相。

**影响**

- Run 状态可能和 Sampling 状态不一致；
- Pipeline 需要反复把 Run 改成 `queued/running/succeeded/failed`；
- 部分成功、取消、阶段切换都要靠额外的聚合特判；
- Run 的状态更新可能覆盖真实的 Sampling 状态语义。

**正确原则**

- Run 主要保存 `runId`、`projectId`、`samplingIds` 以及运行类型/请求信息；
- Sampling 保存真实的执行和评估状态；
- Run 状态需要时从 Sampling 即时推导；
- 如果为了查询性能保留缓存，只能是派生投影，不能成为第二个权威状态。

**已落实**

- 持久化的 `RuntimeRunRecord` 只保存 `runId`、`projectId`、`samplingIds` 和 `phase`，不再保存 `status`。
- `RuntimeStore` 不再提供 `updateRun()`；Run 创建后不需要随着 Sampling 生命周期反复写回状态。
- `getRun()` 读取关联 Sampling，并通过 `aggregateRunStatus()` 即时生成对外 `RunSnapshot.status`；这个字段是查询投影，不是第二份持久化事实。
- 执行、评估、Pipeline 的生命周期只更新 Sampling；失败、部分成功和阶段切换都由 Sampling 状态自然聚合。
- Runtime 测试在没有任何 Run 状态写入接口的情况下覆盖运行中、成功和失败状态查询。

---

### R-08：Subject 产物和轨迹存了两份

**现象**

同一份 Subject 产物和轨迹同时存在于：

- `Sampling.artifacts`、`Sampling.trajectory`；
- `RuntimeSamplingRecord.execution.artifacts`、`RuntimeSamplingRecord.execution.trajectory`。

相关位置：

- 契约：`packages/eval-contracts/src/model.ts:115-128`、`packages/eval-contracts/src/model.ts:166-171`；
- 写入：`packages/eval-runtime/src/runtime/execution.ts:94-105`；
- 读取：`packages/eval-runtime/src/runtime/evaluation.ts:37-38`、`packages/eval-runtime/src/runtime/evaluation.ts:99-105`。

**大白话**

执行完成时要同时写两边。评估读取一边，查询方可能读取另一边。以后两份内容不一致时，不知道哪份是真的。

**正确原则**

Subject 的产物和完整轨迹只在 `Sampling` 中保留一份，作为唯一真相。`ExecutionOutput` 如果继续存在，只能是生命周期函数的临时返回值，不能再作为第二份持久化结果。

---

### R-09：`start()` 和 `pipeline()` 缺少请求级幂等

**现象**

入口每次调用都会生成新的 Run ID 和 Sampling ID。请求本身没有调用方幂等键，也没有“已处理请求 → 原 Run”的持久化映射。

相关位置：`packages/eval-runtime/src/runtime/index.ts:116-134`、`packages/eval-runtime/src/runtime/index.ts:164-180`。

**大白话**

1. 客户端调用 `start()`；
2. Runtime 已经创建了 Run、Sampling 和 Agent；
3. 返回 `RunHandle` 时网络断了；
4. 客户端重试；
5. Runtime 又创建并执行一整批新的 Sampling。

**影响**

- 同一个逻辑请求被执行两次；
- 产生重复成本、重复产物和重复评估；
- SP 内部的 Submission 幂等无法解决 Runtime 整体重复创建的问题。

**正确原则**

入口需要调用方提供幂等键，并把它和原 Run 绑定。相同幂等键再次请求时，直接返回原来的 RunHandle，而不是重新创建 Sampling。

本条已确认的范围是 `start()` 和 `pipeline()`；`evaluate()` 是否允许同一 Sampling 被有意重新评估，需要单独定义业务语义。

---

### R-10：静态输入被重复塞进每个 Runtime Sampling

**现象**

Dataset 的 `Data` 保存静态输入，但 Runtime 又定义了复制这些字段的 `Sample`：

- `packages/eval-dataset/src/dataset/model.ts:21-28`；
- `packages/eval-runtime/src/runtime/model.ts:19-26`。

同时，`RuntimeSamplingRecord` 又直接包含完整 `sample`：

- `packages/eval-runtime/src/runtime/store.ts:17-22`；
- `packages/eval-runtime/src/runtime/index.ts:249-268`。

`persistNewRun()` 再把完整 `RuntimeSamplingRecord` 交给 `RuntimeStore`：

- `packages/eval-runtime/src/runtime/index.ts:285-290`。

**大白话**

一个 Sample 启动 100 次，真正需要的是 100 份不同的运行状态；不是把同一份 JSON、初始上下文和素材描述复制 100 次。

**边界共识**

- Dataset 只负责 `Data/Sample` 静态输入；
- Dataset 和 Submission 完全无关；
- `Sampling` 只保存 `sampleId` 和这一次运行自己的状态、Submission、产物、轨迹、评估结果；
- `RuntimeSamplingRecord.sample` 如果为了执行方便保留，只能是运行时临时拼出来的关联对象，不能作为每个 Sampling 的持久化副本。

**正确原则**

```text
Data/Sample：存一份静态输入
Sampling：存 N 份独立运行状态，只引用 sampleId
RuntimeSamplingRecord：运行时 join，不作为完整持久化结构
```

---

### R-11：`RunPhase` 把 Pipeline 错当成了阶段

**现象**

当前模型把下面三个值放在同一个 `RunPhase` 中：

```ts
"execution" | "evaluation" | "pipeline"
```

相关位置：`packages/eval-contracts/src/model.ts` 的 `RunPhase` 定义，以及 `packages/eval-runtime/src/runtime/index.ts:271-282`、`packages/eval-runtime/src/runtime/index.ts:452-463`。

**大白话**

真正的执行阶段只有两个：

```text
execution
evaluation
```

`pipeline` 不是第三个执行阶段，只是把这两个阶段串起来的编排方式。

**影响**

- `phase` 这个字段名和真实语义不一致；
- 聚合逻辑需要写 `phase === "pipeline"` 的特殊判断；
- 后续独立设计执行状态和评估状态时，模型会继续混淆；
- 查询方无法区分“Run 的启动模式”和“当前正在执行的阶段”。

**正确原则**

拆开两个概念：

```text
runKind / orchestration: execution | evaluation | pipeline
stage: execution | evaluation
```

但更准确的边界是：Pipeline 不应该成为 `runKind`，也不应该创建单独的 Pipeline Run。Pipeline 只是一个行为，负责先调用 execution，再调用 evaluation；持久化的仍然只有实际的执行记录和评估记录。Pipeline 是两个阶段的组合，不是第三种数据模型。

---

### R-12：评估结果应该独立建模为 `EvaluationRecord`

**现象**

当前 Subject 的产物、轨迹和尝试记录属于 `Sampling`，但 `EvaluationAgentOutput` 只存在于 `RuntimeSamplingRecord.evaluation`：

```ts
interface RuntimeSamplingRecord {
  readonly sampling: Sampling;
  readonly sample: Sample;
  readonly execution?: ExecutionOutput;
  readonly evaluation?: EvaluationAgentOutput;
}
```

**大白话**

一个 Sampling 的执行事实在 `Sampling` 里，评估事实却挂在 Runtime 的临时包装对象旁边。单独拿到 `Sampling`，看不到评估结果；只拿 RuntimeSamplingRecord，又把领域数据和运行时拼装结构绑在了一起。

**正确原则**

评估结果应该独立建模成明确的 `EvaluationRecord`，通过 `samplingId` 关联：

```text
Sampling
└── samplingId

EvaluationRecord
├── evaluationId
├── samplingId
├── evaluator
├── submission
├── attempts
├── output
└── status
```

这样执行记录和评估记录各自有清晰的所有权，评估结果不再依赖 `RuntimeSamplingRecord` 这个内部拼装结构。

---

### R-13：`config` 必须成为真正的配置入口

**现象**

`packages/eval-runtime/src/config/model.ts` 定义了 `ExecutionConfig`、`EvaluationConfig` 和 `PipelineConfig`，但 Runtime 实际执行仍直接接收 `StartRunRequest`、`EvaluateRequest` 和 `PipelineRequest`。

**大白话**

现在有两套配置模型，但只有 Request 真正生效。`config` 只是被导出、没有参与配置解析、校验、查找或运行。

**确认结论**

不删除 `config`，而是让它成为真正的配置入口：

- 配置负责定义可复用的执行、评估和 Pipeline 参数；
- Runtime 请求只负责选择配置并提供本次运行的输入范围/覆盖项；
- 配置经过统一解析和校验后，生成 Runtime 使用的有效配置；
- `StartRunRequest`、`EvaluateRequest`、`PipelineRequest` 不能再和 `config` 平行维护一套重复字段。

这样 `config` 才有真实职责，也能成为运行配置的唯一来源。

---

### R-14：`RuntimeSamplingRecord` 不能同时承担三种职责

**现象**

当前 `RuntimeSamplingRecord` 同时被用作：

1. `RuntimeStore` 的持久化记录；
2. Runtime 内部执行时拼出的上下文；
3. `getSampling()` 对外返回的查询结果。

它把 `sampling`、`sample`、`execution` 和 `evaluation` 全部放在同一个类型中。

**大白话**

数据库记录、Runtime 临时对象和公开 API 返回值全部挤在一个类型里。于是 Sample 被带进持久化，EvaluationRecord 独立后又无法自然归位，Store 的变化也会直接变成 API 变化。

**正确原则**

至少要区分三个边界：

```text
SamplingState       持久化的 Sampling 状态
SamplingContext     Runtime 执行时拼出的 Sample + Sampling
SamplingSnapshot    对外查询结果
```

不要求拆成新的 workspace package，但不能继续让一个 `RuntimeSamplingRecord` 包打天下。

---

### R-15：配置需要统一的运行时解析、校验和归一化入口

**现象**

当前配置校验散落在多个位置：

- `packages/eval-runtime/src/runtime/index.ts` 校验 ID、并发数和请求结构；
- `packages/eval-runtime/src/runtime/retry.ts` 校验重试参数；
- `packages/eval-runtime/src/runtime/agent-lifecycle.ts` 校验 Harness 类型；
- `packages/eval-runtime/src/config/model.ts` 只有 TypeScript 接口，没有运行时解析和校验。

**大白话**

外部配置进来后，不是先变成一份确定、合法的有效配置，而是执行到哪里再临时检查哪里。

**正确原则**

配置成为正式入口后，应该统一走：

```text
加载配置 → 解析 → 完整校验 → 归一化 → Runtime 只消费有效配置
```

Runtime 内部不再对同一份配置做分散、重复和不一致的临时判断。

同时，本次解析出的有效配置必须和运行绑定并固化：

- 保存配置 ID 及版本；或
- 保存本次生效配置的不可变快照；
- 不能只保存 `runId`、`projectId` 和 `samplingIds`，却无法知道本次运行实际采用了什么并发、重试和 Harness 参数。

## 明确不计入本次问题

以下内容在讨论中被明确排除，不能重新当作已确认问题：

- SP 中 Chat ID 和 Submission ID 的重复：两者在当前 SP 语义中相同，不作为问题；
- `materializeEvaluationInput()` 当前没有返回复制回执：这是 SP 正式写入接口接入工作，不作为当前 Runtime 核心问题；
- Sampling 并发写入、旧 Worker 与新 Worker 同时写入、因此必须增加版本号/CAS：当前没有确认这些场景，版本号不作为独立问题；
- 未分类错误默认是否可重试：错误分类方案尚未确定，先预留，不作为当前问题；
- 重新评估是否覆盖历史结果：当前不把它作为问题；
- 通过持续轮询、超时、取消、推送丢失等生产化机制完善运行可靠性：属于后续接入和可靠性工作，不阻塞核心 Runtime 设计；
- 重新拆分顶层 workspace 包、照搬 pydantic 代码细节、增加没有明确职责的 adapter/config 包：均不属于本次评审目标。

## 当前结论

当前评审确认的核心方向不是重写 Runtime，而是收紧唯一真相和实体边界：

1. Sampling 只保存一次运行实例的真实状态；
2. Data/Sample 只保存静态输入，不携带任何 Submission；
3. 产物和轨迹只保留在 Sampling；
4. Run 作为分组/查询句柄，不维护第二份权威状态；
5. 执行阶段和评估阶段状态分开；
6. Pipeline 是编排方式，不是第三个阶段；
7. SP Agent 创建、提交、重启和收集遵守同一次操作的幂等语义；
8. Runtime 入口对整批请求提供幂等；
9. 每个 Sampling 的成功或失败不应阻断其他 Sampling 的独立生命周期。
