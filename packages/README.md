# Shared Packages

| Package | Role |
| --- | --- |
| `eval-contracts` | Cross-package evaluation contracts, including Project plans and Run targets |
| `eval-dataset` | Editable source Dataset, Data, required user prompt, extensible JSON fields and optional initial-resource references |
| `eval-runtime` | Project plan validation and digests, Run preview/admission, execution, evaluation and SP Harness orchestration |
| `eval-metrics` | Fixed four-level reporting, Agent resource and trajectory statistics, JSON Schema output field summaries |

All four entries are independent workspace packages. Their subdirectories are package-internal modules, not additional workspace packages. Database and application integration remain outside these package cores.
