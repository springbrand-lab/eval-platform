# Package Boundaries

## Repository layout

```text
eval-platform/
├── packages/
│   ├── eval-contracts/
│   ├── eval-dataset/
│   ├── eval-runtime/
│   └── eval-metrics/
└── apps/
    ├── eval-api/
    ├── eval-web/
    └── eval-cli/
```

The four package workspaces keep the package boundary stable. `eval-runtime` contains runtime orchestration; `eval-dataset` contains Dataset/Data management, validation and serialization. Persistence implementations and application integration remain outside these package cores. Applications additionally contain `CONTEXT.md`.

The deployment source for the SP Harness is a fixed SP Git branch resolved to a commit during one Eval release workflow. That workflow deploys an independent Eval SP API/database, Agent Worker, Space Worker, DO namespaces and R2; all Eval SP calls, including login and Agent Config, target this deployment. Deployment orchestration is repository-level work, not another workspace package. See [Eval SP deployment](eval-sp-deployment.md). The source branch belongs to Project, while each Run records the actual source commit; Sampling does not own a branch.

Package-internal submodules:

```text
eval-dataset/
└── dataset/

eval-runtime/
├── config/
├── harness/
└── runtime/

eval-metrics/
├── evaluators/
├── aggregation/
└── reporting/
```

## Dependency direction

```text
eval-contracts → eval-dataset → eval-runtime → eval-metrics
                        ↓             ↓             ↓
                       eval-api / eval-web / eval-cli
```

The arrows describe allowed consumption direction. The contract package must not depend on runtime, storage, API, Web, CLI or Cloudflare bindings.

## Package responsibilities

### `eval-contracts`

Owns stable runtime/evaluation types shared across packages: Project, Sampling, HarnessConfig, ExecutionOutput, EvaluationAgentOutput, EvaluatorResult, ArtifactRef, TrajectoryRef and EvidenceRef. Project's target model binds an SP source branch; Run records the deployed source commit as provenance, without adding a branch to Sampling. These fields are not yet implemented in the current contracts/schema. Dataset/Data belong to `eval-dataset`; runtime Sample belongs to `eval-runtime`. Evidence and explanations remain Evaluation Agent outputs, not an independent attribution contract.

It is the only place for cross-package evaluation contracts. `AgentResourceSnapshot` carries unchanged SP usage events, telemetry events and billing settlements with collection scope and source-completeness metadata. It does not implement orchestration, persistence, normalization, aggregation or pricing.

### `eval-dataset`

Owns Dataset/Data schemas, required current `userPrompt`, arbitrary additional JSON business fields, initial-session references, initial-material references, JSON/YAML serialization and `createDatasetService(store)`. Dataset and Data are scoped to one Eval SP user by the application Store; Data is reusable across that user's datasets through explicit associations, not per-dataset copies. Runtime Sample is owned by `eval-runtime` and inherits its Data owner's scope. The pure Dataset package does not authenticate users or store SP accounts. Dataset and reference objects are strict; Data preserves arbitrary extra JSON business fields while validating known fields. Its user prompt cannot be omitted or blank, and extension fields cannot override the generated `dataId` on creation.

JSON numbers must be finite, and integers must stay within JavaScript's safe-integer range at every input, persistence validation and serialization boundary. Larger integer identities must be supplied as strings; the package rejects them rather than coercing or rounding them. YAML integers are parsed as BigInt and range-checked before conversion. JSON and YAML reject duplicate property names within each object; JSON checks decoded property names before native parsing can discard earlier values and does not accept JSONC extensions.

`InitialSessionRef` contains required external `bundleId` and `sessionId`; `InitialMaterialsRef` contains required external `bundleId` and `materialId`. Both references themselves are optional, but a supplied reference must locate a concrete resource inside a Bundle, not just the Bundle itself. Eval validates and preserves these identifiers without generating, deriving or filling them in; this is separate from automatic Dataset/Data entity ID generation. Generator specs and inline resource bodies are not accepted as references. The initialization Session identity is not the active Chat/Submission identity. Session bodies, framework-native formats, tool-call schemas and Context reconstruction belong to SP and the selected Agent framework. The current task is the required `userPrompt`, not a field inferred from generic data or Session history. Dataset does not own a second Session store.

