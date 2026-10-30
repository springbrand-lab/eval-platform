import { equalJson } from "@eval-platform/eval-contracts";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { Data } from "@eval-platform/eval-dataset";
import { digestJson } from "@eval-platform/eval-runtime";
import type { Context } from "hono";
import type { z } from "zod";
import { digest } from "../agent-imports/model.js";
import { patchedInitialResources, dataInitialResourcePatchSchema, type DataInitialResourcePatch } from "../initial-resources.js";
import type { AppBindings } from "../lib/types.js";
import { requireInitializationBudget } from "../sp/bundle-content.js";
import { getPreparation } from "./preparation.js";
import { bindDataResourcesSchema } from "./schemas.js";

export type BindingInput = z.output<typeof bindDataResourcesSchema>;
export interface BindingPlan {
  readonly version: 3;
  readonly request: BindingInput;
  readonly datasetId: string;
  readonly dataId: string;
  readonly expectedContentDigest: string;
  /** Entire post-binding Data, hashed from the original full Data plus the exact planned references. */
  readonly contentDigest: string;
  readonly patch: DataInitialResourcePatch;
}

const conflict = () => new HttpError("EVAL_SP_CONFLICT", "The Data binding no longer matches its original intent");

/** Null clears and omission preserves; the selection already contains only owned UUID references. */
function resolvedPatch(input: BindingInput): DataInitialResourcePatch {
  return dataInitialResourcePatchSchema.parse({
    ...(input.initialMaterials === undefined ? {}
      : { initialMaterials: input.initialMaterials }),
    ...(input.evalInitialMaterials === undefined ? {}
      : { evalInitialMaterials: input.evalInitialMaterials }),
    ...(input.initialSession === undefined ? {}
      : { initialSession: input.initialSession }),
  });
}

function fingerprint(owner: string, input: BindingInput) {
  return digest(["management-bind/v2", owner, input]);
}

function storedPlan(owner: string, input: BindingInput, row: {
  kind: string; fingerprint: string; plan: Record<string, unknown>;
}): BindingPlan {
  const plan = row.plan as unknown as BindingPlan;
  if (row.kind !== "bind" || plan?.version !== 3 || !equalJson(plan.request, input)
    || plan.datasetId !== input.datasetId || plan.dataId !== input.dataId
    || plan.expectedContentDigest !== input.expectedContentDigest
    || !/^[a-f0-9]{64}$/u.test(plan.contentDigest)
    || !equalJson(plan.patch, resolvedPatch(input))
    || row.fingerprint !== fingerprint(owner, input)) throw conflict();
  return plan;
}

/** Count every selected Material, including retained soft-deletes, before claiming an operation. */
async function preflightExisting(c: Context<AppBindings>, input: BindingInput, current: Data,
  byteSizes: { readonly initialMaterials: readonly number[]; readonly evalInitialMaterials: readonly number[] }) {
  for (const field of ["initialMaterials", "evalInitialMaterials"] as const) {
    const selections = input[field];
    if (!selections) continue;
    if (selections.length !== byteSizes[field].length) throw conflict();
    requireInitializationBudget(byteSizes[field].reduce((sum, size) => sum + size, 0), field);
  }
  const session = input.initialSession;
  if (session && (current.initialSession?.bundleId !== session.bundleId
    || current.initialSession?.sessionId !== session.sessionId)) {
    await c.var.services.sessionBundles.getResource(session.bundleId, session.sessionId);
  }
}

async function preflightIntent(c: Context<AppBindings>, input: BindingInput): Promise<Data> {
  const { data, byteSizes } = await c.var.services.initialResources.preflightBindMaterialBytes(
    input.datasetId, input.dataId, input.expectedContentDigest, {
      initialMaterials: input.initialMaterials ?? [],
      evalInitialMaterials: input.evalInitialMaterials ?? [],
    });
  await preflightExisting(c, input, data, byteSizes);
  return data;
}

/** Plan one guarded Data mutation, never a Dataset, upload or Bundle creation. */
export async function bindDataResources(c: Context<AppBindings>, input: BindingInput) {
  const management = c.env.evalManagement;
  if (!management) throw new HttpError("INTERNAL_ERROR", "Management binding has no durable store");
  const owner = c.var.user.id;
  const previous = await management.store.get(owner, input.operationKey);
  let plan: BindingPlan;
  if (previous) {
    plan = storedPlan(owner, input, previous);
  } else {
    const current = await preflightIntent(c, input);
    const patch = resolvedPatch(input);
    plan = {
      version: 3, request: input, datasetId: input.datasetId, dataId: input.dataId,
      expectedContentDigest: input.expectedContentDigest,
      contentDigest: await digestJson(patchedInitialResources(current, patch)), patch,
    };
  }
  const operation = await management.store.begin(owner, input.operationKey, "bind",
    fingerprint(owner, input), plan as unknown as Record<string, unknown>);
  if (operation.status === "completed") {
    // A historical receipt is still queryable, but never claim that its binding remains current
    // after a later edit, detach or Dataset deletion. No resource bytes need to be reopened.
    const current = await c.var.services.initialResources.inspectBindTarget(plan.datasetId, plan.dataId,
      plan.expectedContentDigest, plan.contentDigest);
    if (await digestJson(current) !== plan.contentDigest) throw conflict();
  } else {
    // Before the Data stage, reject an intervening edit/detach. Only an attempted
    // stage can reconcile a possible lost commit response by its planned full digest.
    const attempted = operation.stages[`data:${plan.dataId}`]?.status;
    await c.var.services.initialResources.inspectBindTarget(plan.datasetId, plan.dataId, plan.expectedContentDigest,
      attempted ? plan.contentDigest : undefined);
    const stage = `data:${plan.dataId}`;
    const claim = await management.store.attempt(owner, input.operationKey, stage);
    const bound = await c.var.services.initialResources.bindData(plan.dataId, plan.patch, {
      datasetId: plan.datasetId, expectedContentDigest: plan.expectedContentDigest,
      resultContentDigest: plan.contentDigest,
      ...(claim.status === "started" ? {} : { replay: true }),
      ...(claim.status === "confirmed" ? { confirmed: true } : {}),
    });
    if (await digestJson(bound) !== plan.contentDigest) throw conflict();
    if (claim.status !== "confirmed") await management.store.confirm(owner, input.operationKey, stage, {
      datasetId: plan.datasetId, dataId: plan.dataId, contentDigest: plan.contentDigest,
    });
    await management.store.complete(owner, input.operationKey);
  }
  const receipt = await getPreparation(c, input.operationKey);
  if (receipt.kind !== "bind" || receipt.status !== "completed") throw conflict();
  return { operationKey: input.operationKey, kind: "bind", status: "completed",
    datasetId: plan.datasetId, dataId: plan.dataId, contentDigest: plan.contentDigest };
}
