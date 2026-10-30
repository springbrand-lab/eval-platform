import { equalJson } from "@eval-platform/eval-contracts";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { Data, InitialMaterialsRef } from "@eval-platform/eval-dataset";
import { digestJson } from "@eval-platform/eval-runtime";
import type { Context } from "hono";
import type { z } from "zod";
import { digest } from "../agent-imports/model.js";
import { patchedInitialResources, dataInitialResourcePatchSchema, type DataInitialResourcePatch } from "../initial-resources.js";
import type { AppBindings } from "../lib/types.js";
import { requireInitializationBudget } from "../sp/bundle-content.js";
import { materialRefs, planResources, resourceUploads, sessionRef,
  type PlannedAsset, type ResourceCase } from "./preparation-plan.js";
import { prepareResource, getPreparation } from "./preparation.js";
import { bindDataResourcesSchema } from "./schemas.js";

export type BindingInput = z.output<typeof bindDataResourcesSchema>;
export interface BindingPlan {
  readonly version: 2;
  readonly request: BindingInput;
  readonly uploadFacts: Awaited<ReturnType<typeof resourceUploads>>["facts"];
  readonly datasetId: string;
  readonly dataId: string;
  readonly expectedContentDigest: string;
  /** Entire post-binding Data, hashed from the original full Data plus the exact planned references. */
  readonly contentDigest: string;
  readonly patch: DataInitialResourcePatch;
  readonly assets: readonly PlannedAsset[];
}

const conflict = () => new HttpError("EVAL_SP_CONFLICT", "The Data binding no longer matches its original intent");

/** Null clears; omission is not included in the patch; uploads resolve through planned, never guessed IDs. */
function resolvedPatch(input: BindingInput, plan: Pick<BindingPlan, "assets">): DataInitialResourcePatch {
  return dataInitialResourcePatchSchema.parse({
    ...(input.initialMaterials === undefined ? {}
      : { initialMaterials: input.initialMaterials === null ? null : materialRefs(plan, input.initialMaterials) }),
    ...(input.evalInitialMaterials === undefined ? {}
      : { evalInitialMaterials: input.evalInitialMaterials === null ? null : materialRefs(plan, input.evalInitialMaterials) }),
    ...(input.initialSession === undefined ? {}
      : { initialSession: input.initialSession === null ? null : sessionRef(plan, input.initialSession) }),
  });
}

function resourceCase(input: BindingInput): ResourceCase {
  return {
    ...(input.initialMaterials ? { initialMaterials: input.initialMaterials } : {}),
    ...(input.evalInitialMaterials ? { evalInitialMaterials: input.evalInitialMaterials } : {}),
    ...(input.initialSession ? { initialSession: input.initialSession } : {}),
  };
}

function fingerprint(owner: string, input: BindingInput, facts: BindingPlan["uploadFacts"]) {
  return digest(["management-bind/v1", owner, input, facts]);
}

/** No staged metadata or bytes are needed to replay an existing planned operation. */
function storedPlan(owner: string, input: BindingInput, row: {
  kind: string; fingerprint: string; plan: Record<string, unknown>;
}): BindingPlan {
  const plan = row.plan as unknown as BindingPlan;
  if (row.kind !== "bind" || plan?.version !== 2 || !Array.isArray(plan.assets)
    || plan.assets.length > 17 || !Array.isArray(plan.uploadFacts)
    || plan.uploadFacts.length > 17 || !equalJson(plan.request, input)
    || plan.datasetId !== input.datasetId || plan.dataId !== input.dataId
    || plan.expectedContentDigest !== input.expectedContentDigest
    || !/^[a-f0-9]{64}$/u.test(plan.contentDigest)
    || !equalJson(plan.patch, resolvedPatch(input, plan))
    || row.fingerprint !== fingerprint(owner, input, plan.uploadFacts)) throw conflict();
  return plan;
}

/** Count all existing and staged bytes before any resource write; retained deleted refs are not free. */
async function preflightExisting(c: Context<AppBindings>, input: BindingInput, current: Data,
  uploaded: ReadonlyMap<string, { kind: string; byteSize: number }>,
  byteSizes: { readonly initialMaterials: readonly number[]; readonly evalInitialMaterials: readonly number[] }) {
  for (const field of ["initialMaterials", "evalInitialMaterials"] as const) {
    const selections = input[field];
    if (!selections) continue;
    let size = 0;
    let existingIndex = 0;
    for (const selection of selections) {
      if ("uploadRef" in selection) {
        const upload = uploaded.get(selection.uploadRef);
        if (!upload || upload.kind !== "material") throw conflict();
        size += upload.byteSize;
      } else {
        const byteSize = byteSizes[field][existingIndex++];
        if (byteSize === undefined) throw conflict();
        size += byteSize;
      }
      requireInitializationBudget(size, field);
    }
    if (existingIndex !== byteSizes[field].length) throw conflict();
  }
  const session = input.initialSession;
  if (session && "bundleId" in session
    && (current.initialSession?.bundleId !== session.bundleId || current.initialSession?.sessionId !== session.sessionId)) {
    await c.var.services.sessionBundles.getResource(session.bundleId, session.sessionId);
  }
}

