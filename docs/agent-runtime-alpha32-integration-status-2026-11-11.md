# Runtime alpha.32 Integration Status

Date: 2026-11-11. This is a source-delivery checkpoint, not completed migration
acceptance or release approval.

## Public Trajectory Reuse Follow-up: 2026-11-12

The ordinary Chat mismatch was a source integration defect, not only an
unpublished-package gate. Ordinary SP HTTP now consumes the canonical raw
forward page and mounted record-download contract. Agent, API, Web and the
trajectory plugin use the same `agent-contracts/trajectory` owner; Harness
aliases and bundles that leaf instead of maintaining another wire schema.
The existing Eval resource/native/billing routes retain their storage and
settlement authority. No second trajectory or resource data source was added.

Latest-tail, older-history and live refresh remain explicit UI behavior.
`tail=true` uses the actual stored ingest index and a byte-bounded window;
`cursor.previousThroughSeq` is an indexed predecessor, not cursor arithmetic
or a reconstructed `beforeSeq/hasOlder` response. Oversized records remain
visible references with lazy, verified original-byte downloads.

Generic JSON inspection and streaming integrity/envelope verification are
owned by Agent Contracts and exposed through the public Harness root. SP
indexed-fact extraction remains in SP. EP Metrics/reply interpretation remains
EP-owned; its local stream adapter decreased from 739 to 341 lines after the
generic parser/verification removal. Receipts prove byte integrity,
native envelope/identity and scope, not complete opaque native-body schema
validation. Runtime .32 resource IDs are preserved without trimming; finite
opaque numbers such as `1e20` remain valid while native IDs/cursors remain safe
integers.

| Final source check | Result | Sampled peak RSS |
| --- | --- | --- |
| Registered ordinary API/default transport/OpenAPI | 11 passed; Session lookup fixture, not real PostgreSQL auth | 430 MiB |
| Trajectory plugin | 7 passed; typecheck passed separately | 373 / 406 MiB |
| SP Web SDK | 3 passed | 540 MiB |
| Canonical trajectory and generic observer | 21 passed | 216 MiB |
| Harness source | Types passed; 92 tests passed | 339 / 453 MiB |
| Release regression | Passed | 1,074 MiB |
| Final standalone declarations and awaited Node/browser proof | Passed | 913 MiB |
| EP real-candidate consumer: strict adapter types and six suites | Types passed; 232 passed | 1,018 MiB |

The current candidate is
`SP/packages/eval-harness/dist/trajectory-stream-final-20261112-04/springbrand-eval-harness-0.1.0-alpha.10.tgz`,
SHA-256 `3c11c34a4e19a6a0ced6537575afae674a17eb7f7c7d634de8303f470b60fb5d`.
It supersedes the earlier candidates below and has not been published.
The final EP proof used that exact tarball through independent package extraction
and ordinary resolution, leaving Harness external to the bundled EP test source.
No SP private source, fake schema, installed-module patch or EP dependency
override supplied the owner capability. The reproducible driver and final log
are under EP `.scratch/native-stream-public-proof/`; the final log is
`final-3c11c34a-types-and-six-suites.log`.

**Worker acceptance remains blocked.** Real ordinary Runtime/DO producer,
store/streaming/tail and HTTP-byte suites exceeded the unchanged 2.5 GiB
watchdog budget during module loading, before assertions. Attempts are stopped;
no actual-Worker HTTP golden or end-to-end acceptance is claimed. SDK-produced
stream smoke and Node transport fixtures are not substitutes. Do not repeat
the same heavy entry or raise the budget. Agent types still report the two
upstream Space `artifacts-sync.ts:161,170` incompatibilities; installed source,
assertions and security controls were not bypassed.

All checks are queued on the shared watchdog lock and execute serially.
Only cached dependencies were added through the offline package manager:
exact `fast-sha256@1.3.0` and the real Harness-to-AgentContracts workspace
dependency. EP's formal Harness alpha.9 pins and lockfile remain unchanged.
The two installed-package stream/observation suites currently have 21 passing
and 40 failing tests: alpha.9 lacks the streaming exports and rejects raw inline
pages. EP source now requires
the real alpha.10 dependency cutover before deployment; the isolated candidate
proof is not that cutover.
Publication, real dependency cutover, PostgreSQL auth/CAS, fresh registry
install, Worker acceptance and deployment parity are separate open gates.