The four internal files are `dataset/model.ts`, `dataset/serialization.ts`, `dataset/store.ts` and `dataset/index.ts`. Creation uses native UUIDs; editable-field updates are full replacements. Dataset/Data platform IDs are validated as UUIDs and canonicalized to lowercase at the schema boundary, following SP's Zod UUID normalization pattern. Import, duplicate detection, service queries, Store comparisons and returned snapshots use that canonical identity; external resource references and Data business fields are preserved unchanged. Serialization has no persistence side effects. Import assigns missing IDs and submits a complete `DatasetSnapshot` through one atomic Store command. Existing IDs may be reused only for identical content; conflicting imports never overwrite or partially commit. Deleting a Dataset preserves shared Data; deleting referenced Data is rejected atomically. Export reads one consistent Store snapshot.

`DatasetStore` is the application-injected PostgreSQL persistence port. Its implementation must follow SP's transaction, uniqueness and foreign-key constraint pattern, not instantiate a database client inside the Dataset package or rely on service-side prechecks. File bundles remain references to existing material capabilities; the package does not generate manifests/hashes, upload/download files, own an R2 binding or operate DO storage. Runtime/Harness owns materialization through public Workspace boundaries. SP's private workspace helpers are not copied or imported across repository source paths.

### `eval-runtime`

Owns Config resolution plus `start`, `evaluate`, `pipeline`, `getRun`, `getSampling`, `getEvaluation`, `listEvaluations`, Sampling lifecycle, separate execution/evaluation concurrency limits, retry, evaluation-input materialization and the `RuntimeStore` persistence port. `ExecutionConfig` owns Dataset/Sample selection and Subject execution policy; `EvaluationConfig` owns the Evaluation Agent policy; `PipelineConfig` composes the two. Runtime requests only select these configs and provide the Project/Sampling scope required by the operation. `ConfigResolver` is the single runtime parsing/validation/normalization boundary and returns effective configs with explicit defaults. `RuntimeStore.createRunWithSamplings()` atomically creates the Run, Sampling records, the Run's EvaluationRecords and the Run's immutable effective-config snapshot; the Runtime does not sequence independent persistence calls for one aggregate. Run status is a derived query projection from Sampling and EvaluationRecord state, not a separately persisted RuntimeStore field. No config version concept is introduced. SP is the first-party Harness contract inside this boundary; `apps/eval-api` composes its concrete public HTTP/WebSocket client, and a separate `eval-sp-adapter` package is intentionally not created.

Run binds a batch of Samplings to an immutable scope of actual phases: execution, evaluation, or execution followed by evaluation. `RunPhase` contains only `execution | evaluation`; `RunPhases` allows only those three valid scopes. A Run is the same generic query handle for each scope, not a separate Pipeline entity or Run kind. `getRun()` derives both the current phase and status from the scoped Sampling states. `pipeline()` only sequences the two real phases, and failure handling follows the next unfinished phase without a Pipeline-specific state branch.

Harness exposes `ensureAgent`, not an unconditional creation operation. SP Chat is the persistent Session; each prompt submission within that Chat has its own SP Submission ID. Runtime assigns and persists the Subject `subjectChatId` or Evaluator `chatId` before calling SP, then passes it through the ordinary Inbox/Chat creation seam of the independent Eval SP deployment. Repeated or concurrent ensures for the same Chat identity must return the original Agent handle. An identity already bound to a different owner, Project, Sampling, role, framework, Agent Config or Evaluator Workspace binding must fail without rebinding or creating another Agent. SP owns authoritative deduplication and provisioning; Runtime owns identity persistence and operation-specific retry decisions, not a second local creation registry.

`start()` and `pipeline()` also use SP's request-admission pattern at the Run level: a caller-provided `requestId` and optional `idempotencyKey` are persisted with the Run identity, checked before expensive sample resolution, and checked again by the Store's atomic Run/Sampling admission. A duplicate returns the original Run; an identity bound to different request facts is rejected. Runtime memory is only an optimization and never the source of truth.

