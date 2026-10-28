# Pi-native Eval evidence: cutover and parity gate

This is a deliberately breaking **new-run** consumer change, not a migration. SP owns the
trajectory wire in the **published public** `@springbrand/eval-harness` export. Eval never
imports SP private source, queries SP Durable Object storage, or upgrades an event-only
`sp-trajectory/v1` bundle by relabelling its JSON. Eval currently pins
`@springbrand/eval-harness@0.1.0-alpha.5`, whose exported page is still event-only.
The SP release worktree has an offline `0.1.0-alpha.7` **candidate tarball** and
public `evalEvidenceTrajectoryPageSchema` / `evalResourceSnapshotSchema`, not a
published or pinned release. Until a Pi-native package is **published** and pinned,
local fixtures verify consumer behavior and public-schema shape, **not** live
SP/Eval interoperability or deployment readiness.

## Consumer contract to compare against SP's public export

- Authenticated `GET /internal/v1/eval-harness/users/{userId}/chats/{chatId}/evidence/trajectory`
  uses `submissionId`, `afterSeq`, `limit <= 200`, and on subsequent pages/resume
  `throughSeq`. The page is
  `{format:"sp-pi-trajectory/v1",cursor:{throughSeq:number},records:[{ingestSeq:number,record:TrajectoryRecord}],nextAfterSeq:number|null}`.
  All cursors are safe nonnegative integers, `ingestSeq` is positive and increasing, every
  record is at or below the *same* frozen high-water mark, and `nextAfterSeq` is the final
  returned seq or null precisely at the frozen end. Later Chat work must not enter an
  export resumed with its saved watermark.
- The actual **published UA public** `TrajectoryRecord` is
  `{format:"pi-trajectory/v1",resource:{agentId,sessionId},submissionId:string|null,projection:{kind:"safe",policyId,policyVersion},record:{type:"conversation"|"entry",value},parent?,origin?}`.
  There is **no top-level** `kind`, `event`, `request`, `hook`, `message`, `turnId`,
  `timestamp` or `projection.contentComplete`. Pi messages are
  `record.value.model` (assistant, user and toolResult); model-free bookkeeping
  is an Entry with `value.kind:"springbrand.trajectory"` and public
  `readTrajectoryBookkeeping(value)` returns a `type:"event"|"request"|"hook"`
  fact. Native event facts still contain `turn.started`/`turn.finished`,
  `generation.started`/`generation.finished` and `tool.started`/`tool.finished`;
  their Pi-owned input/output is **omitted**, not reconstructed. A finished
  generation's event holds Step status/Token facts, while `refs.assistantTimestamp`
  can link it to one Pi assistant message. Tool Call arguments and Tool Result
  content live in Pi messages and are matched by `toolCallId`. Ambiguous or
  missing linkage is diagnosed and cannot prove zero. Final reply is the last
  *native Pi assistant* `record.value.model` message of the exact Submission,
  not the bookkeeping `turn.finished` fact. Source policy redacts strings but
  preserves Pi block structure; use the public trajectory helper rather than
  inventing a content-completeness field.
  The published UA `@springbrand/agent-runtime/trajectory` can be consumed now;
  SP's **new** `@springbrand/eval-harness` native page schema is not yet published.
  A bare old `turn.finished` event JSON is never a Pi-native record.
- SP's operation-scoped resource snapshot retains `scope`, `readiness`, `finalized`,
  `usageEvents` and `billingSettlements` and replaces both `telemetryEvents` and its
  coverage field with `nativeRecords:[{ingestSeq,record}]` / `coverage.nativeRecords`.
  Old readiness counters such as `pendingTelemetryEvents` remain SP diagnostics, not
  invented metric values. Eval rejects foreign Chat/Submission records; raw bytes go into
  `eval_attempt_resources` in the same CAS transaction as the summary and a body-free
  Metrics projection. Tokens and charged units still come **only** from usage and
  settlement facts; native Pi usage supports **Step classification** only.