## Earlier Source Continuation: 2026-11-12

This section records the newer source and verification checkpoint; the
2026-11-11 results below are historical, not verification of today's changes.
The user reconfirmed that they own publication. No package publication,
deployment, live database mutation or live model call was performed.

- The exact-lookup Action contract no longer requires or accepts locally invented
  `toolDescription`, `attachmentInputFields` or `produces` metadata. The existing
  authenticated HTTP regression first reproduced a 500, then passed with the
  upstream-only contract; the shared strict-schema regression also went red/green.
- Frank catalog failures now become `ACTION_CATALOG_UNAVAILABLE` with HTTP 503,
  preserving their cause and safe upstream diagnostics. They are not user
  authentication failures, missing Actions, fabricated estimates or unknown 500s.
  Five new HTTP regressions went red/green across upstream auth, rate-limit
  and service statuses, plus failures without an upstream status.
- Registry inspection found the published alpha tag at Harness alpha.9 and no
  alpha.10. EP's formal dependencies and lockfile remain unchanged. Its current
  public wire regression has 8 passed and 3 failed tests: the installed alpha.9
  parser still requires SAFE rather than accepting raw records.

| Serial, bounded check | Result | Sampled process-tree peak RSS |
| --- | --- | --- |
| SP API focused Action/import/billing/error regressions | 112 passed, 9 skipped | 486 MiB |
| Shared business Contracts suite | 104 passed | 219 MiB |
| Public Harness source types / tests | Types passed; 61 tests passed | 315 / 400 MiB |
| Independent release regression | 1 passed; declarations, Node and browser proofs | 1,068 MiB |
| EP API focused management/resource regressions | 104 passed | 545 MiB |
| Rebuilt alpha.10 artifact verification | Declarations, Node and browser proofs passed; no install | 966 MiB |

The rebuilt candidate is
`SP/packages/eval-harness/dist/alpha32-continuation-20261112/springbrand-eval-harness-0.1.0-alpha.10.tgz`.
Its SHA-256 remains
`093f5ed760d924dd8f2a257ee586e021bfb5e8b7d370e67b21894127636a900d`.
It is byte-identical to the earlier candidate, not a published or installed EP release.
Evidence logs are SP `.scratch/alpha32-continuation-20261112-*.log`.

Whole-SP-API application typechecking was stopped twice by the 2.5 GiB RSS
watchdog, including after reducing the native compiler GC target. It is
**unverified**, not green, and is paused rather than retried with more memory.
Subsequent checks used one Vitest worker, a 1,024 MiB Node heap and a 768 MiB
native compiler GC target. These are execution budgets, not relaxed compiler
flags or assertions. PostgreSQL, full Worker, upstream-owner and deployed gates
remain open. After the user publishes alpha.10, both EP Harness pins must move
together through a real package-manager update before raw HTTP acceptance.

## Delivery Contract

The user owns package publication. Deliver the code in the two target worktrees
without publishing, waiting for publication to hand it over, or replacing
missing public APIs with local copies. After the user publishes the required
packages, perform the exact dependency/lockfile cutover and rerun the deferred
consumer checks. Runtime itself stays at alpha.32.

## Scope And Safety

- Write only in SP `sp-eval-20261110` and EP `ep-main-20261110`.
- The SP 1105 and UA 1103fresh worktrees are read-only references.
- Runtime stays exactly `@springbrand/agent-runtime@0.3.1-alpha.32`.
- New Chats/Runs use raw Pi records as the sole trajectory truth. Historical
  stored results and archived evidence are retained without reinterpretation.
- No publication, deployment, live database mutation, live model call, or live
  browser/account operation has been performed.
- Final compiler, test, and archive verification jobs run serially.
  Node heap is limited to 1536 MiB, native
  compiler GC has a 1536 MiB soft target, and test workers are limited to one.
  Those are execution limits, not relaxed assertions or compiler settings.

## Current SP/EP Remediation

This section supersedes the earlier checkpoints retained below. SP/EP-owned
source corrections are implemented; package installation, public-owner gaps,
PostgreSQL and deployed acceptance are separate, uncompleted gates.

### Implemented