Static Sample input belongs to the Catalog, not to each Sampling record. `SamplingState` contains only run-specific Sampling state; `EvaluationRecord` independently owns evaluator, submission, attempts, status and output, linked by `samplingId`. Execution consumes a temporary `RuntimeSamplingContext`; evaluation consumes a temporary `RuntimeEvaluationContext` that joins Sampling, EvaluationRecord and Sample. Store commands never include those temporary contexts, and `getSampling()` returns a separate flat `SamplingSnapshot`. Independent evaluation resolves distinct Sample IDs through `RuntimeCatalog.getSample()` before the atomic Run/Sampling/EvaluationRecord write. No Sample versions or input snapshots are introduced.

`Sample` is `{ sampleId: string, data: Data }`, not an extension of Data. Catalog methods and Runtime input preparation consume this single shape, with no flattened compatibility branch. The outer `sampleId` is a platform identity; a business `sampleId` inside Data remains arbitrary JSON and is preserved for both Subject and Evaluation Agent initialization. Only Data's platform `dataId` is stripped from the Agent input. This does not introduce a persisted Data copy for each Sampling.

`SpHarnessConfig.kind` selects the SP hosting boundary, while its required `framework` selects the Subject engine: `sp`, `codex`, or `cc` (Claude Code). All three use the same public Chat/Submission/Workspace lifecycle, not an eval-owned CLI or process launcher. `EvaluationConfig` requires the SP framework and a selected SP Agent Config. The framework is part of the Run's effective-config snapshot, request fingerprint and immutable Agent creation facts. `ensureAgent` receives it and returns a handle bound to that framework; subsequent operations use that handle, and retries cannot silently switch engines. Missing or unsupported frameworks fail configuration validation without falling back to SP. The eval-side boundary assumes SP provisions the selected engine; this change does not implement cloud provisioning in SP.

Before a Subject's first submission, `materializeInitialData()` receives the complete `DataInput`, preserving extra business fields but excluding platform Sample/Data identities. It must copy any initial materials and referenced Session into that Agent's own DO storage, load it using the selected framework and rebuild Context. The current `userPrompt` is then submitted unchanged, not wrapped with business data or Session history. Its stable initialization idempotency key is scoped to the target Chat/Session identity; repeated calls return the original preparation result without restoring over an advanced Session, and conflicting initialization facts are rejected. Runtime stores no second preparation registry. A restart continues the existing Agent Session and does not reapply the seed. Session references and bodies are not included in the execution prompt or Sampling persistence. An Evaluation Agent remains an independent Chat and Session, but its Workspace is bound to the Subject Chat's physical SpaceDO by the Subject owner user ID and Chat ID. Its own material inputs and outputs are confined to `/evaluations/<evaluationId>/`; Subject artifacts remain in place and are read as primary evidence. The complete Subject trajectory is materialized into that same SpaceDO as supporting evidence. The Evaluator never loads the Subject's seed as its own running Session. SP initialization is assumed to exist at the public Chat/Workspace boundary; no SP implementation is added here.

Execution and Evaluation share an `initialization` retry operation, separate from creation, submission, status, collection and restart. It retries the preparation callback against the same Agent with unchanged inputs and operation-specific idempotency keys, without creating another attempt, consuming restart capacity or inspecting an unsubmitted Submission. Retryability is checked before consulting the injected controller; unretryable errors and exhausted retries fail without submitting a task. The default controller deliberately leaves initialization counts and backoff unspecified, as it does for other non-restart operations. Preparation is marked complete only after every step succeeds and is not repeated after an Agent restart.

Evaluator `ensureAgent()` receives an immutable `evaluationWorkspace` binding containing the Subject's `{userId, chatId}` and the target `evaluationId`; retrying with conflicting binding facts fails. SP creates the Subject Chat under its selected `AgentConfigRef.ownerUserId`, which supplies the SpaceDO `userId` when a later independent Evaluation reconstructs the binding. `materializeSubjectTrajectory()` receives that Subject Workspace reference, the collected complete `TrajectoryRef` and the stable `subject-trajectory:<subjectChatId>` idempotency key. SP reads the Subject Chat's trajectory and writes it once to its own SpaceDO; repeated evaluations reuse the same file. The preparation callback may be retried after a lost response, but the Evaluator cannot submit until SP confirms materialization. No Subject artifact bytes are copied, and Eval owns no DO storage or second preparation registry.

