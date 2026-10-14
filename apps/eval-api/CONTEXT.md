# API Context

`eval-api` is the internal control-plane application for evaluation projects.

It will expose authenticated operations for Project, Dataset, Sample, Sampling,
Execution, Evaluation, Artifact, Trajectory and Metric views. It consumes
package public exports and delegates execution/evaluation orchestration to
`@eval-platform/eval-runtime`.

It does not own Agent execution, SP Chat/DO storage, Dataset semantics or
evaluation scoring logic.

The API workspace owns PostgreSQL migrations and implementations of the public
DatasetStore, RuntimeStore and read-only MetricsSource ports. A caller supplies
the `pg` Pool; these adapters never import SP's private database client. The
Catalog stores user-owned Projects and Samples that reference the same user's
Data, with Agent listing supplied separately. The Metrics projection uses one
repeatable-read, read-only transaction and the Runtime's status projection.
HTTP routes, authentication, Config persistence and SP Harness provisioning
are not implemented by the persistence adapters.

The API app also owns a single-instance Node Run worker. Run admission and
PostgreSQL notification commit atomically; the worker listens, scans unfinished
Runs on startup/reconnect and periodically, and calls the Runtime's `resume()`.
It never runs the Agent locally or stores a second Run status. A production
process entry point depends on the not-yet-connected SP Harness and Config
store; at most one worker process may be deployed at any moment.
