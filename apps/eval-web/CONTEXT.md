# Web Context

`eval-web` is the internal evaluation console.

It will create Projects from Datasets, Data subsets and Sampling counts with a
Subject Agent and execution policy, fill or replace the evaluation plan until
the first evaluating Run locks it, preview and submit Runs over Project,
Dataset, ProjectSample and Sampling selections, stop and delete, and display
the four-level metrics, produced artifacts, evaluation results and read-only
Chat, Workspace and Trajectory views.

It consumes the API and package public contracts. It does not connect directly
to SP Durable Objects or reconstruct trajectory facts from UI state.
