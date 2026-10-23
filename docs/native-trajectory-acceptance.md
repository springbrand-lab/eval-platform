# Native trajectory consumer verification

Status: the nullable-context/primary-reply integration and draft-cache cleanup
have local-only regression evidence.
Exact model-input replay and a compaction prompt renderer are not requirements.
The earlier 727 fixture passes missed the compaction accounting bug and are NOT
acceptance. Upstream release and production-chain acceptance remain blocked.
This is issue 06 handoff evidence, not permission to publish or deploy.

## Implemented paths

- `eval-runtime/harness/native-execution.ts` accepts explicit SP execution
  membership, deduplicates immutable native source identities, requires a safe
  projection, and selects all immutable owned execution entries, independent of
  Pi's compaction window. `openTrajectory().context()` at each native terminal
  seal supplies a separate model-visible reply/branch view.
  Dependencies remain available to the official reader but are not selected as
  current execution work merely because they have `origin: execution`.
- `eval-runtime/harness/trajectory.ts` shares native record descriptions,
  on-demand canonical Pi context/request audit/typed hook inspection, and root-scoped final reply
  selection. Final replies cannot fall back past an interrupted/failed final
  context-bound generation or unsealed later bound preparation, promote
  compaction/unbound inline responses, or use a child/old/fork response.
  Explicitly unbound later calls/preparations do not invalidate the legitimate
  native primary reply. Their canonical context is null, never latest.
  Request details retain model definitions/options, safe steps, end and response,
  but have no replayed `inputs`/`messages`. Input changes stay safe audit records,
  not full before/after input snapshots. Typed output-hook values remain useful.
- Native Metrics projections use version 6, source fingerprints independent of
  receiver sequence, selected-record flags, a scope fingerprint, and explicit
  incomplete interpretation diagnostics. Raw snapshots are interpreted before
  synchronous aggregation. Only current native v6 is supported; unsupported
  native projection versions fail explicitly, without fallback or migration.
  Native v4/v5 were unreleased drafts, not historical user records.
  Cache reads validate source identity/fingerprint and selected membership.
  Historical metric versions 1–3 and unformatted persisted historical resources
  retain their read-only reader.
- Generation invocations, native task identities, deferred polls, retries and
  compaction are separate observations. The existing model-request count includes
  dispatched generation requests and deferred polls; generation/compaction
  invocations exclude polls. Polls do not add thinking/content steps.
  Exceptional native `request_end.response` usage remains usable.
  Unbound auxiliary hook/custom task calls remain real independent invocations
  with measured usage, regardless of canonical visibility or reply eligibility.
  Interrupted or missing-response usage is unknown, not free. Only formal
  billing settlements contribute charged credits.
- The API preserves SP native readiness trees and raw safe records. New output
  references require native format, explicit execution scope and fixed cursor.
  Resource reads compare the requested Chat, operation key and known Submission.
  Finalized resources require native and business delivery for every required
  execution. Missing source/seal/dependencies cannot prove a zero charge.
  Evidence pagination pins SP's public `scope` and `cursor.throughSeq`; export
  progress and native manifests keep both unchanged across resume.
- Web live/history loading still retains its loaded interval, refresh gap
  filling, older-page pagination, identity/cursor contradiction checks and
  concurrent refresh/history merge. New GETs require native format and safe
  records. Expanded native requests use the SDK reader, not a second context
  reconstruction. Partial loaded dependencies remain an explicit inspection
  gap with retry, not a fallback transcript. Cross-page actor policy changes
  are rejected. Unknown metric/outcome zeros render as “未获得”.

Artifacts remain primary evidence. No UI theme/layout redesign is included.
Role labels remain “执行 Agent” and “评估 Agent”.

## Public interface dependencies

