import { z } from "@hono/zod-openapi";
import { AGENT_FRAMEWORKS, type RetryPolicy } from "@eval-platform/eval-contracts";
import { platformIdSchema } from "@eval-platform/eval-dataset";
import { catalogLabelSchema } from "../db/catalog-metadata.js";
import { RUN_TARGET_IDS, SAMPLING_COUNT_MAX } from "../limits.js";
import { idempotencyKeySchema, unique } from "../routes/schemas.js";

// The single definition of the Project creation and evaluation-plan request bodies. Routes validate with
// these schemas and the service consumes their output types; plan value rules belong to Runtime.

/** A request size limit: the Samplings one ProjectSample creates per execution. */
const samplingCountSchema = z.number().int().positive().max(SAMPLING_COUNT_MAX);

const retryPolicySchema = z.strictObject({
  maxRestarts: z.number(),
}) satisfies z.ZodType<Pick<RetryPolicy, "maxRestarts">>;

/** Shape only; concurrency, retry and timeout rules belong to Runtime's plan normalization. */
const agentPolicy = {
  userAgentId: platformIdSchema,
  retryPolicy: retryPolicySchema.exactOptional(),
  timeoutMs: z.number().exactOptional(),
};

export const evaluationPlanSchema = z.strictObject({
  ...agentPolicy,
  evaluationConcurrency: z.number(),
  outputSchemaId: platformIdSchema,
});

export const projectCreateSchema = z.strictObject({
  /** Owner-scoped creation identity; the first Run is admitted under the same key. */
  idempotencyKey: idempotencyKeySchema,
  name: catalogLabelSchema,
  description: catalogLabelSchema.exactOptional(),
  datasets: z.array(z.strictObject({
    datasetId: platformIdSchema,
    /** Omitted: every current member of the Dataset. */
    dataIds: z.array(platformIdSchema).min(1).max(RUN_TARGET_IDS).refine(unique, "must not contain duplicates").exactOptional(),
  })).min(1).max(RUN_TARGET_IDS)
    .refine((datasets) => unique(datasets.map((dataset) => dataset.datasetId)), "must not repeat a Dataset"),
  /** Default Sampling count of every selected Data. */
  samplingCount: samplingCountSchema,
  /** Per-Data overrides of `samplingCount`; every key must be a selected Data. */
  samplingCounts: z.record(platformIdSchema, samplingCountSchema)
    .refine((counts) => Object.keys(counts).length <= RUN_TARGET_IDS, `must name at most ${RUN_TARGET_IDS} Data`).exactOptional(),
  execution: z.strictObject({
    ...agentPolicy,
    framework: z.enum(AGENT_FRAMEWORKS),
    executionConcurrency: z.number(),
  }),
  evaluation: evaluationPlanSchema.exactOptional(),
  /** The first Run; a new Project has no successful Sampling, so it cannot be evaluation-only. */
  run: z.strictObject({ operation: z.enum(["execution", "pipeline"]) }),
});

export type EvaluationPlanBody = z.output<typeof evaluationPlanSchema>;
export type ProjectCreateBody = z.output<typeof projectCreateSchema>;
export type DatasetSelection = ProjectCreateBody["datasets"][number];