Each submitted execution/evaluation attempt owns a persisted `AgentResourceCollection`. Before dispatch, Runtime persists the pending operation scope as `chatId + idempotencyKey`; SP assigns the actual Submission ID on acceptance, which Runtime saves on the Attempt immediately after the receipt or recovery lookup. A collected resource snapshot must include `chatId + submissionId + idempotencyKey`; the Harness may resolve the operation by Chat and key if the receipt is uncertain. Runtime calls the required public `Harness.collectAgentResources()` after terminal observation or uncertain submission/status failure, before collecting outputs, deciding a restart or publishing the stage's terminal state. Creation/initialization failures that never dispatch have no resource collection. Failed, interrupted and cancelled submissions are collected too. Every restart keeps the previous attempt's facts; a separately requested evaluation keeps its own facts in its new EvaluationRecord. Store updates atomically persist the attempt and its resource collection with the owning Sampling/EvaluationRecord. No resource ledger, database client or DO storage access is added to Runtime.

SP supplies an operation-scoped, consistent snapshot containing only that operation's new work and descendants, excluding imported Session history and shared Subject evidence. `usageEvents`, `telemetryEvents` and `billingSettlements` contain the original JSON records: all fields, missing fields, null values, source identities, parent/child relationships, ordering and duplicates are retained. Runtime validates only the requested scope, collection envelope and lossless JSON serializability; it does not extract model requests/tools/Turns, normalize statuses/Token fields, merge events, deduplicate, calculate totals/durations, convert currencies or reprice billing. Source `coverage` and `finalized` metadata are preserved rather than used to derive a second resource-completeness result. Runtime stores no processed resource metrics.

Resource reads have an independent `resources` retry operation, with no default retry count/backoff policy. Retry re-reads the same scope and never creates/restarts an Agent or resubmits work. `AgentResourceCollection.status` is only `pending | collected | failed`: collected means the original snapshot was saved, not that the source is complete. Exhausted/unretryable reads are persisted as failures and do not change the Agent/output result or replace its original error. `getSampling()` and EvaluationRecord queries expose these durable facts even from a new Runtime instance; Metrics consumes Runtime/Dataset public queries rather than SP or private Store tables. Artifacts and complete trajectories still use references; resource snapshots store source resource events, not an additional Workspace or Session copy.

Agent terminal facts are captured immediately on observation, before resource collection or persistence. The terminal Attempt is saved before resource collection so a later resource write failure cannot erase the already-observed Agent result. The same terminal status and completion time are retained through all subsequent errors. A completed Attempt never becomes failed because Runtime finalization failed; the owning execution/evaluation stage's `lastError` records that separate failure. Record writes use an independent `persistence` retry operation: the expected immutable record is captured once, a failed write is reconciled against the latest stored facts, and any retry saves the same record without collecting resources/output again or creating, submitting or restarting an Agent. Reconciliation compares JSON facts without depending on object property order, while retaining array ordering, duplicates and null values. The same stage RetryController is shared by lifecycle and persistence rather than allocating a fresh allowance for each write. No default persistence retry count or backoff is prescribed. This applies to resource records, terminal Attempt facts, output saves and cancellation/error finalization, not Run admission.

Pipeline cancellation writes for failed executions run independently of the successful Samplings' evaluation scheduler. Each cancellation reconciles/retries only its own EvaluationRecord. If cancellation cannot be saved, its finalization error is recorded on that EvaluationRecord, never on another Sampling, and already-confirmed cancellation is not downgraded. Successful Samplings do not wait for unrelated cancellation retries. If even the local error record cannot be persisted, `EvalRuntimeDependencies.onError` receives a scoped Error (console error reporting is the default); there is no silent discard or global failure rewrite caused by an unrelated cancellation. No new Run state, version, operation registry or orchestration entity is added.

Every Runtime Sampling/Evaluation update carries the previous persisted facts as its expected value. A Store atomically replaces a record only while those facts still match. A changed record is read and reconciled, never overwritten by an old full-record snapshot. This conditional write adds no persisted version. If write and read-back both fail until the persistence budget is exhausted, Runtime treats the commit outcome as unknown and leaves the stage recoverable; lifecycle error handling cannot write a failure status from stale memory. A collected resource snapshot remains intact when a later refresh fails, with the refresh error reported separately. Finalized snapshots are not refreshed.