- All eleven model presets require `free`, as explicitly confirmed by the user.
  The canonical Model catalog alone drives ordinary configuration, import,
  preflight, replay and downgrade behavior. No Opus-specific Pro gate remains.
  Free model admission does not mean zero Credit pricing: settlement, reservations
  and Guard are unchanged.
- Billing publishes an immutable Card and its complete, explicitly zero-sample
  initial policy set atomically. Policies are keyed by `(rate_version, meter_id)`;
  admission reads its pinned version and rejects missing policies, even in off
  mode. Exact publication replay does not reset refined policies.
- Refresh computes outside the aggregate lock, then rechecks the Card, complete
  stored snapshot and bounded source fingerprint. Source reads have lower/upper
  cutoffs, deterministic ordering and a 100,000-row ceiling. Changed older/equal
  generations retry within three attempts; an older committer cannot discard a
  newer candidate. One multi-row upsert replaces the per-meter write loop.
- Canonical immutable projections distinguish Account total
  (`available + all reserved`) from enforced Turn remaining
  (`available + this receipt's remaining Turn hold`). Request preparation reads
  authenticated, deadline/cancellation-bounded Account facts; unavailable reads
  suppress optional advice without cached/zero fallback. Guard deliberately acts
  on its own coherent settlement receipt, not newer Account state spliced with an
  older hold. Account-cache and per-Run observation frontiers are independent.
- Billing producer types and public Harness parsing use the Contracts-owned
  `SettledAccountFacts`/`settledAccountFactsSchema`. Actual settlement, canonical
  reply parsing, Billing pagination and public Harness parsing preserve reserved
  facts. Negative balances remain valid; inconsistent holds and unsafe sums fail.
- Ordinary Chat Super Link coordination uses existing public SDK connection
  updates with revision CAS, live operation readiness and owner/Project/Chat
  validation. It preserves unrelated bindings, chooses no account among multiple
  candidates, and rechecks one-use invocation evidence before dispatch. Toolkit
  choices are routing preferences. Legacy creation-scope fields are removed.
  Temporary Agents never mutate the Session; their distinct limitation is below.
- Header/native/billing pages are the only live resource collection paths.
  Combined Agent/API routes, unbounded aggregators, exclusive helpers and the
  unused native iterator are removed, including fixtures. The shared
  `EvalResourceSnapshot` aggregate remains for EP persistence, not HTTP fallback.
- EP delegates generic page grammar to public Harness parsing and keeps original
  values. Observation, management, resource collection and Web retain only their
  requested-progress, frozen-cutoff, ownership/descendant and byte/hash/framing
  responsibilities. The copied generic schemas and unused header exports are gone.
- The terminating Eval HTTP adapter now normalizes unknown failures to canonical
  JSON 500 with the cause retained; output-schema errors are not caller 422s.
  Tests preserve privacy-safe bodies and one correlated request record.
- The single-large-record OOM was a Vitest byte-array comparison allocation,
  not demonstrated producer corruption. Exact length/full-byte scanning replaces
  the comparator's millions of `Object.entries` allocations. The original
  Unicode payload, >5 MiB threshold, full body/hash, replay, scope and EOF proofs
  remain. No memory increase, assertion weakening or production workaround.
- The custom execute failure classifier/observer/event is removed. The permitted
  successful single-line guidance uses native facts and a real `return` keyword
  boundary, not identifier prefixes or guessed error messages. The migration-added
  Pi Responses hunk is removed; the installed module also resolves the baseline
  `a3b2117c...` patch hash. Inherited Pi/Agents safeguards are not claimed patch-free.

### Current Verification

Final checks use the installed workspace binaries, one Vitest worker and a
1536 MiB Node heap under the shared execution lock. Skips are not passes.

