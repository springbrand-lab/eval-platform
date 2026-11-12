# Runtime alpha.32 findings: normal Chat binding implemented; public-owner gates remain

Updated 2026-11-11 against installed public packages and current target source.
SP-owned normal Chat Super Link connection coordination is now implemented
(section 2); this does **not** establish whole-Super-Link acceptance. Native
authorization UI integration and verifiable temporary-child invocation authority
remain public-owner gates. Space, provider serialization and retained SDK safety
gates remain separate.

The initial post-OOM audit was source inspection only. The later Super Link
implementation has verified **local** unit/typecheck evidence described below,
not live-account or deployment acceptance. This documentation-only update ran
no tests, typechecks, installs, network/model/provider/DB calls, publication,
deployment or servers, and writes only this document. Installed artifacts and
target source, not an unpublished similarly versioned checkout, are the primary
evidence. Paths below are absolute; line numbers describe this checkout.

Current authorization: implement SP/EP-owned corrections only. UA, Pi, Agents,
Space and other published-package defects remain owner issues, not permission
to patch those capabilities inside SP/EP. Current target-owned work and executed
checks are recorded by the parent in `agent-runtime-alpha32-integration-status-2026-11-11.md`.
Section 2 supersedes the initial missing-normal-Chat-binding finding; other
truthful audit findings and their distinct acceptance gates are retained.

## 1. Space: platform API mismatch, plus separate transfer gaps

### Artifacts errors are not fixed by refreshing the current typegen

**Confirmed:** SP installs Space `0.3.1-alpha.1` and Runtime
`0.3.1-alpha.32`:
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/package.json:25-40`.
Space exports TypeScript source and declares no platform peer/version
constraint; its development Workers-types range is `^4.20251008.0`:
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/space/package.json:1-26`.

- Space reads `created.tokenExpiresAt` and `repo.remote` at
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/space/src/space/artifacts-sync.ts:153-181`.
- The target Agent declarations were generated with **workerd 1.20261006.1**,
  compatibility date **2026-08-01**, matching installed Wrangler `4.149.0`'s
  workerd dependency. They are not merely older than the installed toolchain:
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/worker-configuration.d.ts:1-3`;
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/wrangler/package.json:1-3,74-84`.
- That public platform API has no initial-token expiry field; repository
  metadata is obtained through **`repo.info()`**, not capability properties.
  `createToken()` still returns an explicit `expiresAt`:
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/worker-configuration.d.ts:11212-11245,11313-11345`.
  Installed Workers-types `5.20261012.1` agrees:
  `/Users/apple/code/.worktrees/sp-eval-20261110/node_modules/.pnpm/@cloudflare+workers-types@5.20261012.1/node_modules/@cloudflare/workers-types/index.d.ts:12463-12476,12565-12600`.
- Space Worker instead pins **Workers-types 5.20260731.1**, whose old API
  includes both fields. This explains the split; it is not evidence that the
  newer declarations are wrong:
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/space-worker/package.json:16-23`;
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/space-worker/tsconfig.json:3-16`;
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/space-worker/node_modules/@cloudflare/workers-types/index.d.ts:11448-11462,11505-11519`.

**Action/owner:** fix and release the **upstream Space** Artifacts adapter for
the actual platform API: obtain existing-repository remote metadata through
`info()`, and obtain a token with a documented expiry through `createToken()`
rather than assuming creation returns an expiry. Then adopt an exact published
Space version and align each consuming Worker's genuine platform declarations.
Space already has the latter token path at
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/space/src/space/artifacts-sync.ts:200-221`.
No compatible fixed release was established offline. Do **not** downgrade
globals to July, merge ambient properties, cast away errors, patch
`node_modules`, or fork Space into SP. Regenerating Agent types with its current
Wrangler will not restore removed API fields.

The read-only SP reference has the same October-generated API and July Space
Worker pin:
`/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/agent/worker-configuration.d.ts:1-3,11207-11220,11308-11340`;
`/Users/apple/code/.worktrees/sp-prompt-governance-main-port-20261105/apps/space-worker/package.json:16-23`.
UA's source Space still reads the same obsolete fields, with an old type setup:
`/Users/apple/code/.worktrees/ua-prompt-governance-release-0.3.1-fresh-20261103/packages/space/src/space/artifacts-sync.ts:153-181`;
`/Users/apple/code/.worktrees/ua-prompt-governance-release-0.3.1-fresh-20261103/packages/space/tsconfig.json:1-9`.
Neither reference is a fix to copy.

