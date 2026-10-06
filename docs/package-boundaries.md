# Package Boundaries

## Repository layout

```text
eval-platform/
├── packages/
│   ├── eval-contracts/
│   ├── eval-dataset/
│   ├── eval-runtime/
│   └── eval-metrics/
└── apps/
    ├── eval-api/
    ├── eval-web/
    └── eval-cli/
```

The four package workspaces keep the package boundary stable. `eval-runtime` now contains the runtime orchestration implementation and focused tests; the other packages remain contract and result-layer foundations. Applications additionally contain `CONTEXT.md`.

Package-internal submodules:

```text
eval-dataset/
└── dataset/

eval-runtime/
├── config/
├── harness/
└── runtime/

eval-metrics/
├── evaluators/
├── attribution/
├── aggregation/
└── reporting/
```

## Dependency direction

```text
eval-contracts
├── eval-dataset
├── eval-metrics
└── eval-runtime
        ↑
eval-dataset / eval-metrics
        ↑
eval-api / eval-web / eval-cli
```

The arrows describe allowed consumption direction. The contract package must not depend on runtime, storage, API, Web, CLI or Cloudflare bindings.

## Package responsibilities

### `eval-contracts`

Owns stable runtime/evaluation types shared across packages: Project, Sampling, HarnessConfig, ExecutionOutput, EvaluationAgentOutput, EvaluatorResult, AttributionResult, ArtifactRef, TrajectoryRef and EvidenceRef. Dataset/Data belong to `eval-dataset`; runtime Sample belongs to `eval-runtime`.

It is the only place for cross-package evaluation contracts. It does not implement orchestration or persistence.

### `eval-dataset`

Owns Dataset/Data definitions, JSON, initial context and initial-material references. It treats data as reusable across datasets. File bundles are represented by references, manifests and hashes; the package does not own an R2 binding. Runtime Sample is owned by `eval-runtime`.

### `eval-runtime`

Owns `start`, `evaluate`, `pipeline`, `getRun`, `getSampling`, Sampling lifecycle, separate execution/evaluation concurrency limits, retry, evaluation-input materialization and the `RuntimeStore` persistence port. `RuntimeStore` exposes semantic atomic commands for creating a Run with its Samplings and committing evaluation preparation; the Runtime does not sequence independent persistence calls for one aggregate. SP is the first-party Harness inside this boundary; a separate `eval-sp-adapter` package is intentionally not created.

Harness exposes `ensureAgent`, not an unconditional creation operation. Runtime assigns and persists the stage's `submissionId` before calling SP; Harness passes that identity to SP's public Chat creation seam. Repeated or concurrent ensures for the same identity must return the original Agent handle. An identity already bound to a different owner, Project, Sampling, role or Agent Config must fail without rebinding or creating another Agent. SP owns authoritative deduplication and provisioning; Runtime owns identity persistence and operation-specific retry decisions, not a second local creation registry.

### `eval-metrics`

Owns four internal submodules: `evaluators` for evaluation context and evaluator contracts, `attribution` for failure-cause and evidence interpretation, `aggregation` for score normalization and aggregation, and `reporting` for case results and experiment reports. It does not decide how an Agent runs or how a Workspace is copied.

### `apps/eval-api`

Future internal API entry point. It will expose runtime controls to Web, CLI and automation through authenticated internal routes.

### `apps/eval-web`

Future internal UI entry point. It will select Project, Dataset, Sample, Subject Agent, Judge Agent, execution concurrency and evaluation concurrency, then render Run, artifact, metric and attribution results.

### `apps/eval-cli`

Future CLI entry point. It will use the same config and API semantics as Web; it is not the source of truth for Cloudflare Agent trajectories.

## SP alignment

The runtime Harness must consume the same public concepts as `sp-platform`:

- Agent Config reference: `ownerUserId`, `userAgentId`;
- `Inbox.createChat(title, userAgentId, chatId?)`;
- `dispatchMessage(message, "enqueue" | "steer")`;
- `SubmissionReceipt` and `getSubmission()`;
- `TrajectoryPage` pagination with SP's maximum page size;
- Workspace tree, manifests and content boundaries.

Eval records one `submissionId` for an SP Chat/Submission and does not store a second `chatId` for the same Agent.

That ID is assigned before provisioning and reused after an uncertain creation response. `ensureAgent` retries retain the same creation facts and ID; a separately requested re-evaluation receives a new evaluation identity. Creation identity is distinct from the idempotency key used to submit or restart work inside that Agent.

The eval project must not import SP private source files, use Web projections as facts, or read Durable Object SQLite directly.