- SP's public package source sets a **4,000,000-byte** page ceiling. Eval must
  enforce no higher ceiling (by the HTTP client's read bound). SP must
  paginate by *bytes as well as count* and return an explicit failure for a single
  unpageable record, never truncate one. Eval writes each complete
  `{ingestSeq,record}` line unchanged; a line above the evidence file limit fails
  non-retryably. Artifacts and immutable Subject inputs remain primary.
- A new bundle is `schemaVersion:2`, `trajectory.format:"sp-pi-trajectory/v1"`;
  its trajectory and each part count native **`records`**, not legacy events.
  `evidenceId` and `manifestSha256` are content hashes of those **new** manifest bytes.
  An unfinished old event export cannot resume as a native one. Existing version-1
  manifests, blobs, refs, scores and resource rows are not rewritten or deleted.
  Version-1 reads and old event-only metrics are unsupported; missing native facts
  return partial/unavailable, not a fake zero. Dataset, Execution and Evaluation
  remain independent entry points; Subject/Evaluator result acceptance is unchanged.

## Offline public-contract proof and remaining blocker

`fixtures/pi-native-public-v1.json` is the exact compact output of
`scripts/generate-pi-native-fixture.mjs` using published
`@springbrand/agent-runtime/trajectory@0.3.1-alpha.9` exports:
`createTrajectoryRecord`, `createTrajectoryEntry`,
`createTrajectoryEventFact`, `projectTrajectoryForExport`, the public
`trajectoryRecordSchema` and `readTrajectoryBookkeeping`. With an already
installed **public** UA export and the SP release worktree's **public**
`packages/eval-harness/src/index.ts`, the following regenerates the fixture
byte-for-byte and asserts that all 16 records parse as both SP's new public
page and its resource snapshot (run from `apps/eval-api`; no packages are
linked or pinned to another worktree):

```sh
EVAL_UA_PUBLIC_TRAJECTORY_MODULE='file:///path/to/installed/@springbrand/agent-runtime/dist/trajectory/index.js' \
EVAL_SP_PUBLIC_EVAL_HARNESS_MODULE='/path/to/sp-release/packages/eval-harness/src/index.ts' \
node --import tsx ../../scripts/generate-pi-native-fixture.mjs --compact |
  cmp - ../../fixtures/pi-native-public-v1.json
```

This offline public-schema assertion succeeded locally. It cannot prove a
deployed endpoint emits those bytes or that safe Projection privacy is configured
there. A direct offline `pnpm add @springbrand/agent-runtime@0.3.1-alpha.9` to
`eval-metrics` currently fails resolving transitive
`@chat-adapter/catalog@4.43.0`; **no** `file:/tmp` dependency is committed.
The production interpreter therefore reads only the known bookkeeping fields
and treats unknown or ambiguous Entries as unsupported. Once the public
dependency is installable and SP publishes the native Harness release,
replace these temporary structural checks with the public parser/schema and
rerun this proof plus actual service parity. Direct children are provable from
their public parent; deeper subagent ancestry requires a verified scoped
lineage and must not be accepted merely because some parent exists.

## Evidence required before an integrated green or release

1. Publish SP's `@springbrand/eval-harness` new public release, pin it in Eval's
   `apps/eval-api/package.json` / lockfile and replace the temporary structural page
   schema with the actual **public** exported type/schema. Confirm `throughSeq` is an
   accepted query parameter on both first-page replay and later pages; if the public
   package offers a different snapshot anchor or record shape, change Eval and rerun
   this gate rather than adding a legacy fallback.
2. Obtain a redacted **actual** SP-generated page sequence, resource snapshot, and
   Evaluator Pi assistant/Tool-result sample from the Eval deployment. Check auth
   rejects absent/wrong service token, foreign user/Chat/key/Submission; first and
   resumed reads keep the same `throughSeq` with appended records; page max bytes,
   empty terminal page, failed Tool/Step, partial delivery, redacted content, and a
   record larger than one importable part. Confirm the public UA `TrajectoryRecord`,
   `readTrajectoryBookkeeping`, Pi message refs, task identity, policy redaction,
   timestamp units, and usage shape against an actual SP-native export.
   No secrets or original prompts belong in fixtures or logs.
3. Cross-check byte-for-byte native JSONL lines, part SHA-256, v2 manifest hashes,
   source cursor/replay, artifact and input file hashes, imported Evaluator Space
   paths, and final reply of **only** the selected Submission. Compare one new Run's
   raw `usageEvents` and `billingSettlements` against Metrics Token/charge diagnostics
   and validate the compact/raw Statistics and coverage parity for the same actual
   native records. Verify historic v1 manifest bytes/ref/hash and accepted scores
   before and after without importing/rewriting those objects.
4. Run focused checks/tests without a DB if credentials are unavailable. Parent runs
   full suites **serially** after integration; PostgreSQL test fixtures may truncate
   their isolated test database, so do **not** run them under the current no-DB-delete
   restriction. No push, publish or deploy is part of this worktree.
