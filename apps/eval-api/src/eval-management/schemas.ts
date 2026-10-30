import { RUN_OPERATIONS } from "@eval-platform/eval-contracts";
import { platformIdSchema } from "@eval-platform/eval-dataset";
import { z } from "zod";
import { expectedSnapshotsSchema, projectCreateSchema } from "../projects/schemas.js";
import { OUTPUT_SCHEMA_BYTES } from "../limits.js";
import { entityIdSchema, idempotencyKeySchema, unique } from "../routes/schemas.js";
import { expectedPlanDigestsSchema, submitRunBodySchema, selectorSchema } from "../routes/runs/runs.routes.js";

export const pageSchema = {
  page: z.number().int().min(1).max(10_000).default(1),
  pageSize: z.number().int().min(1).max(50).default(20),
};
const byteOffset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional();
const search = z.string().trim().max(120).optional();
/** SP resource IDs may contain '/' (encoded for detail reads), unlike Runtime path IDs. */
export const resourceIdSchema = idempotencyKeySchema.max(255);
const resourceIds = z.array(resourceIdSchema).max(50).refine(unique, "IDs must be unique").default([]);

export const listOptionsSchema = z.strictObject({
  category: z.enum(["agents", "datasets", "dataset_data", "projects", "project_detail", "output_schemas", "output_schema_detail", "project_schema_detail",
    "material_bundles", "session_bundles", "materials", "sessions", "material_files", "session_files",
    "input_limits", "credits",
    "approval_dataset", "approval_agent", "approval_output_schema", "approval_project"]),
  q: search, ...pageSchema,
  bundleId: platformIdSchema.optional(),
  materialId: platformIdSchema.optional(),
  sessionId: platformIdSchema.optional(),
  datasetId: platformIdSchema.optional(),
  dataIds: z.array(platformIdSchema).min(1).max(50).refine(unique).optional(),
  userAgentId: platformIdSchema.optional(),
  outputSchemaId: platformIdSchema.optional(),
  schemaOffset: byteOffset,
  projectId: entityIdSchema.optional(),
  projectSampleIds: z.array(entityIdSchema).max(50).refine(unique).optional(),
  samplingIds: z.array(entityIdSchema).max(50).refine(unique).optional(),
}).superRefine((value, ctx) => {
  const invalid = () => ctx.addIssue({ code: "custom", message: "Choose one bounded selection" });
  if (value.schemaOffset !== undefined
    && value.category !== "output_schema_detail" && value.category !== "project_schema_detail") invalid();
  if (["material_bundles", "session_bundles", "materials", "sessions", "material_files", "session_files"].includes(value.category)) {
    if (value.q !== undefined || value.datasetId || value.dataIds || value.userAgentId || value.outputSchemaId
      || value.projectId || value.projectSampleIds || value.samplingIds
      || (value.category === "materials" || value.category === "sessions"
        || value.category === "material_files" || value.category === "session_files") !== !!value.bundleId
      || (value.category === "material_files") !== !!value.materialId
      || (value.category === "session_files") !== !!value.sessionId) invalid();
  } else if (value.bundleId || value.materialId || value.sessionId) {
    invalid();
  } else if (value.category === "dataset_data") {
    if (!value.datasetId || value.dataIds || value.userAgentId || value.outputSchemaId || value.projectId
      || value.projectSampleIds || value.samplingIds || value.q !== undefined) invalid();
  } else if (value.category === "approval_dataset") {
    if (!value.datasetId || value.userAgentId || value.outputSchemaId || value.projectId || value.projectSampleIds || value.samplingIds
      || value.q !== undefined || value.pageSize > 10) invalid();
  } else if (value.category === "approval_agent") {
    if (!value.userAgentId || value.outputSchemaId || value.datasetId || value.dataIds || value.projectId
      || value.projectSampleIds || value.samplingIds || value.q !== undefined || value.page !== 1) invalid();
  } else if (value.category === "approval_output_schema") {
    if (!value.outputSchemaId || value.userAgentId || value.datasetId || value.dataIds || value.projectId
      || value.projectSampleIds || value.samplingIds || value.q !== undefined || value.page !== 1) invalid();
  } else if (value.category === "output_schema_detail") {
    if (!value.outputSchemaId || value.userAgentId || value.datasetId || value.dataIds || value.projectId
      || value.projectSampleIds || value.samplingIds || value.q !== undefined || value.page !== 1
      || value.pageSize !== 20) invalid();
  } else if (value.category === "project_schema_detail") {
    if (!value.projectId || value.outputSchemaId || value.userAgentId || value.datasetId || value.dataIds
      || value.projectSampleIds || value.samplingIds || value.q !== undefined || value.page !== 1
      || value.pageSize !== 20) invalid();
  } else if (value.category === "approval_project") {
    if (!value.projectId || value.userAgentId || value.outputSchemaId || value.datasetId || value.dataIds || value.q !== undefined || value.pageSize > 10
      || !((value.projectSampleIds?.length ?? 0) + (value.samplingIds?.length ?? 0))
      || (value.projectSampleIds?.length ?? 0) + (value.samplingIds?.length ?? 0) > 50) invalid();
  } else if (value.category === "project_detail") {
    if (!value.projectId || value.userAgentId || value.outputSchemaId || value.datasetId || value.dataIds
      || value.projectSampleIds || value.samplingIds || value.q !== undefined) invalid();
  } else if (value.datasetId || value.dataIds || value.userAgentId || value.outputSchemaId
    || value.projectId || value.projectSampleIds || value.samplingIds) {
    invalid();
  }
});

