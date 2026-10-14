# Eval HTTP control plane

`apps/eval-api` exposes the existing Dataset, Catalog, Config, Runtime and Metrics services through a Node HTTP server. It owns request authentication and composition, not evaluation semantics or SP storage. Every `/api/*` request requires `Authorization: Bearer <Eval SP session token>`; the server calls the configured Eval SP `/api/auth/me` for every request and uses only the returned user ID to scope PostgreSQL operations. The client cannot select an owner. `GET /healthz` checks only that the HTTP process is serving.

Requests and responses use JSON unless a Dataset document is imported or exported. Creation returns `201`, deletion returns `204`, missing resources on reads and updates return `404`, invalid inputs return `400`, conflicting identities return `409`, and an invalid or absent session returns `401`. Dataset and Data deletion is idempotent, so deleting an already absent record also returns `204`. JSON object bodies reject duplicate keys at every depth. Oversized bodies return `413`. Unexpected storage or network failures are reported without exposing internal error details. IDs in URL path segments are URL encoded.

Run admission uses a token-free, owner-scoped ConfigReader and `createEvalRunAdmission`; Config editing uses a separate Store with the current request's session token. Concurrent Execution and Pipeline requests for one user share an admission instance while active; the existing independent-evaluation handler separately shares its admission instance for concurrent evaluation requests. Each cache releases idle owners. Run and Sampling reads use owner-scoped PostgreSQL readers and Runtime's public projection functions. No Harness or Worker credentials are present in the HTTP process.

Sampling and Evaluation responses retain artifact and complete trajectory references. Their bytes remain behind Eval SP's public read-only Workspace and Trajectory APIs; this control plane does not read SP Durable Object storage.

| Operation | Route | Input |
| --- | --- | --- |
| Current user | `GET /api/me` | — |
| SP Agent Configs | `GET, POST /api/agent-configs`; `GET, PATCH, DELETE /api/agent-configs/{id}` | SP's public Agent Config JSON on writes |
| Agent choices | `GET /api/agents?role=subject|evaluator` | Optional role |
| Projects | `GET, POST /api/projects`; `GET /api/projects/{id}` | Create: `{name}` |
| Successful Samplings | `GET /api/projects/{id}/samplings/successful`; `GET /api/projects/{id}/samplings/successful/ids` | Existing [independent evaluation contract](eval-independent-evaluation-entry.md) |
| Datasets | `GET, POST /api/datasets`; `GET, PUT, DELETE /api/datasets/{id}` | Dataset input on create/full replacement |
| Dataset membership | `GET, POST, DELETE /api/datasets/{id}/data` | POST/DELETE: `{dataIds:[...]}` |
| Dataset documents | `POST /api/datasets/import?format=json|yaml`; `GET /api/datasets/{id}/export?format=json|yaml` | Import body is the raw document text |
| Data | `GET, POST /api/data`; `GET, PUT, DELETE /api/data/{id}` | Data input on create/full replacement; optional `datasetId` query on list |
| Samples | `GET, POST /api/samples`; `GET /api/samples/{id}` | List requires `dataId` query; create: `{dataId}` |
| Configs | `GET, POST /api/configs/{execution|evaluation|pipeline}`; `GET, PUT /api/configs/{kind}/{id}` | Existing public Config input; PUT fully replaces editable fields |
| Execution and Pipeline admission | `POST /api/runs/{execution|pipeline}` | Config ID with `projectId` and `idempotencyKey` |
| Independent evaluation | `POST /api/projects/{id}/evaluations`; `GET /api/projects/{id}/runs/{runId}`; `GET /api/projects/{id}/runs/{runId}/evaluations` | Existing [independent evaluation contract](eval-independent-evaluation-entry.md), including `202` submission, `8 MiB` body and `10,000` ID limits |
| Run and result facts | `GET /api/runs/{id}`; `GET /api/samplings/{id}`; `GET /api/evaluations/{id}`; `GET /api/samplings/{id}/evaluations` | — |
| Metrics | `GET /api/metrics/projects/{id}` and `/datasets/{datasetId}`, `/samples/{sampleId}`, `/samplings/{samplingId}` beneath that Project | Optional repeated `runId` query filters |
| Initial resources | `PUT /api/bundles/{bundleId}/materials/{materialId}`; `PUT /api/bundles/{bundleId}/sessions/{sessionId}`; `PATCH /api/data/{dataId}/initial-resources` | See [Harness protocol](eval-sp-harness-protocol.md) |

The API's `start:api` process requires `DATABASE_URL`, `EVAL_SP_API_ORIGIN`, `EVAL_SP_WRITE_ORIGIN`, `EVAL_SP_SOURCE_BRANCH`, `EVAL_SP_SOURCE_COMMIT` and `EVAL_BUNDLE_DIR`. `EVAL_API_HOST` defaults to `127.0.0.1`; `EVAL_API_PORT` defaults to `8788`. `EVAL_WEB_ORIGIN` optionally restricts browser origins on the independent-evaluation routes. The API and Run Worker mount the same Bundle directory and use the same Eval SP release. The API does not hold the Agent Worker service token or run admitted work inline; PostgreSQL Run admission notifies the separate single-instance Worker.
