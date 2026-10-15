# Eval HTTP control plane

`apps/eval-api` exposes the Dataset, Catalog, Config, Runtime and Metrics services through one Hono application served by `@hono/node-server` (`start:api`, entry `src/server.ts`). It owns request authentication and composition, not evaluation semantics or SP storage. Process configuration is listed in the [eval-api README](../apps/eval-api/README.md). This document is the single source for routes, the response envelope, status codes and error codes.

## Application structure

The layout follows SP's `apps/api`: `lib/create-app.ts` installs request IDs, pino request logging (`hono-pino`), the trusted-Origin check, CORS, `notFound` and `onError` for every route; `lib/api-errors.ts` holds the single `apiError` translation; `middlewares/` holds the service-account scope, Origin trust and logging; each domain lives in `routes/<domain>/<domain>.routes.ts | .handlers.ts | .index.ts` with `@hono/zod-openapi` route definitions. Owner-scoped services are assembled once in `owner-services.ts`; concurrent requests of one owner share its admission instance through `active-owner-admission.ts`, and the entry is released when the owner has no active request.

## Authentication and Origin

The Eval API runs as one fixed Eval SP service account; there is no interactive login. `EVAL_SP_SERVICE_USER_ID` names that account and `EVAL_SP_SERVICE_SESSION_TOKEN` is its long-lived service session, issued by SP's `bootstrap-eval-service-account` script. At startup the process verifies the token once through Eval SP `/api/auth/me` and refuses to start unless it resolves to the configured user. One middleware then scopes every `/api/*` request to that account; requests carry no `Authorization` header and the client cannot select an owner. Agent Config calls to Eval SP use the service session. `GET /healthz` only reports that the process is serving. The API is an internal service and must only be reachable from trusted networks.

A request carrying an `Origin` other than `EVAL_WEB_ORIGIN` is rejected with `403 REQUEST_UNTRUSTED_ORIGIN` on every route; requests without `Origin` (non-browser clients) pass. CORS allows only that Origin and exposes `X-Request-ID`. The same Origin is sent as the trusted Origin on Eval SP Agent Config writes.

## Envelope

Responses use `@springbrand/http` through `@eval-platform/eval-contracts/http` (`createHonoHttp`) with the catalog in `@eval-platform/eval-contracts/http-errors` (`defineErrorCatalog`).

- Success: `{ "success": true, "msg": <payload>, "errMsg": "", "code": "" }`. Creation returns `201`, independent evaluation admission and stop return `202`, deletion and Dataset membership changes return `204` with no body. Dataset export returns the document text.
- Failure: `{ "code", "errMsg", "requestId", "errors"?, "details"? }`; `errors` carries field-level `{path, errMsg}` items. Every response has the `X-Request-ID` header.

Codes are uppercase `DOMAIN_REASON`. `packages/eval-contracts/src/http-errors.ts` is the complete list with each code's status and default message; handlers map errors only by class, never by message text. Unexpected failures return `500 INTERNAL_ERROR` without internal details and are logged through `errorDiagnostics`.