### CAS exists; directory change detection and transfer guarantees do not

**Confirmed present in published Space:**

- `writeFileBytesIfVersion` checks content version, timestamp, size and MIME;
  publication rechecks the admitted row identity in a synchronous storage
  transaction after uploading bytes. A loser is a conflict; the successful
  receipt contains its own committed content version, not a later `stat`:
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/space/src/space/space-files.ts:510-607,857-878`.
- `listVersionedFilesAfter` is bounded, exclusive path-keyset listing in SQLite
  BINARY order, scoped to current ready files. It explicitly promises **no
  cross-page inventory snapshot**:
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/space/src/space/workspace-port.ts:53-73,286-297`;
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/space/src/space/space-files.ts:990-1020`.
- SP routes those public operations, without reimplementing CAS:
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/src/workspace/index.ts:129-185`.

**Confirmed missing/contradictory in the current target path:**

- A FileSurface keyset listing is **not** Runtime's optional directory
  `readDirPage`. The latter requires a directory-bound durable mutation cursor
  and serialization with **all** mutations:
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/agent-runtime/src/config/ports.ts:239-252`.
  `ChatWorkspacePort` supplies only offset `readDir`:
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/src/workspace/chat-port.ts:145-148`.
  The public facade only forwards an existing `readDirPage`; it cannot add one:
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/agent-runtime/src/adapter/cloudflare/workspace/scoped-workspace.ts:427-462`.
- Same-mount `cp/mv` delegate to Space; cross-mount copy creates directories and
  writes earlier files **before** finding a later symlink. There is no full-tree
  preflight or copied-byte verification:
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/src/workspace/chat-port.ts:158-224`.
  Native Space copy removes the exact destination first (no existing-directory
  basename semantics) and inserts referenced content rows; native move removes
  the destination then renames rows, rather than copying/verifying before
  source removal. Self/overlap and per-descendant 100 MiB checks are absent:
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/space/src/space/space-files.ts:1047-1105`;
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/space/src/space/durable-object.ts:905-921`.
  The actual SQL backend constructs Shell's `WorkspaceFileSystem` over those
  Space methods, not an alternate safe transfer engine:
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/space/src/space/fs-backend.ts:85-98`.
- Runtime .32 describes full-descendant checking, basename semantics, a
  **100 MiB per-source-file** ceiling, and source removal only after verified
  copying:
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/agent-runtime/src/config/ports.ts:56-70,270-279`;
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/agent-runtime/src/tools/codemode/workspace-file-commands.ts:329-357`.
  Those commands call the Host port; they do not implement these guarantees.

**Action/owner:** these are real storage/Host-contract gaps, separate from the
Artifacts compile errors. Publish the generic mutation cursor and safe transfer
capability at its owning Space/public adapter boundary, then retain only SP's
Chat/UserSpace routing and access rules. A Chat-local notification counter
cannot serialize direct Space writers or other Chats' UserSpace writes. Do not
copy UA's private Host transfer engine into SP. Its existence is reference
evidence, not an installed public helper:
`/Users/apple/code/.worktrees/ua-prompt-governance-release-0.3.1-fresh-20261103/worker/src/runtime-host/resources/workspace-mutations.ts:493-579,745-824`.

**Tests inspected, not executed:** the desired directory/transfer assertions are
at `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/src/workspace/space-transfer-contract.worker.test.ts:23-85`;
current source contradicts them. CAS/race/receipt/keyset/text-cursor coverage is
written at `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/src/workspace/file-surface.worker.test.ts:32-180`.
The installed Runtime still supports those FileSurface text cursors; do not
substitute a newer source checkout's read protocol. The large transfer test
creates a source above 100 MiB; no such allocation/test was run during this audit.

## 2. Super Link: normal Chat binding implemented; native UI and temporary authority remain gated

### What the installed public SDK actually proves

Installed SDK is **`0.1.2-alpha.1`**:
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/super-link-sdk/package.json:1-4`.