Production code imports only public `@springbrand/eval-harness` exports.
The SP source currently exports the native SDK trajectory seam,
`EvalTrajectoryScope`, `EvalTrajectoryCursor`, safe evidence page validation,
`TrajectoryDeliveryState`, `RuntimeBusinessDeliveryState`, and delivery
predicates. The readiness decoder is shared in EP Harness and constrained by
these public SP types; it does not derive a second readiness fact from events.
No SP private module or Durable Object storage is used.

Installed `@springbrand/eval-harness@0.1.0-alpha.5` lacks the native exports.
The installed UA release also does not establish the new public export chain.
No package was published, installed from the network, or manually fabricated
in the lockfile/node_modules. Existing dependency drafts have not been rolled
back.

The actual public wire was read in SP's `packages/eval-harness/src/index.ts`:
`scope` is `{resource: {agentId, sessionId}, submissionId}`, and the fixed
cursor is `{throughSeq}`. The SDK's `context()` is canonical Pi conversation
context-at. `request()` retains `record`, `data`, nullable canonical `context`, safe
`steps`, `end` and `response`, without replayed `messages`; there is no public
full-input `input()` reader or compaction renderer. EP uses `hook()` for typed
output changes and shows other safe change records as audit facts.
Generation request/preparation `cutoff: EntryId | null` is required; null is
explicitly unbound and preparation detail also returns `canonicalContext: null`.
Compaction stays anchored. Ownership binds through the actual Registry
TaskRuntime/HookApi, not caller cancellation signals. EP consumes their native
identity through public Harness/SDK records, not a competing capture layer.
EP did not invent missing wire fields or edit UA/SP issue records.

## Actual verification (2026-10-22 takeover)

All commands used the existing Node executables directly, never pnpm installation.
Except the installed-package RED below, tests used temporary aliases to the
dedicated SP/UA worktrees. The SDK's actual `openTrajectory`/Pi reader ran;
network edges and records are deterministic fixtures, not real LLM/Action calls.
Expected scope, values and historical hashes are asserted independently.

Run each command in the indicated workspace:

| Workspace and command | Result |
| --- | --- |
| runtime: `node node_modules/vitest/vitest.mjs run src/harness/trajectory.test.ts` | Installed-package RED: suite cannot load because `evalTrajectoryScopeSchema` is absent; no native release acceptance |
| runtime: `node node_modules/vitest/vitest.mjs run --config ../../apps/eval-api/.trajectory-verify.config.ts src/harness src/runtime` | 407 passed / 11 files |
| metrics: `node node_modules/vitest/vitest.mjs run --config ../../apps/eval-api/.trajectory-verify.config.ts src/aggregation src/reporting` | 199 passed / 8 files |
| API, with `DATABASE_URL=''`: `node node_modules/vitest/vitest.mjs run --config .trajectory-verify.config.ts src/sp/harness.test.ts src/sp/evidence.test.ts src/sp/observation.test.ts src/db/attempt-resources.postgres.test.ts` | 83 passed, 10 PostgreSQL tests skipped / 4 files |
| Web: `node node_modules/vitest/vitest.mjs run --config .trajectory-verify.config.ts src/api-sdk/observations-api.test.ts src/features/observation/trajectory-tab.test.tsx src/features/observation/use-trajectory.test.ts src/features/metrics` | 38 passed / 7 files (jsdom, not a live browser turn) |
| runtime / metrics / API / Web: `node node_modules/typescript/bin/tsc --noEmit -p .trajectory-verify.tsconfig.json --pretty false` | All exit 1 with `skipLibCheck: false`; respectively 100 / 100 / 181 / 101 external diagnostics, no EP source/test diagnostics after fixing one EP `unknown` cast |
| repo: `git diff --check` | Passed |

Typecheck blockers include source-chain UA profile/conversation/submission
errors, Agents/AI declarations, SP saxes declarations, and API optional Drizzle
drivers/declarations. None were suppressed, patched in node_modules or treated
as a green typecheck.