export const searchResourcesSchema = z.strictObject({
  kind: z.enum(["models", "skills", "action_groups", "actions", "connector_components", "extensions", "toolkits", "references"]),
  q: search, ...pageSchema,
  supplierId: resourceIdSchema.optional(), unassigned: z.boolean().optional(),
  cursor: z.string().min(1).max(512).optional(), id: resourceIdSchema.optional(),
}).superRefine((value, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: "custom", message });
  if (value.kind === "actions" && !value.id && (!!value.supplierId === (value.unassigned === true))) {
    invalid("Choose exactly one Action supplierId or unassigned:true");
  }
  if (value.id && (value.supplierId || value.unassigned !== undefined)) invalid("A detail read cannot filter Action groups");
  if (value.kind !== "actions" && (value.supplierId || value.unassigned !== undefined)) invalid("Action group filters are only for actions");
  if (value.cursor && value.kind !== "toolkits") invalid("cursor is only for toolkits");
  if (value.id && !["actions", "references"].includes(value.kind)) invalid("id is only for Action or Reference details");
  if (value.kind === "toolkits" && value.page !== 1) invalid("Toolkit connections use cursor, not page");
});

export const createAgentSchema = z.strictObject({
  operationKey: idempotencyKeySchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).optional(),
  purpose: z.enum(["execution", "evaluation"]),
  instructions: z.string().max(32_000).refine((value) => value.trim().length > 0, "instructions must not be blank"),
  modelId: resourceIdSchema,
  skillIds: resourceIds,
  referenceFileIds: z.array(platformIdSchema).max(8).refine(unique, "IDs must be unique").default([]),
  actionIds: resourceIds,
  connectorToolkitIds: resourceIds,
  connectorIds: resourceIds,
  extensionIds: resourceIds,
});

