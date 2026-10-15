# Eval HTTP control plane

`apps/eval-api` exposes the Dataset, initial-resource catalog, Agent Config, Project, Run, observation and Metrics services through one Hono application served by `@hono/node-server` (`start:api`, entry `src/server.ts`). It owns request authentication and composition, not evaluation semantics or SP storage. Process configuration is listed in the [eval-api README](../apps/eval-api/README.md); the Project, Runtime and Metrics design behind these routes is recorded in [Project、Runtime 与 Metrics 设计](eval-project-redesign.md). This document is the single source for routes, the response envelope, status codes and error codes.

## Application structure

The layout follows SP's `apps/api`: `lib/create-app.ts` installs request IDs, pino request logging (`hono-pino`), the trusted-Origin check, CORS, `notFound` and `onError` for every route; `lib/api-errors.ts` holds the single `apiError` translation; `middlewares/` holds session authentication, Origin trust and logging; each domain lives in `routes/<domain>/<domain>.routes.ts | .handlers.ts | .index.ts` with `@hono/zod-openapi` route definitions. Owner-scoped services are assembled once per request in `owner-services.ts`; concurrent requests of one owner share its Run admission instance through `active-owner-admission.ts`, and the entry is released when the owner has no active request.

## Authentication and Origin

Every `/api/*` request requires `Authorization: Bearer <Eval SP session token>`. One session middleware calls the configured Eval SP `/api/auth/me` for every request and scopes all services to the returned user ID; the client cannot select an owner, and another owner's records are reported as missing (`404`). A missing or rejected session is `401 AUTH_UNAUTHENTICATED`; an unreachable Eval SP is `503 EVAL_SP_UNAVAILABLE`, never a `401`. `GET /healthz` is unauthenticated and only reports that the process is serving.

A request carrying an `Origin` other than `EVAL_WEB_ORIGIN` is rejected with `403 REQUEST_UNTRUSTED_ORIGIN` on every route; requests without `Origin` (non-browser clients) pass. CORS allows only that Origin, the `Authorization` and `Content-Type` headers, and exposes `X-Request-ID`. The same Origin is sent as the trusted Origin on Eval SP Agent Config writes.

## Envelope

Responses use `@springbrand/http` through `@eval-platform/eval-contracts/http` (`createHonoHttp`) with the catalog in `@eval-platform/eval-contracts/http-errors` (`defineErrorCatalog`).

- Success: `{ "success": true, "msg": <payload>, "errMsg": "", "code": "" }`. The route tables below give the `msg` payload. Creation returns `201`; Run submission and stop return `202`; deletion and Dataset membership changes return `204` with no body. Dataset export returns the document text, not an envelope.
- Failure: `{ "code", "errMsg", "requestId", "errors"?, "details"? }`; `errors` carries field-level `{path, errMsg}` items. Every response has the `X-Request-ID` header.

Codes are uppercase `DOMAIN_REASON`. `packages/eval-contracts/src/http-errors.ts` is the complete list with each code's status and default message (reproduced in [Error codes](#error-codes)); handlers map errors only by class, never by message text. Unexpected failures return `500 INTERNAL_ERROR` without internal details and are logged through `errorDiagnostics`. An unknown route or method is `404 REQUEST_NOT_FOUND`.

## Request bodies and limits

Every JSON body goes through one reader: the route requires `Content-Type: application/json` (`415 REQUEST_UNSUPPORTED_MEDIA_TYPE` otherwise), `readBytesLimited` caps the received bytes (`413 REQUEST_PAYLOAD_TOO_LARGE`), the text must be strict UTF-8 (`400 REQUEST_INVALID_INPUT`), and `parseStrictJson` requires a JSON object and rejects duplicate fields at any depth (`400 REQUEST_INVALID_JSON`) before the route schema validates it (`422 REQUEST_VALIDATION_FAILED` with `errors`; objects are strict, so unknown fields fail). The stop route ignores any body. Dataset document import reads the raw JSON/YAML text through the same bounded UTF-8 reader without a media-type check.

Identifiers:

- Runtime entity IDs in paths and Run bodies (Project, Run, ProjectSample, Sampling, Evaluation) are 1–512 characters without surrounding whitespace, control characters or `/` (`entityIdSchema`). Idempotency keys follow the same rule but may contain `/` (`idempotencyKeySchema`).
- Dataset, Data, Bundle, Material, Session, output-format and Agent Config IDs are UUIDs (`platformIdSchema`): case-insensitive on input, lowercase in responses. A non-UUID path segment is a `422`.

Content limits live only in `apps/eval-api/src/limits.ts`; body limits are derived from them (worst-case JSON escaping plus metadata framing), so a body carrying maximal valid content is never rejected for size.

