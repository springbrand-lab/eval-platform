# Package Boundaries

- `eval-contracts` owns stable cross-package evaluation types.
- `eval-dataset` owns Dataset, Data and initial-data references.
- `eval-runtime` owns config, execution/evaluation orchestration, runtime Sample and the SP Harness seam.
- `eval-metrics` owns evaluator, attribution, aggregation and reporting submodules.
- `apps/*` consume package public exports and do not import package internals.
- No package imports `sp-platform/agent/src/*` or accesses SP Durable Object storage directly.
