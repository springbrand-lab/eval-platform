# Shared Packages

| Package | Role |
| --- | --- |
| `eval-contracts` | Cross-package evaluation contracts |
| `eval-dataset` | Dataset, Data, JSON, initial context and initial-material references |
| `eval-runtime` | Config, execution, evaluation and SP Harness orchestration |
| `eval-metrics` | Evaluators, attribution, aggregation and reporting |

All four entries are independent workspace packages. Their subdirectories are package-internal modules, not additional workspace packages. Production implementations are intentionally deferred.
