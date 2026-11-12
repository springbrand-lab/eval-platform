# Runtime alpha.32: root-cause investigation and proposed remediation

**Status: SP/EP-owned source remediation implemented; publication, public-owner
and environment acceptance gates remain.**
Research and parent source/probe verification: 2026-11-11. The user subsequently
authorized the target-owned changes and explicitly left UA/upstream gaps open.
Implementation and current verification results belong to
`agent-runtime-alpha32-integration-status-2026-11-11.md`.
Findings and line references below describe the investigation checkpoint.

## Implementation Outcome

The current delivery/proof matrix is
`agent-runtime-alpha32-integration-status-2026-11-11.md`; the investigation and
three original failing probes below are historical evidence, not current defects.

- Card/full-policy publication is atomic; policies are version/meter-addressed.
  Refresh uses bounded source cutoffs/fingerprints, complete-snapshot CAS,
  three retries and one bulk write. Newer/equal-cutoff work lost to an older
  concurrent commit was additionally reproduced and fixed.
- Canonical Account/Turn projections, fresh request reads and independent
  Account/Run frontiers replace scalar/stale facts. Guard acts on coherent own
  receipts, never a reconstructed current Account/old Turn combination.
- The real producer-to-page-to-Harness path reuses canonical settlement facts.
  Public page grammar is consumed once; retired combined routes/aggregators and
  copied generic schemas are removed. EP's persisted aggregate is preserved.
- Ordinary Chat Session connection CAS and invocation rechecks are implemented
  through the public SDK. Temporary-first unbound coordination still lacks a
  public native invocation/input authority; no target-local substitute is added.
- The migration-added Pi conversion hunk and execute error-string classifier/
  event are removed. Existing safety patches remain explicit owner debt.
- The user's latest explicit decision makes all eleven model presets Free for
  admission. This supersedes the interim conservative Pro-policy restoration.
  It changes no Credit prices, reservation/settlement behavior or Guard.
- Local strict release/Node/browser proofs and serial source tests are recorded
  in the status document. No package was published, no migration applied and no
  live operation accepted. Migration 0044 requires an approved coordinated fleet
  cutover and retains PostgreSQL specifications rather than claiming them passed.

## Scope, authority and evidence notation

- `SP` = `/Users/apple/code/.worktrees/sp-eval-20261110`.
- `EP` = `/Users/apple/code/.worktrees/ep-main-20261110`.
- Read-only Git observations: SP HEAD = `3696f184ac10a4916ce96c6caef5609ac82da697`;
  EP HEAD = `e0b7e0417be3761f015a6bc815058eb1afb043bf`. Migration changes are working-tree
  changes, including untracked files, not commits after those baselines.
- `R` = `SP/apps/agent/node_modules/@springbrand/agent-runtime` (installed alpha.32).
- `P` = `SP/apps/agent/node_modules/@earendil-works/pi-ai` (patched 1.4.0).
- `A` = `SP/apps/agent/node_modules/agents` (patched 0.30.0).
- `U` = `EP/node_modules/.pnpm/node_modules/@earendil-works/pi-ai` (unpatched 1.4.0).
- `A1` = `EP/node_modules/.pnpm/node_modules/agents` (unpatched 0.30.1).
- `PI_PATCH` = `SP/patches/@earendil-works__pi-ai@1.4.0.patch`;
  `SDK_PATCH` = `SP/patches/agents.patch`;
  `EDITOR_PATCH` = `EP/patches/@springbrand__agent-config-editor@0.1.0-alpha.4.patch`.
- These aliases expand to actual local paths; `path:line-range` cites current source
  unless explicitly marked `@baseline`. Installed sources prove local artifact behavior,
  not registry integrity or deployed parity. Package identities: `R/package.json:2-3,32-52`,
  `P/package.json:2-7`, `A/package.json:15-20`, `U/package.json:2-7`, `A1/package.json:15-20`.
Evidence ranking: **observed** = manifests, lock resolution, patch hunks and source;
**inference** = static consequences of that call chain; **unknown** = not verified.
Existing tests are specifications here, not passing-test evidence: no test suite
was rerun. The parent subsequently ran three bounded, offline diagnostics against
real modules, described in section 10. Those are not live PostgreSQL or Worker proof.
### Required invariants and limits

- User mandate: retain exact `@springbrand/agent-runtime@0.3.1-alpha.32`; support new
  Chats/Runs only; raw Pi is the sole trajectory/evidence truth, not a SAFE/raw switch.
  Artifacts remain primary evaluation evidence and the complete raw trajectory supporting
  evidence (`EP/AGENTS.md:9-14`; `EP/docs/package-boundaries.md:416-426`).