- `SessionView.connectionIds` is a toolkit-to-connection map; `connections` is
  optional on both create and update. Project authorization returns a full
  `ConnectionAttempt`, including the resulting `ConnectionView` with Project,
  user, toolkit and status:
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/super-link-sdk/dist/types.d.ts:6-21,29-89`.
- Session-scoped operation discovery has `auth.required`, `source`, `status`
  and `nextAction` (including a reconnect target when applicable). **It does not
  return a selected/effective `connectionId` or connection binding receipt.**
  Neither a generic Toolkit `connected` status nor its account list replaces
  operation authorization:
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/super-link-sdk/dist/types.d.ts:91-134`.
- Existing public methods include Project `connections.authorize/getAttempt`,
  Session `authorize/getAttempt`, and revision-checked
  **`session.update({ connections }, { expectedRevision })`**. No separate named
  `attach`/`bind` method is needed:
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/super-link-sdk/dist/index.d.ts:53-78,87-119`.
  Session authorize resolves a slug in the Session catalog and calls scoped
  `manage_connections`; update really PATCHes the Project Session:
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/super-link-sdk/dist/index.js:3-64`.
  The README explicitly supports referencing a Project-authorized account from
  a same-Project/user Session through `connections`:
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/super-link-sdk/README.md:53-71`.

The exact public update input declares `connections`, and the bundled client
PATCHes it with `expectedRevision`, then refreshes `Session.view`:
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/super-link-sdk/dist/types.d.ts:50-56`;
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/super-link-sdk/dist/index.js:39-41,678-681`.
This is an existing revision-CAS capability, not a generic SDK-unsupported gate.
SP does not need to infer every possible unpinned-account resolution: it now
establishes and verifies an explicit binding for the current operation.

### Current normal Chat coordination

- `chatSession(context)` resolves the trusted Severn owner and configured Project,
  recovers the existing Chat Session, validates identity/lifetime and rechecks its
  protected binding. New Sessions are unscoped; Agent Toolkit preferences neither
  narrow nor widen authoritative remote Toolkit/Tool limits. The saved creation
  key and identity CAS remain; `creationToolkitIds` is no longer declared or
  consumed, new bindings do not write it, and historical bindings are not rewritten:
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/src/runtime/tools/super-link/session.ts:38-44,65-164`.
- Before accepting a user-connection operation, the live SDK operation must say
  `ready`. SP then reads real scoped account facts, checks Project/user/Toolkit
  ownership and active/connected state, and binds only a sole non-disconnected
  candidate that is active and operation-ready. Parent-context
  `Session.update({ connections }, { expectedRevision })`
  preserves unrelated map entries, rereads on conflicts, stops after three
  conflicts, and refreshes/reverifies Session/account facts after success:
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/src/runtime/tools/super-link/session.ts:167-254`;
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/src/runtime/tools/super-link/prerequisite.ts:144-165,180-225`.
  Ambiguous multiple accounts, disconnected/reconnect-required, wrong-owner and
  out-of-scope accounts, and explicit unbound/mismatched connection IDs fail
  closed. No account chooser was added; a model's explicit ID is not binding
  authority. Account count or Toolkit metadata alone is not authorization.
  Credential refreshability remains the SDK operation's decision, not an SP
  interpretation of credential-expiry metadata.
- Prerequisite scope binds durable Submission, Session identity/owner/Project/
  revision, connection map, authoritative limits, operation and explicit selection.
  Check evidence is one-use invocation evidence, not an authorization grant.
  Dispatch rereads live facts and rejects changed binding/authentication/scope/
  credential-source facts before SDK execution:
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/src/runtime/tools/super-link/prerequisite.ts:69-108,227-290,307-323`;
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/src/runtime/tools/super-link/index.ts:31-38,99-105`.
  Existing durable execution identity remains the SDK idempotency input; rechecking
  is not permission for arbitrary replay.

Personal Connector authorization can remain Project-level. Its Model calls native
`connections.authorize/getAttempt`; the public attempt DTO intentionally contains
status/redirect/expiry, not a Chat Session or the full SDK connection:
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/api/src/models/connectors/index.ts:37-47`;
`/Users/apple/code/.worktrees/sp-eval-20261110/packages/contracts/src/connectors.ts:22-33`.
That DTO does **not** need a fabricated Session field to claim coordination.
On the subsequent normal parent business-operation prerequisite/recheck, SP
resolves the existing Session server-side, reads owner-scoped account facts and
performs the CAS above. The SDK's authorization response need not mutate an old
in-memory view; SP explicitly refreshes it. Models still cannot start authorization:
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/src/runtime/tools/super-link/index.ts:81-90`.
The remaining native authorization UI bridge is described in section 3, not
reclassified as missing SDK connection-patch support.

