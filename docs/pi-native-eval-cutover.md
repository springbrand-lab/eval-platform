# Pi-native Eval evidence: cutover and parity gate

This is a deliberately breaking **new-run** consumer change, not a migration. SP owns the
trajectory wire in the **published public** `@springbrand/eval-harness` export. Eval never
imports SP private source, queries SP Durable Object storage, or upgrades an event-only
`sp-trajectory/v1` bundle by relabelling its JSON. Eval currently pins
`@springbrand/eval-harness@0.1.0-alpha.5`, whose exported page is still event-only.
Until a Pi-native package is **published** and pinned, local structural fixtures verify
only Eval behavior, **not** SP/Eval interoperability or deployment readiness.

## Consumer contract to compare against SP's public export

- Authenticated `GET /internal/v1/eval-harness/users/{userId}/chats/{chatId}/evidence/trajectory`
  uses `submissionId`, `afterSeq`, `limit <= 200`, and on subsequent pages/resume
  `throughSeq`. The page is
  `{format:"sp-pi-trajectory/v1",cursor:{throughSeq:number},records:[{ingestSeq:number,record:TrajectoryRecord}],nextAfterSeq:number|null}`.
  All cursors are safe nonnegative integers, `ingestSeq` is positive and increasing, every
  record is at or below the *same* frozen high-water mark, and `nextAfterSeq` is the final
  returned seq or null precisely at the frozen end. Later Chat work must not enter an
  export resumed with its saved watermark.
- Every record has `format:"pi-trajectory/v1"` and `projection.kind:"safe"`. The
  current **structural** Eval adapter expects `kind:"event"|"request"|"hook"|"message"|"result"`;
  events `turn_start`/`turn_end` and `tool_execution_start`/`tool_execution_end` with stable
  `turnId`/`toolCallId`; request `phase:"start"|"end"` with `requestId`, status, timing and
  optional Step token fields; hook `before_model`/`after_model`/`before_tool`/`after_tool`;
  native Pi assistant messages with `content` blocks, `stopReason`, `timestamp`, optional
  `usage`, and `requestId`/`turnId`; and native Tool results with a `toolCallId`, `isError`,
  `content` and timing. Assistant **final replies** additionally require an exact
  `submissionId`. These are consumer assumptions, **not** claims about an unpublished
  upstream schema. Before release, compare every field/kind with the real public
  `TrajectoryRecord` and safe projection; update this focused adapter if SP names differ.
  The optional `projection.contentComplete === true` explicitly proves that all Pi
  content blocks were included; without that proof, a positive thinking/text block
  can be counted but the *absence* of other blocks remains unknown, never zero.
  Agree on SP's actual completeness signal or keep this conservative coverage.
  Unpaired `message_start`/`message_update`/`message_end` event-only records are
  diagnosed as unsupported, not discarded as proof of zero model requests; confirm
  SP's public pairing/delivery guarantee before changing that interpretation.
  Do not simulate UA generation inputs or accept old `turn.finished` as native history.
- SP's operation-scoped resource snapshot retains `scope`, `readiness`, `finalized`,
  `usageEvents` and `billingSettlements` and replaces both `telemetryEvents` and its
  coverage field with `nativeRecords:[{ingestSeq,record}]` / `coverage.nativeRecords`.
  Old readiness counters such as `pendingTelemetryEvents` remain SP diagnostics, not
  invented metric values. Eval rejects foreign Chat/Submission records; raw bytes go into
  `eval_attempt_resources` in the same CAS transaction as the summary and a body-free
  Metrics projection. Tokens and charged units still come **only** from usage and
  settlement facts; native Pi usage supports **Step classification** only.
- A page's JSON body is limited to **8 MiB** (by the HTTP client's read bound). SP must
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
   record larger than one importable part. Confirm SP's `record.kind`, safe nested
   event/request/hook/message/result fields, timestamp units and Pi usage shape.
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
