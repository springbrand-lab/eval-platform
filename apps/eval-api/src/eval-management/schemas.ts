import { RUN_OPERATIONS } from "@eval-platform/eval-contracts";
import { platformIdSchema } from "@eval-platform/eval-dataset";
import { z } from "zod";
import { projectCreateSchema } from "../projects/schemas.js";
import { entityIdSchema, idempotencyKeySchema, unique } from "../routes/schemas.js";
import { selectorSchema, targetsSchema } from "../routes/runs/runs.routes.js";

export const pageSchema = {
  page: z.number().int().min(1).max(10_000).default(1),
  pageSize: z.number().int().min(1).max(50).default(20),
};
const search = z.string().trim().max(120).optional();
/** SP resource IDs may contain '/' (encoded for detail reads), unlike Runtime path IDs. */
export const resourceIdSchema = idempotencyKeySchema.max(255);
const resourceIds = z.array(resourceIdSchema).max(50).refine(unique, "IDs must be unique").default([]);

export const listOptionsSchema = z.strictObject({
  category: z.enum(["agents", "datasets", "projects", "output_schemas", "input_limits", "credits",
    "approval_dataset", "approval_agent", "approval_project"]),
  q: search, ...pageSchema,
  datasetId: platformIdSchema.optional(),
  dataIds: z.array(platformIdSchema).min(1).max(50).refine(unique).optional(),
  userAgentId: platformIdSchema.optional(),
  projectId: entityIdSchema.optional(),
  projectSampleIds: z.array(entityIdSchema).max(50).refine(unique).optional(),
  samplingIds: z.array(entityIdSchema).max(50).refine(unique).optional(),
}).superRefine((value, ctx) => {
  const invalid = () => ctx.addIssue({ code: "custom", message: "Choose one bounded approval selection" });
  if (value.category === "approval_dataset") {
    if (!value.datasetId || value.userAgentId || value.projectId || value.projectSampleIds || value.samplingIds
      || value.q !== undefined || value.pageSize > 10) invalid();
  } else if (value.category === "approval_agent") {
    if (!value.userAgentId || value.datasetId || value.dataIds || value.projectId
      || value.projectSampleIds || value.samplingIds || value.q !== undefined || value.page !== 1) invalid();
  } else if (value.category === "approval_project") {
    if (!value.projectId || value.userAgentId || value.datasetId || value.dataIds || value.q !== undefined || value.pageSize > 10
      || !((value.projectSampleIds?.length ?? 0) + (value.samplingIds?.length ?? 0))
      || (value.projectSampleIds?.length ?? 0) + (value.samplingIds?.length ?? 0) > 50) invalid();
  } else if (value.datasetId || value.dataIds || value.userAgentId || value.projectId || value.projectSampleIds || value.samplingIds) {
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
const materialSelection = z.union([
  z.strictObject({ uploadRef: uploadRefSchema }),
  z.strictObject({ bundleId: platformIdSchema, materialId: platformIdSchema }),
]);
const sessionSelection = z.union([
  z.strictObject({ uploadRef: uploadRefSchema, format: z.enum(["json", "jsonl"]) }),
  z.strictObject({ bundleId: platformIdSchema, sessionId: platformIdSchema }),
]);
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

export const createProjectSchema = projectCreateSchema;
export const previewRunSchema = z.strictObject({
  projectId: entityIdSchema, operation: z.enum(RUN_OPERATIONS), selector: selectorSchema,
});
export const submitRunSchema = z.strictObject({
  projectId: entityIdSchema, idempotencyKey: idempotencyKeySchema,
  operation: z.enum(RUN_OPERATIONS), selector: selectorSchema, targets: targetsSchema,
});
export const stopRunSchema = z.strictObject({ projectId: entityIdSchema, runId: entityIdSchema });
export const getRunSchema = z.strictObject({ runId: entityIdSchema, ...pageSchema });
export const getMetricsSchema = z.strictObject({
  projectId: entityIdSchema, runId: entityIdSchema,
  scope: z.enum(["project", "dataset", "sample", "sampling"]),
  datasetId: platformIdSchema.optional(), projectSampleId: entityIdSchema.optional(), samplingId: entityIdSchema.optional(),
  ...pageSchema,
}).superRefine((value, ctx) => {
  const expected = { project: undefined, dataset: "datasetId", sample: "projectSampleId", sampling: "samplingId" }[value.scope];
  if (["datasetId", "projectSampleId", "samplingId"].some((key) =>
    (value[key as "datasetId" | "projectSampleId" | "samplingId"] !== undefined) !== (key === expected))) {
    ctx.addIssue({ code: "custom", message: `Supply exactly the ${expected ?? "project"} scope ID` });
  }
});
export const inspectCaseSchema = z.strictObject({
  projectId: entityIdSchema, runId: entityIdSchema, samplingId: entityIdSchema,
  evaluationId: entityIdSchema.optional(), trajectory: z.enum(["subject", "evaluator"]).optional(),
  beforeSeq: z.number().int().positive().optional(), limit: z.number().int().min(1).max(20).default(10),
}).refine((value) => value.trajectory !== "evaluator" || value.evaluationId !== undefined,
  "Evaluator trajectory needs an evaluationId")
  .refine((value) => value.beforeSeq === undefined || value.trajectory !== undefined,
    "beforeSeq requires a trajectory");

/** The same schemas validate calls and generate the advertised input schemas. */
export const managementSchemas = {
  list_options: listOptionsSchema,
  prepare_inputs: prepareInputsSchema,
  get_preparation: getPreparationSchema,
  search_agent_resources: searchResourcesSchema,
  upload_agent_skill: uploadAgentSkillSchema,
  upload_agent_reference: uploadAgentReferenceSchema,
  create_agent: createAgentSchema,
  create_project: createProjectSchema,
  preview_run: previewRunSchema,
  submit_run: submitRunSchema,
  stop_run: stopRunSchema,
  get_run: getRunSchema,
  get_metrics: getMetricsSchema,
  inspect_case: inspectCaseSchema,
} as const;