| Boundary | Current result |
| --- | --- |
| SP Agent unit suite | 56 files, 456 passed. Includes native guidance, fresh balance and Session regressions. |
| SP API full Node suite | 116 files passed, 86 skipped; 918 tests passed, 556 skipped. `DATABASE_URL` unset; no PostgreSQL execution claimed. |
| SP API application and Node-test TypeScript | Both passed after the final source/test changes. |
| SP Agent Contracts | 18 files, 146 passed; typecheck passed. Includes all-Free availability and unchanged generic Plan ranking. |
| Canonical Billing projection tests | 12 passed. |
| Public Harness source | 61 passed; typecheck passed. |
| Standalone release regression and final extracted candidate | Passed strict declarations, Node imports, raw JSON/JSONL, canonical settlement facts, ZIP and browser-root execution. One release regression passed. No dependency installation or publication in this proof. |
| Focused real Worker seams | 41 balance/Guard tests and twelve distinct HTTP/store/catalog/large-record scenarios passed across the recorded isolated runs. This is not the full Worker suite. |
| SP Agent TypeScript | Still blocked by the two installed Space Artifacts errors (`tokenExpiresAt`, `remote`); not a passing compile. |
| EP final compilation | All seven workspaces passed, explicitly serial with `--workspace-concurrency=1` and offline configuration. |
| EP final serial tests | Contracts 66, Dataset 188, Runtime 446, Metrics 304, CLI 1 and Web 531 passed. API: 1,245 passed, 40 failed, 197 skipped. The installed alpha.9 public parser still rejects raw pages; downstream stream/retry assertions consequently fail before their intended phase. Not a passing API suite. |

Final logs in SP `.scratch`: `alpha32-remediation-final-api-green.4t8BLW`,
`alpha32-remediation-final-public-checks.YKHy8E`,
`alpha32-remediation-final-agent-ts.H047jj`, and
`alpha32-remediation-final-ep-all.jpmat1`. Final Agent compilation confirms only
the two Space diagnostics. Both worktrees pass `git diff --check`; retired
production-symbol inventory is empty. EP's lock delta is just the direct
type-only Harness dependency; no unpublished registry entry is fabricated.

The latest candidate is
`SP/packages/eval-harness/dist/alpha32-sp-ep-final/springbrand-eval-harness-0.1.0-alpha.10.tgz`,
SHA-256
`093f5ed760d924dd8f2a257ee586e021bfb5e8b7d370e67b21894127636a900d`.
It supersedes earlier candidate paths/checksums. This proves the extracted local
artifact, not registry publication, a fresh installed EP graph or deployed parity.

### Remaining Gates And Ownership

- EP's formal installed Harness remains alpha.9. The new Contracts type-only
  dependency matches that exact existing pin and loads no Harness/Runtime code
  into the browser. Both API and Contracts pins must move to alpha.10 together
  after the user publishes it; no tarball alias, source alias or fabricated lock
  entry is used. Current public raw/settlement rejection is not compatibility code.
- The Harness release bundles canonical Billing from its owner; it does not
  require a separate business Contracts publication just for that schema.
  Earlier Editor and HTTP-matching business Contracts release work remains a
  separate user-owned package handoff. Registry state was not queried again here.
- Migration `0044_ordinary_ironclad.sql` and its generated metadata are delivered,
  not applied. Pause/drain old publication, maintenance and admission clients for
  the coordinated versioned-policy cutover. Partial/mixed existing snapshots
  deliberately block; repairing them needs a separately approved operator plan.
  Real PostgreSQL concurrency, rollback and migration specifications remain gated.
- The dated DeepSeek default requires its own published Rate Card meter before
  live admission. Tests prove it cannot borrow an old price. No new historical
  price alias or guessed price was added, and historical settled facts stay intact.
- UA/public-owner gates remain: reliable structured execute failure reasons,
  Pi URL image/PDF conversion, official equivalent OOM protection, Space directory
  mutation/transfer safety and Artifacts APIs, and native authorization UI support.
  No target-local replacement is introduced.
- A temporary Agent's first unbound Super Link operation remains fail-closed:
  `.32` exposes child ownership, but not a verifiable current Tool invocation/input
  capability usable by a parent during initial prerequisite checks. No arbitrary
  parent mutator or second pending registry is added. After a trusted parent
  operation binds the account, the same child invocation can recheck and continue.
  Public source evidence and the exact missing fact are recorded in
  `agent-runtime-alpha32-public-blockers-2026-11-11.md`, section 2.
- Actual Channels providers, full Worker/lifecycle acceptance, live models,
  browser/accounts, deployment and PostgreSQL acceptance are not claimed.
  The inherited SDK safety patches remain until equivalent owning releases exist.

## Historical Verification (Pre-Remediation)