| Constant | Value | Meaning |
| --- | --- | --- |
| `RUN_TARGET_IDS` | 10,000 | Most Data one Project binds; most IDs in one Run selector; most IDs in one Run's `targets`; most entries in `dataIds`, `datasets` and `samplingCounts` on creation |
| `SAMPLING_COUNT_MAX` | 100 | Largest `samplingCount` per Data |
| `IDENTIFIER_CHARS` | 512 | Longest Runtime ID or idempotency key |
| `DATASET_DOCUMENT_BYTES`, `PROMPT_DATASET_FILE_BYTES` | 10 MB each | Dataset document and Prompt Dataset file |
| `MATERIAL_FILE_BYTES`, `MATERIAL_TOTAL_BYTES` | 5 MB, 20 MB | One Material file, one Material |
| `OUTPUT_SCHEMA_BYTES` | 1 MB | One output-format file |

| Body limit | Bytes | Routes |
| --- | --- | --- |
| `METADATA_BODY_BYTES` | 4,096 | Bundle create; Bundle/Material/Session/output-format metadata PATCH; Data initial-resources PATCH |
| `JSON_BODY_BYTES` | 1,000,000 | Dataset create/PUT and membership; Data create/PUT; Agent Config POST/PATCH; evaluation-plan PUT |
| `PROJECT_BODY_BYTES` | 5,540,000 | Project creation |
| `RUN_PREVIEW_BODY_BYTES` | 30,757,168 | Run preview |
| `RUN_BODY_BYTES` | 61,510,240 | Run submission |
| `OUTPUT_SCHEMA_BODY_BYTES` | 6,004,096 | Output-format upload |
| `SESSION_BODY_BYTES` | 12,004,096 | Session upload |
| `MATERIAL_BODY_BYTES` | 28,718,764 | Material upload |
| `PROMPT_IMPORT_BODY_BYTES` | 60,004,096 | Prompt Dataset upload |
| `DATASET_DOCUMENT_BYTES` | 10,000,000 | Raw Dataset document import |

## Routes

All `/api/*` routes require the Bearer session and may additionally return `401`, `403`, `422`, `500` and `503` as described above. Routes with a JSON body may also return `400`, `413` and `415`. The tables list each route's success payload and its domain error codes.

### Session and health

| Route | Result |
| --- | --- |
| `GET /healthz` | `{status:"ok"}`; no session |
| `GET /api/me` | `{id, role:"user"\|"admin"\|"super_admin"}` |

### Agent Configs