export const uploadRefSchema = platformIdSchema.describe("Opaque ref returned only by the authenticated byte ingress");
const resourceUpload = { operationKey: idempotencyKeySchema.max(200), uploadRef: uploadRefSchema };
export const saveInitialResourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...resourceUpload, kind: z.literal("material") }),
  z.strictObject({ ...resourceUpload, kind: z.literal("session"), format: z.enum(["json", "jsonl"]) }),
]);
/** Schema content is accepted only from the trusted backend, not an LLM-generated tool payload. */
export const createOutputSchemaSchema = z.strictObject({
  operationKey: idempotencyKeySchema.max(200),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2_000),
  content: z.string().max(OUTPUT_SCHEMA_BYTES),
});
const materialSelection = z.strictObject({ bundleId: platformIdSchema, materialId: platformIdSchema });
const sessionSelection = z.strictObject({ bundleId: platformIdSchema, sessionId: platformIdSchema });
const bindMaterials = z.array(materialSelection).min(1).max(8).superRefine((items, ctx) => {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const identity = `${item.bundleId}:${item.materialId}`;
    if (seen.has(identity)) ctx.addIssue({ code: "custom", path: [index], message: "Duplicate Material" });
    seen.add(identity);
  });
});
export const prepareInputsSchema = z.strictObject({
  operationKey: idempotencyKeySchema.max(200),
  promptUploadRef: uploadRefSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2_000),
  format: z.enum(["json", "jsonl"]),
  cases: z.array(z.strictObject({
    initialMaterials: z.array(materialSelection).max(8).optional(),
    evalInitialMaterials: z.array(materialSelection).max(8).optional(),
    initialSession: sessionSelection.optional(),
  })).min(1).max(50),
});
export const bindDataResourcesSchema = z.strictObject({
  operationKey: idempotencyKeySchema.max(200),
  datasetId: platformIdSchema,
  dataId: platformIdSchema,
  expectedContentDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  initialMaterials: bindMaterials.nullable().optional(),
  evalInitialMaterials: bindMaterials.nullable().optional(),
  initialSession: sessionSelection.nullable().optional(),
}).refine(({ initialMaterials, evalInitialMaterials, initialSession }) =>
  initialMaterials !== undefined || evalInitialMaterials !== undefined || initialSession !== undefined,
{ message: "Supply at least one initial resource field" });
export const getPreparationSchema = z.strictObject({
  operationKey: idempotencyKeySchema.max(200),
  page: z.number().int().min(1).max(10_000).default(1),
  pageSize: z.number().int().min(1).max(10).default(10),
});
export const uploadAgentSkillSchema = z.strictObject({
  operationKey: idempotencyKeySchema.max(200),
  uploadRef: uploadRefSchema,
  name: z.string().min(1).max(120).regex(/^[a-z0-9][a-z0-9-]*$/u),
  overwriteExistingSkill: z.boolean().default(false),
  existingSkillId: resourceIdSchema.optional(),
}).refine((value) => value.overwriteExistingSkill || !value.existingSkillId,
  "An existing Skill ID requires explicit overwrite approval");
export const uploadAgentReferenceSchema = z.strictObject({
  operationKey: idempotencyKeySchema.max(200), uploadRef: uploadRefSchema,
});

export const createProjectSchema = projectCreateSchema.safeExtend({ expectedSnapshots: expectedSnapshotsSchema })
  .refine((body) => body.datasets.length <= 50, "Review at most 50 Datasets per management Project");
