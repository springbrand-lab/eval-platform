# Pi-native Eval evidence: cutover and parity gate

This is a deliberately breaking **new-run** consumer change, not a migration. SP owns the
trajectory wire in the **published public** `@springbrand/eval-harness` export. Eval never
imports SP private source, queries SP Durable Object storage, or upgrades an event-only
`sp-trajectory/v1` bundle by relabelling its JSON. Eval pins the npm-published
`@springbrand/eval-harness@0.1.0-alpha.9` exactly. The **installed artifact**, not
an SP source branch, exports `evalEvidenceTrajectoryPageSchema`, `evalResourceHeaderSchema`,
`evalResourceNativePageSchema` (the same trajectory page) and
`evalBillingResourcesPageSchema` and finalized/partial path/record-byte helpers.
It still depends on Runtime alpha.15 and requires SAFE records. The raw consumer
targets Runtime alpha.32 and a new public Harness release; the existing alpha.9
rejects the new raw fixture. Its HTTP schemas are not bypassed or locally mirrored.
Raw HTTP/evidence lifecycle acceptance remains blocked until the coordinator
pins and verifies that actual public release. No deployment parity is implied.

## Consumer contract to compare against SP's public export

- Authenticated `GET /internal/v1/eval-harness/users/{userId}/chats/{chatId}/evidence/trajectory`
  uses `submissionId`, `afterSeq`, `limit <= 200`, and on subsequent pages/resume
  `throughSeq`. The page is
  `{format:"sp-pi-trajectory/v1",cursor:{throughSeq:number},records:[{ingestSeq:number,record:TrajectoryRecord} | {ingestSeq:number,reference:{format,throughSeq,identity,byteLength,sha256}}],nextAfterSeq:number|null}`.
  All cursors are safe nonnegative integers, `ingestSeq` is positive and increasing, every
  record is at or below the *same* frozen high-water mark, and `nextAfterSeq` is the final
  returned seq or null precisely at the frozen end. Later Chat work must not enter an
  export resumed with its saved watermark.
- The actual **published UA public** `TrajectoryRecord` is
  `{format:"pi-trajectory/v1",resource:{agentId,sessionId},submissionId:string|null,record:{type:"conversation"|"entry",value},parent?,origin?}`.
  Execution has a nonempty Submission and optional `origin:"execution"`;
  Context requires `submissionId:null` together with `origin:"context"`.
  Legacy `projection` is rejected, not stripped or accepted as a union.
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
  not the bookkeeping `turn.finished` fact. Raw marker-looking strings are real
  content, not withholding evidence. Bounded interpretation uses a separate
  format-free record view and JSON-Pointer `omittedPaths`; original raw bytes
  remain unchanged in evidence. Missing interpretations cannot prove zero or
  completeness, and incomplete last replies suppress earlier replies.
  The published UA `@springbrand/agent-runtime/trajectory` can be consumed now;
  SP's **new** `@springbrand/eval-harness` native page schema is not yet published.
  A bare old `turn.finished` event JSON is never a Pi-native record.
- SP's operation-scoped, **bounded** resource header retains `scope`, `readiness`,
  `finalized`, `coverage`, settled Action/Tool charge facts and a frozen Chat
  `cursor.throughSeq`, but not a full array. The authenticated `/native-records`
  route uses the same `sp-pi-trajectory/v1` inline/ref page filtered to the
  selected Submission and provable descendants; `/billing` pages matched
  API-owned usage/model settlements with `cursor:{throughCount,sha256}`. Every
  native reference is a mandatory authenticated byte read, not a partial or
  omitted record. Old `pendingTelemetryEvents` remains an SP diagnostic.
  Eval's new consumer verifies all pages, pair/cursor/hash/scope stability and
  a final unchanged header, then persists only compact, body-free Pi facts and
  independent usage/billing in the existing JSON columns. It **never** calls
  the combined unbounded route for a new download. Historical rows are not
  changed. A nonfinalized header yields pages only with Runtime's explicit
  post-wait `allowPartial=true` opt-in (including the frozen cutoff on billing
  and the bound key on referenced bytes); these are committed known facts
  with `coverage.partial`, never a zero or complete claim. A final billing
  fingerprint probe and repeat header reject changes before sealing. This
  locally mocked partial extension still requires a compatible public package
  and isolated PostgreSQL/deployed-SP integration before any end-to-end claim.