### Exact Runtime .32 gate: verifiable temporary-child invocation authority

Temporary Agents can consume an existing parent binding but never PATCH it.
Their first unbound operation remains configuration-required until a trusted
parent operation binds that account. The parent binding reader already validates
owner/Chat/Project:
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/src/chat/severn-agent.ts:1929-1945`;
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/src/runtime/tools/super-link/session.ts:76-84,141-164,232-235`.
This is not merely an unavailable SP RPC declaration:

- Public native `PiToolPrerequisiteContext` supplies Submission/request/Tool-call/
  Tool-name/signal inside its callback, but no transferable, publicly verifiable
  active-invocation authority:
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/agent-runtime/src/tools/runtime/contracts.ts:40-77`.
  The callback itself is trusted locally and may close over Host dependencies;
  serializing its IDs across a DO RPC does not transfer that native attestation.
  Initial scope/check execute **before** the durable wait row is inserted:
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/agent-runtime/src/tools/runtime/prerequisite-gate.ts:40-48,80-99`.
- The public Runtime control surface exposes Submission lifecycle, not a verifier
  for current validated Tool input/decision state. `SubmissionReceipt` has no
  pending Tool identity/input; displayed prerequisites and canonical history do
  not replace live native wait authority:
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/agent-runtime/src/adapter/cloudflare/define-agent.ts:173-326`;
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/agent-runtime/src/submission/contracts.ts:115-134`;
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/agent-runtime/src/conversation/state.ts:95-105`.
- Public `dynamicAgents.has/get` can establish scoped child membership and reopen
  its stub. Browser WebSocket RPC rejects unannotated methods. Both safeguards
  exist, but neither proves a particular child's current pending operation:
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/agents/dist/agent-routing-CDbpVjYq.d.ts:965-1004`;
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/agents/dist/src-DfLzdwlK.js:2047-2049`.
  Native RPC context sets `agent: this` for the **callee**, with no originating-child
  or native-invocation proof. An internal/non-browser call or serialized pending
  tuple alone is insufficient:
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/agents/dist/src-DfLzdwlK.js:1522-1533`.

**Owner/exit gate:** UA must supply public verifiable current invocation/input
authority, including the initial pre-wait case and current cancellation/decision
state, before SP can safely coordinate child-requested parent mutation. Preserve
fail-closed behavior meanwhile. No fake parent mutator, private Kernel/SQL access,
copied pending registry, autonomous authorization, multi-account auto-selection or scope
widening was added. This is an exact `.32` public-authority limitation, not a
claim that every newer upstream version lacks the capability.

### Verified local proof, not live-account acceptance

The completed implementation check used the serialized lock, installed bins,
`NODE_OPTIONS=--max-old-space-size=1536` and Vitest `--maxWorkers=1`:
`./node_modules/.bin/vitest run --project unit src/runtime/tools/super-link --maxWorkers=1 --reporter=dot`
passed **4 files / 63 tests**. The creation-scope test was observed RED before
removing the obsolete stored field. Tests exercise actual Chat Session and
production Tool prerequisites with external SDK/fetch/storage/DO transport fakes:
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/src/runtime/tools/super-link/prerequisite.test.ts:185-295,475-568`;
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/src/runtime/tools/super-link/session.test.ts:87-212`.
They include stale authorization/scope rejection, claimed-child-invocation
non-authority, no temporary PATCH, and same-invocation recovery/dispatch after
parent binding. No automatic coordinator RPC success is claimed.