- Preserve Eval-specific Dataset/Execution/Evaluation orchestration, evidence collection,
  ownership and public SP boundaries (`EP/AGENTS.md:7-20`;
  `EP/docs/package-boundaries.md:143-171`). Do not replace them with Runtime internals.
- Preserve OOM safeguards; do not delete patches merely to obtain a patch-free manifest.
- The initial investigation authorized only this research file and bounded offline
  probes. The subsequent implementation authorization permits SP/EP source and local
  checks, not UA source, package publication, live database mutation or deployment.
- Do not compensate for missing UA/native failure facts, model serializers or Space
  behavior in either target. Remove the migration-added Pi conversion hunk and the
  custom execute failure parser/observer; retain inherited OOM safeguards until their
  owner supplies a verified replacement.
- No dependency edits, private Runtime clones, missing-interface casts, fake evidence,
  monkeypatches, silent upgrades, compatibility decoders or disguising transitive overrides
  are proposed. Package-boundary rule: `EP/.agents/rules/cc-web-lander-boundary.md:18-33`.

## 1. Literal dependency patch inventory

**Observed at the investigation checkpoint:** these were real applied dependency
modifications, not merely unused patch files. The migration-added Responses hunk
was subsequently removed under the SP/EP-only authorization; no replacement
serializer or new dependency patch is permitted.
SP declares both patches at `SP/pnpm-workspace.yaml:119-121`; lock hashes and importer
identities appear at `SP/pnpm-lock.yaml:80-82,112-129`. Runtime itself resolves patched Pi
and patched Agents at `SP/pnpm-lock.yaml:12546-12559`.

| Patch | Baseline versus migration WIP | Classification |
| --- | --- | --- |
| Pi AI 1.4.0 | Existing baseline patch; WIP adds exactly 21 patch-file lines at `PI_PATCH:79-99`, covering one Responses converter hunk. Baseline file has 245 lines; current file 266. | New serialization debt added to preserved native-shape/validation debt. |
| Agents 0.30.0 | Entire 668-line `SDK_PATCH` is byte-unchanged against SP baseline. Hash `e38f0320…` is unchanged (`SP@baseline:pnpm-lock.yaml:82`; current `:82`). | Preserved upstream SDK debt, including essential OOM protection, not introduced by this migration. |
| Editor alpha.4 | `EDITOR_PATCH` and EP workspace/lock are unchanged against EP baseline. Declaration `EP/pnpm-workspace.yaml:25-26`; hash `d9ef1f46…` at `EP/pnpm-lock.yaml:7-8`. | Preserved UI package debt, outside the current Agent-runtime implementation scope. |

Reproducible read-only comparison: `git diff <baseline> -- patches/ pnpm-workspace.yaml`
in each worktree; SP `--numstat` reports only `21 0` for the Pi patch. Pi lock hash changes
from `a3b2117c…` to `1a3e0f50…` (`SP@baseline:pnpm-lock.yaml:81`; current `:81`).
SP's Pi/telemetry and Agents overrides also predate WIP (`SP/pnpm-workspace.yaml:5-7,71`;
the workspace file has no baseline diff). They are not proof of a new override workaround.
## 2. Pi AI: owner, supplied behavior and fixed-.32 blocker

### Newly added Responses hunk

**Observed behavior:** `PI_PATCH:87-96` serializes native URL `file` blocks as
`input_image.image_url` for images, otherwise `input_file.file_url` with optional filename.
The owner is Pi's provider serializer, not the SP Host model catalog.
The patch targets `dist/api/openai-responses-shared.js`, not an application file.

**Static regression if simply removed:** original Pi maps every non-text user block to
`data:${item.mimeType};base64,${item.data}` (`U/dist/api/openai-responses-shared.js:198-218`).
A URL `file` has `url`, not `data`; that branch therefore cannot preserve its URL and
produces an invalid attachment representation. This is a source-level deduction,
not a reproduced production request. Intended URL image/PDF behavior is specified in
`SP/apps/agent/src/runtime/host/model-provider.native.worker.test.ts:44-59,79-88`.

### Preserved baseline Pi hunks