| Boundary | Command / evidence | Result |
| --- | --- | --- |
| SP Agent compilation before cleanup | `pnpm --filter sp-platform-agent exec tsc --noEmit --pretty false` | Three diagnostics: obsolete SAFE policy import and two public Space Artifacts API mismatches. No OOM. |
| SP Agent unit suite after fixture correction | `pnpm --filter sp-platform-agent exec vitest run --project unit --maxWorkers=1 --no-file-parallelism` | 57 files, 427 tests passed. |
| EP workspace compilation | `pnpm -r --workspace-concurrency=1 --no-bail --if-present check` | Passed across all seven package/application workspaces. This does not prove installed public Harness behavior. |
| Public package availability | Read-only npm `dist-tags` and `versions` for Harness, Editor, business Contracts, Space and Super Link SDK | Harness alpha.10, Editor alpha.5 and business Contracts alpha.1 are not published. Space alpha.1 and Super Link SDK 0.1.2-alpha.1 remain the current alpha versions. |
| EP serial package tests | `pnpm -r --workspace-concurrency=1 --no-bail test` | Contracts 66, Dataset 188, Runtime 446, Metrics 301, CLI 1 and Web 529 tests passed. API: 1232 passed, 39 failed, 197 skipped; failures include the installed Harness alpha.9 SAFE-only public schema rejecting raw records. |
| SP native model/config/tool assembly | Three-file serial Worker run | 25 tests passed: public native multimodal/model requests, both Agent roles' prompts, final CodeMode tool assembly and Config/Approval controls. |
| SP managed browser cleanup | Isolated serial Worker run | Three tests passed after retaining the real `agents/browser` exports in the provider mock. No live browser operation. |
| Focused SP model/config/interaction checkpoint | Six-file serial Worker run; `.scratch/alpha32-final-worker.log` in SP | 41/41 passed at that checkpoint. Includes native Eval answer/recovery, fileRequest foreign-upload rejection, Session owner guards, multimodal model requests, CodeMode assembly and Config/Approval controls. Not a full Worker acceptance or a rerun after the final financial guards. |
| Intermediate SP Node unit suite | `vitest run --project unit --maxWorkers=1 --no-file-parallelism` | 56 files, 425/425 passed. The former two Node answer-policy tests now live in a three-test real Worker suite. |
| Delivery SP Node unit suite | Same serial command; `.scratch/alpha32-delivery-unit.log` in SP | 56 files, 429/429 passed after the final financial corrections. |
| Delivery public Harness source | `pnpm --filter @springbrand/eval-harness run check` and serial Vitest | Compilation passed; 60/60 tests passed, including finalized coverage rejection in both public schemas. This is source verification, not a rebuilt archive or published-package acceptance. |
| Final SP Agent compilation | `pnpm --filter sp-platform-agent exec tsc --noEmit --pretty false` | Only two diagnostics remain, both in published Space alpha.1 Artifacts APIs; no local Agent diagnostic. This is not a passing compile. |
| SP API compilation | `pnpm --filter sp-platform-api run check` | Both application and Node-test TypeScript projects passed. |
| SP API focused Node tests | Six files: turn policy, Profile, intended patch, selectable resources, billing jobs and protected migration routes | 35/35 passed. No PostgreSQL integration suite was run. |
| Delivery EP compilation | `pnpm -r --workspace-concurrency=1 --no-bail --if-present check`; `.scratch/alpha32-delivery-ep-check.log` in SP | All seven workspaces passed after the final corrections. |
| Delivery EP Contracts and Metrics | Serial Vitest with one worker | Contracts: 8 files, 67/67 passed. Metrics: 14 files, 304/304 passed. |
| Delivery EP public-page regressions | `resource-pages.test.ts` filtered to cutoff continuation and finalized settlement coverage | 2/2 selected passed, 50 filtered out. Reference-byte verification uses the real stream parser; this does not establish inline raw acceptance with installed Harness alpha.9. |

The first Agent unit run reproduced two stale-fixture failures. The fixture now
provides the real Host tool-context seam and asserts the exact intended
`settingPatch` request rather than the retired full-setting request. It also
asserts that neither storage reads nor writes occur on API failure. Production
behavior and error preservation were not weakened.

## Earlier Review Follow-Up Corrections

The source-only review follow-up fixes both confirmed local findings, without
weakening public contracts or changing the installed dependency graph:

- Turn admission now validates the accepted DTO with Credit Core's actual
  post-reservation total. The former eager validation rejected a legal initial
  zero-hold account before reserving anything. A database-transport fixture drives
  the real reservation Model; both zero prior holds and stale lower hold facts
  were observed red and then passed. This is not PostgreSQL transaction proof.
- Platform Skill reads now use Component's scoped reader and its existing
  validated manifest projection. One joined query retains binding/scope,
  platform ownership, lifecycle and stable ordering filters. The canonical
  metadata HTTP regression was red before correction; corrupted manifest and
  database outage remain server errors. The Component isolation test permits
  only the binding schema's necessary foreign-key import, not Model reads.
- The management trajectory download now accepts the public at-cutoff
  continuation followed by empty EOF, like the evidence and resource consumers.
  This was a preexisting conformance gap, not a demonstrated new production
  outage. Its reference-byte HTTP regression changed from 502 to complete JSONL.
- Model-facing management descriptions, Web error copy and the API README now
  distinguish raw Pi evidence from raw-derived compact Metrics, without claiming
  SAFE projection. Historical and explicit no-fallback references remain.

Final follow-up verification was serial with one test worker and a 1536 MiB
Node heap limit:

| Check | Result |
| --- | --- |
| SP API application and Node-test TypeScript | Passed |
| SP API focused billing, Skill, isolation, content, Profile and migration tests | 7 files, 36/36 passed |
| EP TypeScript across seven workspaces | Passed |
| EP management MCP plus at-cutoff download | 14 selected passed; 29 filtered out |
| EP Web trajectory tab | 11/11 passed |

No publication, deployment, live database operation or compatibility shim was
performed. Space/Super Link/provider gaps, fresh public-package installation,
full Worker acceptance, PostgreSQL and live acceptance remain external gates.
Initial review claims about a new trajectory package, ZIP implementation
duplication and newly introduced Eval route traversal were rejected after
comparison with the fixed baseline; unrelated unchanged code was not modified.

## Earlier Target-Owned Corrections

- The shared Miniflare API fixture now serves the real Profile projection
  rather than treating `/profile` as an Agent ID and returning a Runtime Input
  body. It also implements the new billing admission, credit-facts, settlement
  acknowledgement, release and terminal-actual test contracts. These are test
  doubles, not production balance or cost substitutes.
- Runtime alpha.32 persists canonical `ask_user` arguments without the old
  `responseType` field. The old Eval answer policy treated a normal text
  question as an unanswerable attachment and cancelled the Submission.
  Eval now reuses the public `askUserFields` helper; it does not copy the
  Runtime normalizer or maintain a local old/new argument switch.
- The same public helper determines the attachment answer index for native
  `fileRequest`. Otherwise a foreign upload could bypass SP's existing
  attachment admission. The public response regression test reproduced
  acceptance before the correction and passed in the final 41-test run.
- The answer-policy tests belong to the Worker project because Runtime's
  public root loads Worker dependencies. No `cloudflare:workers` shim or fake
  Runtime helper was added to make the Node project pass.
- A larger Worker run reached 91 passed tests before reporting three
  interaction failures, a browser mock-export failure and unhandled errors.
  The interaction and mock causes were subsequently corrected. A later
  multi-file run reported 28 passed tests but a Cloudflare pool unexpected exit
  with `Expected global Vitest state`; it is not a passing suite.
- The final isolated Eval HTTP selection confirmed English auto-answer and
  restart recovery passing, then the pool exited unexpectedly before four
  selected large-record/receipt cases finished. Eighteen cases were filtered
  out. The process exited 1; do not report those incomplete cases as passed.
- EP now accepts a public continuation exactly at the frozen cutoff, followed
  by the empty EOF page. Both evidence/resource loops and the structural storage
  guard retain nonadvancing, empty-continuation and out-of-range rejection,
  without inventing a stricter cursor grammar than the public SP contract.
- Bookkeeping lacking the exact source Submission no longer creates scoped
  Metrics counts. Missing, null and foreign attribution have public aggregation
  regressions; genuine unattributable data stays unsupported, not zero.
- Super Link reservation state proves an amount, not execution success.
  Released/succeeded, settled/failed and released/outcome-unknown regressions
  retain the native outcome. Incomplete outcomes and absent billing proof keep
  readiness incomplete. The former terminal-without-billing legacy branch and
  its `unknownExecutions` state have been removed, not retained as a fallback.
