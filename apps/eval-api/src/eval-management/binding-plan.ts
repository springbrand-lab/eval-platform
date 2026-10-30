import { equalJson } from "@eval-platform/eval-contracts";
import { platformIdSchema } from "@eval-platform/eval-dataset";
import { z } from "zod";
import { digest } from "../agent-imports/model.js";
import { dataInitialResourcePatchSchema, type BatchDataBinding, type DataInitialResourcePatch } from "../initial-resources.js";
import { batchBindSchema } from "./schemas.js";

export type BatchBindingInput = z.output<typeof batchBindSchema>;
export interface BatchBindingPlan {
  readonly version: 4;
  readonly request: BatchBindingInput;
  readonly datasetId: string;
  /** Preserves the caller's order; DB row locks and updates instead use sorted Data IDs. */
  readonly bindings: readonly BatchDataBinding[];
}

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const planSchema = z.strictObject({
  version: z.literal(4),
  request: batchBindSchema,
  datasetId: platformIdSchema,
  bindings: z.array(z.strictObject({
    dataId: platformIdSchema, expectedContentDigest: sha256, contentDigest: sha256,
    patch: dataInitialResourcePatchSchema,
  })).min(1).max(20),
});

/** Omission preserves a Data field, while explicit null removes it. */
export function bindPatch(input: {
  readonly initialMaterials?: BatchBindingInput["bindings"][number]["initialMaterials"];
  readonly evalInitialMaterials?: BatchBindingInput["bindings"][number]["evalInitialMaterials"];
  readonly initialSession?: BatchBindingInput["bindings"][number]["initialSession"];
}): DataInitialResourcePatch {
  return dataInitialResourcePatchSchema.parse({
    ...(input.initialMaterials === undefined ? {} : { initialMaterials: input.initialMaterials }),
    ...(input.evalInitialMaterials === undefined ? {} : { evalInitialMaterials: input.evalInitialMaterials }),
    ...(input.initialSession === undefined ? {} : { initialSession: input.initialSession }),
  });
}

export function batchBindingFingerprint(owner: string, input: BatchBindingInput): string {
  return digest(["management-bind-batch/v4", owner, input]);
}

/** A stored batch may be replayed only for the original owner, request and ordered planned results. */
export function validBatchBindingPlan(owner: string, key: string, fingerprint: string,
  value: unknown): value is BatchBindingPlan {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success || !equalJson(value, parsed.data)) return false;
  const { request, datasetId, bindings } = parsed.data;
  return request.operationKey === key && request.datasetId === datasetId
    && bindings.length === request.bindings.length
    && bindings.every((entry, index) => entry.dataId === request.bindings[index]!.dataId
      && entry.expectedContentDigest === request.bindings[index]!.expectedContentDigest
      && equalJson(entry.patch, bindPatch(request.bindings[index]!)))
    && fingerprint === batchBindingFingerprint(owner, request);
}

/** The batch stage confirms all intended post-bind digests, never just one member. */
export function batchBindingReceipt(plan: BatchBindingPlan) {
  return { datasetId: plan.datasetId, bindings: plan.bindings.map(({ dataId, contentDigest }) =>
    ({ dataId, contentDigest })) };
}

export function validBatchBindingStages(plan: BatchBindingPlan, value: unknown, completed: boolean): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const stages = value as Record<string, unknown>;
  if (Object.keys(stages).some((name) => name !== "batch")) return false;
  const batch = stages.batch;
  if (batch === undefined) return !completed;
  if (batch === null || typeof batch !== "object" || Array.isArray(batch)) return false;
  const entry = batch as Record<string, unknown>;
  if (entry.status === "attempted") return !completed && entry.receipt === undefined;
  return entry.status === "confirmed" && equalJson(entry.receipt, batchBindingReceipt(plan));
}