### `eval-metrics`

Owns three internal submodules: `evaluators` interprets EvaluationRecord outputs, `aggregation` processes resources and groups statistics, and `reporting` serves Project/Dataset/Sample/Sampling views. There is no independent evaluator execution or attribution workflow. It reads original Dataset/Runtime facts, including failed/cancelled/restarted work, without querying SP or repricing bills. Resource interpretation, source-identity deduplication, parent/child overlap handling, model/Token normalization, costs, tool/request/Turn counts, durations, success rates and all higher-level summaries belong here, not in Runtime.

`MetricsSource.read(query)` is the application's read-only, consistent Dataset/Runtime projection port, not another Store. It returns the Project, Dataset snapshots, runtime Samples, Sampling snapshots, EvaluationRecords and Run snapshots required by the query. Applications can reuse public queries or provide a transactional read projection; the package does not access private Store tables or implement PostgreSQL/DO/R2 adapters. Source results are detached before processing. Every view requires an explicit Project scope; the application source uses that Project's owner to restrict Dataset, Data and Sample reads. Optional Run selection restricts both Sampling and Evaluation identities to those Runs. Without Run selection, all evaluations are retained, never silently replaced by the newest one. Shared Data can occur in several Dataset views of the same user; Project statistics aggregate distinct Samplings directly, not Dataset subtotals.

Scores keep their supplied scale. A failed Agent, a Runtime finalization error and an unreported score remain different facts. Missing or invalid scores are not zero; score distributions are grouped by evaluator identity, not averaged across different judges. Stage success rates use terminal records as the denominator; durations describe Agent attempt spans, not a batch's parallel wall-clock time.

Resource totals carry `complete | partial | unavailable` coverage and nullable values. Complete empty source streams can prove zero; absent, pending, failed, unfinalized or unsupported data cannot. Usage identity is owner plus eventId, telemetry identity is session plus eventId, operation identity is session plus operationId, and model settlement identity is accountId plus eventId. Missing source identities or contradictory duplicates are diagnosed rather than silently counted. Action charges use their execution identity. Provider USD, model debits, rated/shortfall/platform-owned units and actual Action charges stay separate; the package does not derive charges from prices or tool estimates. A Subagent summary suppresses child detail only for each individual Token or Provider USD metric that contains a valid value; missing summary metrics keep valid child detail and report the resulting coverage. Actual distinct billing settlements remain authoritative charges. SP input/output/cache buckets are disjoint, while reasoning is an output subset and is not added to total tokens. Model requests and Turns are counted from distinct telemetry operations, not usage rows or model-request/Turn equivalence. Per-tool outcomes and durations come from paired start/terminal events. Parsing does not mutate any raw source records.

The recognized billing facts are SP's model settlement receipt with its authoritative `accountId` and public Action log entries using `executionId` and `chargedCredits`. An in-progress Action is not a settlement, even if its provisional charged field is zero. Unsupported statuses and private database row layouts are not reinterpreted as final charges. The resource carrier still preserves those original records for diagnostics.

Ambiguous subagent summaries and cyclic parent relationships are diagnosed and cannot suppress trustworthy child details. Contradictory terminal outcomes or tool names remain unknown instead of picking a winner. Project counts describe Data associated with observed Samplings; Dataset counts describe that Dataset's complete current catalog, including Data without runs.

The implemented files are `evaluators/model.ts`, `evaluators/index.ts`, `aggregation/model.ts`, `aggregation/resources.ts`, `aggregation/statistics.ts`, `aggregation/index.ts`, `reporting/model.ts` and `reporting/index.ts`, plus focused tests and the two package entry files. Experiment comparison, metric persistence/caches and application UIs are not introduced in this phase.

### `apps/eval-api`

Internal control-plane composition boundary. Its PostgreSQL adapters implement the public `DatasetStore` and `RuntimeStore` ports, and one read-only `MetricsSource` over a consistent Dataset/Runtime snapshot. The adapters share a caller-injected Drizzle/`pg` connection; the application does not import SP private database code or read Durable Object storage. Database migrations, not process memory, enforce same-owner Dataset/Data/Sample relationships, atomic Dataset imports and Run request-id/idempotency uniqueness. Runtime Sample input is stored once in the Catalog as a reference to its owner's Data; Sampling/Evaluation keep their original raw facts, including all attempts and resources. A Run stores immutable scope and effective config, while its current progress is projected using the Runtime's own projection functions, never saved as a second status. Re-evaluating an existing Sampling creates a new EvaluationRecord and does not overwrite its execution.