The new tests were first observed RED for missing declaration/finalization
checks, absent source falsely proving zero credits, deferred-poll invocation
overcount, stale final-reply fallback, missing operation-key correlation,
cross-page policy drift and unknown outcome zeros. Focused runs above are GREEN
after the fixes. They also cover reused child executions, actor/session ID
collisions, old branches/dependencies, unsafe input, interrupted usage, cache
scope/version/identity pollution, out-of-order pages and concurrent live/history
merges. New native reads never fall back to the historical decoder.

`historical-evidence.test.ts` opens a literal pre-existing-style formatted
manifest and JSONL without calling the exporter. It fixes manifest SHA-256
`6976f3a0946b04c065a61eb57d1f92ab950e59c74a22705b9856e7a9f7db63dd`
and JSONL SHA-256
`6e4c2b37a3e0c5c7d9755dfe4c775e275fbdcd3390e1cfc779a251ea59c160c0`.
Historical resource bytes also have a fixed hash; metric versions 1–3 are read
without changing their bytes or object identity.

Logs are `/tmp/ep-{runtime,metrics,api,web}-native-final.log` and matching
`-typecheck.log`; RED logs use `/tmp/ep-*-red.log`. Temporary absolute-path
verification configs/aliases and inherited logs were archived under
`/tmp/ep-native-local-verification` and removed from this repo after the runs.
The inherited browser fixture/profile was removed too. Production code retains
normal package imports; no alias is a release fix.

## Review 67060b73 follow-up (2026-10-22)

### P1: real compaction RED, then GREEN

Read-only source evidence: Pi 1.1 `dist/harness/context.js:64–94` derives only
the newest head-marker window. UA `harness/trajectory-journal.ts:112–156,167–211`
keeps request/end and canonical assistant links outside that window.
UA `trajectory/source.ts:249–256` selects execution work through the seal's
commit sequence and immutable submission attribution, not native-ID mint order.
EP now follows that boundary; it does not implement a context engine/serializer.

Before production edits, `native-pi.test.ts` ran actual public Pi Harness +
MemoryStorage generation, Tool execution and compaction. A real compaction
which removed the old prefix made EP report **complete zero generation/tool
counts** despite two current generation calls and one executed probe; tokens
retained only compaction usage. Another real compaction retained the canonical
final assistant but hid its request metadata: finalReply was `undefined`.
Unsealed-prefix and executed-fork accounting also failed. Those are behavioral
REDs, not missing-export load failures.

`native-execution.ts` now separates all observed owned work from Pi-visible
context. No native-ID/seal-ID ordering or visible-parent-task traversal selects
work. `trajectory.ts` links visible root assistants to full-source requests/ends,
uses official SDK context-at queries for later preparation/dispatch blockers,
and still uses the public SDK request reader. Later failed/interrupted/prepared,
child, fork and compaction reply protections remain.

Seven persistent real-Pi regressions cover counts/usage/provider cost before and
after compaction, actual compaction invocation, old SID isolation, retained
assistant/hidden metadata, live-prefix partial values, actual off-branch work,
later preparation, pre-minted seal ID, and real failure followed by compaction.
Only the public projector creates safe markers. Expected values come from actual
faux Models responses/usage and the executed Tool counter, not EP interpretation.
Two old fixtures incorrectly excluded same-SID fork work; their assertions now
retain that work (including unknown/partial usage for an unanswered dispatch).
Native v5 cache reuse is rejected; v6 changes selection semantics. Historical
v1 bytes/hashes and historical metric versions 1–3 are unchanged.

### P2: public partial snapshot is reachable

This is not based only on nullable TypeScript fields. UA
`adapter/cloudflare/agent.ts:1623–1627,1697–1705` can return an unreadable,
unbound resource after runtime initialization failure, with the requested SID.
SP `chat/severn-agent.ts:541–550,768–820` still obtains the receipt, marks
stateUnreadable and serves the partial resources body; `eval/resources.ts:175–201`
does not require finalized. EP API `harness-wire.ts:184–192` and Runtime
`runtime/resources.ts:95–104` previously rejected it before Metrics, which also
called `nativeExecutionMembers` outside its catch. The shared validator now
preserves that legal non-final state, and compaction returns unavailable root
identity diagnostics without inventing membership. Finalized and contradictory
identities remain rejected. Public Metrics and Runtime regressions passed.

