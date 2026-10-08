# Shared Packages

| Package | Role |
| --- | --- |
| `eval-contracts` | Cross-package evaluation contracts |
| `eval-dataset` | Dataset, Data, required user prompt, extensible JSON fields and optional initial-resource references |
| `eval-runtime` | Config, execution, evaluation and SP Harness orchestration |
| `eval-metrics` | Evaluation results, resource statistics and four-level reporting |

All four entries are independent workspace packages. Their subdirectories are package-internal modules, not additional workspace packages. Database and application integration remain outside these package cores.