| Situation | Status and code |
| --- | --- |
| Body or query fails its schema (including an explicit evaluation list over 10,000 IDs) | `422 REQUEST_VALIDATION_FAILED` with `errors` |
| Non-JSON `Content-Type` on a JSON route | `415 REQUEST_UNSUPPORTED_MEDIA_TYPE` |
| Malformed JSON, non-object body or duplicate field at any depth | `400 REQUEST_INVALID_JSON` |
| Body is not valid UTF-8 | `400 REQUEST_INVALID_INPUT` |
| Body over its route limit | `413 REQUEST_PAYLOAD_TOO_LARGE` |
| Domain input rejected after schema validation | `400` `RUNTIME_INPUT_INVALID`, `DATASET_INPUT_INVALID`, `CATALOG_INPUT_INVALID`, `CONFIG_REFERENCE_INVALID`, `METRICS_QUERY_INVALID`, `BUNDLE_FILE_INVALID` |
| Missing or other owner's entity | `404` `PROJECT_NOT_FOUND`, `RUN_NOT_FOUND`, `CONFIG_NOT_FOUND`, `DATASET_NOT_FOUND`, `DATA_NOT_FOUND`, `SAMPLE_NOT_FOUND`, `SAMPLING_NOT_FOUND`, `EVALUATION_NOT_FOUND`, `BUNDLE_RESOURCE_NOT_FOUND`, `BUNDLE_FILE_NOT_FOUND`, `OUTPUT_SCHEMA_NOT_FOUND` |
| Run admission conflicts | `409` `PROJECT_BUSY`, `RUN_IDEMPOTENCY_CONFLICT`, `PROJECT_SOURCE_BRANCH_CONFLICT`, `PROJECT_LAUNCH_SELECTION_CONFLICT`, `PROJECT_OUTPUT_SCHEMA_CONFLICT`, `PROJECT_EMPTY`, `SAMPLE_EVALUATION_PROMPT_MISSING`, `SAMPLING_UNAVAILABLE` |
| Stop of a Run that has already finished | `409 PROJECT_NO_ACTIVE_RUN` |
| Resource still referenced or content changed under one ID | `409` `DATASET_IN_USE`, `DATA_IN_USE`, `BUNDLE_RESOURCE_IN_USE`, `OUTPUT_SCHEMA_IN_USE`, `DATASET_IDENTITY_CONFLICT`, `BUNDLE_FILE_CONFLICT` |
| Content over a catalog limit | `413` `CATALOG_PAYLOAD_TOO_LARGE`, `BUNDLE_FILE_TOO_LARGE`, `EVALUATION_SELECTION_TOO_LARGE` |
| Eval SP rejected a relayed request | `EVAL_SP_FORBIDDEN`, `EVAL_SP_NOT_FOUND`, `EVAL_SP_CONFLICT`, `EVAL_SP_REQUEST_INVALID`, `EVAL_SP_REQUEST_FAILED`, `REQUEST_RATE_LIMITED` |
| Dependency temporarily unavailable; retry the same request | `503` `EVAL_SP_UNAVAILABLE`, `DATABASE_UNAVAILABLE`, `BUNDLE_FILE_UNAVAILABLE`, `RUNTIME_PERSISTENCE_UNCONFIRMED` |

## Request bodies

Every JSON body goes through one reader: `readBytesLimited` caps the received bytes, the text must be strict UTF-8, and `parseStrictJson` rejects duplicate fields before the route schema validates it. Each route's byte limit is derived from the content limits in `apps/eval-api/src/limits.ts` (worst-case JSON escaping plus metadata framing), so a body that carries maximal valid content is never rejected for size; content limits themselves are enforced by the schemas and catalog. The stop route ignores any body. Dataset document import reads the raw JSON/YAML text through the same bounded UTF-8 reader. Runtime IDs and idempotency keys are 1–512 characters without surrounding whitespace or control characters, and Runtime entity IDs (Project, Run, Sample, Sampling, Evaluation, Config) additionally must not contain `/` (validated by `entityIdSchema`); Bundle, Material, Session, output-format, Dataset and Data IDs are UUIDs (validated by `platformIdSchema`, case-insensitive on input and lowercase in responses), so a non-UUID path segment is a `422`.

## Routes