Identity-less intent/unknown required children are produced by UA
`adapter/cloudflare/native-trajectory.ts:189–219`. The SP recursive
`isEvalTrajectoryDelivered` requires every resource/SID, so such a child already
prevents complete coverage even though known membership extraction skips it.
The added test proves known-root values stay partial and charges unavailable;
no guessed child actor/SID or heuristic readiness rule was added.

### Follow-up commands and remaining limits

Same direct Node/Vitest commands as above, using temporary public-source aliases:
runtime `src/harness src/runtime`: **408 passed / 11 files**;
metrics `src/aggregation src/reporting`: **209 passed / 9 files**, including
seven real-Pi regressions; API's same four focused files with `DATABASE_URL=''`:
**83 passed, 10 PostgreSQL skipped**; Web's same seven focused files:
**38 passed** (including live/history merge and metrics rendering). RED logs:
`/tmp/ep-pi-regression-red.log`, `/tmp/ep-pi-readiness-red.log`;
GREEN logs: `/tmp/ep-pi-{runtime,metrics,api,web}-final.log`.
Runtime/metrics strict source-alias typechecks still exit 1 with **100 external
diagnostics each**, no EP source/test diagnostics; no casts or skipLibCheck
were added to hide failures. Logs: `/tmp/ep-pi-{runtime,metrics}-typecheck.log`.

Related real-Pi test devDependencies are declared in eval-metrics; they are not
installed in EP. Lockfile refresh and alias-free package verification remain
coordinator-owned; no network install or fabricated lock entries were used.
This follow-up does not close full package/browser/live/production acceptance.
All six temporary alias/config files were archived outside EP, together with
these logs, under `/tmp/ep-native-local-verification/review-67060b73-yIEI1t`,
then removed from EP. Production imports remain public package imports.
After removal, the alias-free native metrics suite was rerun and failed to load
at `eval-runtime/src/harness/evidence.ts:279`: installed alpha.5 still lacks
`evalTrajectoryScopeSchema` (`undefined.optional`). No tests ran.
Evidence: `/tmp/ep-pi-published-seam.log`. Local GREEN does not close this RED.
`git diff --check` passed after the follow-up edits.

## Scope-reconciled continuation (prior diagnostics, 2026-10-22)

The EP reader no longer calls `reader.input()` or accesses a replayed request
`messages` field. Dedicated trajectory expansion labels `canonicalContext`
truthfully and explains that canonical conversation plus safe changes is not a
complete Models-input snapshot. Raw fields, extensions, model definitions,
effective options and typed output-hook values remain intact. Ordinary Chat
presentation, layout, paging/interval merging and root reply selection were
not redesigned.

The real public Pi Harness/MemoryStorage/faux-Models regression no longer
records a compaction input delta, template, slots or serializer recipe. It
still proves actual pre-compaction calls/Token/provider-USD/Tool counts,
compaction invocation/summary/usage, hidden request metadata with a retained
root final reply, off-branch work, old Submission isolation, later preparation,
failure and a pre-minted seal ID. The first no-recipe runs were genuinely RED
in the then-current upstream reader (`Missing native compaction input delta`);
they became GREEN after the UA owner updated that public source. No EP fallback
or copied compaction serializer was added.

That continuation briefly added draft-native v4/v5 RAW rederivation and an
extra API query/PostgreSQL test. They are **removed** by the cleanup below:
these were unreleased intermediate implementations, not historical user data.
The earlier diagnostic logs are retained as an audit of work, not evidence of
a deployed compatibility requirement. The extra PostgreSQL test was never run.

