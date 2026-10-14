# API Context

`eval-api` is the internal control-plane application for evaluation projects.

It will expose authenticated operations for Project, Dataset, Sample, Sampling,
Execution, Evaluation, Artifact, Trajectory and Metric views. It consumes
package public exports and delegates execution/evaluation orchestration to
`@eval-platform/eval-runtime`.

It does not own Agent execution, SP Chat/DO storage, Dataset semantics or
evaluation scoring logic.

The API workspace owns PostgreSQL migrations and implementations of the public
DatasetStore, RuntimeStore, ConfigStore and read-only MetricsSource ports. A caller supplies
the `pg` Pool; these adapters never import SP's private database client. The
Catalog stores user-owned Projects and Samples that reference the same user's
Data, with Agent listing supplied separately. User-facing Runtime and Metrics
adapters require the owner identity verified by Eval SP; only the Worker Store
scans and resumes Runs across users. The Metrics projection uses one
repeatable-read, read-only transaction and the Runtime's status projection.
The owner-scoped Config adapter saves Execution, Evaluation and Pipeline configs;
it verifies Agent Config references through the authenticated Eval SP client.
The independent-evaluation HTTP handler verifies each Bearer session through
Eval SP and composes owner-scoped Catalog, Runtime and ConfigStore services.
The Node API process composes the owner-scoped PostgreSQL ConfigStore and
Runtime, while the separate worker executes admitted Runs. Other control-plane
routes and SP Harness provisioning remain outside the independent-evaluation
HTTP handler.

The API app also owns a single-instance Node Run worker. Run admission and
PostgreSQL notification commit atomically; the worker listens, scans unfinished
Runs on startup/reconnect and periodically, and calls the Runtime's `resume()`.
It never runs the Agent locally or stores a second Run status. The worker
process and Eval SP Harness client exist, but the required SP service routes
still need server-side implementation. At most one worker process may be deployed.