| Hunk and exact owner | Behavior supplied; removal risk |
| --- | --- |
| Pi Anthropic stream/parser and replay, `PI_PATCH:1-78` | Retains `server_tool_use` / `tool_search_tool_result` as `providerNative`, accumulates their input and replays native blocks; supports URL images/documents. Removing it loses these additions, not just an SP routing preference. |
| Pi public types, `PI_PATCH:100-164` | Adds Anthropic routing typing, `FileContent`, `ProviderNativeContent`, message-union membership and `Tool.deferLoading`. These are package-contract extensions, not legitimate app DTO definitions. |
| Pi token estimator, `PI_PATCH:165-182` | Handles additional assistant blocks without assuming `block.name`; original estimator otherwise reads `block.name.length` (`U/dist/utils/estimate.js:40-49`). Removing only this hunk while retaining native blocks risks a runtime exception. |
| Pi argument validation/coercion, `PI_PATCH:183-266` | Parses JSON-encoded composite values, omits empty optional non-string values and applies schema coercion before TypeBox conversion. Removal changes accepted arguments; original `validateToolArguments` does not apply this pre-conversion pass (`U/dist/utils/validation.js:280-301`). Exact affected production calls remain unverified. |

The type discrepancy is independently observable in unpatched Pi: user/assistant unions
exclude those native additions (`U/dist/types.d.ts:266-284,363-370`), and `Tool` lacks
`deferLoading` (`U/dist/types.d.ts:528-533`). It is not inferred from SP's patched install.

**Observed fixed-version coupling:** alpha.32 declares exact Pi AI 1.4.0
(`R/package.json:32-40`), imports `FileContent` and `ProviderNativeContent` and validates
them as native shapes (`R/src/conversation/canonical-context.ts:5-9,28-37,65-88`).
Its OpenRouter adapters read `deferLoading` and Anthropic routing
(`R/src/models/openrouter/messages.ts:34-45,64-65`;
`R/src/models/openrouter/openai.ts:65-71`). Thus this is not solely an app relying on
extra declarations: the fixed Runtime source itself expects a patched transitive shape.

### Is an existing public no-patch interface enough?

**Observed:** alpha.32 already owns model registration/routing through public
`createPiModels` / `resolvePiModel` (`R/src/index.ts:172-176`;
`R/src/models/index.ts:996-1054`). Its capability gate preserves supported URL `file`
blocks; it does not serialize them (`R/src/conversation/message/model-input.ts:34-53`;
`R/src/models/index.ts:729-767`). Its Responses adapter delegates to Pi
(`R/src/models/openrouter/openai.ts:13-15,173-195`).

The Runtime's PDF payload repair handles data-URL PDFs, not native URL-file conversion
(`R/src/models/index.ts:261-305`). Its `protocolResponse` capture is Responses-only, so
it does not replace the Anthropic native-block patch
(`R/src/models/openrouter/protocol-response.ts:29-40,62-71`).
Pi exposes `onPayload` (`U/dist/types.d.ts:65-69`), but rebuilding provider conversion
there, in a Host subclass or in a copied stream loop would relocate the same fork.

**Conclusion/inference:** no supported same-behavior, no-patch route was established for
this fixed alpha.32 + original Pi 1.4.0 combination. The native type dependency is an
additional blocker even if a particular request avoids URL attachments. A newer Pi
override or silently changed Runtime version is not a root fix under the user's mandate.
Escalate the incompatibility to the Runtime/Pi owners; require a documented, validated
public route compatible with the exact allowed artifact graph. If none exists, report
the acceptance gate blocked. Do not pretend that a future upstream release already
solves the immutable fixed-version graph, or overwrite an existing published version.
**Pi safe-exit proposal:** require native type/schema, serializer, estimator and validator parity through the permitted public graph,
including URL image/PDF requests and Anthropic server-tool continuations. Retire the patch and lock identity only after that evidence exists.

## 3. Agents SDK: preserve safety, retire only with equivalent owner behavior

The package owner is Cloudflare Agents (`A/package.json:15-20`). The patch covers more
than OOM: React/hydration and immutable stream parts (`SDK_PATCH:1-42,280-319`),
connection ownership/replacement and draining (`:324-480,601-630`), Agent Tool start/
recovery failure handling (`:481-599`) and first-frame resume ordering (`:632-668`).
Those mechanisms belong in the SDK, not application copies. Removing the whole patch
would also remove these behaviors; production impact per non-OOM hunk remains unverified.

OOM-specific additions durably pre-arm a strike before risky alarm work, restore it on
non-OOM errors and finish an unlanded seal on the next wake (`SDK_PATCH:99-221`).
They record the executing job and guard deletion by matching `id + execution_started_at`
(`:51-65,225-254`), preserve unrelated/newer jobs and independently attempt reset even
when storage sync fails (`:178-215,258-278`). This is not merely a larger retry count.