All commands below used existing direct binaries and temporary public-source
aliases, not released-package acceptance:

| Workspace / command | Actual result |
| --- | --- |
| runtime: `node node_modules/vitest/vitest.mjs run --config ../../apps/eval-api/.trajectory-verify.config.ts src/harness src/runtime` | **411 passed / 11 files** |
| metrics: `node node_modules/vitest/vitest.mjs run --config ../../apps/eval-api/.trajectory-verify.config.ts src/aggregation src/reporting` | **212 passed / 9 files**, including seven real-Pi regressions |
| API with `DATABASE_URL='' EVAL_IMPORT_TEST_DATABASE_URL=''`: `node node_modules/vitest/vitest.mjs run --config .trajectory-verify.config.ts src/sp/harness.test.ts src/sp/evidence.test.ts src/sp/observation.test.ts src/db/attempt-resources.postgres.test.ts` | **83 passed, 11 PostgreSQL skipped / 4 files** |
| Web: `node node_modules/vitest/vitest.mjs run --config .trajectory-verify.config.ts src/api-sdk/observations-api.test.ts src/features/observation/trajectory-tab.test.tsx src/features/observation/use-trajectory.test.ts src/features/metrics` | **39 passed / 7 files**, jsdom only |
| runtime / metrics / API / Web: `node node_modules/typescript/bin/tsc --noEmit -p .trajectory-verify.tsconfig.json --pretty false` | **RED**, `skipLibCheck: false`; respectively **91 / 91 / 172 / 101 external diagnostics**, no EP source/test diagnostics |
| repo: `git diff --check` | Passed |

Strict typecheck blockers remain in external declarations, including
Agents/AI, saxes, HTTP/contracts, optional Drizzle drivers and Web dependencies.
Two newly exposed EP test type errors (the removed `source: compaction` union
member and an excess cache-marker property) were corrected, not cast away.
No declaration checks or upstream failures were suppressed.

Historical fixed manifest/JSONL/resource hashes and historical metric versions
1–3 still pass unchanged. Native cache version remains 6. Fixed throughSeq,
scope/resume checks, live/history interval merging, unknown usage/charges and
root/Submission-only reply protections remain in the focused suites.

Logs, RED evidence and all eight temporary alias/config files are archived at
`/tmp/ep-native-local-verification/scope-reconciled-CddHxt`; those temporary
files were removed from EP. Production imports remain public package imports.
An alias-free rerun remains RED at `eval-runtime/src/harness/evidence.ts:279`:
installed `eval-harness@0.1.0-alpha.5` lacks `evalTrajectoryScopeSchema` and the
suite cannot load. Local source GREEN does not close that published-seam RED.
The alias-free runtime command
`node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json --skipLibCheck false --pretty false`
also exits 1 with 56 diagnostics, including missing public native exports.
Evidence: `published-final.log` and `published-runtime-typecheck.log` in the
same archive directory.

## Nullable binding and draft-cache cleanup (2026-10-22)

Three vertical RED/GREEN slices implement the shared **Ownership Is Not A
Context Requirement** decision at EP's existing public Harness/SDK/Metrics seams:

1. A valid null preparation reproduced `Storage.entry() requires an entry ID`.
   Preparation detail now branches explicitly to `canonicalContext: null`.
   Both preparation-only and invoked records are checked while a later canonical
   user message is visible through the official `context()` reader. Invoked
   preparation/request/end details preserve the SDK's null context, model
   options, outcome and response, without replay or source-byte mutation.