The same local Agent `tsc --noEmit --pretty false` reported only the two known
installed Space errors: `tokenExpiresAt` and `remote` at
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/space/src/space/artifacts-sync.ts:161,170`.
These earlier executed local checks were **not rerun** for this document.
They do not prove live OAuth/account acceptance, deployed resolver parity,
native UI closure or temporary-first automatic binding.

## 3. Runtime .32 response path and installed Web boundary

The Runtime **already** exposes
`respondToolInteraction(fullPrerequisiteResponse)` publicly. The response must
include `id`, `submissionId`, `toolCallId`, `toolName`, `scopeKey`, `version` and
`decision: "recheck" | "declined"`:
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/agent-runtime/src/tools/runtime/prerequisite-contracts.ts:9-30`;
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/agent-runtime/src/adapter/cloudflare/define-agent.ts:221-231,637-641,1115-1118`.
It checks the live wait/Submission, rederives scope and calls the Host checker
before resuming; a browser decision is never account-authorization truth:
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/agent-runtime/src/adapter/cloudflare/agent.ts:2025-2085`;
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/agent-runtime/src/tools/runtime/human-decisions.ts:67-127`.
Prerequisite decisions intentionally bypass the ordinary answer/attachment
preparation hook; implementing authorization in that hook would miss this path.

Installed Web versions are chat-client **`0.3.0-alpha.18`** and message-panel
**`0.3.0-alpha.16`**:
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/web/node_modules/@springbrand/chat-client/package.json:1-3`;
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/web/node_modules/@springbrand/message-panel/package.json:1-3`.
The supplied helper is still string/answer-only and sends two arguments:
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/web/node_modules/@springbrand/chat-client/src/use-universal-agent-chat.ts:131-140,1323-1338`.
The installed renderer likewise accepts only that answer callback:
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/web/node_modules/@springbrand/message-panel/cloud-os/chat/cloud-os-chat-messages.tsx:120-126`.
SP passes it directly:
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/web/src/features/chat/chat-route.tsx:987-1005`.
This path cannot substitute for the full prerequisite-response protocol.
This is a statement about the supplied helper/renderer, not a claim generic RPC
cannot carry an object. Upgrade their **owning public packages** for prerequisite
projection/response/render slots, then connect SP's business authorization flow;
do not add an app-local clone or modify UI/node_modules during this audit.

This remaining Channels/Web authorization bridge must preserve the full native
wait identity and Host-owned authorization/recheck flow. It is separate from the
implemented normal Chat binding on a business-operation recheck after personal
Connector authorization, and from the missing cross-Agent invocation authority
in section 2. Neither a browser-supplied account nor a new Session field in the
Project-level attempt DTO is a substitute.

## 4. Unattended governance blocks invocation; it does not prune declarations

