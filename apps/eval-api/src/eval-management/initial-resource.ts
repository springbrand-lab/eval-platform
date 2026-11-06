import { equalJson } from "@eval-platform/eval-contracts";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { platformIdSchema } from "@eval-platform/eval-dataset";
import type { Context } from "hono";
import type { AppBindings } from "../lib/types.js";
import { initialResourceFingerprint, planResource, uploadFact, type InitialResourceInput, type PlannedAsset,
  type UploadFact } from "./preparation-plan.js";
import { getPreparation, prepareResource, verifyResource } from "./preparation.js";
import type { OperationReceipt } from "./store.js";

export interface InitialResourcePlan {
  readonly version: 1;
  readonly request: InitialResourceInput;
  readonly uploadFact: UploadFact;
  readonly asset: PlannedAsset;
}

const conflict = () => new HttpError("EVAL_SP_CONFLICT", "The resource operation no longer matches its original intent");

function storedPlan(owner: string, input: InitialResourceInput, row: OperationReceipt): InitialResourcePlan {
  const plan = row.plan as unknown as InitialResourcePlan;
  const asset = plan?.asset;
  if (row.kind !== "initial_resource" || plan?.version !== 1 || !asset
    || !equalJson(plan.request, input) || !plan.uploadFact
    || !equalJson(plan.uploadFact, {
      uploadRef: asset.uploadRef, kind: asset.kind, name: asset.name, mediaType: asset.mediaType,
      byteSize: asset.byteSize, sha256: asset.sha256,
    })
    || asset.uploadRef !== input.uploadRef || asset.kind !== input.kind
    || !platformIdSchema.safeParse(asset.bundleId).success || !platformIdSchema.safeParse(asset.resourceId).success
    || (input.kind === "material" ? asset.format !== undefined : asset.format !== input.format)
    || row.fingerprint !== initialResourceFingerprint(owner, input, plan.uploadFact)) throw conflict();
  return plan;
}

/** One durable standalone Bundle + child; never a Dataset, Data, Prompt or model-visible file. */
export async function saveInitialResource(c: Context<AppBindings>, input: InitialResourceInput) {
  const management = c.env.evalManagement;
  if (!management) throw new HttpError("INTERNAL_ERROR", "Management resources have no durable store");
  const owner = c.var.user.id;
  const previous = await management.store.get(owner, input.operationKey);
  let plan: InitialResourcePlan;
  if (previous) {
    // Replay uses only the persisted immutable facts and identity, not an expired upload
    // or a newly planned ID. An unconfirmed write is checked read-only in prepareResource.
    plan = storedPlan(owner, input, previous);
  } else {
    const upload = await management.files.info(owner, input.uploadRef, input.kind);
    plan = { version: 1, request: input, uploadFact: uploadFact(upload),
      asset: await planResource(owner, input, management.files, upload) };
  }
  let operation: OperationReceipt;
  try {
    operation = await management.store.begin(owner, input.operationKey, "initial_resource",
      initialResourceFingerprint(owner, input, plan.uploadFact), plan as unknown as Record<string, unknown>);
  } catch (error) {
    // Concurrent identical calls may have planned different random UUIDs. Only the
    // persisted winner is allowed to write; a changed intent never claims its upload.
    const winner = await management.store.get(owner, input.operationKey);
    if (!winner) throw error;
    plan = storedPlan(owner, input, winner);
    operation = await management.store.begin(owner, input.operationKey, "initial_resource",
      winner.fingerprint, plan as unknown as Record<string, unknown>);
  }
  if (operation.status === "completed") {
    // A historical receipt is queryable, but a save replay must not claim a
    // now-deleted or altered resource as currently available to bind.
    await verifyResource(c, plan.asset);
  } else {
    await prepareResource(c, plan.asset, management.store, input.operationKey);
    await management.store.complete(owner, input.operationKey);
  }
  const receipt: { kind: string; status: string; stage?: string; resourceKind?: string } =
    await getPreparation(c, input.operationKey);
  if (receipt.kind !== "initial_resource" || receipt.status !== "completed"
    || receipt.stage !== "confirmed" || receipt.resourceKind !== input.kind) throw conflict();
  // The exact Moss/Takt success wire shape: no ref, format, labels, byte facts or URLs.
  return {
    operationKey: input.operationKey, kind: "initial_resource", resourceKind: input.kind, status: "completed",
    bundleId: plan.asset.bundleId,
    ...(input.kind === "material" ? { materialId: plan.asset.resourceId } : { sessionId: plan.asset.resourceId }),
  };
}