2. Four bounded cases reproduced rejection of a valid primary reply by later
   unbound preparation/inline/error/interrupted calls. A real public Pi custom
   task reproduced the same failure after the primary answer and compaction.
   Candidates and supersession checks now require explicit context binding;
   primary visibility still comes from Pi's canonical seal context, not native
   ID/arrival chronology. A later bound failed generation still blocks fallback,
   even with an unbound tail. No unbound inline response is promoted.
   Ten real Pi Harness/MemoryStorage/faux regressions now include actual
   `HookApi.models` calls in `afterResponse`/`afterTools` and a custom
   `TaskRuntime.models` call, without caller cancellation signals. Test-side
   bookkeeping uses public SDK writers with those actual API identities; this
   does not claim acceptance of UA's private capture/source integration.
   Actual faux call counters, outcomes, Token totals and executed Tool counters
   are independent expectations. The faux provider reports zero USD despite
   priced model definitions; EP must not estimate a price from those definitions.
   A separate bounded native inline-response case proves positive measured USD
   propagation, and missing/interrupted unbound usage stays unavailable.
   No metric definition or Web production/layout code changed.
3. Removed the unreleased v4/v5 compatibility branch and RAW callback, restored
   the existing single projection query in `metricSnapshots`, and removed the
   continuation's unrun PostgreSQL fallback test. Baseline evidence is local:
   EP HEAD `3c720b33ee07fb848484428313944756162843b1` has historical event
   projection version 3; installed Harness is `0.1.0-alpha.5` without native
   exports. No native SDK/Harness release or authorized native deployment/shared
   DB writes had occurred, as confirmed by the user. No contrary authoritative
   deployment evidence surfaced, and no DB/credentials/network investigation
   was performed. Current native stays v6. Unsupported versions 1/2/3/4/5/7/99
   fail explicitly at snapshot and per-record cache boundaries, including the
   public Metrics query path; there is no reinterpretation, fallback or writeback.
   Current source derivation and v6 scope/fingerprint/membership validation remain.
   Actual historical `sp-trajectory/v1` metric v1–v3 and fixed historical hashes
   remain byte-preserving and read-only.

Final source-alias commands used existing direct binaries in the listed workspace:

| Workspace / command | Actual result |
| --- | --- |
| runtime: `node node_modules/vitest/vitest.mjs run --config ../../apps/eval-api/.trajectory-verify.config.ts src/harness src/runtime` | **419 passed / 11 files** |
| metrics: `node node_modules/vitest/vitest.mjs run --config ../../apps/eval-api/.trajectory-verify.config.ts src/aggregation src/reporting` | **222 passed / 9 files**, including ten real-Pi regressions |
| API: `DATABASE_URL='' EVAL_IMPORT_TEST_DATABASE_URL='' node node_modules/vitest/vitest.mjs run --config .trajectory-verify.config.ts src/sp/harness.test.ts src/sp/evidence.test.ts src/sp/observation.test.ts src/db/attempt-resources.postgres.test.ts` | **83 passed, 10 PostgreSQL skipped / 4 files** |
| Web: `node node_modules/vitest/vitest.mjs run --config .trajectory-verify.config.ts src/api-sdk/observations-api.test.ts src/features/observation/trajectory-tab.test.tsx src/features/observation/use-trajectory.test.ts src/features/metrics` | **39 passed / 7 files**, jsdom only |
| runtime / metrics / API / Web: `node node_modules/typescript/bin/tsc --noEmit -p .trajectory-verify.tsconfig.json --pretty false` | **RED**, `skipLibCheck: false`; respectively **91 / 91 / 172 / 101 external diagnostics**, no EP source/test diagnostics |

The first strict runtime check exposed two existing bound-fixture assumptions
about non-null `request.context`; an explicit bound-context guard corrected
them. No casts or declaration-check suppression concealed this change.
External declaration failures remain blockers, not GREEN typechecks.
RED/GREEN logs, baseline copies and the eight diagnostic config/alias files
are archived outside EP at
`/tmp/ep-native-local-verification/context-binding-VahjlU`.
All eight temporary configs/aliases have been removed from EP. After removal,
the installed-package commands were rerun in `packages/eval-runtime`:

| Alias-free command | Actual result |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run src/harness/trajectory.test.ts` | **RED**, suite fails before any tests at `src/harness/evidence.ts:279`: installed alpha.5 lacks `evalTrajectoryScopeSchema` (`undefined.optional`) |
| `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json --skipLibCheck false --pretty false` | **RED**, exit 1 with **56 diagnostics**, including missing native public exports |
| repository: `git diff --check` | Passed |

`published-final.log`, `published-runtime-typecheck.log`,
`cleanup-baseline-evidence.log`, `strict-diagnostic-summary.txt` and the scoped
`delta-from-start.patch` are in the same archive. Source-alias GREEN is not
released-package, PostgreSQL, live browser or full production acceptance.
The normal `pnpm check` and full PostgreSQL-backed recursive repository test
gate were not run; released exports/declarations and an approved disposable
database remain prerequisites.

## Coordinator-owned remaining acceptance

- Authorize and verify the upstream SDK/runtime/harness export chain through
  independent public tarballs, then exact released dependencies. Installed
  alpha.5 cannot run this EP cutover.
- The declared real-Pi test devDependencies/lockfile are now aligned offline.
  Installing the authorized exact released SDK/Harness chain and validating it
  remain separate gates. Do not add a draft-native cache migration/fallback or
  rewrite archives.
- Resolve external/source-chain typecheck blockers and run normal package/full
  repository gates without aliases or suppressed declaration checks.
- Run authorized disposable PostgreSQL integration (10 focused tests were skipped),
  full browser/live turn, approval/subagent and eval acceptance.
- Synchronize UA issue 05 Interface and issue 06 from this handoff evidence;
  those files were intentionally not edited by the EP writer.

No live LLM/SP turn, real deployment, paid Action, credentials, PostgreSQL
integration, tarball/released-package acceptance, full repository gate,
commit, push, publish or deploy has been performed. The original EP worktree
and SP development worktree have not been modified.

## Coordinated consumer review closure

`approval_decision` now follows the actual public SDK schema through native
history pages, evidence JSONL and hashes. Runtime inspection returns its
unchanged audit data before Models request lookup: a Host request ID is not a
Models invocation identity, even if their strings happen to match. Approval
records do not replace the final reply or add model/tool calls, Token usage or
charged credits. Metrics interpretation, projection version and historical
archive/hash fixtures did not change.

Local public-source verification (temporary aliases only):

- Runtime native page/detail/evidence, immutable historical evidence and
  resource suites: **93 tests passed**.
- All aggregation/reporting suites, including actual Pi/faux Models, compaction
  and unchanged historical/hash tests: **225 tests passed**.
- Two approval inspection cases were RED for wrong category and, separately,
  for incorrectly returning Models request details on a matching request ID;
  the same cases are GREEN after the bounded audit handler.
- Normal source-linked TypeScript passes for Runtime and Metrics. Strict
  `--skipLibCheck false` reports **91 declaration diagnostics** in the shared
  external Agents/AI/provider-utils/saxes/MCP chain, with no EP source diagnostics.
  Existing normal compiler settings were not weakened.

The four already-declared Metrics test devDependencies are now represented in
the lock importer. The exact cached pnpm 11.6.0 generated the lock in a copied,
manifest-only workspace using `--offline --lockfile-only --ignore-scripts`;
isolated frozen-lock validation passed without creating node_modules. Existing
importers/resolutions/snapshots and release policies stayed unchanged; 77 new
cached resolutions/snapshots are the newly required Pi dependency closure.
No integrity/resolution fields were handwritten.

Alias-free native Runtime tests still fail before test collection because the
installed alpha.5 Harness lacks the native public scope schema. Exact published
acceptance, strict declarations, full repository gates, PostgreSQL and real
browser/approval/subagent turns remain open. No UA source/issue file, SP private
implementation, ordinary Chat UI or Pi package was edited by this consumer work.
See `.scratch/pi-native-trajectory/review-consumer-handoff.md` for exact commands,
paths, results and limits; all new logs/configs are under
`/tmp/pi-native-consumer-review.u5QlPR`.
