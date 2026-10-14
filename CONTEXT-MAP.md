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
| API persistence | `apps/eval-api/README.md` | PostgreSQL migrations, Dataset/Runtime Stores and consistent MetricsSource |
| Web and CLI | `apps/eval-web/CONTEXT.md` and `apps/eval-cli/CONTEXT.md` | Future internal UI and CLI entry points |