export const previewRunSchema = z.strictObject({
  projectId: entityIdSchema, operation: z.enum(RUN_OPERATIONS), selector: selectorSchema,
});
export const submitRunSchema = submitRunBodySchema.safeExtend({ projectId: entityIdSchema });
/** Reconciliation never submits, so only this branch may omit digests for old stored Runs. */
const reconcileRunSchema = z.strictObject({
  projectId: entityIdSchema, ...submitRunBodySchema.shape,
  expectedPlanDigests: expectedPlanDigestsSchema.optional(),
}).refine((request) => request.expectedPlanDigests === undefined
  || (request.operation === "execution") === (request.expectedPlanDigests.evaluation === undefined),
{ path: ["expectedPlanDigests", "evaluation"], message: "Supply an evaluation digest exactly when evaluating" });
export const reconcileOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("run"), request: reconcileRunSchema }),
  z.strictObject({ kind: z.literal("project"), request: projectCreateSchema }),
]);
export const stopRunSchema = z.strictObject({ projectId: entityIdSchema, runId: entityIdSchema });
export const getRunSchema = z.strictObject({ runId: entityIdSchema, ...pageSchema });
export const getMetricsSchema = z.strictObject({
  projectId: entityIdSchema, runId: entityIdSchema.optional(),
  scope: z.enum(["project", "dataset", "sample", "sampling"]),
  section: z.enum(["overview", "samples", "tools", "fields"]).optional(),
  role: z.enum(["execution", "evaluation"]).optional(),
  datasetId: platformIdSchema.optional(), projectSampleId: entityIdSchema.optional(), samplingId: entityIdSchema.optional(),
  numericPointer: z.string().max(512).refine((pointer) => pointer === "" || pointer.startsWith("/"),
    "Select a JSON Pointer").optional(),
  ...pageSchema,
  pageSize: z.number().int().min(1).max(50).default(5),
  toolPage: z.number().int().min(1).max(10_000).default(1),
  toolPageSize: z.number().int().min(1).max(5).default(2),
  evaluationId: entityIdSchema.optional(), resultOffset: byteOffset,
}).superRefine((value, ctx) => {
  const expected = { project: undefined, dataset: "datasetId", sample: "projectSampleId", sampling: "samplingId" }[value.scope];
  if (["datasetId", "projectSampleId", "samplingId"].some((key) =>
    (value[key as "datasetId" | "projectSampleId" | "samplingId"] !== undefined) !== (key === expected))) {
    ctx.addIssue({ code: "custom", message: `Supply exactly the ${expected ?? "project"} scope ID` });
  }
  if (value.evaluationId === undefined && value.resultOffset !== undefined
    || value.evaluationId !== undefined && (value.scope !== "sampling"
      || value.page !== 1 || value.pageSize !== 5 || value.toolPage !== 1 || value.toolPageSize !== 2)) {
    ctx.addIssue({ code: "custom", message: "Select one Sampling Evaluation for resultOffset, without summary paging" });
  }
  if (value.scope === "project" || value.scope === "dataset") {
    const section = value.section ?? "overview";
    if (section === "tools") {
      if (!value.role || value.numericPointer !== undefined) {
        ctx.addIssue({ code: "custom", message: "Select a single Tool role without a numeric field selector" });
      }
    } else if (value.role !== undefined || value.toolPage !== 1 || value.toolPageSize !== 2
      || section !== "samples" && section !== "overview" && value.numericPointer !== undefined) {
      ctx.addIssue({ code: "custom", message: "Choose only the selectors for this Metrics section" });
    }
  } else if (value.section !== undefined || value.role !== undefined || value.numericPointer !== undefined) {
    ctx.addIssue({ code: "custom", message: "Sections and numeric field selectors require Project/Dataset scope" });
  }
});
export const inspectCaseSchema = z.strictObject({
  projectId: entityIdSchema, runId: entityIdSchema.optional(), samplingId: entityIdSchema,
  evaluationId: entityIdSchema.optional(),
});

/** Call validation schemas and advertised tool schemas are identical. */
export const managementSchemas = {
  list_options: listOptionsSchema,
  save_initial_resource: saveInitialResourceSchema,
  prepare_inputs: prepareInputsSchema,
  bind_data_resources: bindDataResourcesSchema,
  get_preparation: getPreparationSchema,
  search_agent_resources: searchResourcesSchema,
  upload_agent_skill: uploadAgentSkillSchema,
  upload_agent_reference: uploadAgentReferenceSchema,
  create_output_schema: createOutputSchemaSchema,
  create_agent: createAgentSchema,
  create_project: createProjectSchema,
  preview_run: previewRunSchema,
  submit_run: submitRunSchema,
  reconcile_operation: reconcileOperationSchema,
  stop_run: stopRunSchema,
  get_run: getRunSchema,
  get_metrics: getMetricsSchema,
  inspect_case: inspectCaseSchema,
} as const;
