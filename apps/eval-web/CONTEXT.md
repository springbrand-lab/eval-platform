# Web Context

`eval-web` is the internal evaluation console, embedded in takt and sharing its login.

It prepares Datasets, Data, initial resources, output formats and Agent Configs; creates Projects
from Datasets, Data subsets and Sampling counts with a Subject Agent and execution policy; fills or
replaces the evaluation plan until the first evaluating Run locks it; previews and submits Runs over
Project, Dataset, ProjectSample and Sampling selections; stops Runs and re-syncs judge scores; and
displays the four-level metrics, artifacts, evaluation results, Langfuse links and read-only Chat,
Workspace and Trajectory views. It also shows the service account's credits and records manual grants.

It consumes only the Eval API and package public contracts. It never drives an Agent, never connects
to SP Durable Objects, and never reconstructs trajectory facts from UI state. Its Worker is the only
place the takt token is checked; the Eval API sees the verified user only as an audit actor.