SP's seven-strike policy is a legitimate Host setting
(`SP/apps/agent/src/chat/severn-agent.ts:207-208,286-290`).
The SDK already has public strike-limit configuration and a post-strike policy hook
(`A/dist/durable-object-lifecycle-DOI_bzCH.d.ts:17-23`;
`A/dist/agent-routing-CDbpVjYq.d.ts:5502-5520`), but those do not supply the patch's
pre-reset persistence and guarded queue handling. Runtime alpha.32 already owns sealed
Submission failure/abort (`R/src/adapter/cloudflare/agent.ts:635-678`); do not clone it.
Existing OOM regression specifications cover post-reset write rejection, bystanders,
stale execution identity and once-only seals
(`SP/apps/agent/src/alarm-memory-limit-breaker.worker.test.ts:83-185`); not executed here.

**Known/unknown:** inspected SP installs contain patched 0.30.0, not a pristine original.
Unpatched 0.30.0 equivalence and later upstream fixes are therefore unverified.
The available unpatched 0.30.1 is not an established exit candidate: it counts strikes
after reset and puts `storage.sync()` and `reset()` in one try block
(`A1/dist/lifecycle-v1rKHV2C.js:709-758`). Do not infer upstream absorption from SP's
already-patched artifact or from a newer version number.

**Safe exit proposal:** retain safeguards until an owner-supplied public SDK artifact
has hunk-by-hunk parity evidence, passes the preserved OOM specifications, preserves
Runtime terminalization and fits alpha.32's peer range (`R/package.json:50-52`).
Never substitute a Host alarm loop, private SQL job manipulation or subclass monkeypatch.
Separately flag preserved type debt: the Host spreads Runtime statics through
`as unknown as typeof Agent` (`SP/apps/agent/src/chat/severn-agent.ts:287-290`;
baseline `:267-270`); alpha.32's public class type exposes only construction
(`R/src/adapter/cloudflare/define-agent.ts:368-379`). A cast-free public options path
must preserve inherited defaults and seven-strike policy; do not erase safety to hide it.

## 4. EP editor patch and public package cutover

The editor patch is primarily UI, but not exclusively translations: it introduces a
supplementary-content prop, removes the prompt modal, changes empty sections and embeds
localized deletion feedback (`EDITOR_PATCH:84-96,127-162,205-208,294-310`).
Its owner is the shared editor (`SP/packages/agent-config-editor/README.md:3-18`).
Blind removal would revert those behaviors. It is not new Runtime migration debt.
Do not assume an Editor alpha.5 candidate absorbs it: workspace prompt UI still contains
English/modal behavior (`SP/packages/agent-config-editor/src/agent-editor.tsx:152-154,274`).
UI parity and any patch retirement require a separately scoped owner review/publication.

A separate observed release blocker is EP's installed Harness alpha.9, which declares
Runtime alpha.15 (`EP/apps/eval-api/package.json:25`;
`EP/apps/eval-api/node_modules/@springbrand/eval-harness/package.json:2-3,17-22`).
SP's WIP Harness alpha.10 declares alpha.32 and imports its public trajectory schema
(`SP/packages/eval-harness/package.json:2-4,16-19`;
`SP/packages/eval-harness/src/index.ts:1-2,438-445`).
Publication/consumer upgrade belongs to the user; this research proves neither published
availability nor acceptance of the new wire by the installed old consumer.

## 5. Provider adapter versus a hidden package fork

The inspected SP Provider module is legitimate host wiring, not a replacement serializer:
it supplies credentials, gateway URL, headers, model catalog metadata/modalities and
routing pins through `RuntimeProviderPort`
(`SP/apps/agent/src/runtime/host/model-provider.ts:1-6,29-90`;
`R/src/config/ports.ts:1057-1088`). This module has no baseline diff.
The title consumer uses the public factories, not a local Provider loop
(`SP/apps/agent/src/runtime/host/sessions/title-generator.ts:1-6,30-44`).
This narrow result does **not** certify every other WIP Host module as free of substitutes.

## 6. Prior corrections: retain owner-level fixes, remove remaining drift

Small changes are not automatically workarounds. The deletion test is whether they
restore the owning module's invariant, or introduce another truth/implementation.

