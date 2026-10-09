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
Catalog stores user-owned Projects and global Samples that reference global
Data, with Agent listing supplied separately. The Metrics projection uses one
repeatable-read, read-only transaction and the Runtime's status projection.
HTTP routes, authentication, Config persistence and SP Harness provisioning
are not implemented by the persistence adapters.
