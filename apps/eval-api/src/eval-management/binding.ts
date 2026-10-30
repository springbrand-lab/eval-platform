import { equalJson } from "@eval-platform/eval-contracts";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { Data } from "@eval-platform/eval-dataset";
import { digestJson } from "@eval-platform/eval-runtime";
import type { Context } from "hono";
import type { z } from "zod";
import { digest } from "../agent-imports/model.js";
import { patchedInitialResources, type BatchDataBinding, type DataInitialResourcePatch } from "../initial-resources.js";
import type { AppBindings } from "../lib/types.js";
import { requireInitializationBudget } from "../sp/bundle-content.js";
import { batchBindingFingerprint, batchBindingReceipt, bindPatch, validBatchBindingPlan,
  type BatchBindingInput, type BatchBindingPlan } from "./binding-plan.js";
import { getPreparation } from "./preparation.js";
import { bindDataResourcesSchema } from "./schemas.js";
import { ManagementOutcomeUnknownError } from "./skill.js";

export type BindingInput = z.output<typeof bindDataResourcesSchema>;
type SingleBindingInput = Extract<BindingInput, { dataId: string }>;
type TargetInput = Pick<SingleBindingInput, "datasetId" | "dataId" | "expectedContentDigest"
  | "initialMaterials" | "evalInitialMaterials" | "initialSession">;
export interface BindingPlan {
  readonly version: 3;
  readonly request: SingleBindingInput;
  readonly datasetId: string;
  readonly dataId: string;
  readonly expectedContentDigest: string;
  /** Entire post-binding Data, hashed from the original full Data plus the exact planned references. */
  readonly contentDigest: string;
  readonly patch: DataInitialResourcePatch;
}

const conflict = () => new HttpError("EVAL_SP_CONFLICT", "The Data binding no longer matches its original intent");

function fingerprint(owner: string, input: SingleBindingInput) {
  return digest(["management-bind/v2", owner, input]);
}

function storedPlan(owner: string, input: SingleBindingInput, row: {
  kind: string; fingerprint: string; plan: Record<string, unknown>;
}): BindingPlan {
  const plan = row.plan as unknown as BindingPlan;
  if (row.kind !== "bind" || plan?.version !== 3 || !equalJson(plan.request, input)
    || plan.datasetId !== input.datasetId || plan.dataId !== input.dataId
    || plan.expectedContentDigest !== input.expectedContentDigest
    || !/^[a-f0-9]{64}$/u.test(plan.contentDigest)
    || !equalJson(plan.patch, bindPatch(input))
    || row.fingerprint !== fingerprint(owner, input)) throw conflict();
  return plan;
}