async function preflightIntent(c: Context<AppBindings>, input: BindingInput,
  uploaded: ReadonlyMap<string, { kind: string; byteSize: number }>): Promise<Data> {
  const { data, byteSizes } = await c.var.services.initialResources.preflightBindMaterialBytes(
    input.datasetId, input.dataId, input.expectedContentDigest, {
      initialMaterials: (input.initialMaterials ?? []).filter(
        (selection): selection is InitialMaterialsRef => "bundleId" in selection),
      evalInitialMaterials: (input.evalInitialMaterials ?? []).filter(
        (selection): selection is InitialMaterialsRef => "bundleId" in selection),
    });
  await preflightExisting(c, input, data, uploaded, byteSizes);
  return data;
}

/** A first plan is saved before any Bundle write; replay never replans an identity or imports another Dataset. */
export async function bindDataResources(c: Context<AppBindings>, input: BindingInput) {
  const management = c.env.evalManagement;
  if (!management) throw new HttpError("INTERNAL_ERROR", "Management binding has no durable store");
  const owner = c.var.user.id;
  const previous = await management.store.get(owner, input.operationKey);
  let replayPlan = previous !== null;
  let plan: BindingPlan;
  if (previous) {
    plan = storedPlan(owner, input, previous);
  } else {
    const { uploads, facts } = await resourceUploads(owner, [resourceCase(input)], management.files);
    if ([...uploads.values()].some((item) => item.expiresAt.getTime() <= Date.now())) {
      throw new HttpError("REQUEST_INVALID_INPUT", "The upload ref expired before starting the binding");
    }
    const current = await preflightIntent(c, input, uploads);
    const assets = await planResources(owner, [resourceCase(input)], management.files, uploads);
    const patch = resolvedPatch(input, { assets });
    plan = {
      version: 2, request: input, uploadFacts: facts, datasetId: input.datasetId, dataId: input.dataId,
      expectedContentDigest: input.expectedContentDigest,
      contentDigest: await digestJson(patchedInitialResources(current, patch)), patch, assets,
    };
  }
  let operation;
  try {
    operation = await management.store.begin(owner, input.operationKey, "bind",
      fingerprint(owner, input, plan.uploadFacts), plan as unknown as Record<string, unknown>);
  } catch (error) {
    // Concurrent, identical first calls can independently plan random IDs. The winner's
    // persisted owner/key/fingerprint is authoritative; never create from the loser's plan.
    const winner = await management.store.get(owner, input.operationKey);
    if (!winner) throw error;
    plan = storedPlan(owner, input, winner);
    replayPlan = true;
    operation = await management.store.begin(owner, input.operationKey, "bind",
      winner.fingerprint, plan as unknown as Record<string, unknown>);
  }
  if (operation.status === "completed") {
    // A historical receipt is still queryable, but never claim that its binding remains current
    // after a later edit, detach or Dataset deletion. No resource bytes need to be reopened.
    const current = await c.var.services.initialResources.inspectBindTarget(plan.datasetId, plan.dataId,
      plan.expectedContentDigest, plan.contentDigest);
    if (await digestJson(current) !== plan.contentDigest) throw conflict();
  } else {
    // Before another resource write, reject an intervening edit/detach; allow the planned final
    // digest only after an attempted Data stage (a possible lost commit response).
    const attempted = operation.stages[`data:${plan.dataId}`]?.status;
    await c.var.services.initialResources.inspectBindTarget(plan.datasetId, plan.dataId, plan.expectedContentDigest,
      attempted ? plan.contentDigest : undefined);
    if (replayPlan && !attempted && plan.assets.some((asset) =>
      operation.stages[`resource:${asset.uploadRef}`]?.status !== "confirmed")) {
      await preflightIntent(c, input, new Map(plan.uploadFacts.map(
        ({ uploadRef, kind, byteSize }) => [uploadRef, { kind, byteSize }])));
    }
    for (const asset of plan.assets) await prepareResource(c, asset, management.store, input.operationKey);
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
    datasetId: plan.datasetId, dataId: plan.dataId, contentDigest: plan.contentDigest,
    resources: { total: plan.assets.length, confirmed: plan.assets.length } };
}