| Correction | Verified classification and remaining work |
| --- | --- |
| Admission accepted DTO | Correct invariant repair. Credit Core returns the actual Account hold; the callback constructs and atomically persists the accepted receipt. Keep strict validation and immutable replay. Do not calculate `oldReserved + precharge` at the caller. `SP/apps/api/src/models/billing/turn-reservation.ts:61-87`; `models/credit-account/index.ts:418-459`. |
| Platform Skills | Correct ownership repair. Component owns the scoped binding join and validated manifest projection; platform-skill owns scope orchestration, not a second Component catalog. Keep the one query. `SP/apps/api/src/models/component/skill-store.ts:40-55`; `models/platform-skill/index.ts:6-14`. |
| Cutoff equality and EOF | Correct behavior repair, but repeated interpretation remains. The baseline public Harness already allowed equality; EP's independent `>=` checks drifted. Consolidate page grammar as specified below rather than leaving each caller to remember the comparison. `SP/packages/eval-harness/src/index.ts:585-619`; `EP/apps/eval-api/src/eval-management/trajectory.ts:35-55`; `sp/harness.ts:392-412,740-790`. |
| Raw/compact descriptions | Correct model-facing contract repair, not a new execution mechanism. Keep raw evidence separate from Metrics-owned body-free derivation. `EP/apps/eval-api/src/eval-management/mcp.ts:42-43`; `packages/eval-metrics/src/aggregation/compact-resources.ts:21-83`. |

The admission and binding files are new WIP, so Git baseline comparison cannot
reconstruct earlier intermediate buggy WIP. Existing HTTP/transport tests establish
their assertions, not PostgreSQL concurrency or a fresh published-package acceptance.

## 7. Target-owned root remediation

### 7.1 One Billing module owns Card and policy consistency

**Observed root:** policy identity is only `meter_id`; calculation precedes the lock
and publication is an unconditional per-meter write. Card publication separately
inserts a Card, while admission requires a matching policy. An hourly refresh is
therefore a hidden readiness dependency, not just maintenance.

Sources: `SP/apps/api/src/models/billing/schema.ts:151-160`;
`turn-policy-refresh.ts:10-44`; `index.ts:394-430`;
`turn-reservation.ts:49-54`; `SP/apps/api/src/node/turn-billing-jobs.ts:28-37`.

Recommended interface and implementation:

1. Keep the existing Billing module and its exported publication, refresh and
   admission interfaces. Add no PolicyService, repository or DO ledger.
2. Make policies version-addressable in the existing table:
   `(rate_version, meter_id)`, associated with the immutable Card. A future-effective
   Card must be stageable without overwriting the active Card's policies.
3. Publish the submitted Card and its complete initial policy set in one atomic
   transaction. Recheck publication/replay/monotonicity under the aggregate lock.
   Identical publication replay must not replace later refreshed policies.
   Preserve the explicit, provenance-labelled cold-start algorithm in
   `turn-policy.ts:52-78`; its predictions are not actual charges or fabricated usage.
4. Calculate bounded samples outside long-held locks, using explicit lower/upper
   source cutoffs and deterministic tie-breaking. Under the lock, recheck Card,
   source and stored snapshot identity; retry/recompute with a fixed limit when
   facts changed. Wall-clock `computedAtMs` alone is not a total order.
5. Commit a complete policy set with one parameterized multi-row operation and
   a snapshot-wide freshness condition, not independent per-meter decisions.
   A losing candidate returns committed state or a retryable conflict, never
   claims its proposed values were committed. No mixed-generation meter set.
6. Require the admission's pinned `rateVersion` in policy reads; remove meter-only
   reader signatures and aliases. Missing policy remains unavailable, not an old
   Card fallback. Queue and internal HTTP refresh enter the same module.

Why a one-row monotonic CAS is insufficient: it can prevent reverse overwrites,
but cannot hold active and scheduled Card policies simultaneously. Why merely moving
the lock is insufficient: it does not make Card-only publication ready for admission.

Ship the schema migration with complete active/scheduled snapshots before cutover.
Do not rewrite possibly applied migrations, run live migrations, or remove old keys
without a separately approved operator procedure. No historical result rewrite.

### 7.2 One balance snapshot, explicit projections, truthful freshness

Credit Core already owns balances. Reservation moves available to reserved;
debit spends allocations; release returns eligible unused allocations.
`SP/apps/api/src/models/credit-account/index.ts:402-479,632-705,2270-2331`.

- Total settled balance: `availableUnits + reservedUnits`, including all Account holds.
- Enforced Turn remaining: `availableUnits + turnReservedUnits`, using that settlement's
  remaining hold, not initial precharge and not another Turn's hold.
- Both calculations consume one coherent versioned snapshot, with safe-integer
  checks. Unknown facts are not zero. Do not change Web's intentionally unreserved
  Account field to mean total.

