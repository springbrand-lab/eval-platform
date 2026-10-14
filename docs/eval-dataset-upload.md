# Dataset upload and initial-resource catalog

The Dataset tab creates one prompt Dataset from a JSON or JSONL file. The file contains only Data rows; the create request carries Dataset `name` and `description` separately. Both fields are required, nonblank text. Every row requires nonblank `name`, `description`, `userPrompt` and `evalPrompt`. Prompt text is preserved. Other JSON business fields are allowed, but this upload route rejects platform IDs and initial-resource references; users select resources for each returned Data row after import. The existing general Dataset import remains available for execution-only data.

`POST /api/datasets/prompt-import` accepts JSON `{name,description,format,content}`. For `format:"json"`, `content` is a JSON array of Data objects. For `format:"jsonl"`, every nonblank line is one Data object. The API validates the whole input before one atomic Dataset/Data import and returns `{dataset,data}` with server-generated IDs. Both formats reject duplicate decoded JSON keys. The body is limited to 20 MB, while file content is limited to 10 MB. Invalid input returns `400`, over-limit input `413`.

Bundle, Material and Session catalog identities follow SP's UUID pattern, generated with `crypto.randomUUID()` by the Eval API. IDs are opaque and the UI displays required `name` and `description`. One Bundle groups separately uploaded resources; there is no whole-Bundle upload. A Material is one file or a directory represented by its contained file paths. A Session is one canonical JSON or JSONL context. Bundle metadata and resource metadata are owner-scoped PostgreSQL records; file bytes remain in the owner-scoped `EVAL_BUNDLE_DIR`. No SP Durable Object storage is accessed.

| Operation | Route | JSON body / response |
| --- | --- | --- |
| Create Bundle | `POST /api/bundles` | `{name,description}` / `201 {bundleId,name,description}` |
| List Bundles | `GET /api/bundles` | `200 Bundle[]` |
| Read/edit Bundle | `GET, PATCH /api/bundles/{bundleId}` | `200 Bundle`; PATCH accepts `name` and/or `description` |
| Delete Bundle | `DELETE /api/bundles/{bundleId}` | `204`; marks the Bundle and its resources deleted |
| Upload one Material | `POST /api/bundles/{bundleId}/materials` | `{name,description,files:[{path,mediaType,contentBase64}]}` / `201 {bundleId,materialId,name,description}` |
| List Materials | `GET /api/bundles/{bundleId}/materials` | `200 Material[]` |
| Read/edit/delete Material | `GET, PATCH, DELETE /api/bundles/{bundleId}/materials/{materialId}` | `200 Material`; PATCH accepts `name` and/or `description`; DELETE returns `204` |
| Upload one Session | `POST /api/bundles/{bundleId}/sessions` | `{name,description,format:"json"|"jsonl",content}` / `201 {bundleId,sessionId,name,description,format}` |
| List Sessions | `GET /api/bundles/{bundleId}/sessions` | `200 Session[]` |
| Read/edit/delete Session | `GET, PATCH, DELETE /api/bundles/{bundleId}/sessions/{sessionId}` | `200 Session`; PATCH accepts `name` and/or `description`; DELETE returns `204` |
| Bind one Data row | `PATCH /api/data/{dataId}/initial-resources` | Optional `{initialMaterials:{bundleId,materialId},evalInitialMaterials:{bundleId,materialId},initialSession:{bundleId,sessionId}}` / updated Data |
| Upload output format | `POST /api/evaluation-output-schemas` | `{name,description,content}` where `content` is the JSON Schema file text / `201 {outputSchemaId,name,description,schema}` |
| List output formats | `GET /api/evaluation-output-schemas` | `200 OutputSchema[]` |
| Read/edit output format | `GET, PATCH /api/evaluation-output-schemas/{outputSchemaId}` | `200 OutputSchema`; PATCH accepts `name` and/or `description` |
| Delete output format | `DELETE /api/evaluation-output-schemas/{outputSchemaId}` | `204` |
| Bind Project output format | `PUT /api/projects/{projectId}/evaluation-output-schema` | `{outputSchemaId}` / updated Project |

The Material upload preserves each file's workspace path and supports nested paths. Empty directories are not represented. The Session content must satisfy the canonical SP history format. Resource references are bound at the individual Material or Session level, never to an entire Bundle. `initialMaterials` supplies Subject execution; `evalInitialMaterials` supplies evaluation; `initialSession` supplies Subject execution only. Binding verifies selected uploaded resources belong to the authenticated owner. Re-uploading a Material or Session under the same generated ID is not part of this create flow.

Every route requires the Eval SP Bearer session. The API obtains the owner from that session, not the body. Catalog queries and writes use the owner in SQL, and Bundle file writes use the same owner directory. Missing Bundles or resources return `404`.

An output format is one standalone, immutable draft 2020-12 JSON Schema file. It has a server-generated UUID, required `name` and `description`, and no Bundle. The catalog validates and stores the parsed Schema. A Project stores only `evaluationOutputSchemaId` and may change that ID until its first Evaluation Run is admitted. Runtime resolves the saved Schema through that ID before initializing each Evaluator. Project list/read responses expose the ID, not the Schema body. A missing or another owner's ID cannot be bound.

Uploaded Material files, Session content and output Schema content have no edit operation. Names and descriptions can be changed without uploading again. Dataset and Data already expose full metadata updates; the per-Data resource binding PATCH and Project output-format binding PUT change selected IDs.

All catalog deletes are soft deletes. Deleted entries disappear from owner list/detail queries and cannot be newly bound; their records and bytes remain so existing Data and Project bindings continue to run. Deleting a Bundle also hides its Materials and Sessions. Dataset and Data delete endpoints likewise mark rows deleted and hide them from ordinary queries; a Data still referenced by an active Dataset or a Sample, or a Dataset still selected by a Config, cannot be deleted. Once a Dataset has been deleted, its former membership does not prevent soft deletion of an otherwise unused Data row.
