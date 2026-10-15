# Context Map

| Area | Entry point | Responsibility |
| --- | --- | --- |
| Architecture | `docs/architecture.md` | Overall evaluation model, Project plan, Run admission and SP boundary |
| Project design | `docs/eval-project-redesign.md` | Design record of Project snapshots and creation, Runtime admission and Metrics |
| Deployment | `docs/eval-sp-deployment.md` | Independent Eval SP release, storage and identity ownership |
| Package graph | `docs/package-boundaries.md` | Package ownership and dependency direction |
| Runtime | `packages/eval-runtime/README.md` | Plan validation and digests, Run preview/admission, execution, evaluation and pipeline orchestration seam |
| Contracts | `packages/eval-contracts/README.md` | Stable cross-package evaluation contracts, including Project plans and Run targets |
| Dataset | `packages/eval-dataset/README.md` | Editable source Dataset, Data, JSON, initial context and initial-material references |
| Metrics | `packages/eval-metrics/README.md` | Fixed four-level reporting, Agent resource and trajectory statistics, JSON Schema numeric outputs |
| API application | `apps/eval-api/README.md` | Processes and environment, PostgreSQL adapters, SP Harness and Bundle directory |
| HTTP contract | `docs/eval-http-api.md` | Routes, response envelope, status and error codes |
| Evaluation-only Runs | `docs/eval-independent-evaluation-entry.md` | Selection and submission of evaluation-only Runs |
| Run scheduling | `docs/architecture.md` | pg-boss Run Worker, recovery and stop semantics |
| SP requirements | `docs/sp-eval-api-requirements.md` | Capabilities Eval requires from the independent Eval SP |
| Web and CLI | `apps/eval-web/CONTEXT.md` and `apps/eval-cli/CONTEXT.md` | Future internal UI and CLI entry points |