/** Count every selected Material, including retained soft-deletes, before claiming an operation. */
async function preflightExisting(c: Context<AppBindings>, input: TargetInput, current: Data,
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

async function preflightIntent(c: Context<AppBindings>, input: TargetInput): Promise<Data> {
  const { data, byteSizes } = await c.var.services.initialResources.preflightBindMaterialBytes(
    input.datasetId, input.dataId, input.expectedContentDigest, {
      initialMaterials: input.initialMaterials ?? [],
      evalInitialMaterials: input.evalInitialMaterials ?? [],
    });
  await preflightExisting(c, input, data, byteSizes);
  return data;
}

/** The original v3, one-Data plan/receipt is intentionally unchanged. */
async function bindSingleDataResources(c: Context<AppBindings>, input: SingleBindingInput) {
  const management = c.env.evalManagement;
  if (!management) throw new HttpError("INTERNAL_ERROR", "Management binding has no durable store");
  const owner = c.var.user.id;
  const previous = await management.store.get(owner, input.operationKey);
  let plan: BindingPlan;
  if (previous) {
    plan = storedPlan(owner, input, previous);
  } else {
    const current = await preflightIntent(c, input);
    const patch = bindPatch(input);
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

function storedBatchPlan(owner: string, input: BatchBindingInput, row: {
  ownerUserId: string; operationKey: string; kind: string; fingerprint: string; plan: Record<string, unknown>;
}): BatchBindingPlan {
  if (row.ownerUserId !== owner || row.operationKey !== input.operationKey || row.kind !== "bind"
    || !validBatchBindingPlan(owner, input.operationKey, row.fingerprint, row.plan)
    || !equalJson(row.plan.request, input)) throw conflict();
  return row.plan;
}

async function planBatch(c: Context<AppBindings>, input: BatchBindingInput): Promise<BatchBindingPlan> {
  const bindings: BatchDataBinding[] = [];
  for (const entry of input.bindings) {
    // All preflights happen before store.begin; the DB reservation and the final atomic
    // transaction each recheck the full digests and membership under sorted row locks.
    const current = await preflightIntent(c, { ...entry, datasetId: input.datasetId });
    const patch = bindPatch(entry);
    const contentDigest = await digestJson(patchedInitialResources(current, patch));
    // An already-satisfied Data remains in the batch: its original and target
    // digests coincide, while other members may still need an atomic write.
    bindings.push({ dataId: entry.dataId, expectedContentDigest: entry.expectedContentDigest,
      contentDigest, patch });
  }
  return { version: 4, request: input, datasetId: input.datasetId, bindings };
}

/** Read *all* rows in one locked owner/membership snapshot; a subset is never a batch receipt. */
async function readBatch(c: Context<AppBindings>, plan: BatchBindingPlan): Promise<boolean> {
  const rows = await c.var.services.initialResources.inspectBindTargets(plan.datasetId, plan.bindings);
  if (rows.length !== plan.bindings.length) throw conflict();
  let allPlanned = true;
  for (const [index, row] of rows.entries()) {
    const entry = plan.bindings[index]!;
    if (row.dataId !== entry.dataId) throw conflict();
    const actual = await digestJson(row);
    if (entry.contentDigest === entry.expectedContentDigest) {
      // An unchanged member proves only its original state, not that the
      // changing members were written after the batch stage was attempted.
      if (actual !== entry.expectedContentDigest) throw conflict();
    } else if (actual === entry.expectedContentDigest) {
      allPlanned = false;
    } else if (actual !== entry.contentDigest) {
      throw conflict();
    }
    // The target must actually be the result of applying the stored patch,
    // even if the plan claims that target equals the original digest.
    if (await digestJson(patchedInitialResources(row, entry.patch)) !== entry.contentDigest) throw conflict();
  }
  return allPlanned;
}

/** v4 is one write-ahead stage and one DB transaction, not twenty successful single-Data calls. */
async function bindBatchDataResources(c: Context<AppBindings>, input: BatchBindingInput) {
  const management = c.env.evalManagement;
  if (!management) throw new HttpError("INTERNAL_ERROR", "Management binding has no durable store");
  const { store } = management;
  const owner = c.var.user.id;
  let existing = await store.get(owner, input.operationKey);
  let plan: BatchBindingPlan;
  if (existing) {
    plan = storedBatchPlan(owner, input, existing);
  } else {
    try {
      plan = await planBatch(c, input);
    } catch (error) {
      // A concurrent identical first caller might commit during preflight. Adopt only
      // its persisted same-key plan; a changed intent or missing plan still fails.
      existing = await store.get(owner, input.operationKey);
      if (!existing) throw error;
      plan = storedBatchPlan(owner, input, existing);
    }
  }
  const operation = await store.begin(owner, input.operationKey, "bind",
    batchBindingFingerprint(owner, input), plan as unknown as Record<string, unknown>);
  plan = storedBatchPlan(owner, input, operation);
  const receipt = batchBindingReceipt(plan);
  if (operation.status === "completed") {
    if (!await readBatch(c, plan)) throw conflict();
  } else {
    const claim = await store.attempt(owner, input.operationKey, "batch");
    if (claim.status === "confirmed" && !equalJson(claim.receipt, receipt)) throw conflict();
    if (claim.status === "started") {
      const bound = await c.var.services.initialResources.bindDataBatch(plan.datasetId, plan.bindings);
      if (bound.length !== plan.bindings.length) throw conflict();
      for (const [index, row] of bound.entries()) {
        if (row.dataId !== plan.bindings[index]!.dataId
          || await digestJson(row) !== plan.bindings[index]!.contentDigest) throw conflict();
      }
    }
    // An attempted lost response is *read-only*: every changing member must
    // reach its target; no-op members must remain at their original full digest.
    // An original changing member remains unknown, never triggering a second write.
    if (!await readBatch(c, plan)) throw new ManagementOutcomeUnknownError();
    if (claim.status !== "confirmed") await store.confirm(owner, input.operationKey, "batch", receipt);
    await store.complete(owner, input.operationKey);
  }
  const final = await getPreparation(c, input.operationKey);
  if (final.kind !== "bind" || final.status !== "completed"
    || !("totalBindings" in final) || final.totalBindings !== plan.bindings.length) throw conflict();
  return { operationKey: input.operationKey, kind: "bind", status: "completed",
    ...receipt };
}

export async function bindDataResources(c: Context<AppBindings>, input: BindingInput) {
  return "bindings" in input ? bindBatchDataResources(c, input) : bindSingleDataResources(c, input);
}
