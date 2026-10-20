# Project Rules

`eval-platform` is an independent internal evaluation project. Before changing a package, read `docs/package-boundaries.md` and the package README in the same directory.

## Non-negotiable boundaries

- Do not move evaluation code into `sp-platform`.
- Do not import `sp-platform/agent/src/*` private implementation files.
- Do not read or write SP Durable Object storage directly from evaluation code.
- Treat SP Chat, Submission, Trajectory and Workspace public seams as the only SP integration boundary.
- Keep Dataset, Execution and Evaluation independently startable; `pipeline` is orchestration only.
- Always collect Subject artifacts and the complete trajectory; artifacts remain the primary evidence and trajectory is supporting evidence.

## Package work

- Keep dependencies flowing from contracts toward adapters and applications.
- Add behavior only after the package boundary and public contract are documented.
- Keep package metadata, `tsconfig.json`, `README.md` and focused tests together; shared packages expose `src/index.ts`, applications expose only their process entry points.
- Do not commit generated output, local secrets or Durable Object state.
- Web role labels are “执行 Agent” and “评估 Agent”; do not use 被测 Agent, 测试 Agent, 实验 Agent or 评委. Keep the public Subject/Evaluator contracts unchanged.
- SP Agent selections with `kind: "connector_toolkit"` are Connector Toolkits, not managed MCP Servers. Purpose reconciliation checks only selections without `kind` against the MCP catalog and preserves Toolkit selections.

## Verification

- `pnpm check`, then `DATABASE_URL=postgres://<user>:<pass>@<host>:<port>/<db> pnpm -r --no-bail test`; without `DATABASE_URL` the PostgreSQL integration tests are skipped.