| Operation | Route | Input / result |
| --- | --- | --- |
| Health | `GET /healthz` | `{status:"ok"}`; no session |
| Current user | `GET /api/me` | — |
| SP Agent Configs | `GET, POST /api/agent-configs`; `GET, PATCH, DELETE /api/agent-configs/{id}` | SP's public Agent Config JSON on writes |
| Agent choices | `GET /api/agents?role=subject|evaluator` | Optional role |
| Projects | `GET, POST /api/projects`; `GET /api/projects/{projectId}` | Create: `{name}` |
| Project evaluation output format | `PUT /api/projects/{projectId}/evaluation-output-schema` | `{outputSchemaId}` or `{outputSchemaId:null}`; see [Dataset upload](eval-dataset-upload.md) |
| Datasets | `GET, POST /api/datasets`; `GET, PUT, DELETE /api/datasets/{datasetId}` | Dataset input on create/full replacement |
| Dataset membership | `GET, POST, DELETE /api/datasets/{datasetId}/data` | POST/DELETE: `{dataIds:[...]}` |
| Dataset documents | `POST /api/datasets/import?format=json|yaml`; `GET /api/datasets/{datasetId}/export?format=json|yaml` | Import body is the raw document text |
| Prompt Dataset upload | `POST /api/datasets/prompt-import` | `{name,description,format,content}`; see [Dataset upload](eval-dataset-upload.md) |
| Data | `GET, POST /api/data`; `GET, PUT, DELETE /api/data/{dataId}` | Optional `datasetId` query on list |
| Data initial resources | `PATCH /api/data/{dataId}/initial-resources` | See [Dataset upload](eval-dataset-upload.md) |
| Samples | `GET, POST /api/samples`; `GET /api/samples/{sampleId}` | List requires `dataId` query; create: `{dataId}` |
| Configs | `GET, POST /api/configs/{execution|evaluation|pipeline}`; `GET, PUT /api/configs/{kind}/{configId}` | PUT fully replaces editable fields |
| Execution and Pipeline admission | `POST /api/runs/execution`, `POST /api/runs/pipeline` | `{projectId, executionConfigId|pipelineConfigId, idempotencyKey}` / `201 RunHandle` |
| Independent evaluation admission | `POST /api/projects/{projectId}/evaluations` | `{evaluationConfigId, samplingIds, idempotencyKey}` / `202 {runId, samplingIds}` |
| Successful Samplings | `GET /api/projects/{projectId}/samplings/successful`; `GET /api/projects/{projectId}/samplings/successful/ids` | Page: optional `sampleId`, `afterSamplingId`, `limit` (default 100, max 1,000) / `{samplings, nextCursor}`; all IDs: optional `sampleId` / `{samplingIds}` |
| Current Run and stop | `GET /api/projects/{projectId}/runs/current`; `POST /api/projects/{projectId}/runs/{runId}/stop` | `{run:{runId, stopRequested?} | null}`; stop: `202 {runId, stopRequested:true}` |
| Project Run views | `GET /api/projects/{projectId}/runs/{runId}`; `GET /api/projects/{projectId}/runs/{runId}/evaluations` | `{run}` with Evaluation IDs and status; `{evaluations}` in the Run's Evaluation ID order |
| Run and result facts | `GET /api/runs/{runId}`; `GET /api/samplings/{samplingId}`; `GET /api/samplings/{samplingId}/evaluations`; `GET /api/evaluations/{evaluationId}` | — |
| Metrics | `GET /api/metrics/projects/{projectId}` and `/datasets/{datasetId}`, `/samples/{sampleId}`, `/samplings/{samplingId}` beneath that Project | Optional repeated `runId` query |
| Initial-resource catalog | `GET, POST /api/bundles`; `GET, PATCH, DELETE /api/bundles/{bundleId}`; `GET, POST /api/bundles/{bundleId}/materials|sessions`; `GET, PATCH, DELETE` on each Material/Session | See [Dataset upload](eval-dataset-upload.md) |
| Output-format catalog | `GET, POST /api/evaluation-output-schemas`; `GET, PATCH, DELETE /api/evaluation-output-schemas/{outputSchemaId}` | See [Dataset upload](eval-dataset-upload.md) |

Selection and resubmission rules for independent evaluation are in [Independent evaluation entry](eval-independent-evaluation-entry.md). Selecting all IDs returns `413 EVALUATION_SELECTION_TOO_LARGE` instead of a truncated list when more than 10,000 match. Dataset and Data deletion is idempotent.

## Run admission and stop

Run admission uses a token-free, owner-scoped ConfigReader and `createEvalRunAdmission`; Config editing uses a separate Store with the service session token. The HTTP process holds no Harness credential and never runs Agents: admission and stop requests commit their Run facts and enqueue the Run job in the same PostgreSQL transaction (see [Run scheduling](architecture.md#run-调度与停止)).

Admission responses follow the rules in [Run admission](architecture.md#run-准入与独立评估): a matching replay returns the original Run; a reused key with different facts, or a key retired by a replaced Run, is `409 RUN_IDEMPOTENCY_CONFLICT`; a new key while the Project has an unfinished Run is `409 PROJECT_BUSY`; a replaced Run ID is `404 RUN_NOT_FOUND`.

`POST .../runs/{runId}/stop` targets only the named current Run and returns `202 {runId, stopRequested:true}`, including for a repeat before replacement; an unknown or replaced Run is `404 RUN_NOT_FOUND`; a finished Run without a stop request is `409 PROJECT_NO_ACTIVE_RUN`. The response only records the request; stop semantics are described in [Run scheduling and stop](architecture.md#run-调度与停止).

Sampling and Evaluation responses retain artifact and complete trajectory references. Their bytes remain behind Eval SP's public read-only Workspace and Trajectory APIs; this control plane does not read SP Durable Object storage.