The current reminder discards reserved, and its durable cache drops `asOfMs`.
Admission/terminal refresh plus monotonic versions does not establish request-time
freshness after another Chat, Action, grant or expiry changes the Account.
Sources: `SP/apps/agent/src/runtime/host/runtime-host.ts:190-202,624`;
`run-billing-context.ts:165-176,225-253`; `low-credit-reminder.ts:7-14`;
`SP/apps/api/src/models/billing/turn-reservation.ts:298-308`.

Use existing `@springbrand/contracts/billing` snapshot schemas and checked immutable
projections, not persisted total/remaining fields or another balance module.
Replace `settledAvailableCredits()` and its scalar callback; retain no alias.
Read fresh facts through the existing authenticated Account reader at real request
preparation, including resumed execution, honoring Runtime's deadline/cancellation.
Unavailable fresh facts suppress optional advice; malformed facts remain errors.
Never silently reuse stale facts as current or let advice failure disable Guard.

Separate the Account-cache version frontier from each Run's settlement observation.
The present global-cache early return can suppress a Run's first Guard observation.
Define and test whether Guard acts on its coherent settlement receipt or current
state; do not splice a newer Account balance with an older Turn hold. Reuse existing
per-Run receipt/version state; any current-state reevaluation must be supplied
coherently by the Billing owner, not reconstructed in the Host.

### 7.3 Remove the duplicate settlement snapshot schema

**Additional blocking defect, reproduced offline:** new charged settlements contain
`reservedUnits` and possibly `turnReservedUnits`; the Harness's inline
`accountAfter` schema accepts only version and available. The real page projector
therefore rejects current valid receipts.

Sources: `SP/packages/contracts/src/billing.ts:62-75,127-135`;
`SP/apps/api/src/models/billing/index.ts:777-798,852-865,997`;
`SP/packages/eval-harness/src/index.ts:674-682`.
Old-shape fixtures still mask it at
`SP/apps/api/src/models/billing/eval-pages.node.test.ts:24`.

Replace the inline snapshot definition with the canonical Billing contract.
Update Harness dependency/standalone packaging and its consumer smoke check in the
same delivery. Do not strip reserved fields, add an old/new union, use passthrough
to hide the mismatch, or preserve stale fixtures. Regress through the actual
settlement producer, billing page projector and public Harness consumer together.

### 7.4 One public page grammar, distinct request-relative checks

Keep Runtime `.32` as native-record grammar owner and Harness as the Eval page
grammar owner. Reuse `EP/apps/eval-api/src/sp/harness-wire.ts:181-204`'s validation
of original values; an observation adapter returns a validated page.
Remove downstream restatements of generic page grammar.

Prove the contract export is browser-safe. If it is not, expose a small page-only
public subpath from the existing owner, not a new package or paginator framework.
Do not import a Runtime implementation root into Web or copy its validator.

Keep Chat/parent ownership, operation-descendant proof, requested `afterSeq`
progress, frozen cutoff continuity, file limits and framing at their actual seams.
Whole-Chat evidence and operation-scoped resources remain different consumers.
Bounded interpretations and body-free Metrics are legitimate derived facts,
not a SAFE/raw second truth.

### 7.5 Super Link: fix SP coordination using the existing public capability

Correct the earlier blanket "upstream blocker" classification. The installed SDK
already offers revision-checked `Session.update`; SP currently reconciles Toolkit
scope but its prerequisite requires an explicit connection binding.

Sources: `SP/apps/agent/node_modules/@springbrand/super-link-sdk/dist/index.d.ts:117-119`;
`SP/apps/agent/src/runtime/tools/super-link/session.ts:89-112`;
`super-link/prerequisite.ts:181-198`.

Put protected owner/Chat coordination in the existing SP Session module. Confirm
the SDK's binding patch shape, select only authorized required connections, update
under the expected revision, and re-read/revalidate before dispatch. Temporary
Agents inherit parent authority and cannot expand it. Do not fabricate binding
records, bind every connected account, bypass prerequisites or create another
Session store. Exact live server behavior remains an acceptance gate, not proof
that the SDK has no interface.

## 8. Execute guidance: owner-level capability, not a connected string parser

**Observed:** production assembly passes raw `workspace.codeExecution`, while
`observeExecuteUsage` is called only by tests. The consumer is mounted, but its
native branch handles successful results, not failures.
`SP/apps/agent/src/runtime/config/tools/universal.ts:160-165`;
`runtime/host/execute-usage-guidance.ts:57-103,120-151`;
`runtime/host/reminder-rules.ts:37-38`.