The application also owns a single-instance Node Run worker, not a fifth package. PostgreSQL admission transaction emits a wakeup notification; the worker subscribes before scanning recoverable Runs, rescans after reconnect and at intervals, and invokes Runtime `resume(runId)` with the saved configuration. No persistent job table or duplicate Run status is added. Deployments must not overlap worker instances; moving to multiple concurrent workers requires cross-process coordination rather than an in-memory Set. The worker accepts injected Runtime and connections; real SP Harness/Config composition remains pending.

Recovery scanning resumes work left in a nonterminal state by a stopped process; it is not a new retry policy. A handled failure whose retry controller declines further attempts becomes terminal `failed`, rather than being retried on every scan. Shutdown waits for active Runs before the application closes its database connections or starts a replacement worker.

Projects have an ownerUserId; the target Project model also binds the deployed SP Git branch. Dataset, Data and Sample are owned by one Eval SP user; Data is reusable across that user's datasets and Projects, never across owners. The application Store must scope every read, write, import and association to the authenticated user and enforce same-owner references in PostgreSQL. The Catalog stores Projects and Samples and delegates Agent listing to an injected provider for the independent Eval SP API. `MetricsSource` limits reads to the requested Project and optionally selected Runs, limits both Sampling and Evaluation records, includes all independent re-evaluations when no Run is selected, and reads under a single repeatable-read, read-only transaction. Dataset membership is current owner-scoped catalog state; no Dataset/Sample/Run version is introduced. Eval SP owns login and its `user-agent` library; Eval stores only Agent Config references and its own immutable Execution/Evaluation configuration records. Each Run saves its effective config snapshot; `pipeline` only sequences the two independently startable operations. The concrete public SP HTTP/WebSocket client belongs to this application composition layer, not a fifth shared package.

### `apps/eval-web`

Future internal UI entry point. It will select Project, Dataset, Sample, Subject Agent, Judge Agent, execution concurrency and evaluation concurrency, then render Run, artifacts, metrics and Evaluation Agent evidence.

### `apps/eval-cli`

Future CLI entry point. It will use the same config and API semantics as Web; it is not the source of truth for Cloudflare Agent trajectories.

## SP alignment

The runtime Harness must consume the same public concepts as `sp-platform`:

- Agent Config reference in the independent Eval SP `user-agent` library: `ownerUserId`, `userAgentId`;
- ordinary Inbox/Chat ensure in the independent Eval SP deployment, with an optional immutable `evaluationWorkspace` binding for Evaluators; these Chats do not appear in dev/production Inbox;
- `dispatchMessage(message, "enqueue" | "steer")`;
- `SubmissionReceipt` and `getSubmission()`;
- `TrajectoryPage` pagination with SP's maximum page size;
- Workspace tree, manifests and content boundaries.

Runtime now records a preassigned Chat ID on Sampling/EvaluationRecord and the actual per-attempt Submission ID on each Attempt. The concrete SP Harness still needs to return and reconcile those real IDs through SP Submission receipts and operation lookups.

The Eval UI lists Chats through Run/Sampling/Evaluation rather than an Inbox management screen. Viewing Chat, Workspace and Trajectory is read-only for interactive users; only the controlled Run Worker submits work. This access policy, unattended approval/`ask_user` handling, shared Evaluator SpaceDO, full trajectory materialization and operation-scoped resource queries remain SP integration work even though a special out-of-Inbox Chat implementation is no longer required.

The Chat ID is assigned before provisioning and reused after an uncertain creation response. `ensureAgent` retries retain the same creation facts and Chat ID; a separately requested re-evaluation receives a new Evaluator Chat and EvaluationRecord identity. Chat creation identity is distinct from the idempotency key used to submit or restart work inside that Chat.

The eval project must not import SP private source files, use Web projections as facts, or read Durable Object SQLite directly.