Agent Configs are created, read, edited and deleted in Eval; the independent Eval SP only hosts them. Requests are relayed with the caller's session to Eval SP `/api/user-agent-configs`; bodies are SP's public Agent Config JSON, forwarded unchanged (any JSON object). Project creation and evaluation-plan saving clone the selected Agent Configs into frozen copies; which copies count as frozen and the reserved `eval-frozen-` slug prefix are defined in [Agent Config 冻结副本](eval-project-redesign.md#23-agent-config-冻结副本). On the wire: frozen copies are omitted from both lists, `PATCH`/`DELETE` of one and selecting one as a creation or evaluation-plan source are `409 AGENT_CONFIG_FROZEN`, and a `POST`/`PATCH` body with a reserved `slug` is `422 REQUEST_VALIDATION_FAILED`.

| Route | Body / result | Domain errors |
| --- | --- | --- |
| `GET /api/agent-configs` | SP Agent Config list without frozen copies | Relayed SP errors |
| `POST /api/agent-configs` | SP create body / `201` SP Agent Config | `422 REQUEST_VALIDATION_FAILED` (reserved slug); relayed SP errors |
| `GET /api/agent-configs/{id}` | SP Agent Config; a frozen copy is readable | Relayed SP errors |
| `PATCH /api/agent-configs/{id}` | SP update body / SP Agent Config | `409 AGENT_CONFIG_FROZEN`; `422 REQUEST_VALIDATION_FAILED` (reserved slug); relayed SP errors |
| `DELETE /api/agent-configs/{id}` | `204` | `409 AGENT_CONFIG_FROZEN`; relayed SP errors |
| `GET /api/agents?role=subject\|evaluator` | `[{agentConfig:{ownerUserId,userAgentId}, name, role}]`, one entry per role unless `role` is given; frozen copies excluded | Relayed SP errors |

Relayed SP errors: SP `401` → `401 AUTH_UNAUTHENTICATED`; `403` → `EVAL_SP_FORBIDDEN`; `404` → `EVAL_SP_NOT_FOUND`; `409` → `EVAL_SP_CONFLICT`; `400`/`422` → `422 EVAL_SP_REQUEST_INVALID`; `429` → `REQUEST_RATE_LIMITED`; other statuses → `502 EVAL_SP_REQUEST_FAILED`. For `400`, `409` and `422`, SP's `errMsg` and field `errors` are relayed. An unreachable SP is `503 EVAL_SP_UNAVAILABLE`.

### Projects

A Project's execution plan, Dataset/Data snapshot and Sampling counts are fixed at creation; the only configuration write afterwards is the evaluation plan, replaceable until the first pipeline or evaluation Run locks it. Soft-deleted Projects are `404 PROJECT_NOT_FOUND` on every Project, Run, result, observation and Metrics route.

| Route | Body / result |
| --- | --- |
| `GET /api/projects` | Non-deleted `Project[]` (`{projectId, ownerUserId, name, description?, sourceBranch, createdAt}`), newest first |
| `POST /api/projects` | Creation body below / `201 {project: Project, run: RunHandle \| null}` |
| `GET /api/projects/{projectId}` | `ProjectView` below |
| `DELETE /api/projects/{projectId}` | `204` |
| `PUT /api/projects/{projectId}/evaluation-plan` | Evaluation plan body below / `ProjectView` |

Creation body:

```text
{
  idempotencyKey,                             owner-scoped creation key; the first Run uses the same key
  name, description?,                         nonblank text
  datasets: [{ datasetId, dataIds? }],        1..RUN_TARGET_IDS distinct Datasets; dataIds omitted = every current member
  samplingCount,                              1..SAMPLING_COUNT_MAX, default for every selected Data
  samplingCounts?: { [dataId]: count },       per-Data overrides; every key must be selected
  execution: { userAgentId, framework: "sp"|"codex"|"cc", executionConcurrency, retryPolicy?, timeoutMs? },
  evaluation?: <evaluation plan body>,         required when run.operation is "pipeline"
  run: { operation: "execution"|"pipeline" }
}
```

Evaluation plan body: `{userAgentId, evaluationConcurrency, retryPolicy?, timeoutMs?, outputSchemaId}`. The route checks only shape and numeric types; Runtime's plan normalization is the single source of the value rules and rejects violations with `400 RUNTIME_INPUT_INVALID`: concurrencies are positive integers, `timeoutMs` is a finite number of at least 1, and `retryPolicy` is `{maxRestarts, initialBackoffMs, maxBackoffMs}` with a non-negative integer `maxRestarts`, non-negative `initialBackoffMs` and `maxBackoffMs >= initialBackoffMs`. The creation service rejects a pipeline first Run without an evaluation plan before cloning any Agent Config.

Creation reads the selected owned, non-deleted Datasets and their current members in one consistent snapshot; a Data shared by several selected Datasets becomes one ProjectSample. It clones the Subject (and Evaluator) Agent Config, stores the snapshot, both plans and the copies in one transaction, then previews and submits the first Run with selector `{all:true}`. If any step fails, nothing remains visible: rows of a Project without a Run are removed and the copies are deleted. Cancelling the form calls no route.

Creation is idempotent per owner and `idempotencyKey`; the replay, race and compensation rules are defined once in [Project 创建](eval-project-redesign.md#31-创建). On the wire: a matching replay returns `201 {project, run}` without cloning any Agent Config, where `run` is the creation's own first Run or `null` when the Project already has other Runs; a different body under the key is `409 PROJECT_IDEMPOTENCY_CONFLICT`; a key whose Project was soft-deleted is `404 PROJECT_NOT_FOUND`; a first Run that keeps meeting evaluation-plan changes ends in `409 PROJECT_PLAN_CHANGED` with the Project kept for a same-key replay.

`ProjectView` is the fixed plan plus current state: `{project, datasets: [{datasetId, name, description?, kind, projectSampleIds}], execution, executionPlanDigest, evaluation: {plan, digest, lockedAt | null} | null, projectSamples: [{projectSampleId, projectId, dataId, datasetIds, samplingCount, data}], currentRun: {runId, stopRequested?} | null}`. `execution.subjectAgentConfig` and `evaluation.plan.evaluatorAgentConfig` are the Agent Config bodies as frozen; `harness.agentConfig` names the frozen copy. `evaluation.plan.outputSchema` is `{outputSchemaId, digest}`; `evaluation.lockedAt` is set by the first pipeline or evaluation Run.

| Route | Domain errors |
| --- | --- |
| Create | `404 PROJECT_NOT_FOUND` (key of a deleted creation, whatever the body); `409 PROJECT_IDEMPOTENCY_CONFLICT`; `400 RUNTIME_INPUT_INVALID` (pipeline without evaluation plan, Data not a current member, override for unselected Data, no Data, plan values such as concurrency, retry policy and timeout); `413 RUN_TARGETS_TOO_LARGE` (more than `RUN_TARGET_IDS` Data); `404 DATASET_NOT_FOUND`, `OUTPUT_SCHEMA_NOT_FOUND`; `409 AGENT_CONFIG_FROZEN` (a frozen copy selected as source); `409 RUNTIME_RECORD_CONFLICT` (identical requests kept racing the same key; retry with the same key); relayed SP errors; every first-Run admission error of [Run submission](#runs) |
| Detail | `404 PROJECT_NOT_FOUND` |
| Delete | `404 PROJECT_NOT_FOUND`; `409 PROJECT_BUSY` while a Run is active or its stop is not finalized |
| Evaluation plan | `404 PROJECT_NOT_FOUND`, `OUTPUT_SCHEMA_NOT_FOUND`; `409 PROJECT_EVALUATION_PLAN_LOCKED`, `AGENT_CONFIG_FROZEN`; `400 RUNTIME_INPUT_INVALID`; relayed SP errors |

### Runs

Each Run is chosen per request: `operation` is `execution`, `pipeline` or `evaluation`, and the selector is any combination of `{all:true, datasetIds, projectSampleIds, samplingIds}` (at least one key, at most `RUN_TARGET_IDS` IDs in total). Expansion happens inside the Project snapshot. Preview returns the fixed `targets` the caller must submit unchanged; a retry resubmits the same targets instead of re-expanding.

| Route | Body / result |
| --- | --- |
| `POST /api/projects/{projectId}/runs/preview` | `{operation, selector}` / `RunPreview`: `{projectId, operation, selector, targets:{projectSampleIds, samplingIds}, replacedSamplingCount, newSamplingCount, evaluationCount, executionPlanDigest, evaluationPlanDigest\|null}` |
| `POST /api/projects/{projectId}/runs` | `{idempotencyKey, operation, selector, targets:{projectSampleIds, samplingIds}}` (each list unique, at most `RUN_TARGET_IDS` IDs in total) / `202 RunHandle {runId, samplingIds}` |
| `GET /api/projects/{projectId}/runs/current` | `{run: {runId, stopRequested?} \| null}` |
| `POST /api/projects/{projectId}/runs/{runId}/stop` | No body / `202 {runId, stopRequested:true}` |
| `GET /api/projects/{projectId}/runs/{runId}` | `{run: RunSnapshot}` |
| `GET /api/projects/{projectId}/runs/{runId}/evaluations` | `{evaluations: EvaluationRecord[]}` in the Run's admission order |

Expansion rules: `all` and `datasetIds` expand to the Project's bound ProjectSamples. For execution and pipeline, each target ProjectSample replaces all its current Samplings with `samplingCount` new ones, and each target Sampling whose ProjectSample is not a target is replaced one for one. For evaluation, `targets.projectSampleIds` is empty and `targets.samplingIds` lists the current successful Samplings; explicitly selected Samplings must have succeeded. Unselected Samplings and Evaluations are never touched; evaluation keeps every Subject fact and replaces only the targets' EvaluationRecords. The first pipeline or evaluation Run locks the evaluation plan.

`RunSnapshot` is `{runId, projectId, sourceCommit, operation, phases, selector, targets, samplingIds, evaluationIds, phase, status, stopRequested?, stopFinalized?}`. `samplingIds` and `evaluationIds` list the Run's records that are still current; records replaced by later Runs drop out, and Runs are never deleted.

| Route | Domain errors |
| --- | --- |
| Preview | `404 PROJECT_NOT_FOUND`, `DATASET_NOT_FOUND`, `PROJECT_SAMPLE_NOT_FOUND`, `SAMPLING_NOT_FOUND`; `409 PROJECT_EVALUATION_PLAN_REQUIRED`, `RUN_TARGETS_EMPTY`, `SAMPLING_UNAVAILABLE`, `PROJECT_SAMPLE_EVALUATION_PROMPT_MISSING`; `413 RUN_TARGETS_TOO_LARGE` when the expanded targets exceed `RUN_TARGET_IDS` |
| Submit | Preview's `404`s; `400 RUNTIME_INPUT_INVALID` (evaluation targets listing ProjectSamples, a Sampling listed with its own ProjectSample); `409 PROJECT_BUSY`, `RUN_IDEMPOTENCY_CONFLICT`, `PROJECT_SOURCE_BRANCH_CONFLICT`, `PROJECT_EVALUATION_PLAN_REQUIRED`, `PROJECT_PLAN_CHANGED`, `RUN_TARGETS_STALE`, `RUN_TARGETS_EMPTY`, `SAMPLING_UNAVAILABLE`, `PROJECT_SAMPLE_EVALUATION_PROMPT_MISSING` |
| Current | `404 PROJECT_NOT_FOUND` |
| Stop | `404 RUN_NOT_FOUND` (also for another owner's or a deleted Project); `409 PROJECT_NO_ACTIVE_RUN` |
| Run, Run evaluations | `404 RUN_NOT_FOUND` |

### Result reads

| Route | Result | Domain errors |
| --- | --- | --- |
| `GET /api/runs/{runId}` | `RunSnapshot` | `404 RUN_NOT_FOUND` |
| `GET /api/samplings/{samplingId}` | `Sampling` `{samplingId, projectId, projectSampleId, execution, subjectAgent, subjectChatId?, executionAttempts, artifacts?, trajectory?}` | `404 SAMPLING_NOT_FOUND` |
| `GET /api/samplings/{samplingId}/evaluations` | Current `EvaluationRecord[]` of the Sampling, by `evaluationId` | `404 SAMPLING_NOT_FOUND` |
| `GET /api/evaluations/{evaluationId}` | `EvaluationRecord` `{evaluationId, samplingId, evaluator, chatId?, status, attempts, output?}`; `output.structuredOutput` is the Evaluator's raw result file `{path, content, contentHash?}` | `404 EVALUATION_NOT_FOUND` |

Replaced Samplings and Evaluations no longer exist and read as `404`. Sampling and Evaluation responses retain artifact and complete trajectory references; their bytes remain behind Eval SP's public read-only Workspace and Trajectory APIs, and this control plane does not read SP Durable Object storage.

### Read-only observation

| Route | Result | Domain errors |
| --- | --- | --- |
| `GET /api/projects/{projectId}/samplings/{samplingId}/observation` | `AgentObservationRef` for the Subject | `404 PROJECT_NOT_FOUND`, `SAMPLING_NOT_FOUND` |
| `GET /api/projects/{projectId}/evaluations/{evaluationId}/observation` | `AgentObservationRef` for the Evaluator | `404 PROJECT_NOT_FOUND`, `EVALUATION_NOT_FOUND` |

`AgentObservationRef` is `{role, projectId, samplingId, evaluationId?, ownerUserId, chatId?, state}`. The API checks the owner, a non-deleted Project and that the Sampling or Evaluation is current in that Project. The Subject entry uses `Sampling.subjectChatId` and the Subject Agent Config owner; the Evaluator entry uses `EvaluationRecord.chatId` and the Evaluator owner. `state` is `available` when a Chat ID and at least one attempt exist, otherwise `not-started`. The entry is available in every Run state. No writable Chat URL is returned; the read-only Chat, Context, Workspace and Trajectory pages are served by Eval SP.

### Metrics

All four routes are read-only views over one consistent snapshot of the Project's fixed hierarchy (Project → Dataset → ProjectSample → Sampling) and its current results; live Dataset membership is never consulted. An optional repeated `runId` query (`?runId=a&runId=b`) restricts Samplings and Evaluations to those Runs without changing the bound hierarchy. No other query parameter is accepted.

| Route | Result |
| --- | --- |
| `GET /api/metrics/projects/{projectId}` | `ProjectOverview {project, runIds, summary, datasets: [{dataset, summary}]}` |
| `GET /api/metrics/projects/{projectId}/datasets/{datasetId}` | `DatasetOverview {project, runIds, summary, dataset, projectSamples: [{projectSampleId, dataId, datasetIds, samplingCount, summary}]}` |
| `GET /api/metrics/projects/{projectId}/samples/{projectSampleId}` | `SampleOverview {project, runIds, summary, projectSample, samplings: [{samplingId, execution, summary, artifactCount, hasTrajectory}]}` |
| `GET /api/metrics/projects/{projectId}/samplings/{samplingId}` | `SamplingDetail {project, runIds, summary, projectSample, sampling, subject: AgentMetricView, evaluations: [{record, agent: AgentMetricView, output: EvaluationOutputView}]}` |

`runIds` is the selected Runs, or every Run with a current member in the view. Every `summary` is a `MetricSummary {counts, execution, evaluation, executionAgent, evaluationAgents, numericOutputs}` recomputed from raw records in scope: `counts` gives fixed `datasets`, `data`, `projectSamples` and current `samplings`, `evaluations`; `execution`/`evaluation` give status distributions, attempts and durations; `executionAgent`/`evaluationAgents` give separate Subject and Evaluator resources (tokens, cost, settlements, operations, trajectory summary, coverage, diagnostics); `numericOutputs` gives the evaluation plan's Schema reference, validation counts and per-JSON-Pointer numeric summaries. Never-run ProjectSamples are included with unavailable values; a shared ProjectSample appears in each of its Dataset rows but is counted once in the Project summary. `AgentMetricView` adds Chat ID, attempts, start/end times, Agent duration, artifacts and trajectory reference; `EvaluationOutputView` adds the raw output text, parsed JSON, Schema validation and numeric observations. Field-level definitions are the public types of `@eval-platform/eval-metrics`.

Domain errors: `404 PROJECT_NOT_FOUND`, `DATASET_NOT_FOUND` (Dataset not bound by the Project), `PROJECT_SAMPLE_NOT_FOUND`, `SAMPLING_NOT_FOUND` (not a current Sampling in scope), `RUN_NOT_FOUND` (a `runId` outside the Project); `400 METRICS_QUERY_INVALID` (duplicate or invalid `runId`).

### Datasets and Data

Datasets and Data are the user's editable source catalog; Projects copy what they select, so later edits and soft deletes never affect existing Projects.

| Route | Body / result | Domain errors |
| --- | --- | --- |
| `GET /api/datasets` | Non-deleted `Dataset[]` | — |
| `POST /api/datasets` | Dataset input / `201 Dataset` | `400 DATASET_INPUT_INVALID`; `409 DATASET_IDENTITY_CONFLICT` |
| `GET /api/datasets/{datasetId}` | `Dataset` | `404 DATASET_NOT_FOUND` |
| `PUT /api/datasets/{datasetId}` | Dataset input (full replacement of editable fields) / `Dataset` | `400 DATASET_INPUT_INVALID`; `404 DATASET_NOT_FOUND` |
| `DELETE /api/datasets/{datasetId}` | `204`; soft delete, idempotent, shared Data preserved | — |
| `GET /api/datasets/{datasetId}/data` | Member `Data[]` | `404 DATASET_NOT_FOUND` |
| `POST /api/datasets/{datasetId}/data` | `{dataIds}` / `204`; atomic attach | `400 DATASET_INPUT_INVALID`; `404 DATASET_NOT_FOUND`, `DATA_NOT_FOUND` |
| `DELETE /api/datasets/{datasetId}/data` | `{dataIds}` / `204` | `404 DATASET_NOT_FOUND` |
| `POST /api/datasets/import?format=json\|yaml` | Raw document text / `201 {dataset, data}` | `400 DATASET_INPUT_INVALID`, `REQUEST_INVALID_INPUT`; `409 DATASET_IDENTITY_CONFLICT` |
| `GET /api/datasets/{datasetId}/export?format=json\|yaml` | Document text with `application/json` or `application/yaml` | `404 DATASET_NOT_FOUND` |
| `POST /api/datasets/prompt-import` | `{name, description, format:"json"\|"jsonl", content}` / `201 {dataset, data}`; see [Dataset upload](eval-dataset-upload.md) | `400 DATASET_INPUT_INVALID` |
| `GET /api/data?datasetId=` | Non-deleted `Data[]`, optionally one Dataset's members | `404 DATASET_NOT_FOUND` |
| `POST /api/data` | Data input / `201 Data` | `400 DATASET_INPUT_INVALID`; `404 BUNDLE_RESOURCE_NOT_FOUND`; `409 DATASET_IDENTITY_CONFLICT` |
| `GET /api/data/{dataId}` | `Data` | `404 DATA_NOT_FOUND` |
| `PUT /api/data/{dataId}` | Data input / `Data` | `400 DATASET_INPUT_INVALID`; `404 DATA_NOT_FOUND`, `BUNDLE_RESOURCE_NOT_FOUND` |
| `DELETE /api/data/{dataId}` | `204`; soft delete, idempotent | `409 DATA_IN_USE` while an active Dataset contains it |
| `PATCH /api/data/{dataId}/initial-resources` | `{initialMaterials?, evalInitialMaterials?, initialSession?}`, each a reference or `null` to clear / `Data`; see [Dataset upload](eval-dataset-upload.md) | `404 DATA_NOT_FOUND`, `BUNDLE_RESOURCE_NOT_FOUND`, `BUNDLE_FILE_NOT_FOUND`; `503 BUNDLE_FILE_UNAVAILABLE` |

Data and reference validation rules are those of `@eval-platform/eval-dataset` and [Dataset upload](eval-dataset-upload.md).

### Initial-resource catalog and output formats

Bundles group separately uploaded Materials and Sessions; output formats are standalone draft 2020-12 JSON Schema files. Metadata PATCH bodies are `{name?, description?}` with at least one nonblank field; uploaded content is immutable. All deletes are soft and hide the entry from lists and reads; file bytes are kept.

| Route | Body / result | Domain errors |
| --- | --- | --- |
| `GET, POST /api/bundles` | POST `{name, description}` / `201 {bundleId, name, description}` | — |
| `GET, PATCH, DELETE /api/bundles/{bundleId}` | Bundle; DELETE `204` and also deletes its resources | `404 BUNDLE_RESOURCE_NOT_FOUND`; `409 BUNDLE_RESOURCE_IN_USE` while active Data reference its resources |
| `GET, POST /api/bundles/{bundleId}/materials` | POST `{name, description, files:[{path, mediaType, contentBase64}]}` / `201 {bundleId, materialId, name, description}` | `404 BUNDLE_RESOURCE_NOT_FOUND`; `400 BUNDLE_FILE_INVALID`; `409 BUNDLE_FILE_CONFLICT`; `413 BUNDLE_FILE_TOO_LARGE`; `503 BUNDLE_FILE_UNAVAILABLE` |
| `GET, PATCH, DELETE /api/bundles/{bundleId}/materials/{materialId}` | Material; DELETE `204` | `404 BUNDLE_RESOURCE_NOT_FOUND`; `409 BUNDLE_RESOURCE_IN_USE` |
| `GET, POST /api/bundles/{bundleId}/sessions` | POST `{name, description, format:"json"\|"jsonl", content}` / `201 {bundleId, sessionId, name, description, format}` | As for Materials |
| `GET, PATCH, DELETE /api/bundles/{bundleId}/sessions/{sessionId}` | Session; DELETE `204` | `404 BUNDLE_RESOURCE_NOT_FOUND`; `409 BUNDLE_RESOURCE_IN_USE` |
| `GET, POST /api/evaluation-output-schemas` | POST `{name, description, content}` (Schema file text) / `201 {outputSchemaId, name, description, schema}` | `400 CATALOG_INPUT_INVALID`; `413 CATALOG_PAYLOAD_TOO_LARGE` |
| `GET, PATCH, DELETE /api/evaluation-output-schemas/{outputSchemaId}` | Output format; DELETE `204` | `404 OUTPUT_SCHEMA_NOT_FOUND` (also for repeated DELETE) |

Bundle, Material and Session names and descriptions are required nonblank text (`400 CATALOG_INPUT_INVALID`). An output format may be soft-deleted while an evaluation plan uses it; the plan keeps reading the Schema by ID, but the format can no longer be selected.

## Run admission and stop

Run admission uses a token-free, owner-scoped `ProjectPlanReader` and `RuntimeStore` with `createEvalRunAdmission`. The HTTP process holds no Harness credential and never runs Agents: admission and stop requests commit their Run facts and enqueue the Run job in the same PostgreSQL transaction (see [Run scheduling](architecture.md#run-调度与停止)).

Admission responses follow the rules in [Run admission](architecture.md#run-准入与独立评估): the request fingerprint covers `projectId`, `operation`, `selector`, `targets` and the plan digests. A matching replay of the Project's latest Run returns the original Run, even while it is active; a reused key with different facts, or the key of a Run that a later admission superseded, is `409 RUN_IDEMPOTENCY_CONFLICT`; a new key while the Project has an unfinished Run is `409 PROJECT_BUSY`. Inside the transaction the Store rechecks the plan digests (`PROJECT_PLAN_CHANGED`), the evaluation plan (`PROJECT_EVALUATION_PLAN_REQUIRED`) and that the submitted targets still match the current Samplings (`RUN_TARGETS_STALE`); on any of these the caller previews again with a new key.

`POST .../runs/{runId}/stop` targets only the named Run of that Project and returns `202 {runId, stopRequested:true}`, including for a repeat; an unknown Run, another owner's Run or a Run of a deleted Project is `404 RUN_NOT_FOUND`; a finished Run without a stop request is `409 PROJECT_NO_ACTIVE_RUN`. The response only records the request; stop semantics are described in [Run scheduling and stop](architecture.md#run-调度与停止).

## Error codes

The complete catalog of `packages/eval-contracts/src/http-errors.ts`. Status `0` codes are produced only by the browser client and never appear in server responses; `RESPONSE_INVALID` is likewise produced by the client when a response is not a valid envelope.

| Code | Status | Raised when |
| --- | --- | --- |
| `REQUEST_INVALID_INPUT` | 400 | Body is not valid UTF-8 |
| `REQUEST_INVALID_JSON` | 400 | Malformed JSON, non-object body or duplicate field |
| `REQUEST_VALIDATION_FAILED` | 422 | Path, query or body fails its schema |
| `REQUEST_PAYLOAD_TOO_LARGE` | 413 | Body over its route limit |
| `REQUEST_UNSUPPORTED_MEDIA_TYPE` | 415 | Non-JSON `Content-Type` on a JSON route |
| `REQUEST_UNTRUSTED_ORIGIN` | 403 | `Origin` other than `EVAL_WEB_ORIGIN` |
| `REQUEST_NOT_FOUND` | 404 | Unknown route or method |
| `REQUEST_RATE_LIMITED` | 429 | Eval SP rate-limited a relayed request |
| `AUTH_UNAUTHENTICATED` | 401 | Missing or rejected Eval SP session |
| `INTERNAL_ERROR` | 500 | Unexpected failure |
| `DATABASE_UNAVAILABLE` | 503 | PostgreSQL unreachable; retry the same request |
| `RESPONSE_INVALID` | 502 | Client only: the response is not a valid envelope |
| `EVAL_SP_FORBIDDEN` | 403 | Eval SP denied a relayed request |
| `EVAL_SP_NOT_FOUND` | 404 | Eval SP resource (for example an Agent Config) missing |
| `EVAL_SP_CONFLICT` | 409 | Eval SP state conflict |
| `EVAL_SP_REQUEST_INVALID` | 422 | Eval SP rejected the request body |
| `EVAL_SP_REQUEST_FAILED` | 502 | Eval SP returned another failure |
| `EVAL_SP_UNAVAILABLE` | 503 | Eval SP unreachable; retry |
| `AGENT_CONFIG_FROZEN` | 409 | Edit, deletion or source selection of a frozen Project copy |
| `PROJECT_NOT_FOUND` | 404 | Unknown, another owner's or soft-deleted Project |
| `PROJECT_BUSY` | 409 | New Run key or deletion while a Run is unfinished |
| `PROJECT_IDEMPOTENCY_CONFLICT` | 409 | Creation key reused with a different body |
| `PROJECT_NO_ACTIVE_RUN` | 409 | Stop of a finished Run without a stop request |
| `PROJECT_SOURCE_BRANCH_CONFLICT` | 409 | Project belongs to another Eval SP source branch |
| `PROJECT_EVALUATION_PLAN_REQUIRED` | 409 | pipeline/evaluation on a Project without an evaluation plan |
| `PROJECT_EVALUATION_PLAN_LOCKED` | 409 | Evaluation plan replacement after the first evaluating Run |
| `PROJECT_PLAN_CHANGED` | 409 | Plan digests changed between preview and admission |
| `PROJECT_SAMPLE_NOT_FOUND` | 404 | ProjectSample not bound by the Project |
| `RUN_NOT_FOUND` | 404 | Unknown or another owner's Run, or Run of a deleted Project |
| `RUN_IDEMPOTENCY_CONFLICT` | 409 | Key reused with different facts or superseded |
| `RUN_STOPPED` | 409 | Runtime refused a stage after a committed stop (Worker side) |
| `RUN_TARGETS_STALE` | 409 | Submitted targets no longer match the current Samplings |
| `RUN_TARGETS_EMPTY` | 409 | Selection or targets contain no work |
| `RUN_TARGETS_TOO_LARGE` | 413 | Expanded selection, or the Data a new Project binds, exceeds `RUN_TARGET_IDS` |
| `RUNTIME_INPUT_INVALID` | 400 | Run request, Project creation selection or plan values rejected (including pipeline creation without an evaluation plan) |
| `RUNTIME_RECORD_CONFLICT` | 409 | Run records changed concurrently (Runtime persistence) |
| `RUNTIME_PERSISTENCE_UNCONFIRMED` | 503 | Run records could not be confirmed; retry with the same key |
| `PROJECT_SAMPLE_EVALUATION_PROMPT_MISSING` | 409 | An evaluated ProjectSample has no `evalPrompt` |
| `SAMPLING_NOT_FOUND` | 404 | Unknown, replaced or another Project's Sampling |
| `SAMPLING_UNAVAILABLE` | 409 | Evaluation of a Sampling without a successful execution |
| `EVALUATION_NOT_FOUND` | 404 | Unknown or replaced Evaluation |
| `DATASET_NOT_FOUND` | 404 | Unknown or deleted Dataset, or a Dataset the Project does not bind |
| `DATASET_INPUT_INVALID` | 400 | Dataset or Data input rejected |
| `DATASET_IDENTITY_CONFLICT` | 409 | Dataset or Data identity reused with different content |
| `DATA_NOT_FOUND` | 404 | Unknown or deleted Data |
| `DATA_IN_USE` | 409 | Data deletion while an active Dataset contains it |
| `CATALOG_INPUT_INVALID` | 400 | Catalog name, description, reference or Schema content invalid |
| `CATALOG_PAYLOAD_TOO_LARGE` | 413 | Output-format content over its limit |
| `BUNDLE_RESOURCE_NOT_FOUND` | 404 | Unknown or deleted Bundle, Material or Session |
| `BUNDLE_RESOURCE_IN_USE` | 409 | Resource deletion while active Data reference it |
| `BUNDLE_FILE_NOT_FOUND` | 404 | Bundle file missing |
| `BUNDLE_FILE_CONFLICT` | 409 | Different content under one file identity |
| `BUNDLE_FILE_TOO_LARGE` | 413 | Material file over its limit |
| `BUNDLE_FILE_INVALID` | 400 | Material or Session file invalid |
| `BUNDLE_FILE_UNAVAILABLE` | 503 | Bundle directory unreadable; retry |
| `OUTPUT_SCHEMA_NOT_FOUND` | 404 | Unknown or deleted output format |
| `METRICS_QUERY_INVALID` | 400 | Invalid Metrics query |
| `NETWORK_ERROR`, `REQUEST_TIMEOUT`, `RESPONSE_TOO_LARGE`, `RUNTIME_UNSUPPORTED`, `REQUEST_REDIRECT_BLOCKED`, `HTTP_ERROR` | 0 | Client only |
