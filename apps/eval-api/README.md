# @eval-platform/eval-api

## Pi-native SP seam (new runs)

The service-authenticated SP Harness consumes SP's **public**
`@springbrand/eval-harness@0.1.0-alpha.7` wire for the supported finalized
reads. The coordinated producer implements
`sp-pi-trajectory/v1` pages with a frozen `cursor.throughSeq` and safe
`pi-trajectory/v1` records or an explicit oversized-record reference, and
resource snapshots carrying `nativeRecords` instead of `telemetryEvents`.
The npm-published alpha.7 artifact is pinned exactly and its installed public
schemas validate evidence and resource headers/pages. It does **not** export
`allowPartial` request types, readers, or path helpers (nor the partial billing
`throughSeq` and record-byte `resourceKey` binding). The explicit post-wait
partial query extension below remains unverified structural HTTP behavior.
Do not deploy this cutover or claim cross-deployment parity until SP publishes
the missing partial contract and actual service responses are verified. No
legacy event decoding or DO storage access is used. Existing
version 1 manifest bytes/refs, resource bytes and scores remain untouched;
old event-only evidence may not be readable with this new code.

The `submissionId` on an evidence trajectory GET authenticates/binds its frozen
watermark, but the response contains the **whole safe Chat trajectory**, including
imported reference Context (`submissionId:null`) and earlier Submissions. Export
verifies each record's safe projection and Chat/parent Chat identity, then keeps
every original `{ingestSeq,record}` in the evidence JSONL without filtering or
rewriting it. Resource snapshots/usage/billing still belong only to the selected
operation and Submission; the Evaluator's final-reply fallback considers only
the selected Submission's own assistant messages. The current JSON page ceiling
is 4,000,000 bytes. A larger single SAFE record occupies one reference, whose
`identity`, byte length, SHA-256 and `throughSeq` bind an authenticated
`GET /evidence/trajectory/records/{ingestSeq}?submissionId=&throughSeq=&identity=&byteLength=&sha256=`.
The body contains the exact UTF-8 `TrajectoryRecord` JSON, streamed in bounded
parts; the adapter verifies headers, length, digest, native identity, Chat
and parent Chat before storing one original JSONL line. The selected Submission
is the authorization, not an evidence filter. A record larger than the SP evidence-file limit
still fails explicitly at a record boundary. The API HTTP page seam uses the
published schemas and record-transfer path; the browser-safe `eval-contracts`
model and bounded byte scanner retain their local safety/storage checks. Real
SP deployment behavior is still unverified.

**Evidence and bounded resource-page streaming are wired locally, but not released.** The SP Harness
now calls `src/sp/native-record-stream.ts` on its authenticated record GET and
feeds the verified original JSONL bytes to `EvidenceStore`. The store freezes
the cursor before reading any bytes and streams whole records into immutable
parts; the R2 adapter uses a temporary file to sign and stream rather than
buffering a whole part. Strict UTF-8, JSON, length, hash, actor, Chat, parent
and Context/Submission are checked before a record completes. The selected
Submission's final-reply fallback also drains referenced records without a
large parsed object. Existing v2 inline JSONL bytes and historical manifests
remain unchanged. Focused tests cover 5+ and 30+ MiB streamed records, R2
uploads, resumed cursors and failures without partial success.

`collectAgentResources` never calls or parses the combined resources JSON.
It reads a small `/header`, frozen `sp-pi-trajectory/v1`
`/native-records` pages and separately fingerprinted, paired `/billing`
pages (200 entries/4 MB each), rechecks the full billing fingerprint (even
after a single page), then checks the header again. Before the resource wait
deadline, Runtime only polls readiness. Afterwards it explicitly opts into a
partial read of already-known facts with `allowPartial=true` on the header,
native and billing pages; partial billing pages also bind the header's
`throughSeq`. Referenced native bytes use the same existing service-auth
endpoint with `allowPartial=true&resourceKey={key}`. The source must keep the
same native cutoff, paired billing fingerprint and header through the entire
download; a changed source or interrupted page never becomes partial success.
Oversized SAFE
Pi records still use the authenticated evidence byte route and contribute
only body-free compact facts to the new resource download. An overly large
Tool body is **unknown**, not a fabricated zero-byte value; model usage,
model settlements and Action/Tool charge IDs remain independent. A temporary
private spool holds one bounded compact row/page at a time, never an entire
`nativeRecords` or billing array in JS; the Store projects it into the
existing two JSON columns atomically with the Attempt revision and deletes
the spool after save/failure. A nonfinalized header without post-wait opt-in
is still pending; an opted-in read retains only verified facts, with
`finalized:false` and `coverage.partial` for missing/unsettled rows rather
than invented zero usage or complete billing. Historical raw resource rows
and v1/v2 evidence bytes are not migrated.

**Release blocker:** The installed npm alpha.7 publishes finalized header,
native/billing page, evidence and record-byte schemas/paths, but not the
post-wait partial route/query contract. Its billing builder rejects
`allowPartial`/`throughSeq`, while its other builders omit partial parameters.
Local mock tests still exercise the explicit opt-in; they are **not** proof that
the pinned SP artifact or a deployed SP accepts it. An isolated PostgreSQL 18.3
regression now verifies the paged Harness → Runtime → Attempt Store transaction,
including typed `json_build_object` parameters; the old untyped SQL fails with
`42P18` before saving any resource snapshot. Publish a compatible public partial
API and verify real deployed SP+API reads before end-to-end parity or release.
No SP private source is imported.

内部评估控制面的应用组合层：Hono HTTP 控制面、PostgreSQL 适配器（`DatasetStore`、Project 快照存储、`ProjectPlanReader`、`RuntimeStore`、只读 `MetricsSource`）、Project 创建与评估计划服务（含 Agent Config 冻结副本）、Eval SP 客户端与 SP Harness，以及 pg-boss Run Worker。不增加第五个共享包。设计见 [Project、Runtime 与 Metrics 设计](../../docs/eval-project-redesign.md)。

### Management MCP Interface

`POST /mcp/eval-management` is an independent, stateless JSON-RPC 2.0 control plane for a **trusted server-side Moss adapter**. Send `Authorization: Bearer <EVAL_MANAGEMENT_MCP_TOKEN>` and `Content-Type: application/json`; do not put the token, service account, actor, files or URLs in tool arguments. The optional secret must have at least 32 characters; when unset the endpoint is 404. Invalid/missing Bearer is 401; GET/DELETE/PUT/PATCH are 405 with `Allow: POST`. `initialize` (supported versions as for `/mcp/evaluation-results`), `ping`, `tools/list` and `tools/call` are stateless; an ID-less notification has no effect (202). Tool failures return MCP `isError` text with a safe error code/message, not raw SP/DB diagnostics. Each authenticated call uses and releases one fixed-account `OwnerServices` lease; no caller can select another owner. `EVAL_RESULT_MCP_TOKEN` and `EVAL_WEB_API_TOKEN` do not authorize this endpoint, and its token cannot authorize `/mcp/evaluation-results`. Never register this management MCP on an Agent Config: only Evaluators receive the **other** MCP's `submit_evaluation`.

This slice advertises **only seventeen** management tools; catalog `page` defaults to 1 and `pageSize` to 20 (maximum 50), while `get_metrics` defaults to **5** rows/fields per page and `get_preparation` pages at most 10 cases. The six new Material/Session option categories clamp that catalog page size to **5**. IDs, selectors and Project bodies use the existing Eval schemas; MCP JSON requests are limited to 1 MB except `create_output_schema`, which has a `MANAGEMENT_OUTPUT_SCHEMA_BODY_BYTES` (6,018,496) JSON-escaping allowance for its 1 MB `OUTPUT_SCHEMA_BYTES` content and bounded labels/key. Run preview/submit/reconcile are limited to 50 fixed targets (narrower than HTTP). Toolkit pagination uses an opaque cursor instead of `page`. Ordinary tool text remains capped at 32 KB; `get_metrics` permits at most 10 MiB of complete sanitized UTF-8 JSON tool text (and 10 MiB of characters). Each **complete displayed** Schema or Evaluation JSON document also has a 10 MiB UTF-8 limit; this is separate from the 2,048-byte/4,800-byte **per-continuation** budgets and the 16 KiB threshold for using the one-shot verified documents GET. `list_options(output_schemas|output_schema_detail|project_schema_detail|material_bundles|session_bundles|materials|sessions|material_files|session_files)`, new `bind_data_resources` / `get_preparation(kind:"bind")`, and selected Evaluation JSON continuations still fail explicitly above 4,800 bytes or characters. The trusted Takt adapter must verify the complete Metrics result before giving a large safe projection to Moss as a sandbox file; simply putting 10 MiB inline would exceed the Agent runtime's 1 MiB durable Tool-result limit. Reads paginate/sanitize model-visible results; no unbounded prompts, SP credentials, raw resource snapshots or binary files:

| Tool | `tools/call` arguments | Result / boundary |
| --- | --- | --- |
| `list_options` | `{category:"agents" \| "datasets" \| "dataset_data" \| "projects" \| "project_detail" \| "output_schemas" \| "output_schema_detail" \| "project_schema_detail" \| "material_bundles" \| "session_bundles" \| "materials" \| "sessions" \| "material_files" \| "session_files" \| "input_limits" \| "credits", q?, page?, pageSize?, datasetId?, projectId?, outputSchemaId?, schemaOffset?, bundleId?, materialId?, sessionId?}`; `materials`/`sessions` require `bundleId`; `material_files`/`session_files` require `bundleId` and their matching `materialId`/`sessionId`; all six forbid unrelated selectors/filtering and return at most five entries per page. `dataset_data` requires `datasetId`, forbids unrelated selectors/filtering, and pages at most five members. `project_detail` requires `projectId` and pages its bound Datasets. `output_schema_detail` requires `outputSchemaId`; **`project_schema_detail` requires only `projectId`**. Both permit only `schemaOffset` (byte cursor, default 0; catalog paging/filtering is forbidden). Trusted adapter also uses `approval_dataset` (`datasetId,dataIds?,page,pageSize<=10`), `approval_agent` (`userAgentId`), `approval_output_schema` (`outputSchemaId`), `approval_project` (`projectId,projectSampleIds,samplingIds,page,pageSize<=10`) | Choice IDs/names, limits or credits. New Material/Session choices contain only active owner-scoped metadata; exact page/item shapes below. `dataset_data` returns only safe Data IDs/names and a verified `order`; see exact contract below. `project_detail` returns the owned frozen Project's case count, Agent names and plan-bound Schema ID, never its content. `output_schema_detail` uses the **active owner-scoped** catalog record; unknown, foreign and deleted entries are unavailable. **`project_schema_detail` reads the Project-bound, plan-digest-checked Schema even if the original catalog entry is renamed or deleted.** It returns `{category,projectId,outputSchemaId,digest,sourceRedacted,schemaChunk,streamRequired?,display?}`; `digest` identifies the original frozen Schema body, whereas `display.sha256` authenticates only the sanitized displayed JSON. Both use bounded `schemaChunk` continuations for small documents or `streamRequired:true`/the fixed trusted GET for large ones. A Project without an evaluation plan has no Schema; absence of numeric fields is **not** evidence of that. Dataset approval reads the same consistent selected-source snapshot that ProjectService will freeze, and returns its complete digest across pages. Agent approval hashes the owned public SP body; output Schema approval hashes the complete owned catalog record (ID, mutable name/description and immutable Schema body), not just its display name. |
| `prepare_inputs` | `{operationKey, promptUploadRef, name, description, format:"json" \| "jsonl", cases:[{initialMaterials?,evalInitialMaterials?,initialSession?}]}` | Exactly one case mapping per prompt row (at most 50). Material selectors are `{uploadRef}` or owned `{bundleId,materialId}`; an optional Subject-only Session is `{uploadRef,format}` or owned `{bundleId,sessionId}`. Creates/reconciles a Prompt Dataset and separate Material/Session Bundles, then binds each Data and reads it back. On success returns only the compact `{operationKey,kind:"prepare",status,datasetId,totalCases,resources:{total,confirmed}}` (<5 KiB, no inline case/resource lists); never starts a Run. |
| `bind_data_resources` | `{operationKey,datasetId,dataId,expectedContentDigest,initialMaterials?,evalInitialMaterials?,initialSession?}` | Binds one **existing** Data belonging to the selected existing Dataset. At least one field is required. Each Material field is a complete ordered replacement of 1–8 `{bundleId,materialId}` or `{uploadRef}` entries, or `null` to clear; omitted fields stay untouched. Session is `{bundleId,sessionId}`, `{uploadRef,format:"json" \| "jsonl"}` or `null` to clear; omitted stays untouched. `expectedContentDigest` is the lowercase full Data `approval_dataset.items[].contentDigest` from before binding. No new Dataset/Data or Run. Success is `{operationKey,kind:"bind",status:"completed",datasetId,dataId,contentDigest,resources:{total,confirmed}}`; the post-bind digest is only a binding receipt, not an approval Dataset digest. |
| `get_preparation` | `{operationKey,page?,pageSize?}` | Existing `prepare` still reports durable status, planned Dataset ID and one page of Data binding/Material/Session receipts (default/max 10 cases). New `bind` returns `{operationKey,kind:"bind",status,datasetId,dataId,expectedContentDigest,contentDigest,binding,page,pageSize,initialMaterials?,evalInitialMaterials?,initialSession?,resources:{total,confirmed,items}}`: only supplied fields resolved to planned/existing references and a page of `{kind,bundleId,resourceId,status}` new-resource receipts (default/max **5**, even if a valid requested `pageSize` is 6–10), **no** original Data or bytes. It also reports safe unknown-outcome state for file/Agent library and output Schema operations. An output Schema receipt contains only `{outputSchemaId,name}`. Never original prompts, Schema content, bytes or attachment URLs. |
| `search_agent_resources` | `{kind:"models" \| "skills" \| "action_groups" \| "actions" \| "connector_components" \| "extensions" \| "toolkits" \| "references", q?, page?, pageSize?, supplierId?, unassigned?, cursor?, id?}` | Live allowlisted SP catalog, concise selectable metadata. Actions require `supplierId` or `unassigned:true`; `action_groups` finds these groups. `id` reads one Action or Reference detail. `cursor` is only for Toolkit pages (status, never connection IDs or credentials). |
| `upload_agent_skill` | `{operationKey,uploadRef,name,overwriteExistingSkill?,existingSkillId?}` | Reads a staged Skill ZIP, checks its actual `SKILL.md` name and current SP library. SP's ordinary POST has no conditional create, so **every write** requires explicit user approval for a possible overwrite (`overwriteExistingSkill:true`); if a same-name Skill exists, also supply its exact approved `existingSkillId`. The trusted adapter enforces approval, never a model assertion. Returns the active Skill ID only after an affirmative public SP receipt. |
| `upload_agent_reference` | `{operationKey,uploadRef}` | Uploads the staged Reference bytes as a public attachment, saves its validated attachment receipt, then creates and verifies the Reference via the public SP library; returns only the Reference ID. No URL or attachment bytes in model output. |
| `create_output_schema` | `{operationKey,name,description,content}` | The trusted Takt backend downloads and validates the verified Feishu JSON attachment and sends its text **server-side**, never through model context. Eval validates the same draft 2020-12 JSON Schema and `OUTPUT_SCHEMA_BYTES` as its owner-scoped catalog. Result is **only** `{outputSchemaId,name}`; no content, upload ref, URL or extra model-visible text. The owner/key/normalized labels/exact-content SHA-256 fingerprint and planned ID live in the existing durable management operation/stage receipts (not a second Schema store); replay verifies that exact owned ID, labels and parsed body before confirming. An attempted write with no provable matching row stays `outcome_unknown`, never repeats that write under the same key. Like ordinary HTTP catalog creation/editing, distinct operations may use identical or case-variant names and yield different IDs; Moss must use the receipt ID, never infer identity or success from a name. A new key must not be used to retry an unknown write. |
| `create_agent` | `{operationKey, name, description?, purpose:"execution" \| "evaluation", instructions, modelId, skillIds?, referenceFileIds?, actionIds?, connectorToolkitIds?, connectorIds?, extensionIds?}` | Creates an Agent via the live SP default template and active resource lookups. Explicitly selected, connected Connector Toolkits map to `{kind:"connector_toolkit",serverId}`; active Connector/Extension Components use their own ID lists. The caller cannot supply Config JSON, managed MCP server IDs or URLs; Eval alone syncs the Evaluator result MCP. `operationKey` deterministically yields a slug; identical replay checks the active owned body and purpose, differing facts conflict. Only a proven new insertion may be deleted on purpose-write failure. |
| `create_project` | `ProjectCreateBody` plus required `expectedSnapshots:{datasets:[{datasetId,digest}],executionAgent,evaluationAgent?,outputSchema?}`. Dataset entries correspond exactly, in order, to `datasets`; evaluating creations require both optional digests, execution-only forbids them. Digests are lower-case canonical SHA-256 from approval views; `outputSchema` is the **full catalog record** approval digest, not the evaluation plan's body-only digest. Ordinary HTTP Project creation can omit `expectedSnapshots` because it has no Takt approval. | Bounded `{project:{projectId,name,createdAt},run:{runId,samplingCount}\|null}` from `projects.create`: the existing selection/Schema/freeze seams reject a mismatched reviewed digest **before** persisting. The first Run uses the creation key and the persisted Project plan digests. Replay uses the existing durable fingerprint. A management Prompt Dataset cannot start a Project before every Data binding is confirmed. SP source reads/copy creation cannot share an atomic DB lock; the frozen copy derives from the source bytes checked against the supplied digest, and later source changes cannot alter the copy. |
| `preview_run` | `{projectId, operation, selector}` | Existing `admission.preview` with fixed `targets` and **prospective** count estimates. Never evidence of completed evaluations or current scores. No mutation. |
| `submit_run` | `{projectId, idempotencyKey, operation, selector, targets, expectedPlanDigests:{execution,evaluation?}}`, both digests and targets copied from the reviewed `preview_run` | Only bounds input then delegates **once** to Runtime `admission.submit`; no management pre-preview, alternate replay or hidden flag. Runtime first checks a stored Project/key/exact-intent Run, then for new keys verifies the approved plan digests and selector/targets again under the Project DB lock. Returns `{runId,samplingCount}`; a stale plan/target never starts work even if the targets still match after a plan replacement. |
| `reconcile_operation` | `{kind:"run",request:{projectId,idempotencyKey,operation,selector,targets,expectedPlanDigests?}}` or `{kind:"project",request:original ProjectCreateBody}` (including `expectedSnapshots` if originally supplied). Only the **read-only Run branch** may omit `expectedPlanDigests`, to look up a persisted legacy Run. | Uses `admission.replay` / ProjectStore's existing creation-key/fingerprint read, **not** `submit` or `create`. A found Project Run must also match the creation's first-Run operation, `{all:true}` selector, complete frozen targets/plan digests, request fingerprint and first sequence; otherwise `RUN_IDEMPOTENCY_CONFLICT` (not success). A matching operation returns `{projectId,runId,samplingCount}` (current retained Run membership count); mismatched ID/body conflicts. Missing Project/Run returns `PROJECT_NOT_FOUND`/`RUN_NOT_FOUND`; a stored Project without its own first Run returns `OPERATION_OUTCOME_UNKNOWN`, never a false success or a new Run. Does not preview targets, read live plans or write any fact. |
| `stop_run` | `{projectId, runId}` | Existing Project-scoped Run stop; never an implicit/current Run. |
| `get_run` | `{runId, page?, pageSize?}` | Status/phase/operation, ID counts and one page of Sampling/Evaluation IDs, not full records. |
| `get_metrics` | `{projectId, runId?, scope:"project" \| "dataset" \| "sample" \| "sampling", datasetId?, projectSampleId?, samplingId?, section?:"overview"\|"samples"\|"tools"\|"fields", role?:"execution"\|"evaluation", page?, pageSize?, toolPage?, toolPageSize?, numericPointer?, evaluationId?, resultOffset?}` | Without `runId`, **every scope** reads currently retained owner-scoped Project facts (`runScope:"project_current"`), not a latest-Run score. With `runId`, the exact-Run filter (`runScope:"exact_run",runId`) still requires current membership after replacement. Exactly the matching scope ID is required. **Breaking default for Project/Dataset:** omitted `section` means `"overview"` rather than the old combined summary+samples+both roles' Tools+fields. No second combined Project response exists. Those scopes return only `{scope,section,project,runScope,runId?}` (Dataset adds `datasetId`) plus their section's payload: `summary` for overview (complete counts/stages including Attempt status/duration, role-separated coverage/cache/tokens/costs/success, output coverage/validation, already-available frozen `evaluationOutputs.schema:{outputSchemaId,digest}|null`, selected numeric `evaluationOutputs.scoreField`, and `evaluationOutputs.fields.total`, **no item lists/byTool**); `projectSamples` and (for Project) `datasets` for samples (with each Sample's existing `scoreIndex` and paged Sampling IDs); **one** `executionAgent` or `evaluationAgents` `{byTool:{page,pageSize,total,items}}` for tools, selected by the required `role`; or `evaluationOutputs:{fields:{page,pageSize,total,items}}` for fields (only numeric/boolean/enum Metrics fields; plain free text does not count). `page/pageSize` apply to samples/fields, `toolPage/toolPageSize` only to tools (default 1/2, max 5); `numericPointer` (default `/score`) selects the overview's overall `scoreField` or Sample rows' `scoreIndex.field` in samples, but is forbidden for tools/fields/Sample/Sampling. `role` is only valid for tools. Per-Tool rates and scores are forwarded from existing Metrics, not recomputed. `scope:"sample"` and `"sampling"` (including selected-only `evaluationId`/`resultOffset` response) retain their existing contract; they do not accept `section` or `role`. |
| `inspect_case` | `{projectId, runId?, samplingId, evaluationId?}` | Without `runId`, requires a **current** owned Sampling (and selected Evaluation, if any) in that Project. With `runId`, requires the original exact Run/Sampling/Evaluation membership **and** current members. Returns bounded Sampling/Subject resource Metrics, selected Evaluator Metrics, result excerpt and internal evidence references. It does not return trajectory bytes or a continuation cursor. The existing Project Metrics toolSuccessRate, cache/tokens and ID drilldown are unchanged. |

**Existing Material/Session discovery:** `list_options` accepts the six exact
categories `material_bundles`, `session_bundles`, `materials`, `sessions`,
`material_files`, `session_files`. All return
`{category,bundleId?,materialId?,sessionId?,page,pageSize,total,items}`:
the optional top-level IDs echo only the required selection. Bundle pages
need no IDs and contain `{bundleId,name,description}`; `materials` requires
`bundleId` and returns `{bundleId,materialId,name,description,byteSize}`;
`sessions` requires `bundleId` and returns
`{bundleId,sessionId,name,description,format:"json"|"jsonl"}`;
file pages require `bundleId` **and** `materialId` or `sessionId` respectively,
and return only `{path,mediaType,byteSize}`. Each item may additionally mark
`sourceRedacted:true` and `nameTruncated`, `descriptionTruncated`,
`pathTruncated` or `mediaTypeTruncated` when applicable. Names/descriptions are
redacted before truncation to 80/120 UTF-16 code units, paths to 160 and media
types to 80. A sensitive filename/path or metadata is fully masked, never
partially excerpted. Bundle/resource IDs are validated UUIDs, never arbitrary
catalog strings. Only active resources belonging to the fixed owner are
selectable; wrong-kind, deleted, foreign and unknown choices fail closed. No
`q`, Data/Project selectors, source content, private URL or binary bytes can
appear in these pages. `page` is 1–10,000; the existing catalog
`pageSize` default 20 and valid maximum 50 are clamped to 5; `total` counts
the entire selected active list and an out-of-range page has `items:[]`.
**Both** JSON-stringified result length and UTF-8 byte length must be at most
4,800; an over-budget page fails rather than truncating any item or changing
`total`.

**Guarded rebind of existing Data:** select the Dataset member explicitly
(`list_options({category:"dataset_data",datasetId})` for IDs,
`list_options({category:"approval_dataset",datasetId,dataIds:[dataId]})` for
its full `contentDigest`). Submit `bind_data_resources` with the original
digest and complete replacements for only the fields to change. `null`
removes a field, **not** a null resource; `[]` is not a valid replacement.
Subject `initialSession` never becomes Evaluator Session data. The first write
locks the owned active Dataset and Data, confirms current membership and no
pending upstream `prepare`, checks the entire original Data's canonical
SHA-256 under the Data row lock, then checks the entire next Data's catalog
references (including unchanged fields) for owner, kind, retained soft-deletes,
duplicate ordered Materials and each role's initialization byte budget.
An unmodified, retained soft-deleted reference may stay or move within its
original field; adding it to another field is a new selection and fails.
Updating a live Data changes no previously frozen ProjectSample, nor any
existing Project or Run.

Before `store.begin` or any new Bundle write for a **new** bind, EP locks the
owned Dataset/Data and checks the original full Data digest and membership. For
each supplied Material replacement it sums trusted upload-receipt byte sizes
**plus the owner-catalog byte sizes of all existing selected Materials**,
including active and soft-deleted references retained in that same Data field,
then enforces the separate Subject/Evaluator initialization budgets. Retained
does **not** mean zero bytes. A deleted Material newly selected for a different
field remains unavailable. This preflight does not trust model-supplied sizes
or expose file content; the atomic Data update still rechecks the full next
Data and budget under its row lock. An already-over-budget request creates
neither an operation nor an orphan Material/Session Bundle. Before any
outstanding Bundle write on a pending same-key replay, the same preflight uses
the persisted trusted upload facts; once the Data stage was attempted, all
resources were already confirmed, so no further Bundle write is needed.

The new `kind:"bind"` shares `eval_management_operations` with `prepare_inputs`
but has a separate versioned plan and fingerprint of the original request,
owner and trusted upload metadata (kind/name/mediaType/size/SHA-256). New
Material/Session uploads use the existing authenticated byte ingress and
single-resource planned Bundle IDs; an attempted write is reconciled by its
**exact planned IDs and stored bytes** before confirmation. A write with an
unknown result never receives a second resource identity. The Data binding
stage uses its stored original and planned post-binding **full Data digests**
to reconcile a lost response; it never silently restores data changed by
another editor. `get_preparation(kind:"bind")` reports the planned
`contentDigest` **even while pending**; only `status:"completed"` and
`binding:"confirmed"` establish that the bind was recorded (a later edit
still requires a fresh approval). The same owner/key/intent replays its
durable receipt **only while the current owned Dataset member still has the
planned full Data digest**; a changed/deleted/detached Data fails closed rather
than being restored. `get_preparation` remains a historical receipt if the
Data was later edited. A changed intent, a second pending bind of the same
Data (even via another Dataset), or reuse of an uploadRef under another key
conflicts before another resource is created. The pending bind fences `dataset_data`, `approval_dataset` and
management `create_project` for that Dataset. `prepare_inputs` and its
legacy `kind:"prepare",version:1` Dataset row-order proof remain unchanged;
a `bind` receipt never supplies file-row order provenance. If staged bytes
expire before an unconfirmed new resource can be reconciled, retain the
pending operation and use `get_preparation`/manual reconciliation; do not
start a new operation key to guess success.

`list_options({category:"dataset_data",datasetId,page?,pageSize?})` returns **exactly**
`{category:"dataset_data",datasetId,name:<safe Dataset name>,order:"upload"|"unknown",page,pageSize,total,items:[{dataId:<UUID>,name:<safe Data.name or null>,sourceRedacted?:true,nameTruncated?:true}]}`.
The owned, active Dataset must not have a pending Moss preparation **or binding**. `page` starts at 1; the shared default `pageSize:20` and any larger **valid** catalog size (at most 50) are clamped to **5**, and the response reports the actual size (5 for those inputs). `total` covers all current members, not just the page; a page beyond the end has `items:[]`. Source-authored names are redacted before bounded truncation (Data names at 80 UTF-16 code units; Dataset name at 100); null/missing/non-string Data names return `null`. The source's prompt text and arbitrary business fields, URLs and Material/Session references are **never** returned. The result including JSON escaping must fit 4,800 UTF-8 bytes/characters. `order:"upload"` requires **both** intact Dataset-level original-order provenance and valid stored positions for every member, or an owner-scoped completed original Moss preparation whose `plan.dataIds` and confirmed receipts prove the entire all-`NULL` membership of an untracked legacy Prompt Dataset. A real detach invalidates provenance durably, even if every row is removed and reattached with contiguous positions; a no-op detach does not. A completed plan cannot revive invalidated provenance or override known positions. Pre-`0012` Datasets with positions but no recorded provenance cannot prove their original file row and become `order:"unknown"`, even if unchanged in reality: a previous detach-all/readd is indistinguishable. Legacy UI imports without a valid plan are also unknown. Unknown order provides deterministic IDs for explicit `dataIds` selection, **not** an inferable first file row. The selected member order used in `approval_dataset`'s digest and Project creation is the same deterministic order, but `approval_dataset` and `expectedSnapshots` shapes and checks are unchanged; explicit Data ID selection still works.

An incidental `page`/`pageSize` on `overview` or `tools` does not add rows to those responses; only `samples`/`fields` use that page, and only `toolPage`/`toolPageSize` page Tools.

Project/Dataset `section:"overview"` `summary.evaluationOutputs.scoreField` is
`{jsonPointer:string,value:number|null,coverage:"complete"|"partial"|"unavailable",
observationCount:number,contributingEvaluationCount:number,missingEvaluationCount:number,
sourceRedacted?:true,jsonPointerTruncated?:true}|null`. It is the existing
`sampleScoreIndex(summary,numericPointer ?? "/score").field` for the **overall**
Project/Dataset Metrics summary, not an average of paged Sample rows, a Tool
success rate or a business pass rate. `value` is the selected numeric Metrics
field's precomputed `numeric.mean` (including zero); absent or non-numeric
pointers yield `scoreField:null`. A selected field with no usable observations
keeps its `value:null`, coverage and counts; a sensitive pointer keeps the
pointer/counts but masks the value with `sourceRedacted:true`. Select another
numeric Schema field with its exact `numericPointer`. The complete field list
remains exclusively in `section:"fields"`; neither missing nor redacted results
are filled from individual Evaluations or Sample rows.

**Metric/Schema continuations (read-only, model-visible):** Project/Dataset
`section:"tools",role:"execution"` returns `executionAgent.byTool`, and
`role:"evaluation"` returns `evaluationAgents.byTool`, each
`{page,pageSize,total,items:[{toolName:string|null,count:{value:number|null,coverage},completed,failed,cancelled,inProgress,unknown,coverage,toolSuccessRate:{value:number|null,coverage}}]}`.
They are separate source-backed pages of `ResourceStatistics.trajectory.byTool`;
the other role and the overview's resource totals are never copied into a tools response.
Sample/Sampling scope's original `summary.*.byTool` shape is unchanged.
`toolSuccessRate` is the **Metrics-supplied** value for each native Tool name:
`completed / (completed + failed + cancelled)` among that name's terminal calls,
or `null` when there are none; `inProgress`/`unknown` never enter the denominator.
Its coverage equals **that row's** `count.coverage` (including partial/unavailable),
not the overall role's coverage. Eval API and Takt must not recompute or average
this rate. `total` includes all rows, including a null/unknown Tool name.
An unsafe or overlong Tool name is masked with `sourceRedacted:true` on that row;
its counts remain native Metrics facts. Project/Dataset/field labels and bounded
field distributions similarly mark any source redaction or display truncation;
`distributionCount`/`distributionTruncated` distinguish an excerpt of >10 options
from a complete distribution. A numeric field whose JSON Pointer itself names a
sensitive value (e.g. `/token`) retains the pointer/count/coverage but masks
`numeric` as null (`numericRedacted:true`) and every distribution value with
`sourceRedacted:true`; a redacted null is **not** a zero or a missing score.
Other aggregate scores/counts themselves are not clipped.

Project/Dataset `section:"samples"` `projectSamples.items[].scoreIndex` is
`{evaluations:number,statuses:Record<SamplingStatus,number>,validation:Record<EvaluationValidationStatus,number>,
field:{jsonPointer:string,value:number|null,coverage:"complete"|"partial"|"unavailable",
observationCount:number,contributingEvaluationCount:number,missingEvaluationCount:number,
sourceRedacted?:true,jsonPointerTruncated?:true}|null}`. All facts come directly
from that row's **already computed** `summary.evaluation` and
`summary.evaluationOutputs`, for the requested numeric field (default `/score`);
`field:null` means no numeric Metrics field at that pointer, not zero. A field
with no usable observations has `value:null` and its source coverage/counts.
`value` is that field's `numeric.mean` over observed numeric **values**; multiple
Evaluations or an array field can contribute multiple observations, so it is
not an individual Evaluation score or the native per-Tool `toolSuccessRate`.
`statuses` are Evaluator stage statuses, **not** Subject/execution statuses;
`validation` distinguishes valid/invalid/unavailable outputs. Use
`section:"overview"` for the separate execution/evaluation resource summaries;
`runScope`/optional `runId` on each page identify current versus exact-Run facts. To index a different
Schema numeric field, pass its exact JSON Pointer as `numericPointer`; do not
infer a score from an arbitrary field or recompute it in Takt.

After paging Evaluation IDs at `scope:"sampling"` (without `evaluationId`), call
`get_metrics({scope:"sampling",projectId,samplingId,evaluationId,resultOffset?:number,runId?})`.
The selected-only response is
`{scope:"sampling",project:{projectId,name},runScope,runId?,projectSample,sampling,evaluationResult:
{evaluationId,outputStatus:"succeeded"|"failed"|null,validation:{status,reason},
contentHash:string|null,sourceRedacted:boolean,rawJsonChunk:JsonChunk|null,
streamRequired?:true,display?:{totalBytes:number,sha256:string}}}`.
`rawJsonChunk` is **null** for absent, malformed or unsafe-number output
(no `streamRequired`); it is also null with `streamRequired:true` and a
displayed-document digest when a parsed result is larger than the bounded MCP
continuation allowance. A parsed value withheld because a *key itself* is
unsafe has `rawJsonChunk:null,sourceRedacted:true` **without**
`streamRequired`. The real Metrics validation reason remains visible.
A successfully parsed result that violates its Schema (`schema-mismatch`) still
has its parsed JSON available by one of these paths **when displayable**,
with `validation.status:"invalid"`, never a fabricated valid score. A parsed
result with an unavailable Schema (`no-schema` or `invalid-schema`) is likewise
returned with `validation.status:"unavailable"`. For a parsed JSON `null`, the real chunk contains
the text `"null"`, not an absent result. A parsed result can be an object, array,
string, boolean, number or null, including nonnumeric text and nested values.
The output's original text/paths/evidence are never returned by this tool.
Wrong evaluation/sampling/Project/owner/current-or-exact-Run membership is an error.

`list_options({category:"output_schema_detail",outputSchemaId,schemaOffset?:number})`
returns `{category:"output_schema_detail",outputSchemaId,name,nameTruncated?:true,
sourceRedacted:boolean,schemaChunk:JsonChunk|null,streamRequired?:true,
display?:{totalBytes:number,sha256:string}}` for the active owned catalog
record. `list_options({category:"project_schema_detail",projectId,schemaOffset?:number})`
instead returns `{category:"project_schema_detail",projectId,outputSchemaId,digest,
sourceRedacted:boolean,schemaChunk:JsonChunk|null,streamRequired?:true,
display?:{totalBytes:number,sha256:string}}` from
`projects.getEvaluationOutputSchema(projectId)` (the Project-frozen evaluation
plan, including renamed/soft-deleted catalog Schemas). No `runId` is accepted:
the Project's current frozen plan, not a historical Run's plan, owns this
reference. The catalog display name is at most 80 characters, with truncation marked;
the **displayed** Schema document (MCP chunks or trusted GET) retains its `properties`,
`$defs`, types, conditions, enums and descriptions, not just aggregated numeric
fields unless a specific value has been explicitly redacted. Both chunk types are
`{text:string,offset:number,totalBytes:number,nextOffset:number|null,sha256:string}`:
`text` is at most 2,048 UTF-8 bytes (adaptively smaller if JSON escaping or
long IDs require it to stay below the 4,800-byte/character model-text limits), on code-point boundaries from
`JSON.stringify(parsedJson)` / `JSON.stringify(schema)`, after the same
redaction policy. MCP continuations apply only when the **displayed** document
is at most 16,384 UTF-8 bytes; larger documents yield
`{schemaChunk|rawJsonChunk:null,streamRequired:true,display:{totalBytes,sha256}}`.
SHA-256 hashes the **whole displayed canonical JSON**, not an individual page
or the Evaluator's original file (`contentHash`). For small documents, start
at offset 0, follow `nextOffset` until null, check every page's identity,
total and hash, concatenate UTF-8 bytes and verify
the digest; a changed digest/total means restart, never accept a partial result.
Out-of-range, mid-code-point and nonzero MCP cursors for stream-required
documents are errors. No silently clipped JSON or Schema is called complete.

The trusted Takt adapter should consume MCP `content[0].text` **only if**
`isError` is absent, and must not truncate it again. For a small selected
Evaluation/Schema, keep the same IDs and optional exact `runId`, start at byte
offset 0 and follow `nextOffset` until `null`. Compare `totalBytes` and `sha256`
across **all** pages; encode and concatenate `text` chunks as UTF-8, verify
their combined byte count/SHA-256, then parse the one displayed JSON document.
For `streamRequired:true` do **not** follow `resultOffset`/`schemaOffset`: use
the fixed authenticated GET below, compare its manifest's `display` size/SHA
to the MCP `display`, and reject a changed identity (including the original
Project Schema `outputSchemaId` and `digest`). A missing chunk, changed
digest, error or out-of-budget aggregate is **not** a completed result:
reject/restart, or retry a normal aggregate with smaller `pageSize` /
`toolPageSize` or a narrower scope. `contentHash` describes original Evaluator
text and is not the displayed JSON digest.

Schema and Evaluation JSON retain safe object field names, including literal
`url`, `token` and `prompt`, but replace these sensitive keys' **entire value**
(string, number, boolean, null, object or array) with
`"[REDACTED: sensitive source content]"`. Other unsafe string values are also
masked in full, except `reason`/`explanation` strings inside an explicitly
selected Evaluation: complete URL/credential/verbatim private-prompt spans are
masked while safe surrounding explanation is retained. An ambiguous or still
unsafe explanation is masked in full. Schema documents and all other management
reads keep the original full-value policy. `sourceRedacted:true` is set
on **every MCP chunk** or the stream manifest when the document is transformed,
and the digest covers only the displayed **redacted** JSON. A property name
that **itself contains** a literal URL, credential or private prompt cannot
be emitted: return `schemaChunk`/`rawJsonChunk:null,sourceRedacted:true`
without `streamRequired` (trusted GET reports `display:null,withheld:true`),
never silently omit that key. Takt's `UNSAFE_JSON_KEY` policy must allow the
safe names `url`/`token`/`prompt` **only when their value is exactly the marker
and the result is flagged `sourceRedacted:true`**; it must still reject an
actual URL/credential in a key, unmarked sensitive values and partial output.
MCP's response-level redaction flag may also include a redacted name or
`contentHash`, whereas GET's flag refers to its JSON document; preserve
either flag when reporting to the user. A redacted display is **not** an
original complete Schema/result (e.g. a redacted Schema need not itself
validate as a usable Schema), and an undetectable paraphrase of a secret cannot
be inferred to be safe or restored from a hash.

**Trusted JSON document GET (not a model tool):**
`GET /mcp/eval-management/documents?kind=output_schema&outputSchemaId=<id>` or
`GET /mcp/eval-management/documents?kind=project_schema&projectId=<id>` or
`GET /mcp/eval-management/documents?kind=evaluation_result&projectId=<id>&samplingId=<id>&evaluationId=<id>[&runId=<id>]`
accepts exactly those query fields (no URL, path, owner, arbitrary cursor or
token). The same management Bearer is checked **before** the fixed-owner lease;
other credentials fail. Catalog Schema selection uses the active owned catalog;
Project Schema selection uses the owned, digest-checked Project evaluation
plan (not the mutable/deleted catalog choice), and rechecks both its reference
and content before the terminal manifest;
Evaluation selection uses the same Metrics current-scope checks and, when
`runId` is supplied, original Run membership as `get_metrics`. Every source is
rechecked at the stream end. Wrong, foreign, soft-deleted Projects, unavailable
catalog Schemas or replaced selections
never receive a terminal manifest. `200 application/x-ndjson; charset=utf-8`
is attachment-only with sandbox CSP, `nosniff` and no-store; it does **not**
put the JSON bytes or a URL into model context. No new DB, file spool,
document cache or SP integration is involved.

Its JSONL has zero or more `{"type":"chunk","offset":0,"base64":"..."}` lines
of at most **8,192 decoded bytes** each, in consecutive byte-offset order,
followed by exactly one terminal manifest line and EOF. For a Schema the
manifest is `{"type":"manifest","format":"eval-management-json/v1",
"kind":"output_schema","outputSchemaId":"<id>",
"display":{"totalBytes":123,"sha256":"<lowercase SHA-256>"},
"sourceRedacted":false,"withheld":false,"displayComplete":true}`. A Project
Schema manifest has `kind:"project_schema",projectId,outputSchemaId,digest`
at the **top level**, with the same display/redaction/completion fields;
`digest` is the frozen original-body digest, **not** `display.sha256`.
For an
Evaluation, `kind` is `"evaluation_result"` and the **only** identity/status
fields in place of `outputSchemaId` are
`projectId,samplingId,evaluationId,runScope:"project_current"|"exact_run",
runId?` (only for exact Run), `outputStatus:"succeeded"|"failed"|null` and
`validation:{status,reason}`; the same four display/redaction/completion
fields then follow.
For absent/malformed Evaluation output there are **no** chunks,
`display:null,withheld:false` with the real validation reason; for a key unsafe
to display there are no chunks and `display:null,withheld:true,sourceRedacted:true`.
For a present document `display` hashes the concatenated **decoded displayed**
UTF-8 bytes (even if redacted), not base64/JSONL or the original text. Takt must
check identities, validation, frame ordering/nonempty lengths, full byte count,
SHA-256 and any MCP `display`, a **terminal** manifest and EOF before using
the parsed JSON; HTTP 200 or a prefix is not success. Failed/aborted/cancelled
streams have no manifest. `displayComplete` certifies delivery of the *display*
or explicit null, never completeness of a redacted original. Other MCP tools
and the separate, trusted trajectory download are unchanged.

Takt owns approval and must keep the original preview digests/targets and the original create body with its review digests. On an uncertain write, `reconcile_operation` only consults previously persisted EP facts. A lookup miss must **not** become a blind `submit_run`/`create_project` retry: compare to the original approved facts and obtain new human approval for a changed plan or source. The Runtime's required expected digests, rather than management preview logic, block a D1→D2 same-target Run. No second Run receipt or approval state is stored in EP.

**Trusted bulk trajectory Interface (not an MCP/model tool):** `GET /mcp/eval-management/trajectories?projectId=<id>&samplingId=<id>&role=subject|evaluator[&evaluationId=<id>][&runId=<id>]` accepts exactly these query fields, with `evaluationId` required only for `evaluator` and forbidden for `subject`. It uses the **same management Bearer before the owner lease**, not the Eval Web/Evaluator token. An absent/not-started Chat is 404; a foreign, deleted/replaced or nonmember Project/Sampling/Evaluation/Run is never streamed. It returns `200 application/x-ndjson; charset=utf-8`, `Content-Disposition: attachment`, sandbox CSP and no-store. No caller-supplied URL, arbitrary path, token in the query or model context, second trace store or direct SP DO/private-file read.

The JSONL contains zero or more **complete** record lines `{"ingestSeq":N,"record":<SAFE Pi record>}\n` in ascending order, followed by **exactly one terminal** line `{"type":"manifest","format":"sp-pi-trajectory/v1","projectId":"...","samplingId":"...","runScope":"project_current"|"exact_run","runId":"..."?,"role":"subject"|"evaluator","evaluationId":"..."?,"chatId":"...","throughSeq":<frozen watermark>,"recordCount":<number of record lines>,"recordsSha256":"<lowercase SHA-256>","complete":true}\n`. `recordsSha256` hashes the exact bytes of **all preceding record lines including their LF**, not the manifest; `recordCount` counts those lines, and `throughSeq` is frozen from the first public SP page (including an empty Chat at zero). Takt must validate the requested identities, every record/sequence, count/hash/cutoff and **terminal manifest followed by EOF**, then atomically save; HTTP 200 or a record prefix alone is *not* completion. Abort, replacement or downstream/SP error omits the terminal line. There is no resumable per-4-KiB MCP trajectory path.

The API pages only public owner-session `GET /api/chats/{chatId}/trajectory?afterSeq=&limit=200&throughSeq=` (one frozen Chat, native `EVAL_EVIDENCE_TRAJECTORY_PAGE_MAX`, with the installed public harness's 4 MB response/schema bound) and, for references from those validated pages, the fixed owner-session `GET /api/chats/{chatId}/trajectory/records/{ingestSeq}?throughSeq&identity&byteLength&sha256`. Each page validates **every** row in sequence and the frozen cutoff/next cursor; a terminal page and unchanged current ownership are required for the manifest. Both Subject and Evaluator use this same route; not the Worker-only `/evidence/trajectory/records` transfer. Inline records retain every parsed SAFE native field; a large reference retains its original JSON bytes. A reference is downloaded **once per file**, spooled privately up to the installed SP record-file limit, and checked end-to-end for headers, byte length, SHA-256, UTF-8/JSON, SAFE projection, identity, Chat and parent **before any part of that record line is released**. The per-record spool is deleted after reading, failure or abort. Source SP's SAFE policy remains authoritative.

`POST /mcp/eval-management/uploads` is a **separate** authenticated byte ingress (same independent management Bearer, no Web/Evaluator token). `Content-Type: application/octet-stream` and headers `X-Upload-Kind` (`prompt|material|session|skill|reference`), `X-Upload-Name` (one percent-encoded filename, not a path), `X-Upload-Media-Type`, `X-Upload-Size` (decimal bytes) and `X-Upload-Sha256` (lowercase hex) are required. Optional **server-only** `X-Upload-Id` is a UUID (including UUIDv8); it is the already-persisted `eval_management_uploads.upload_id` and returned `uploadRef`. Without it the server generates a random UUID, preserving existing clients/response `{uploadRef,byteSize,sha256,expiresAt}`. A second POST with the same reserved/ready ID is rejected, never re-writes the staged bytes. The trusted Takt backend, not the model, sends verified Feishu attachment bytes and metadata. Takt derives UUIDv8 from the **original** D1 personId, operationKey, kind, messageId and resourceKey, not from byte SHA alone (identical bytes can represent different intended uploads). On a lost response for a pending row, Takt must **only GET the same ID and compare the original metadata**, never POST again or mint a different key.

`GET /mcp/eval-management/uploads/{uploadId}` is a fixed, read-only trusted-backend recovery route: the same management Bearer is checked before leasing the fixed owner. The response is **only** `{uploadRef,kind,name,mediaType,byteSize,sha256,expiresAt}` for a READY, unexpired, owner-scoped row **and** staged file whose size/SHA-256 can be verified read-only; no bytes, URL, inferred ref-by-hash or new receipt. Invalid UUID returns 400; missing, reserved, expired, foreign or missing/corrupt file returns unavailable (404), never success; after the 24-hour staging TTL it is an **unknown outcome requiring manual reconciliation**, not permission to re-POST. Unsupported methods on that fixed path return 405 (`Allow: GET`); the POST ingress remains 405 (`Allow: POST`) for GET/PUT/PATCH/DELETE. Both endpoints are no-store and disabled without the management secret.

Recovery also requires the GET-serving API process to see the **same existing private staging root** as the POST-serving process. A READY PostgreSQL row on a different node with non-shared staging does not prove the file is accessible there: GET fails closed as unavailable, and the adapter must keep the outcome unknown for manual reconciliation. Do not substitute a hash lookup, a second POST or a newly created empty staging directory.

Maxima: 20 MiB (20,971,520 bytes) Prompt, 5 MB Material (public SP limit), 8 MB UTF-8 Session (then SP's 2M-character native-context validation), and 20 MiB Skill ZIP/Reference; all additionally use the Agent-import 20 MiB/file, 2 GiB private staging root and 24-hour fixed TTL. Streaming checks actual size/hash; a PostgreSQL reservation caps total bytes and at most eight simultaneous uploads across API instances. Expired/unready/wrong-kind refs cannot authorize a tool write. Upload refs never appear in an Agent Config or Project.

All five new operations reuse an `operationKey` for an unknown response. The durable fingerprint covers normalized intent and the immutable SHA/size/kind/name/media type of referenced uploads (or, for output Schemas, the exact bounded content SHA-256 without storing that content in the operation). A changed intent with the same key conflicts. Preparation saves planned UUIDs before any catalog write, reconciles by owned identity/content and confirms a stage only after read-back. Before the first `store.begin` or any Dataset/Bundle write for a **new** preparation, it checks each case's Subject and Evaluator Material fields separately against SP's 20,000,000-byte initialization budget, counting existing owned and staged Material sizes together; same-key recovery follows the saved plan rather than rechecking previously bound, possibly soft-deleted resources. `prepare_inputs` returns only a compact completion receipt; `get_preparation({operationKey,pageSize:1})` is the paginated source for case bindings and resource details. Prompt-import rejects initial refs, so each Data is bound before Project creation. Pi-native history is checked by the existing SP public-context validator, never sent to the Evaluator. A Bundle file with a planned identity is not automatically deleted on an uncertain catalog transaction: if the transaction rolled back, an orphan may need operator reconciliation before that stage can be retried, rather than risking deletion of a committed Material/Session. Remote ordinary SP Skill/Reference writes have no import-key receipt: after a POST was attempted and its result is not proved, **do not resend it, delete its attachment or use a new operation key as a recovery trick**. `get_preparation` reports that stage as `outcome_unknown` for manual review; only an affirmative public result can complete it. An unresolved same-name Skill intent fences other Skill operations. Output Schemas instead retain the existing name-permissive catalog contract; only an exact planned ID and operation key can prove a Schema receipt. Project/Run retain their existing durable idempotency; `create_agent` still lacks durable Agent intent receipts and its uncertain SP response is not treated as success.

`migrations-postgres/0009_management_preparation.sql` and its Drizzle metadata add only upload reservations and owner-scoped operation/stage receipts, after the unchanged Dashboard migrations `0007` and `0008`. The minimal `0010_management_output_schema.sql` changes **only** the existing management operation `kind` check to allow `output_schema`; it creates no column, index, table or uniqueness constraint, and leaves the output Schema catalog and existing identity check unchanged. Existing duplicate names remain valid before and after migration. Neither migration is applied by this change; run the existing deployment migration before enabling management. Without a public SP conditional Skill create or ordinary Skill operation receipt, an attempted/unknown Skill upload stays fenced for manual reconciliation. Skill-name preflight and Reference attachment-identity reconciliation scan at most 500 public catalog entries; a larger catalog fails closed rather than choosing a resource by name. Takt's trusted adapter must enforce attachment provenance and actual user approval; this repository never accepts model-provided approval as proof.

`migrations-postgres/0011_dataset_member_order.sql` is an append-only change to the existing membership table only: nullable, non-negative `position` with a per-Dataset unique index. It leaves every old membership `NULL` rather than guessing from UUID/order of insertion; no old SQL/journal entry or Project/Run fact is rewritten. Migration journal/snapshot integrity tests guard the unchanged applied prefix, and the PostgreSQL upgrade test exercises an old database when a **safe isolated** test `DATABASE_URL` exists. Generating/checking a migration never applies it to production.

`migrations-postgres/0012_dataset_order_provenance.sql` adds only nullable `eval_datasets.original_order_intact` after the immutable `0011` prefix. Existing Datasets remain `NULL` rather than treating their known/dense positions as proof; new Dataset Store creates/imports set it `true`, and effective member removal sets it `false` under the owner-scoped Dataset lock. Append/reattach/replay never reset `false`. Apply `0012` before deploying the new reader and writer; no production database is migrated by generating or testing this change.

### Dashboards and comparison

数据看板的 `GET /api/metrics/comparison` 接受重复 `projectId`、可选 `datasetId` 与 `jsonPointer`，返回 Metrics 的 `ProjectComparisonView`，不设基线。所选项目必须全部归属当前固定服务账号且未删除；事实读取复用现有 Metrics 读取逻辑，在一个 `READ_SNAPSHOT` 事务中完成所有 Project 的读取，不把多个事务冒充同一快照，不读取 SP。查询数量上限由 `COMPARISON_PROJECTS` 及 `GET /api/input-limits` 的 `comparisonProjects` 统一提供，当前为 8；Web 不维护数值副本。数据/Schema 交集、已评分筛选和所有统计归 `eval-metrics`，API 不重算。Sampling/产物/轨迹明细继续使用既有授权端点。

可保存的看板配置由应用的 Dashboards Module 管理：`GET/POST /api/dashboards` 与 `GET/PUT /api/dashboards/{dashboardId}`，公共 DTO/输入 Schema 来自 `eval-contracts`。数据库保存 owner、名称、说明、版本、时间与有序 Project 关联，不保存比较值；配置表与关联表用同 owner 的复合外键防止跨账号引用，读取复用 `READ_SNAPSHOT`，列表不逐看板重复读取 Project。创建在同一事务核验全部 Project 的 owner、未删除及已有已准入 Run 的稳定创建状态（不要求 Run 执行成功），按固定顺序加锁，并以 owner + 创建幂等键与原始规范请求指纹保证重试不重复创建。尚无首个 Run 的暂存 Project 不得被持久引用，避免首 Run 准入失败的删除补偿被新外键阻挡；不通过级联删配置、弱化外键或保留可见孤儿来绕过。更新锁定 owned 看板并核验 revision，版本冲突不覆盖新配置，成功保存后版本递增。既有看板中的 Project 后来软删除不删除看板；读取对比的现有 not-found 状态可通过编辑配置修复。只生成和检查新增迁移，不自动连接真实数据库或应用迁移。

看板数据展示选择复用配置更新 Interface 和 revision；`excludedDataIds` 持久化在看板配置，省略更新时不清空，显式空集合恢复全部。`POST /api/metrics/comparison` 是有界 JSON 请求的只读对比 Interface，避免大量 Data 身份塞进 URL；仍使用同一快照和 Metrics 聚合，不运行 Agent，也不写指标。新增迁移只添加空排除集合列，不修改已有看板或评估事实。

## 项目评估结果下载

`GET /api/projects/{projectId}/evaluation-results.zip` 在同一只读快照中导出项目当前留存的全部采样与评估记录，不受页面筛选或 Run 选择影响；未知、其他所有者或软删除项目返回 `404 PROJECT_NOT_FOUND`。ZIP 按 `project/dataset/sample/sampling` 的固定身份分层，共享用例按项目冻结的数据集归属分别保存。原始评估结果以独立 JSON 文件原样保存，包含无效结果；缺失或未完成结果只保存状态元数据。目录、元数据文件名与响应保护见 [HTTP 下载契约](../../docs/eval-http-api.md#projects)。

下载只读取 Eval 已存事实，不运行 Agent、不补收结果、不读取 SP，不导出 Agent 配置正文、结果提交凭据、原始资源快照或 Workspace/证据文件内容。数据库读取及 ZIP 输出须有界流式处理，不一次性加载全部结果正文或整个压缩包。

## 进程与环境变量

### Agent overwrite imports (public Interface boundary)

Explicit imports create missing IDs and overwrite the target owner's existing
Agent, user Skill and Reference metadata/content in place from the frozen dev
snapshot. Existing IDs are selectable, not skipped or cloned; IDs and original
`createdAt` are preserved, and Agent/Skill revisions advance. Platform Skills,
frozen/default/deleted/disabled resources and other owners remain protected.
Each new preview has distinct operation keys; an uncertain retry uses its
original keys and receipts rather than overwriting again. An unfinished
operation blocks a new operation on the same resource.

`/api/agent-config-sync` adds optional `GET /config`, `GET /users?limit=20`,
`GET /users/:sourceUserId/agents?q=&cursor=&limit=`,
`POST /previews {sourceUserId,agentIds,purpose,idempotencyKey}`,
`GET /tasks/:taskId`, and `POST /tasks/:taskId/apply {idempotencyKey}`.
Both writes return 202 `{taskId}`; the independent `eval-agent-imports` pg-boss
consumer performs preparation/import, not an HTTP request or the Run Worker.
DTOs live in `eval-contracts/src/agent-imports.ts`. Target owner is always the
verified Eval service account; source user only scopes the authorized export.
`onlyMissing` remains an optional catalog filter; Web omits it so existing IDs
remain selectable for overwrite.
User browsing needs no name or email input: missing or blank `q` browses all
eligible dev accounts in the existing authorized export scope. Optional `q` is
trimmed and bounded to 200 characters for search compatibility. The response is
`{users:[{id,name,email}],nextCursor:string|null}` (`AgentImportSourceUserPage`),
with at most 20 users; `limit` is 1–20 (default 20). An optional nonempty cursor
is bounded to 4,096 characters and forwarded unchanged. SP owns stable name/ID
keyset pagination; Eval preserves each page and its cursor rather than capping
the directory or requiring a manual user allowlist. Web displays usernames only;
IDs still identify selections and email remains in the compatible wire contract.
The real official account is listed first. Source Auth IDs are opaque strings
and may be non-UUID legacy IDs; the adapter encodes each ID as one path segment.
Agent/resource IDs and the target-owner authorization rules are unchanged.
Agent search may remain blank after an authorized user is selected.

The Dev source is fixed to `https://devrapi.springbrand.ai`; the
`EVAL_DEV_SP_API_ORIGIN` environment variable is not read. Supplying the existing
Takt `SP_PLATFORM_RESOURCE_ADMIN_TOKEN` for that Dev SP deployment (its
`RESOURCE_ADMIN_TOKEN`) enables imports. No new credential is generated. The shared token retains
its management authority; this client uses only the read-only export routes.
Without the shared token, imports stay disabled.
SP derives transfer policy from its trusted deployment `API_ORIGIN`: dev
(`https://devrapi.springbrand.ai`) exports across all source accounts; Eval
(`https://evalrapi.springbrand.ai`) imports for every authenticated target user;
other origins disable both. There is no import/export-specific user-ID allowlist
or manual account verification. Eval still uses its ordinary fixed service
session, and target auth, trusted Origin and ownership checks remain mandatory.

Disabled imports mean `{enabled:false,maxAgents:50}` and ordinary API behavior remains
available. Owner-scoped persisted `GET /tasks/:taskId` remains available even
after the source token is removed or target imports are disabled; it reads only
Eval task state, never creates a source client/session or enqueues work. Source
browsing and preview/apply remain unavailable without the existing Takt credential.
Source and target origins must differ. The source client exposes only
the approved GET `/api/agent-config-export/users`, `/users/:id/agents`, and
`/users/:id/snapshot?agentIds=`; it never creates shares, sessions or other dev
records. Target imports use the service session and `EVAL_WEB_ORIGIN`:
`POST /api/skills/imports?skillId=&importKey=` (complete ZIP),
`POST /api/user-references/imports` (a freshly uploaded target attachment), and
`POST /api/user-agent-configs/imports`. Recovery reads
`GET /api/agent-config-imports/receipts/:importKey?kind=`.
Reference bytes first use ordinary `POST /api/inbox/attachments` with a temporary
UUID derived from the target owner, Reference ID and import key. Retries reuse
that upload identity; a new operation gets a distinct upload so changed bytes or
metadata cannot collide with an earlier immutable upload. The final `referenceId`
always remains the original resource ID. Previously persisted same-ID attachments
remain valid for recovery without another upload. SP rejects immutable upload
identity or content mismatches with `409 REQUEST_CONFLICT`.
The target adapter treats only HTTP 409 with a known public conflict code
(`AGENT_CONFIG_IMPORT_CONFLICT` or
`REQUEST_CONFLICT`) as an authoritative conflict on dependency/upload and receipt
reads and import POSTs, preserving the structured upstream cause. Unknown
409 codes, malformed responses, network and target authentication failures are
never classified from HTTP status alone. Reads/uploads retain dependency failures;
an uncertain import POST first checks the same key's durable receipt and remains
unresolved if that receipt cannot prove success. Missing receipts remain 404/null.
Upstream failures never invalidate the browser session.
Deploy the Dev SP paginated user-export contract before releasing this Eval API
and its no-typing Web consumer. An incompatible or unavailable source response
fails as dependency unavailability, never as an empty directory or browser
session expiration. This browsing change requires no database migration or new
credential/configuration.
IDs are preserved; platform Skill IDs are strings, not necessarily UUIDs.
Platform Skills are verified against the target catalog, never uploaded as user
Skills. Same-name private Skill collisions block only their dependent Agents.

The API owns unified internal resource sources, durable tasks, per-resource
write-ahead intents/receipts and owner leases. Native or unknown provenance is
never adopted from a matching ID/hash or an unfinished intent. An explicit
overwrite may replace native provenance only after its matching target receipt,
current-resource verification and purpose/source finalization. Source metadata
never appears in ordinary Agent DTOs. A valid target receipt is required before an
import can register provenance or hide an unfinished imported Agent. Imported
objects are retained after purpose/source finalization failures; recovery never
deletes, forks, aliases or allocates replacement IDs.
Confirmed imports awaiting metadata finalization share one ordinary
get/edit/delete/freeze access fence, including explicitly overwritten native
Agents; unknown intents alone do not hide a row.
A receipt proves a historical import commit, not current existence:
every Agent result, including cached receipts and POST replays, is freshly read
and checked against the frozen body and the target's active list before local
purpose/source finalization. SP's retained GET body alone cannot prove it is active.

Preview freezes the selected dependency union and its actual byte hashes under
`EVAL_BUNDLE_DIR/imports` with bounded files/bytes, private permissions and TTL.
Apply consumes that immutable plan, only ready candidates, dependencies first.
New stored plans use version 2 for overwrite consent. Old unsubmitted create-only
version-1 previews require a new check; already-applied version-1 plans may only
finalize matching proven receipts, never start fresh overwrite writes or uploads.
This internal plan version does not change SP's version-1 capability/preflight wire.
Automatic recovery keeps the task `importing`; receipt reconciliation uses stage
`receipts` even when individual Agents have unknown results. Exhausting the queue
recovery budget leaves the task `outcome_unknown` for manual reconciliation, never
fabricated failure or success. The Web only polls this persisted lifecycle.
Invalid paths/URLs on one resource block only its dependent Agents; aggregate
selected-union file/byte limits still reject the whole preview.
Manifest/archive paths are literal filenames, including `%`; only download URLs
are URI-decoded. Neither path validation nor ZIP creation rewrites filenames.
Source export settings must already use SP's canonical public wire defaults
(`presetId: null`, `referenceFileIds: []` when absent in storage). Eval preserves
the complete setting, does not copy SP's normalizer or guess missing defaults,
and blocks an incompatible Agent before any target resource writes.
Every prepared setting, including Agents with no direct Action/Connector/Extension
selections, must pass the fixed target's read-only
`POST /api/agent-config-imports/validate` using the existing service Session and
trusted Origin. The request is
`{setting, dependencies, plannedResources:{skills:[{id,name}], references:[{id,size}]}}`;
`dependencies` defaults to `[]` and `plannedResources` to empty lists.
Its standard success envelope must contain
`{version:1,setting}` with a JSON object exactly equal to the already canonical,
purpose-reconciled setting. Eval does not duplicate SP's setting schema or accept
dropped fields, truncation or rewritten defaults. In particular, current Dev
`authoring`, `preferredSupplierIds` and `referenceNotes` remain intact in the
source snapshot, frozen plan and overwrite-capable Agent POST.

SP owns all admission rules through the same implementation as ordinary writes
and atomic imports: model-plan access, managed MCP, Connector Toolkits,
Actions/Components/Suppliers, Skills/References and exact definition proof checks.
Eval makes no Action detail, Component/Toolkit/model catalog or separate
definition-metadata request for admission. Its managed MCP catalog reads remain
only for Eval purpose reconciliation; Toolkit selections are never treated as
managed MCP Servers.

Planned facts are strict, bounded to 256 unique selected IDs per list and derived
only from the already-durable source snapshot, before preparing the Agent.
Only selected source `kind:"user"` Skills supply `{id,name}`; platform Skills
must already exist on Target. References supply UUID `id` and nonnegative integer
`size`. Unselected resources, URLs, owner fields and source credentials are not
sent. These facts let SP validate future selected Skill name clashes and Reference
totals for both absent IDs and active owned replacements. Incoming planned
Skill names and Reference sizes are used for replacements too; current target
ownership/lifecycle checks still reject protected, foreign, deleted or disabled
resources. Unplanned resources use actual target facts. No second persisted fact
set is added.
Preflight uses a read-only snapshot, creates no resource, upload, receipt or
reservation, and never grants a later write.

Only documented HTTP 422 codes `REQUEST_VALIDATION_FAILED`,
`AGENT_CONFIG_IMPORT_INVALID` or `AGENT_CONFIG_INVALID`, exact HTTP 403
`MODEL_ACCESS_DENIED`, and the known import-conflict 409 codes prove a rejection.
They block that Agent with a safe conflict while retaining structured upstream
diagnostics as the cause, rather than deferring validation to an uncertain POST.
Unknown status/code pairs, missing/incompatible preflight and
auth/service outages fail closed as dependency unavailability, with no fallback
or resource writes. Apply repeats this check with frozen snapshot facts before
any dependency write. The formal Agent import service and receipt recovery repeat
preflight with empty planned lists, requiring actual imported resources.
Cancellation retains its existing dependency-failure wrapper and original SDK
cause, never an Agent conflict.
Definition fingerprint and purpose/MCP checks remain mandatory.
Selected Actions, Connectors and Extensions require source definition evidence
`{kind,id,fingerprint}` (SHA-256 lowercase hex) from snapshot `dependencies`.
Only the selected-root union is accepted; duplicates, wrong kind/ID and missing
proofs are never replaced with target-only versions. Per-Agent proofs are frozen
in the prepared plan and both source/target digests and import keys (at most
500 proofs in the source union and per preflight). Preview and apply send those
expected proofs in the authoritative preflight so SP compares current definitions.
Apply uses no source calls and checks current admission before dependency writes,
then sends the unchanged frozen `dependencies` in the Agent import POST.
SP rechecks exact coverage/current definitions inside resource-write/replay and receipt
verification. No Action/Component publishing, adoption or credentials are part
of this seam; Connector Toolkits remain distinct from managed MCP selections.
All downloads reject redirects, unsafe paths and non-allowlisted URLs; CDN reads
carry no SP token. The target's guarded insert/update operations remain the final defense
against concurrent edits, tombstones, ownership and uniqueness conflicts.
Migrations are review artifacts only; generating them never applies them.

`pnpm --filter @eval-platform/eval-api start:import-worker` runs
`src/agent-import-worker-main.ts` independently. It reads process environment
only (no `.env` discovery). Supply `DATABASE_URL`, `EVAL_BUNDLE_DIR`,
`EVAL_SP_API_ORIGIN`, `EVAL_SP_SERVICE_USER_ID`,
`EVAL_SP_SERVICE_SESSION_TOKEN`, `EVAL_WEB_ORIGIN` and, when enabling the fixed Dev source,
the existing `SP_PLATFORM_RESOURCE_ADMIN_TOKEN`. An absent source token
starts disabled without SP/queue connections. The Run Worker never receives
the shared source token. Busy owner leases are durably deferred in the same
transaction as completing their queue delivery, not acknowledged/lost or
charged against the ten failure retries.
Preview and apply use separate stable queue singleton keys
`preview:<taskId>` / `apply:<taskId>` so an active preview cannot absorb apply.
A rejected required enqueue rolls back the caller's transaction; lease deferral
still completes the old delivery and upserts a delayed wake-up transactionally.

Staging limits are 50 Agents, 1,000 files, 20 MiB per file, 200 MiB per selected
union, 2 GiB for the staging root, with a 24-hour preview TTL. Apply never
refreshes source data. After TTL, existing valid receipts can still finalize
local purpose/source records, but no new remote import is started.
Download origins are separated by purpose in `src/agent-imports/bytes.ts`:
source permits `creation-file-dev.springbrand.ai` and
`devworkspace.springbrand.ai`; target permits only
`creation-file-eval.springbrand.ai` and `evalworkspace.springbrand.ai`.
Both permit the global platform CDN `cdn.springbrand.ai` and their exact fixed
API/static-proxy origin (HTTPS or loopback tests), never the other deployment's
private CDNs. All `/api/` byte URLs, including legacy share ZIP routes, remain
rejected. The logical Skill archive path keeps SP's 240-character bound; encoded
CDN paths have a separate bounded owner/version-prefix budget with segment,
traversal and encoded-separator validation. Neither browser input nor an export
can expand these allowlists. The independent Eval Skill CDN binding/configuration
is an operator step; this repository change does not deploy or verify its DNS.

Ordinary Agent creation retains `POST /api/user-agent-configs`, the original
body/200 response, SP-assigned identity, slug replay and existing failure
compensation. Its optional `X-Agent-Config-Created: true|false` response header
is an internal transport fact: only `true` registers `eval_native`; `false` or a
missing header never adopts an unknown row or changes a proven import binding.
It never calls import capability/import endpoints and works when source is
absent or target imports are disabled. The independent import method never
compensates by deleting an imported object.

Import preview/apply and worker stages probe the fixed target's public
`GET /api/agent-config-imports/config` (`{version:1,enabled}`), and each remote
write rechecks capability, including before `/api/inbox/attachments`. Probes
are not cached as write authority; SP independently enforces deployment capability,
ordinary authentication, trusted Origin and target ownership. The existing Eval
`/config` returns `enabled:false`
when target capability is disabled; upstream 401 stays dependency unavailability,
not browser authentication. A disabled apply keeps its durable plan/key resumable.

`migrations-postgres/0006_agent_imports.sql` and its Drizzle metadata add only
Eval-side source/task/intent/lease structures. No old sources are backfilled.
Target SP needs `0040_agent_config_import_receipts.sql` and
`0041_agent_config_import_overwrite.sql` through its normal deployment pipeline,
not manual remote database actions. Immutable operation receipts may refer to
the same single mutable resource; they are not historical resource copies.
No production import or deployment of this overwrite change has occurred.
Agent import PostgreSQL tests opt in only with `EVAL_IMPORT_TEST_DATABASE_URL`;
they never read `.env` or fall back to `DATABASE_URL`. Other PostgreSQL suites
use `DATABASE_URL`. Local unit checks remain supported with both variables unset;
the corresponding database suites explicitly skip.

After merge, the existing `api` job in `.github/workflows/ci.yml` will run ordinary
and Agent import PostgreSQL tests on its disposable `postgres:17-alpine` service,
using test-only credentials. It defines one `DATABASE_URL`, rejects a missing
value before testing, and explicitly derives
`EVAL_IMPORT_TEST_DATABASE_URL="$DATABASE_URL"` for the test invocation.
`createTestDatabase` creates, migrates and drops its own random `eval_test_<UUID>`
databases on that service. The same job also runs `pnpm test:deployment`;
`deploy-api` still requires the API job to succeed. Live R2 access remains an
explicit operator opt-in and is not verified by this workflow.

`createTestDatabase` defaults to the production migration entry, including history
validation and current-schema probes. Historical upgrade fixtures supply an
initialization callback using Drizzle's migrator with the unchanged migration
prefix, then exercise the production entry with the complete migration folder.
Initialization failures still close the pool and drop the temporary database.

本文是环境变量的唯一完整列表。两个进程对接同一 Eval SP 发布，挂载同一个 `EVAL_BUNDLE_DIR`，配置无效时启动失败。日志统一使用 pino（API 请求日志用 `hono-pino`），错误经 `errorDiagnostics` 脱敏后记录。Run Worker 把 Runtime 与 Harness 诊断事件写入同一 pino 日志（见 [eval-runtime README](../../packages/eval-runtime/README.md) 第 31 条与 [SP Harness 协议](../../docs/eval-sp-harness-protocol.md#diagnostics)），`run_runtime_error` 带 `runId`/`stage`/`samplingId`/`evaluationId`；每个 Run 任务开始时记录 `run_job_start`（`runId`、`jobId`、`retryCount`、`retryLimit`、`final`、`stopPending`）。

`pnpm --filter @eval-platform/eval-api start:api`（`src/server.ts`，配置见 `src/config/api.ts`）启动 HTTP 控制面：

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | Eval PostgreSQL；API 也以生产者身份连接 pg-boss |
| `EVAL_SP_API_ORIGIN` | Eval SP API：启动时校验服务会话，以及 Agent Config |
| `EVAL_SP_SERVICE_USER_ID` | 固定的 Eval SP 服务账号 ID，所有数据都归属这个账号 |
| `EVAL_SP_SERVICE_SESSION_TOKEN` | 该服务账号的长期会话 token，由 SP 的 `eval:bootstrap-service-account` 脚本签发 |
| `EVAL_SP_ADMIN_TOKEN` | Eval SP 部署自己的 `RESOURCE_ADMIN_TOKEN`，只用于给服务账号加积分，不能与 dev/production 共用 |
| `EVAL_WEB_ORIGIN` | Eval Web 来源：唯一的 CORS 与受信 Origin，同时作为 Agent Config 写请求发给 SP 的 Origin |
| `EVAL_SP_SOURCE_BRANCH`、`EVAL_SP_SOURCE_COMMIT` | 当前 Eval SP 发布的分支与完整 commit |
| `EVAL_BUNDLE_DIR` | 共享 Bundle 目录，绝对路径 |
| `EVAL_SP_AGENT_ORIGIN` | Eval SP Agent Worker：只读观察时读取 Chat 消息与工作区 |
| `EVAL_SP_TRUSTED_ORIGIN` | 只读观察请求发给 Eval SP 时携带的 Origin，必须是 Eval SP Agent 信任的来源（eval 部署为 `https://devrapp.springbrand.ai`） |
| `EVAL_WEB_API_TOKEN` | 与 eval-web Worker 共享的令牌（至少 32 个字符）。配置后 `/api/*` 只接受带正确 `X-Eval-Web-Token` 的请求；只有本地开发可以不配 |
| `EVAL_MANAGEMENT_MCP_TOKEN` | 可选，至少 32 个字符；Moss 受信服务端调用管理 MCP 的独立 Bearer Secret，不供 SP Agent 或 Eval Web 使用 |
| `EVAL_RESULT_MCP_TOKEN` | 可选，至少 32 个字符；仅供评估 Agent 调用结果提交 MCP，和管理 Secret 完全独立 |
| `EVAL_API_HOST`、`EVAL_API_PORT` | 可选，默认 `127.0.0.1`、`8788` |
| `LANGFUSE_BASE_URL`、`LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY`、`LANGFUSE_ENVIRONMENT` | 可选，与 Worker 相同；配置后才能调用 Run 的分数补同步接口 |

收到 SIGINT/SIGTERM 后停止接收请求，等待活动请求结束，再关闭 Run 队列和数据库连接池。API 不持有 Agent Worker 服务凭证，也不在请求中运行 Agent。

`pnpm --filter @eval-platform/eval-api start:worker`（`src/run-worker-main.ts`，配置见 `src/config/worker.ts`）启动 Run Worker：

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | Eval PostgreSQL 与 pg-boss |
| `EVAL_SP_AGENT_ORIGIN` | Eval SP Agent Worker，提供 `/internal/v1/eval-harness` 服务路由 |
| `EVAL_SP_SERVICE_TOKEN` | Eval SP 服务凭证，作为 `X-Eval-Service-Token` 发送 |
| `EVAL_BUNDLE_DIR` | 与 API 相同的 Bundle 目录；未配置 R2 时证据包存放在其下的 `evidence/` |
| `EVAL_EVIDENCE_R2_ENDPOINT`、`EVAL_EVIDENCE_R2_BUCKET`、`EVAL_EVIDENCE_R2_ACCESS_KEY_ID`、`EVAL_EVIDENCE_R2_SECRET_ACCESS_KEY` | 可选，四者同时设置：Eval 专用 R2 桶的 S3 接口地址（如 `https://<account>.r2.cloudflarestorage.com`）、桶名与访问密钥。设置后证据包存入该桶 |
| `EVAL_RUN_WORKER_CONCURRENCY` | 可选，每个实例同时处理的 Run 数，默认 `8` |
| `LANGFUSE_BASE_URL`、`LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY` | 可选，三者同时设置：Eval SP 上报 trace 的同一个 Langfuse 项目。设置后评委分数同步为被测 Chat 的 session 分数 |
| `LANGFUSE_ENVIRONMENT` | 可选，必须与 Eval SP trace 的 environment 一致（eval 部署为 `dev`） |

被测执行成功后，Worker 经 SP 导出接口取得被测产物清单、逐个文件和完整 safe Pi 轨迹（原样 `{ingestSeq,record}` 按记录边界分片），由 `src/evidence/` 按内容 hash 固化为 schemaVersion 2 证据包：`evidence/blobs/<sha256>` 与 `evidence/<evidenceId 的 hex>/manifest.json`，Sampling 只记录 `evidence` 引用。导出中断时，已存文件和轨迹游标作为 `Sampling.evidenceExport` 保存，下一轮只补读缺失部分（见 `packages/eval-runtime/README.md`）。评估时 Evaluator 是普通 Agent，有自己的 Chat 和 Space；Worker 把证据包导入 Evaluator Space 的 `/evidence/`（`manifest.json`、`artifacts/<原路径>`、`trajectory/events-000001.jsonl` 等有序分片），Evaluator 看不到 Subject Workspace。历史版本 1 文件不迁移、不删除，但新代码不把旧事件解码为 Pi。

评估 Agent 通过 Eval API 自带的 MCP Server（`POST /mcp/evaluation-results`，工具 `submit_evaluation`，需配置 `EVAL_RESULT_MCP_TOKEN`）直接提交结果，提交时按锁定 Schema 校验并存入 `eval_evaluation_submissions`；没有提交时依次回退到 SP 返回的 `/output/result.json` 和最终回复中的 JSON。只有合法结果才使评估成功，详见[评估结果提交](../../docs/eval-evaluation-result-submission.md)。Metrics 统一按 Project 锁定 Schema 解析和展示所有支持的字段。配置 Langfuse 时，同一 Metrics reader 从合法输出派生顶层 numeric `score` 和可选字符串 `reason`，发布到被测 Chat 的 session，名称 `judge-score`、ID `eval-score:<evaluationId>`。原始输出不增加派生 score/reason 字段；没有 numeric score 不影响评估。同步失败只记在 `scoreSync`，补同步重新从原始输出与锁定 Schema 派生。

Worker 可多实例部署、滚动升级；收到信号后停止取任务，等待进行中的 Run 结束再关闭 pg-boss 和连接池。调度、恢复、停止语义和剩余风险见[架构方案](../../docs/architecture.md#run-调度与停止)。

Run job settlement belongs to the application-owned
`RunRecoveryStore.settleRunJob(runId, jobId)` Interface. Under the same Project
row lock used by admission, stop, recollection and MCP acceptance, it rereads
durable work and atomically completes an idle job, completes and defers a
resource-only wait, or leaves an active job owned by the Worker for retry.
The handler uses this Interface on every successful exit, including an initially
idle Run; pg-boss's later auto-ack is only an idempotent acknowledgement.
A new request therefore either becomes visible before settlement or enqueues
after completion. Correctness must not depend on a different singleton key for
each recovery path. The lock covers database work only, never SP requests.

## 本地开发

`start:api` 和 `start:worker` 自动加载本包目录下的 `.env.eval`（不提交），已有 shell 环境变量优先；文件不存在时只读取 shell 环境变量。根目录 `pnpm dev` 同时启动这两个进程与 Web。使用 Web 默认代理时，在 `.env.eval` 中设置 `EVAL_API_PORT=18788`，并确保 Web 的 `EVAL_API_ORIGIN` 指向该端口。

`@springbrand/eval-harness` 以精确版本从 npm 安装，版本需与 Eval SP 部署的契约一致；ZIP 检查、错误类型和初始化上限均从这个公开入口读取，不直接依赖 SP 的 utils。`@springbrand/http` 直接来自 npm，与 SP 使用同一精确版本。

数据库只有 `migrations-postgres/0000_initial.sql` 一个初始基线，用 `pnpm --filter @eval-platform/eval-api db:migrate` 应用于本地库（需 `DATABASE_URL`），与部署镜像共用同一迁移入口。命令先从实际连接输出库名、角色和服务地址，不输出连接串或凭据；迁移前校验已应用记录的时间与 SQL hash，迁移后用当前 Drizzle schema 验证所有表、列可读取。改写已应用 SQL、未知迁移或缺失结构都会阻断部署，不会因 Drizzle 跳过旧编号而报成功。命令不清库，也不兼容旧结构。本地旧库与新基线或新请求指纹不一致时清库重建；共享库必须经确认的数据恢复/升级操作处理，不能把本地命令指向共享库。测试设置 `DATABASE_URL` 后为每次运行创建独立的临时数据库；不提供时跳过需数据库的测试。pg-boss 在同一数据库中自建 `pgboss` schema。

## 部署

`pnpm --filter @eval-platform/eval-api build` 用 esbuild 把 `src/server.ts`、`src/run-worker-main.ts` 和 `src/migrate.ts`（用 drizzle-orm 应用 `migrations-postgres`）打包为 `dist/*.js`，只把 `pg` 留作外部依赖；`scripts/runtime-package.mjs` 据此从锁文件生成只含这些依赖的运行时包。`Dockerfile`（在仓库根目录构建）的运行时镜像只有 `dist/`、迁移目录和这些生产依赖，不含 TypeScript 源码和 tsx，分别以 `node dist/server.js`、`node dist/run-worker-main.js`、`node dist/migrate.js` 运行。本地开发仍用 `start:api`、`start:worker`（tsx）。生产环境与 Eval SP 共用 AWS 资源：

- 运行在 Eval SP 所在的 EC2 实例上，compose 项目 `eval-platform`（`/opt/eval-platform/production`），服务 `api` 与 `run-worker` 共享 `bundles` 卷作为 `EVAL_BUNDLE_DIR`；日志写入 CloudWatch `/springbrand/eval-platform/production`。
- 数据库是 Eval SP RDS 实例上的 `eval-platform` 库，角色 `eval_platform_app`。
- `api` 加入 Eval SP 的 compose 网络 `eval_default`（别名 `eval-platform-api`），由该网络的 cloudflared 隧道 `sp-platform-api-eval` 对外提供 `https://evalapi.springbrand.ai`；不开放任何主机端口。
- 运行配置在 Secrets Manager：`eval-platform/api/production`（上文环境变量，`DATABASE_URL`、`EVAL_BUNDLE_DIR`、`EVAL_API_HOST`/`PORT` 除外）与 `eval-platform/database/production`（数据库凭证）。部署时生成 `DATABASE_URL`，API 与 Worker 只拿到各自需要的变量。Eval SP 重新发布后需更新其中的 `EVAL_SP_SOURCE_COMMIT` 并重新部署。

AWS 资源由 `infra/aws/cloudformation.yaml`（栈 `eval-platform-api`）创建。推送到 `main` 且改动涉及 eval-api、共享包或部署文件时，`.github/workflows/ci.yml` 在 eval-api（及共享包）测试通过后经 GitHub OIDC 构建并推送 ECR 镜像，再通过 SSM 在实例上执行 `infra/aws/deploy/deploy.sh`：拉取镜像、运行迁移、替换两个服务，检查 `/healthz` 并以 Web 凭证读取初始素材、初始上下文、Prompt 数据集和评分 Schema 四个目录。部署不重建数据库，也不自动上传演示数据；可重复使用的模拟输入见 [联调数据](../../fixtures/eval-demo/README.md)。

## HTTP 控制面

`GET /api/input-limits` 从实际校验常量返回上传与选择上限，Web 不保存数值副本。

Project 视图的 `runSequence` 和 `currentRun` 从同一最新 Run 行及其当前工作投影读取；序号复用准入已有的 `runs.sequence`，没有另一份版本存储。Web 因而能发现两次轮询间已经结束的短 Run。

`GET /api/projects/{projectId}/evaluation-output-schema` 在同一只读快照中检查 Project 归属和可见性，复用 Worker 的计划引用及摘要校验，返回 Schema 引用与正文；没有评估计划时为 null。Schema 目录软删除不影响此读取，目录接口仍禁止新选择已删除项。

路由、信封、状态码、错误码和请求体规则只在 [Eval HTTP 控制面](../../docs/eval-http-api.md) 描述；Dataset 上传、初始资源与输出格式见 [Dataset upload](../../docs/eval-dataset-upload.md)。内容上限的唯一来源是 `src/limits.ts`（`RUN_TARGET_IDS` 同时限制一个 Project 绑定的 Data 数和一次 Run 的选择/目标 ID 数，超出的展开结果返回 413），各路由的请求体上限由其推导。

Eval API 不做交互式登录，固定以一个 Eval SP 服务账号运行。服务账号与它的长期会话由 sp-platform 的 `pnpm --filter sp-platform-api eval:bootstrap-service-account` 在 `sp-platform-eval` 库中创建，可重复执行，每次轮换会话。进程启动时用 `EVAL_SP_SERVICE_SESSION_TOKEN` 调用一次 Eval SP 的 `/api/auth/me`，结果必须是 `EVAL_SP_SERVICE_USER_ID`，否则拒绝启动；之后每个 `/api/*` 请求都归属这个账号，请求不需要携带 `Authorization`，客户端也不能指定用户。Agent Config 的增删改查用服务会话调用 Eval SP 的 `/api/user-agent-configs`，写请求带上 `EVAL_WEB_ORIGIN` 以满足 SP 的来源校验。Eval 不保存配置正文。服务账号的积分不自动发放，由 `/api/credits/grants` 用 `EVAL_SP_ADMIN_TOKEN` 调用 Eval SP 的管理员加积分接口手动添加（见 HTTP 契约的 Credits 一节）。API 是内部服务，只能部署在受信网络内。

共享 Agent 编辑器的默认模板、模型和资源库经 `/api/agent-library` 的显式方法/路径表转发；资源库正文由 SP 公共接口校验，Eval 统一执行请求体限长、JSON 唯一字段、Origin 与固定服务账号规则。配置写入不在此转发表内，仍经过已有冻结副本服务。传输层从 Eval HTTP 目录解码公开编辑器错误，保留验证后的删除阻挡详情；SP 服务会话失效始终是依赖不可用，不能触发浏览器重新登录。接口列表与字节限制见 HTTP 契约。

Agent 用途由 Eval 写入 `eval_agent_config_purposes`，只接受 `execution` 或 `evaluation`；已有配置首次读取时按公开评估结果 MCP 绑定初始化一次。编辑用途时，服务端会把评估结果 MCP 与配置同步：评估 Agent 必须带上唯一可用的结果 MCP，执行 Agent 会移除该绑定。公开 MCP 目录不可用、canonical 评估结果 MCP 歧义或配置选择的 MCP 不可用时，用途读取或需要同步 MCP 的写入返回 `AGENT_CONFIG_PURPOSE_UNAVAILABLE`（503），不返回 unknown 选项。项目冻结执行副本和评估副本时分别校验用途，避免只靠 Web 选择器筛选。

`owner-services.ts` 按服务账号组装一次用户范围内的服务；同一用户的并发请求经 `active-owner-admission.ts` 共享 Run 准入实例（`createEvalRunAdmission` + 用户范围的 `createPostgresProjectPlanReader` 与 `RuntimeStore`），请求结束后释放；准入不持有登录 token。

### Project 创建、评估计划与冻结副本

`src/projects/service.ts` 是 Project 唯一的写入口：

- 创建：在一个 repeatable-read 只读事务里读取所选的自有、未软删除 Dataset 及其当前成员（`dataIds` 必须是当前成员），同一 Data 在多个 Dataset 中只生成一个 ProjectSample（`datasetIds` 按绑定顺序），`samplingCount` 是默认次数，`samplingCounts` 按 Data 覆盖。随后通过 SP 公开接口克隆所选 Agent Config（`src/agent-configs.ts`），用 Runtime 的 `normalize*Plan`/`digest*Plan` 校验与摘要计划，Schema 摘要是规范 JSON 的 sha256。Project、Dataset/Data 快照、两个计划和副本对应行在一个事务内写入，再以 `{all:true}` 预览并提交首个 Run。
- 幂等：请求体顶层 `idempotencyKey` 在用户内唯一（`eval_projects.creation_key`，与校验后请求体的指纹 `creation_fingerprint` 一起保存），首个 Run 使用同一个 key。克隆 SP 副本之前先按 key 查找：同一请求体重放原 `{project, run}`（若上次在创建事务后、准入前中断，则此时补交首个 Run），不同请求体返回 `PROJECT_IDEMPOTENCY_CONFLICT`，已软删除的 Project 不会复活（无论请求体都返回 `PROJECT_NOT_FOUND`）；重放请求的首个 Run 准入失败时只返回错误，从不补偿删除别的请求创建的 Project。并发的相同请求只有一个创建事务提交，其余请求删除自己的副本后重放。
- 创建 key 从 Project 提交起受保护：只有 ProjectService 准入首个 Run 时传入可信的瞬时 `creationFingerprint`；`RuntimeStore.admitRun` 在 Project 行锁下与已存指纹比对后才允许该 key 插入/入队。普通 HTTP/管理 Run 提交无此证明，同 key 即使还没有 Run 也返回 `RUN_IDEMPOTENCY_CONFLICT`；不同 key 仍可先运行并 supersede 创建的首个 Run。证明不在公开请求/Schema、Run 行或队列中；创建的只读对账/重放拒绝已存的错误首 Run 身份，不误报成功。
- 补偿：写入事务前任何失败都删除已建的 SP 副本；首个 Run 准入失败时，若该 Project 仍没有任何 Run，就硬删除它的全部行再删除副本（`deleteUnrun`），否则保留已准入的 Project。SP 删除尽力而为，残留的孤儿副本不会出现在列表中。
- 评估计划：`PUT /evaluation-plan` 先确认未锁定（避免多余副本），冻结新的 Evaluator 副本，再在与准入相同的 Project 行锁下替换计划、标记旧副本 retired；提交后删除旧副本，事务失败则删除新副本。首个 pipeline/evaluation Run 在准入事务中写入 `locked_at`。
- 冻结副本：SP 创建体为 `{slug: "eval-frozen-<uuid>", name: "<原名> (frozen)", description, setting}`（SP 对已存在的 slug 返回原记录，所以每次都用新 slug）；判定与可见性规则见 [Agent Config 冻结副本](../../docs/eval-project-redesign.md#23-agent-config-冻结副本)，实现在 `src/agent-configs.ts`。

## PostgreSQL 适配器

`src/db/client.ts`、`schema.ts` 定义与 SP 一致的 Drizzle/`pg` 注入边界和表结构；领域错误类集中在 `src/db/errors.ts`。所有记录都携带用户归属，组合外键保证 Project、ProjectSample、Sampling、Run 和 Evaluation 同用户。

表结构见 [Project、Runtime 与 Metrics 改造方向](../../docs/eval-project-redesign.md#46-持久化)。目录侧的 Dataset/Data/素材 Bundle/上下文 Bundle/Material/Session/输出格式软删除从不被 Project 阻挡：快照复制了 Data，Worker 按 ID 读取素材文件和 Schema。Bundle、Material、Session 软删除也不被 Data 绑定阻挡，不自动解绑或删除文件；同一 Data 同字段的已有引用可保留、重排或移除，新增绑定仍要求活动资源。用例更新、绑定 PATCH 和相同 Data 导入重放都遵循这一规则，并继续校验归属、类型及完整素材大小。

- `createPostgresProjectStore` 写 Project 快照、替换评估计划、软删除（存在活动 Run 时拒绝）和读取计划视图；`createPostgresProjectPlanReader`（用户范围）与 `createPostgresWorkerProjectPlanReader`（仅 Worker）实现 Runtime 的 `ProjectPlanReader`，已软删除的 Project 读为不存在，详情、预览、Run、Metrics 和观察入口因此一律 404。
- `createPostgresRuntimeStore` 与 HTTP 路由使用同一已校验的 `EvalSpRelease`；`admitRun` 在 Project 行锁下先校验创建 key 的可信瞬时证明，再完成重放/冲突（同 key 的原 Run 即使被后续 Run 取代也可重放）、忙碌检查、发布校验、计划摘要与评估计划复核、目标与当前 Sampling 集合复核、只删除选中记录及其 Run 关联、分批插入、首次评估锁定评估计划，并在同一事务内经 `fromDrizzle(transaction)` 投递 pg-boss 任务。Run 行从不删除，被替换的成员从其 Run 关联中移除。
- `createPostgresWorkerRuntimeStore` 只供 Worker 跨用户恢复 Run，HTTP 路由不能注入它。
- Sampling/Evaluation 写入携带预期 `revision`，PostgreSQL 用条件 `UPDATE` 检查版本并递增；未命中即报告冲突，由 Runtime 读回校准。原始资源快照与摘要在同一事务写入，阶段事实不含快照正文。
- `createPostgresMetricsSource` 在一个 repeatable-read 只读事务内按固定计划读取范围内全部 ProjectSample（含从未运行的）、当前 Sampling/Evaluation（可按 `runIds` 过滤）和相关 Run 投影，全部为集合查询，不用实时 `dataset_data` 推断归属。`createPostgresObservationReader` 校验 Project 与当前记录后返回只读观察引用，从不返回可写 Chat URL。
- 初始 Session/素材只存外部引用，Agent 工作区和完整轨迹只保留 Runtime 原始引用；迁移不触碰 SP DO。

## SP Harness 与 Bundle 目录

readiness 与快照请求接收 Runtime 的本地 `AbortSignal`，使用现有 HTTP SDK 取消请求和正文读取；取消保留其分类，不包装成网络故障。Runtime 统一资源预算、等待和放弃通知，下载名额直到真实请求与原子保存结束才释放，详见 [运行时合同](../../packages/eval-runtime/README.md)。

`src/sp/harness.ts` 用服务凭证确保 Inbox Chat、初始化、提交/重启、按键校准、收集完整产物/轨迹、分页资源、Evaluator 原样的 `structuredOutput` 结果文件，以及按轨迹读取 Evaluator 最后一条回复（`readFinalReply`）；`sp/submission-observer.ts` 以 WebSocket 终态推送为主，Ping/Pong 检测静默失活，断线后按已知 Submission ID 读取一次权威状态（404 表示 Submission 或 Chat 已不存在，不回退按键读取）并对同一 Submission URL 有限重连；瞬态错误只表示状态未知，预算用尽时抛出可重试的 “status unconfirmed” 错误，健康连接期间不轮询。

资源先经无事件的 readiness 路由等待 SP 定稿；期限内不下载未定稿页面。期限届满后通过 `allowPartial=true` 显式读取冻结的已知 native 页面、配对的 API 计费页面及必要的验证字节，保留 `finalized:false`、`coverage.partial` 与真实计数，不把未知计费记为零。证据读取仍携带 `submissionId` 并保留完整 Chat 轨迹。SP HTTP 请求（含 readiness）默认最多等待 60 秒，停止调用最多等待 10 秒；每个资源页面与证据传输分别最多等待 5 分钟，页面 JSON 限 4 MB，其他 JSON 仍按 V8 最大字符串长度限制。证据/资源 GET 的 `409 EVIDENCE_NOT_READY` 通常可重试，但已请求 partial 页且 SP 仍不支持读取时不会重复消耗下载预算；其他 409 不重试。证据导入流式 PUT 并边传边校验大小与 SHA-256；单个证据文件上限取 `DEFAULT_EVIDENCE_LIMITS` 与已安装的 `@springbrand/eval-harness@0.1.0-alpha.7` 的 `EVAL_EVIDENCE_FILE_MAX_BYTES` 中较小者，现为 95 MB。Harness 的 `log` 事件由 Worker 写入 pino，不含正文或凭证。当前只支持 `sp` 框架，`codex`、`cc` 明确拒绝。服务契约、Bundle 文件布局与校验规则见 [Eval SP Harness service contract](../../docs/eval-sp-harness-protocol.md)。SP 服务路由在独立 SP 分支实现；npm alpha.7 已发布，但缺少 partial 请求的公开契约，且真实跨部署联调仍需完成。

初始化的 `data.userPrompt` 与提交的 `prompt` 通过该包的共享 `evalPromptSchema` 校验：只拒绝非字符串及纯空白，首尾空格、换行和 Unicode 空白原样发送，不在 Eval 侧清洗 Prompt。

`src/sp/bundle-directory.ts` 的 `openBundleDirectory` 是 API 上传与 Worker 读取共用的唯一 Bundle 目录实现；文件错误以 `BundleFileError` 表达，只有 `unavailable` 可重试。`src/sp/bundle-content.ts` 是 Material 与 Session 内容的唯一校验规则，上传、ZIP 导入和读取共用；`src/bundle-zip/` 用 SP 的 `inspectStrictZip` 读取 ZIP，再按 Bundle 类型分组成资源。

资源目录通过现有 `BundleCatalog` 的 `listFiles` / `getFile` 提供只读文件清单和内容，先检查当前用户的活动 Bundle 与资源，再读取同一份 Bundle 文件。素材保留资源内路径；上下文以单个 `/context.json` 或 `/context.jsonl` 文件公开原文。HTTP 文件响应与运行观察文件共用附件、sandbox CSP 和禁止缓存的响应边界。目录软删除不开放浏览，Worker 对既有 Project 引用的读取不变。已存内容损坏为 `corrupt`，HTTP 映射为安全的 `500 BUNDLE_FILE_CORRUPT` 并保留内部 cause；上传校验仍为 `invalid` / `too-large`。


数据集维护：DatasetService.addData(datasetId, inputs) 校验全部输入并生成身份，DatasetStore.createDataBatch 在一个事务中创建全部 Data 及其关联，失败不保留部分用例。HTTP `POST /api/datasets/{datasetId}/data/import` 接受 `{format: "json" | "jsonl", content: string}`，采用用例列表的严格解析、资源引用限制及 prompt 文件/请求大小上限；返回 201 Data[]。原有完整文档导入的身份冲突和重放语义不变。Web 导航调整不改变 Subject/Evaluator、资源引用和项目冻结副本契约。


手动重新收集结果：POST /api/projects/{projectId}/samplings/{samplingId}/collect 与 /evaluations/{evaluationId}/collect 返回 202 {runId, queued}；可选请求体 `{"target":"resources"}` 只在已结束阶段仍有已结束 Attempt 欠资源（与 Runtime 同一 `stageOwesResources`）时设置 `resourcesPending` 重新读取资源快照，不改状态；只等资源检查的 Run 由延迟任务在最早 `nextAttemptAt` 唤醒，不消耗重试次数，详见 [HTTP 控制面](../../docs/eval-http-api.md#manual-recollection)。Run 活跃度与 `isStageRecoveryPending()` 一致：没有待收尾停止的 Run 在成员带 `resourcesPending` 时保持活跃；待收尾的停止忽略该标记，收尾会清除它，之后只有手动资源补采会重新设置并让 Run 重新活跃。以下为默认 `output` 目标：仅接受归属匹配、最后 Attempt 为 completed 且有 Chat/Submission 的失败阶段；已成功为幂等无操作，重复待收集请求不重复入队，项目忙或 Run 停止尚未收尾时拒绝；停止已收尾的 Run 可补收输出，也可补采停止时记为失败的资源（均不重开停止）。API 在 Project 行锁内设置 retrying + collectionPending，并原子提交原 Run 队列任务。Worker 只读取已有输出，不创建或重启 Agent/Attempt；执行侧必须归档产物和完整轨迹，评估侧保存原始结果并沿用校验和同步。失败清除待收集标记并保留错误，支持再次补收。补收执行不自动启动之前已取消的评估。当前运行查询允许旧 Run 因补收重新活跃，runSequence 仍是最大创建序号。

Run 评估列表省略可选 output 正文和 attempt.resources，并附带关联 Sampling 的执行状态；详情接口返回完整记录，其中 attempt.resources 只是资源状态与摘要，原始快照不经记录接口返回，而由 `GET /api/projects/{projectId}/{samplings|evaluations}/{id}/attempts/{attemptId}/resource-snapshot` 按 Attempt 以游标分块流式下载，API 不解析快照。手动资源补采（`target: "resources"`）清除各 Attempt 的 `downloads`/`exhausted`，重新给完整下载预算。

## Metrics memory bounds

Each Attempt's resource snapshot is stored in `eval_attempt_resources` (primary key `stage, record_id, attempt_id`; cascades with its Sampling/Evaluation) with its body-free Metrics projection, written in one upsert in the same transaction as the compare-and-set record update that marks it collected (both or neither). Historical raw snapshots are unchanged; new hydrated native records are immediately reduced to verified compact facts, so the raw Pi body is not stored twice in PostgreSQL/R2. New bounded resources are spooled privately, then inserted page by page into a transaction-local table and assembled into the existing `json` columns in PostgreSQL; neither the Harness nor the Store constructs a whole JS snapshot. Independent usage and billing settlements remain unchanged. `eval_samplings.facts`/`eval_evaluations.facts` hold only resource state and summaries, so Worker scheduling, stop, Run views and every stage write stay small; writes compare and bump the record's `revision` column (the MCP result acceptance and manual recollection bump it too). Metrics reads the projection one record at a time, for summaries and Sampling detail alike. Migration `0004_attempt_resources` creates the table (its check requires `evaluation_id` exactly for evaluation rows) and revision columns and drops `metric_facts` with its trigger; it does not backfill. The new SQL assembly still requires an isolated PostgreSQL integration test; Metrics' current per-Attempt JSON hydration may itself become large for very high compact-row counts and is not claimed globally OOM-safe.

The `snapshot` and `metric_snapshot` columns use PostgreSQL `json` to preserve contract-permitted JavaScript strings losslessly, including unpaired surrogates and escaped U+0000; stage facts remain `jsonb`. Migration `0005_resource_snapshot_json` converts both columns in place in one `ALTER TABLE`, preserving existing data and the applied migration-history prefix. Migrations `0000` through `0004` are unchanged and migration-history validation remains enabled. The conversion takes a table lock and may rewrite the table, so plan an appropriate migration window. No online migration execution is included in this change.

MCP-enabled Evaluations complete on validated result acceptance, atomically with the result and its revision. Status-socket loss is recoverable observation failure, not an Evaluation terminal fact. Late submissions cannot bypass Project deletion, Run stop/cancellation or replacement. Runtime preserves accepted results when subsequent observation or collection fails. See [evaluation result submission](../../docs/eval-evaluation-result-submission.md).

The acceptance transaction also preserves an existing resource wait or starts `resourcesPending` for submitted Attempts still owing resources, using Runtime's public resource predicate. A Worker crash after MCP acceptance must not leave a succeeded Evaluation invisible to durable resource recovery. The submission store requires the existing `RunQueue`: when a previously inactive Evaluation acquires owed resource recovery, it enqueues a `collection:<runId>` wake-up in that same Project-locked transaction, so even a completed or settling original job cannot lose recovery. It checks `isStageRecoveryPending()` on the locked Evaluation's old status, regardless of another member keeping the Run active, since that member can finish before acceptance commits. Already-pending Evaluations keep their current durable wake-up, and identical replay neither adds a job nor resets the first wait deadline.
