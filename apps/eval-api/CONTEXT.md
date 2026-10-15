# API Context

`eval-api` is the internal control-plane application for evaluation projects.

It exposes authenticated operations for Project, Dataset, Sample, Sampling,
Execution, Evaluation, Artifact, Trajectory and Metric views. It consumes
package public exports and delegates execution/evaluation orchestration to
`@eval-platform/eval-runtime`.

It does not own Agent execution, SP Chat/DO storage, Dataset semantics or
evaluation scoring logic.

The API workspace owns PostgreSQL migrations and implementations of the public
DatasetStore, RuntimeStore, ConfigStore and read-only MetricsSource ports. A
caller supplies the `pg` Pool; these adapters never import SP's private
database client. The Catalog stores user-owned Projects and Samples that
reference the same user's Data, with Agent listing supplied separately.
User-facing Runtime and Metrics adapters require the owner identity verified
by Eval SP; only the Worker Store resumes Runs across users. Metrics and Run
views read in sets under one repeatable-read, read-only transaction and reuse
the Runtime's status projection.

The Hono HTTP control plane (`start:api`) verifies every Bearer session with
Eval SP, assembles owner-scoped services once per owner and routes Dataset,
Config, Run, Metrics and initial-resource operations. Run admission and stop
requests commit their facts and enqueue a pg-boss Run job in one transaction;
the HTTP process never executes an Agent or holds the SP service credential.
See `docs/eval-http-api.md` for the route contract.

The Run Worker (`start:worker`) consumes those jobs with the real Eval SP
Harness and calls the Runtime's `resume()`; it never stores a second Run
status. Several Worker instances may run at once. A shared `EVAL_BUNDLE_DIR`
stores each user's uploaded material and optional Session content for both
processes. Scheduling and stop semantics are recorded in
`docs/architecture.md`; process configuration is in `README.md`.