- SP's public package source sets a **4,000,000-byte** trajectory page ceiling. Eval
  enforces that limit; SP paginates by bytes as well as count and emits an
  immutable reference for a record above the inline bound, never truncating one.
  Eval streams verified native bytes directly into each complete
  `{ingestSeq,record}` line unchanged; a line above the evidence file limit fails
  non-retryably. Artifacts and immutable Subject inputs remain primary.
- A new bundle is `schemaVersion:2`, `trajectory.format:"sp-pi-trajectory/v1"`;
  its trajectory and each part count native **`records`**, not legacy events.
  `evidenceId` and `manifestSha256` are content hashes of those **new** manifest bytes.
  An unfinished old event or SAFE export is not resumed as raw. Existing version-1
  and SAFE version-2 manifests, blobs, refs, scores and resource rows are not rewritten or deleted.
  Version-1 reads and old event-only metrics are unsupported; missing native facts
  return partial/unavailable, not a fake zero. Dataset, Execution and Evaluation
  remain independent entry points; Subject/Evaluator result acceptance is unchanged.

## Offline public-contract proof and remaining blocker

`fixtures/pi-native-public-v1.json` is the exact compact output of
`scripts/generate-pi-native-fixture.mjs` using published
`@springbrand/agent-runtime/trajectory@0.3.1-alpha.32` exports:
`createTrajectoryRecord`, `createTrajectoryEntry`,
`createTrajectoryEventFact`, `parseTrajectoryRecord`, the public
`trajectoryRecordSchema` and `readTrajectoryBookkeeping`. With an already
installed **public** UA export and the next raw-capable npm Harness public entry,
the following regenerates the fixture byte-for-byte and asserts that all 16
records parse as both SP's published public page and its resource snapshot
(run from `apps/eval-api`; no SP source or private worktree is used):

```sh
EVAL_UA_PUBLIC_TRAJECTORY_MODULE='file:///path/to/installed/@springbrand/agent-runtime/dist/trajectory/index.js' \
EVAL_SP_PUBLIC_EVAL_HARNESS_MODULE='file:///path/to/eval-api/node_modules/@springbrand/eval-harness/dist/eval-harness/src/index.js' \
node ../../scripts/generate-pi-native-fixture.mjs --compact |
  cmp - ../../fixtures/pi-native-public-v1.json
```

The alpha.32 generator matches the checked-in raw fixture byte-for-byte. The
installed alpha.9 Harness rejects that fixture; this is a publication blocker,
not a reason to cast or replace its public schemas. No installs/publication or
live SP calls are part of the Group B implementation. The production Metrics
interpreter consumes only supported body-free facts and treats unknown or
ambiguous Entries as unsupported. Rerun the proof against the next published
raw API and actual service parity.
Direct and nested children,
including attributed child Context, require an ordered verified same-Chat
parent chain; a foreign parent or an imported Chat-wide Context never becomes
part of the selected Submission's resource collection.

## Evidence required before an integrated green or release

1. Publish a Runtime alpha.32-backed raw `@springbrand/eval-harness` release that preserves
   `allowPartial` for header/native/billing requests and binds partial billing
   `throughSeq` and byte-transfer `resourceKey`; pin the exact compatible npm
   version and update the lockfile. Alpha.9 already supplies public partial
   schemas/helpers but is not raw-capable; do not treat a local replacement as a
   release contract. Confirm `throughSeq`, API billing `(throughCount,throughSha256)`
   and Action/Tool identities across the new public partial path, without fallback.
2. Obtain a redacted **actual** SP-generated page sequence, resource header/native/billing pages and
   Evaluator Pi assistant/Tool-result sample from the Eval deployment. Check auth
   rejects absent/wrong service token, foreign user/Chat/key/Submission; first and
   resumed reads keep the same `throughSeq` with appended records; page max bytes,
   empty terminal page, failed Tool/Step, partial delivery, redacted content, and a
   record larger than one importable part. Confirm the public UA `TrajectoryRecord`,
   `readTrajectoryBookkeeping`, Pi message refs, task identity, raw content fidelity,
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