**Confirmed for exact published Runtime .32:** `unattendedMode: "forbidden"`,
interaction requirements and mandatory approvals are rejected by the scheduled
**invocation gate**, with an unattended failure:
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/agent-runtime/src/tools/runtime/decision-gate.ts:302-336`.
Compilation maps every supplied candidate and authorizes inside execute:
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/agent-runtime/src/tools/runtime/compiler.ts:138-172,195-218`.
The Kernel passes the same candidate set to compilation and activation:
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/agent-runtime/src/adapter/cloudflare/agent.ts:1256-1272`;
activation excludes only initially inactive candidates:
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/agent-runtime/src/tools/runtime/activation.ts:21-40`.
The native Conversation receives those active Tools; only wrap-up clears them:
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/agent-runtime/src/harness/session-harness.ts:621-634`.
Separate static deny/allow policy can remove declarations, but is not automatic
scheduled metadata filtering:
`/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/agent-runtime/src/config/assembler.ts:192-227,245-281`.

Consequently SP's forbidden `manage_connections` declaration can still reach a
scheduled model request unless independently excluded. Do not report invocation
safety as declaration pruning. If pruning is a requirement, the owner is
upstream Runtime's per-Submission model Tool surface; do not duplicate its kernel
in SP or fabricate a Host `isUnattended` Boolean.

## Handoff / verification limits

Remaining public owners are Space, Runtime's current-child-invocation authority,
chat-client/message-panel's native prerequisite UI bridge, Runtime/Pi provider
integration, Agents safety parity, and (if declaration pruning is required)
Runtime's per-Submission declaration surface. Normal Chat Session binding is
implemented SP business logic, not an open generic SDK gate. The parent owns
integration status, publication/package adoption and final acceptance reporting.
None requires moving Eval responsibilities into SP, private implementation
imports from EP, or EP access to SP DO storage; raw Pi remains the sole
trajectory source and artifacts remain primary evaluation evidence.

Rules, package boundaries and the Research skill were read before this update.
Bounded local file reads (`ls`, `cat`, `nl`, `sed`, `grep`, `find`, `wc`) followed
the remediation plan's claims back to actual installed sources and patch files.
No additional agents, tests or typechecks were launched; no installs, network,
live DB/SDK calls or package/source edits were performed. Only this findings
document was edited. Section 2 explicitly distinguishes earlier verified local
execution from source-inspected test specifications elsewhere; neither is
deployment or live-account proof.

## 5. Explicit UA/SDK handoff after target-only authorization

The following are open capabilities, not SP/EP fallback implementations:

| Owner | Missing public behavior / exit criterion | Target treatment |
| --- | --- | --- |
| Runtime CodeMode/reminder facts | Structured execute failure reasons from the actual registry/validator, attached to native call and Submission identity. Native `isError` or projected error text alone cannot establish method/argument-failure provenance. | Keep local private-message parsing, execution observers and invented failure events removed. Keep supported native successful-execution guidance. No blanket failure-to-Schema inference. |
| Runtime/Pi provider integration | Preserve native URL image/document inputs, native Anthropic blocks and their types through the permitted public dependency graph, without an application package patch. | The migration-added Responses conversion hunk is removed from source. No Host serializer, payload repair clone or transitive-version override replaces it. The inherited Pi patch remains explicitly inherited debt, not new acceptance proof. |
| Agents lifecycle | Public behavior equivalent to the existing patch's durable pre-arm/strike, guarded executing-job recovery, independent reset and once-only terminalization. | Keep inherited safety until parity is proven. Do not remove OOM protection, copy the alarm loop or cast private SDK interfaces. |
| Space | Correct Artifacts platform APIs, directory mutation cursor and safe transfer guarantees documented in section 1. | Keep the public adapter; no replacement filesystem or ambient-type mask. Required tests stay acceptance gates. |

Primary source anchors for the first three rows:

- `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/agent-runtime/src/config/ports.ts:321-332,1197-1201`;
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/agent-runtime/src/harness/reminder-facts.ts:38-44,368-382`;
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/agent-runtime/src/tools/codemode/adapter.ts:182-215`.
  The public Port returns `AgentToolResult<unknown>` for code/signal; projection
  summarizes failed calls and truncates error text, not an authoritative
  reason category. The registry/validator owner must emit the missing facts.
- `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/agent-runtime/package.json:32-40`;
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/node_modules/@springbrand/agent-runtime/src/conversation/canonical-context.ts:5-9`;
  `/Users/apple/code/.worktrees/ep-main-20261110/node_modules/.pnpm/node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js:198-218`;
  `/Users/apple/code/.worktrees/sp-eval-20261110/patches/@earendil-works__pi-ai@1.4.0.patch:1-78,92-245`.
  Original Pi's Responses converter maps non-text input to a base64 image, not
  native URL image/PDF blocks; fixed `.32` also imports the extended native types.
  The migration-added Responses hunk is absent from the current patch. Remaining
  native Anthropic/types/estimator/validation hunks are inherited baseline debt,
  not new work or no-patch acceptance. A public owner solution must prove native
  type/schema, serializer, estimator and validator parity through the allowed
  fixed-version graph; no SP serializer or transitive override replaces it.
- `/Users/apple/code/.worktrees/sp-eval-20261110/patches/agents.patch:99-278`;
  `/Users/apple/code/.worktrees/sp-eval-20261110/patches/agents.patch:51-65`;
  `/Users/apple/code/.worktrees/sp-eval-20261110/apps/agent/src/alarm-memory-limit-breaker.worker.test.ts:83-185`.
  Retained inherited OOM safety durably pre-arms strikes, guards executing-job
  recovery by ID/start time, seals once on a later wake and attempts reset even
  if sync fails. These patch/test sources specify the parity gate; this document
  does not claim a newly executed OOM suite or an unpatched SDK replacement.

These are installed-artifact/source findings, not a claim about every newer
upstream checkout or registry release. User edits in UA are not edited or
assumed published by this task. Exact Runtime `.32` remains fixed.

Do not classify the following as UA blockers: stale policy writes, Card/policy
publication readiness, reminder balance meaning/freshness, duplicate settlement
snapshot schemas, generic page-grammar duplication or the now-implemented normal
Chat Session binding coordination. Those belong to authorized SP/EP work. The
distinct public current-child-invocation authority gap in section 2 remains
UA-owned; do not hide it behind a fabricated parent mutator.