Connecting that observer alone is not the recommended repair. It copies private
validation messages, misses real `state.read` errors, cannot distinguish an SDK
validation error from JavaScript throwing matching text, and invents random event
identities. Consumer flags are also shared across Submission deliveries by
fingerprint. Sources: `execute-usage-guidance.ts:7-9,19-55,68-79,105-127`;
`R/src/tools/codemode/file-surface-tools.ts:320-329`;
`R/src/harness/event-rule-router.ts:125-127`.

The public `.32` execution Port returns `AgentToolResult<unknown>` and receives
code/signal, without a native invocation identity or authoritative failure category.
SDK validators throw ordinary Errors; projection reduces causes to text. Native
commit/fact interfaces expose `isError`, identities and selected arguments, not
failure provenance.
`R/src/config/ports.ts:321-332,1197-1201`;
`R/src/tools/codemode/state-functions.ts:240-246,319-328`;
`R/src/tools/codemode/adapter.ts:182-215`;
`R/src/harness/session-harness.ts:489-507`;
`R/src/harness/reminder-facts.ts:38-44,368-382`.

Recommended design: **Runtime-owned structured outcome facts -> one SP business
Reminder Adapter**. The validator/registry owner supplies bounded, trusted,
native-call/Submission-scoped facts. SP translates those facts into fixed guidance.
Runtime remains the sole owner of registration, deduplication, cutoff, delivery,
cancellation and mounting. No SP queue, replay cursor, persistent consumer Map,
error-string mirror, broad `isError -> schema mistake` inference or private SDK hook.

The needed authoritative category is not established in exact `.32`'s public
interface. This is an owner capability gate, not permission to invent an export,
edit installed SDK code or silently change Runtime. Keep the independent successful
single-line-return rule. When an authorized public replacement exists, delete the
custom failure event, parser/error table, observer, random IDs, secondary subscription
and obsolete isolated-observer tests in the same replacement.

Do not claim one universal wrapper covers all subagents. Classic extraction builds
SDK-owned Shell tools outside that factory and has no equivalent reminder slot
(`R/src/adapter/cloudflare/subagent/tools.ts:68-109,220-254`;
`subagent/runner.ts:135-144`; `subagent/definition.ts:133-139`).
This is a supported `.32` path to account for, not permission to clone or arbitrarily
delete it. Required parity beyond its public interface is an upstream decision.
Also do not promise crash-before-mount exactly-once recovery: `.32` explicitly does
not replay live consumer work after eviction (`R/src/harness/session-harness.ts:405-410`).

## 9. Replace/delete/keep and implementation order

All actions below are **proposed, not performed**. Existing file deletion, schema
mutation, publication and deployment each retain their separate approval gates.

| Action | Exit condition; no retained legacy branch |
| --- | --- |
| Keep prior admission/Skill repairs | Keep actual Core results, strict DTOs, Component manifest ownership and caller-seam regressions. |
| Replace policy storage/readers/publication | One versioned Billing aggregate, whole-set atomic commit, version-required readers; remove meter-only interface and per-meter loop. |
| Replace reminder scalar reader | Fresh coherent canonical facts and checked projections; remove old getter/alias, not add a second balance. |
| Replace duplicate accountAfter schema | Canonical Billing contract, matching standalone Harness dependencies, real producer-to-page regression; remove old-shape fixtures. |
| Replace generic page revalidation | One public owner grammar; retain request/ownership-specific checks and original raw bytes. |
| Retire combined resource endpoint | First confirm no required callers. Then remove `SP/apps/agent/src/eval/routes.ts:43-45`'s old route, `chat/severn-agent.ts:1022-1037`, and exclusive `evalBillingPages`/`evalResourceBody`/`recordsForSubmission` machinery. Keep paged readiness/coverage. Do not claim a live legacy endpoint is removed while it remains registered. |
| Replace execute failure observer | Only with the supported authoritative fact interface; no old/new dispatch or private-message fallback. |
| Complete Session coordination | Existing revision-checked SDK update, owner/Chat checks and fresh prerequisite verification, no second Session store. |
| Retire dependency patches | Only after each owner's replacement satisfies the original behaviors and allowed graph. Never rename the fork as an Adapter. Preserve OOM until parity is proven. |
| Keep history and independent projections | No archived-byte rewrite, historical SAFE decoder, guessed costs, memory-limit removal or schema loosening. Execution-level `safe` is not SAFE trajectory legacy. |

Recommended sequence:

