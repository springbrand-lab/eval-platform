# CLI Context

`eval-cli` is the automation and local-operation entry point for evaluation.

It will validate Datasets, upload initial resources, create Projects, preview,
submit and stop Runs, and query results using the same control-plane semantics
as the API and Web applications.

It is not the source of truth for Cloudflare Agent trajectories. The runtime
Harness obtains those through SP's public Chat, Submission, Trajectory and
Workspace seams.
