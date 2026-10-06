# API Context

`eval-api` is the internal control-plane application for evaluation projects.

It will expose authenticated operations for Project, Dataset, Sample, Sampling,
Execution, Evaluation, Artifact, Trajectory and Metric views. It consumes
package public exports and delegates execution/evaluation orchestration to
`@eval-platform/eval-runtime`.

It does not own Agent execution, SP Chat/DO storage, Dataset semantics or
evaluation scoring logic.
