# Context Map

| Area | Entry point | Responsibility |
| --- | --- | --- |
| Architecture | `docs/architecture.md` | Overall evaluation model and SP boundary |
| Deployment | `docs/eval-sp-deployment.md` | Independent Eval SP release, storage and identity ownership |
| Package graph | `docs/package-boundaries.md` | Package ownership and dependency direction |
| Runtime | `packages/eval-runtime/README.md` | Execution, evaluation and pipeline orchestration seam |
| Contracts | `packages/eval-contracts/README.md` | Stable cross-package evaluation contracts |
| Dataset | `packages/eval-dataset/README.md` | Dataset, Data, JSON, initial context and initial-material references |
| Metrics | `packages/eval-metrics/README.md` | Evaluation results, resource statistics and four-level reporting |
| API application | `apps/eval-api/README.md` | Processes and environment, PostgreSQL adapters, SP Harness and Bundle directory |
| HTTP contract | `docs/eval-http-api.md` | Routes, response envelope, status and error codes |
| Run scheduling | `docs/architecture.md` | pg-boss Run Worker, recovery and stop semantics |
| Web and CLI | `apps/eval-web/CONTEXT.md` and `apps/eval-cli/CONTEXT.md` | Future internal UI and CLI entry points |