- The owning public Harness header and snapshot schemas now require complete
  native, usage and settlement coverage for `finalized:true`. EP's existing
  readiness validation agrees. Explicit partial collection stays available;
  it cannot manufacture a finalized zero-credit result from missing receipts.
- These regressions were observed red before correction and then passed.
  The temporary Eval debug marker is absent. Live boundary documentation now
  describes raw Pi and the pending public-package cutover, not SAFE projection.

## Earlier Authorized Cleanup

The user explicitly approved deletion of these twelve unreachable old files
under SP `apps/agent/src/`:

- `telemetry/action-redaction.ts`
- `runtime/tools/browser/console-capture.ts`
- `runtime/tools/browser/console-capture.test.ts`
- `runtime/tools/browser/console-report.ts`
- `runtime/tools/browser/console-report.test.ts`
- `runtime/tools/browser/page-visit.ts`
- `runtime/tools/browser/screenshot.ts`
- `runtime/tools/browser/screenshot.test.ts`
- `runtime/tools/browser/session.ts`
- `runtime/tools/browser/tools.ts`
- `runtime/tools/browser/tools.test.ts`
- `runtime/tools/browser/tools.worker.test.ts`

The new managed-browser, agent-tools, wiring and raw-record tests remain.

## Earlier Package Handoff (Superseded By Current Gates)

- Harness: source in SP `packages/eval-harness`, version alpha.10, exact
  Runtime alpha.32, raw native validation and retained Eval layout/contracts.
  The existing `pack:release` and `verify:release` scripts are the release seam.
- Editor: source in SP `packages/agent-config-editor`, proposed public
  alpha.5, with the alpha.32 model catalog. Its existing release verifier fails
  the single HTTP-module-identity
  assertion: workspace HTTP alpha.5 versus published business Contracts
  alpha.0's HTTP alpha.4.
- Business Contracts: source in SP `packages/contracts`, proposed public
  alpha.1, must carry the matching HTTP dependency and relevant shared business
  exports before Editor's public dependency identity can be verified.
- Earlier local archives are checkpoint artifacts, not proof that the final
  source has been packaged or passed the release gates. Rebuild from the source
  being published; do not weaken the identity assertion, edit installed modules
  or hide the mismatch behind an override.
- In particular, the finalized-coverage schema and Tool receipt corrections
  postdate the earlier Harness archive. Its recorded checksum is not the final
  deliverable and must not be used to publish this source.
- EP still formally consumes Harness alpha.9 and Editor alpha.4, so its
  installed graph still contains Runtime alpha.15 and alpha.9. Compilation
  passing does not mean the raw migration or runtime dependency cutover is
  complete. Do not fabricate a registry lock entry for an unpublished package.
- Publication is the user's next action, not an assistant prerequisite.
  Deployment, databases and live operations remain outside this delivery.

## Earlier Gap Inventory (Superseded By Current Gates)

These are not fixed merely by publishing Harness or Editor:

- Space alpha.1 uses obsolete Artifacts APIs (`tokenExpiresAt`, `repo.remote`)
  and does not prove the alpha.32 directory cursor and safe cp/mv guarantees.
  The owning Space source needs correction and a new public package. No
  filesystem fork, downgraded globals, ambient mask or node_modules edit is
  part of this delivery.
- Super Link has native authorization and revision-checked Session updates,
  but the protected authorize/poll-to-Chat-Session binding bridge is not closed.
  ToolAuth alone does not expose the selected effective connection ID; the
  deployed resolver semantics remain unverified. A DTO-only bridge is
  insufficient. Ordinary prerequisite response support in the currently
  installed chat-client/message-panel also remains an owner-package gap.
- The target explicitly declares channels unsupported because real
  setup/send/history providers are not provisioned. That is an honest
  degradation, not completed channel-tool alignment, and must not be replaced
  by empty account lists or made-up setup links.
- Full Worker acceptance is not green. Finish the isolated interaction and
  large-record checks, then investigate any remaining pool/lifecycle failures
  without relaxing timeouts, suppressing unhandled errors or counting skipped
  cases as passed.
- PostgreSQL, fresh-install, deployed parity, live model/browser and release
  acceptance remain outstanding and must not be reported as passed.

See `agent-runtime-alpha32-public-blockers-2026-11-11.md` for primary-source
locations and the owning boundaries.