1. **P0: constraints and owner contracts.** Record the fixed-.32/Pi incompatibility,
   execute provenance gate and SDK safety requirements. Seek a permitted public
   owner solution, not more local patches. If none exists, the exact version,
   complete capability and zero-patch requirements cannot all be claimed satisfied.
   Only the user can change those constraints; never overwrite a published version.
2. **P1: target-owned money correctness.** Implement Billing aggregate/migration and
   shared settlement snapshot contract; prove real charged billing collection first.
3. **P2: coherent request facts and SP coordination.** Correct balance meaning,
   freshness, scoped rule state and Session binding using existing modules.
4. **P3: one page grammar and complete replacement.** Migrate all actual callers,
   remove obsolete endpoint/helpers after inventory, retain evidence integrity.
5. **P4: owner capability replacement.** Consume permitted public artifacts and
   remove corresponding patches/parsers only with parity tests. Do not port
   upstream implementation into these two worktrees.
6. **P5: user-owned publication/cutover/acceptance.** Publish final source artifacts,
   install exact approved versions and regenerate locks. Preserve Runtime `.32`;
   do not let an all-alpha updater silently move it. No alpha.9/SAFE fallback.

Target-owned work can be prepared independently of owner publication. A blocked
capability remains explicitly incomplete; it is not a reason to hide local bugs.
The inherited Editor patch needs a separately scoped owner/parity review; publishing
alpha.5 alone does not prove it can be dropped. This plan does not claim that
unrelated UI debt or all repository patches have already been eliminated.

## 10. Offline evidence and acceptance gates

The parent ran three serial `NODE_OPTIONS=--max-old-space-size=1536
pnpm --filter sp-platform-api exec tsx --eval ...` diagnostics. No probe files,
production changes, network calls or database connections were created.
The exact inline commands and outputs are retained in this session's tool transcript.

| Probe | Actual seam and result | Limitation |
| --- | --- | --- |
| Reverse refresh completion | Actual `refreshTurnPolicies` + real Drizzle + in-memory SQL transport. Writes: v2/computed2000, then v1/computed1000; final v1. Expected-v2 assertion failed. | Simulates the relevant SQL writes, not PostgreSQL locks/isolation; intentionally does not emulate a future conditional upsert. |
| Held balance reminder | Canonical facts `{availableUnits:20,reservedUnits:80}`; actual `LowCreditReminder` with the current Host's exact scalar projection and a valid request event. It emitted the below-50 wrap-up text; expected-null assertion failed. | Demonstrates projection/rule behavior, not execution of real RuntimeHost or freshness after remote changes. |
| New settlement billing page | Canonical settled facts with reserved/Turn-reserved; actual `pageEvalSubmissionSettlements`. Failed at `billing/index.ts:997` with `unrecognized_keys` for both fields. | Receipt shape matches the verified producer; no live debit or DB transaction executed. |

These failures verify defects; they are **not fixed**, green regressions or full
acceptance. Preserve the counterexamples as real caller-seam tests before changes:

- Billing publication/refresh/admission: current and scheduled Card activation,
  reverse completion, same-version reordered/equal cutoffs, source changes,
  rollback/replay, all-meter atomicity and bounded SQL. Real isolated PostgreSQL
  interleavings are required; no production DB or weakened assertion.
- Real RuntimeHost/resource loader: 20+80 does not warn, total49 warns, total50 does
  not; other Turn/Action holds, off/observe/enforce distinction, unavailable facts,
  out-of-order receipts, request-time refresh and wake/recovery without mixed versions.
- Actual settlement -> billing page -> standalone public Harness/EP consumer:
  current snapshots are accepted with strict fields and paired/frozen coverage.
- Production execute assembly, both Agent roles and supported child paths:
  invalid method/arguments, ordinary errors including matching text, duplicate
  publication, retries/abort, cross-Submission scope and original result preservation.
  Isolated observer mocks or fabricated ToolAssemblyResult are insufficient.
- Real installed page contract through evidence, replies, resources, management
  and Web: equality followed by empty EOF; inline/reference parity; invalid and
  nonadvancing cursors; hashes, bytes, ownership and partial/finalized coverage.
- SDK replacement: preserved OOM pre-arm/reset/recovery/fencing specifications,
  native URL image/PDF and Anthropic continuation parity; no hidden patch identity.
- Live Session authorization/revision races, Space transfer guarantees and actual
  provider/channel capability remain separate, explicitly unrun acceptance gates.

Do not report the migration accepted until the approved graph, required owner
interfaces, legacy deletion and serial Worker/PostgreSQL/live gates all have proof.
