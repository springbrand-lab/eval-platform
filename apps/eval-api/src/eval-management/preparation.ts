import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { equalJson } from "@eval-platform/eval-contracts";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { parsePromptDatasetUpload, platformIdSchema } from "@eval-platform/eval-dataset";
import { digestJson } from "@eval-platform/eval-runtime";
import type { Context } from "hono";
import { BundleResourceNotFoundError } from "../db/errors.js";
import type { AppBindings } from "../lib/types.js";
import { requireInitializationBudget, validateMaterialFiles, validateSessionContent } from "../sp/bundle-content.js";
import type { BindingPlan } from "./binding.js";
import { record, short } from "./common.js";
import type { InitialResourcePlan } from "./initial-resource.js";
import { initialResourceFingerprint, planPreparation, plannedCaseBindings, preparationFingerprint, uploadFact,
  validPreparationPlan, validPreparationStages, type PreparationInput, type PreparationPlan,
  type PlannedAsset } from "./preparation-plan.js";
import { saveInitialResourceSchema } from "./schemas.js";
import { ManagementOutcomeUnknownError } from "./skill.js";
import type { ManagementStore, OperationReceipt } from "./store.js";

const conflict = () => new HttpError("EVAL_SP_CONFLICT", "The preparation no longer matches its planned resources");
const unavailable = () => new HttpError("INTERNAL_ERROR", "Management preparation has no durable store");
const digestBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const stageOf = (operation: OperationReceipt, name: string) => operation.stages[name]?.status ?? "pending";

function dependencies(c: Context<AppBindings>) {
  if (!c.env.evalManagement) throw unavailable();
  return c.env.evalManagement;
}

function storedPreparation(owner: string, input: PreparationInput, operation: OperationReceipt): PreparationPlan {
  if (operation.ownerUserId !== owner || operation.operationKey !== input.operationKey
    || operation.kind !== "prepare"
    || !validPreparationPlan(owner, input.operationKey, operation.fingerprint, operation.plan)) throw conflict();
  const plan = operation.plan;
  if (plan.promptUploadRef !== input.promptUploadRef || plan.name !== input.name
    || plan.description !== input.description || plan.format !== input.format
    || !equalJson(plan.cases, input.cases)
    || !validPreparationStages(plan, operation.stages, operation.status === "completed")) throw conflict();
  return plan;
}

/** Read only the planned identities/statuses; never a prompt, ZIP, byte body or attachment URL. */
export async function getPreparation(c: Context<AppBindings>, operationKey: string, page = 1, pageSize = 10) {
  const operation = await dependencies(c).store.get(c.var.user.id, operationKey);
  if (!operation) throw new HttpError("REQUEST_NOT_FOUND", "Unknown preparation key");
  if (operation.kind === "initial_resource") {
    const plan = operation.plan as unknown as InitialResourcePlan;
    const asset = plan?.asset;
    if (plan?.version !== 1 || !asset || (asset.kind !== "material" && asset.kind !== "session")
      || !saveInitialResourceSchema.safeParse(plan.request).success
      || plan.request.operationKey !== operationKey || plan.request.kind !== asset.kind
      || plan.request.uploadRef !== asset.uploadRef
      || !platformIdSchema.safeParse(asset.uploadRef).success
      || !equalJson(plan.uploadFact, { uploadRef: asset.uploadRef, kind: asset.kind,
        name: asset.name, mediaType: asset.mediaType, byteSize: asset.byteSize, sha256: asset.sha256 })
      || operation.fingerprint !== initialResourceFingerprint(c.var.user.id, plan.request, plan.uploadFact)
      || !platformIdSchema.safeParse(asset.bundleId).success || !platformIdSchema.safeParse(asset.resourceId).success
      || (asset.kind === "material" && asset.format !== undefined)
      || (asset.kind === "session" && asset.format !== "json" && asset.format !== "jsonl")) {
      throw new HttpError("RESPONSE_INVALID", "Stored resource plan is invalid");
    }
    const stage = operation.stages[`resource:${asset.uploadRef}`];
    if (stage?.status === "confirmed" && !equalJson(stage.receipt,
      { bundleId: asset.bundleId, resourceId: asset.resourceId })) {
      throw new HttpError("RESPONSE_INVALID", "Stored resource receipt is invalid");
    }
    if (operation.status === "completed" && stage?.status !== "confirmed") {
      throw new HttpError("RESPONSE_INVALID", "The resource was not confirmed");
    }
    return {
      operationKey, kind: "initial_resource", resourceKind: asset.kind,
      status: operation.status === "completed" ? "completed"
        : stage?.status === "confirmed" ? "finalizing"
          : stage?.status === "attempted" ? "outcome_unknown" : "preparing",
      stage: stage?.status ?? "pending", bundleId: asset.bundleId,
      ...(asset.kind === "material" ? { materialId: asset.resourceId } : { sessionId: asset.resourceId }),
    };
  }
  if (operation.kind === "bind") {
    const plan = operation.plan as unknown as BindingPlan;
    if (!plan || plan.version !== 3 || !plan.patch || plan.datasetId !== plan.request?.datasetId
      || plan.dataId !== plan.request.dataId) {
      throw new HttpError("RESPONSE_INVALID", "Stored binding plan is invalid");
    }
    const binding = stageOf(operation, `data:${plan.dataId}`);
    if (operation.status === "completed" && binding !== "confirmed") {
      throw new HttpError("RESPONSE_INVALID", "Stored binding receipt is invalid");
    }
    return {
      operationKey, kind: "bind", status: operation.status === "completed" ? "completed"
        : binding === "confirmed" ? "finalizing" : binding === "attempted" ? "outcome_unknown" : "preparing",
      datasetId: plan.datasetId, dataId: plan.dataId,
      expectedContentDigest: plan.expectedContentDigest, contentDigest: plan.contentDigest,
      binding,
      ...plan.patch,
    };
  }
  if (operation.kind !== "prepare") {
    const stage = operation.kind === "skill" ? "skill"
      : operation.kind === "reference" ? "reference" : "output_schema";
    const final = operation.stages[stage];
    const confirmed = final?.status === "confirmed" ? record(final.receipt) : null;
    return { operationKey, kind: operation.kind,
      status: operation.status === "completed" ? "completed"
        : confirmed ? "finalizing"
          : Object.values(operation.stages).some((item) => item.status === "attempted") ? "outcome_unknown" : "pending",
      ...(confirmed ? { receipt: operation.kind === "skill"
        ? { skillId: short(confirmed.skillId, 255), name: short(confirmed.name, 120) }
        : operation.kind === "reference"
          ? { referenceId: short(confirmed.referenceId, 36), name: short(confirmed.name, 240) }
          : { outputSchemaId: short(confirmed.outputSchemaId, 36), name: short(confirmed.name, 200) } } : {}),
      stages: Object.fromEntries(Object.entries(operation.stages).map(([name, item]) => [name, item.status])),
    };
  }
  if (operation.ownerUserId !== c.var.user.id || operation.operationKey !== operationKey
    || !validPreparationPlan(c.var.user.id, operationKey, operation.fingerprint, operation.plan)
    || !validPreparationStages(operation.plan, operation.stages, operation.status === "completed")) {
    throw new HttpError("RESPONSE_INVALID", "Stored preparation plan is invalid");
  }
  const plan = operation.plan;
  const start = (page - 1) * pageSize;
  return {
    operationKey, kind: "prepare", status: operation.status === "completed" ? "completed" : "preparing",
    datasetId: plan.datasetId, dataset: stageOf(operation, "dataset"),
    page, pageSize, totalCases: plan.dataIds.length,
    cases: plan.dataIds.slice(start, start + pageSize).map((dataId, offset) => {
      const index = start + offset;
      return {
        dataId, binding: stageOf(operation, `data:${dataId}`),
        initialMaterials: plan.cases[index]!.initialMaterials ?? [],
        evalInitialMaterials: plan.cases[index]!.evalInitialMaterials ?? [],
        ...(plan.cases[index]!.initialSession ? { initialSession: plan.cases[index]!.initialSession } : {}),
      };
    }),
  };
}

/** Check only owned, already-saved refs and role budgets before the first Prompt import. */
async function preflightMaterials(c: Context<AppBindings>, input: PreparationInput): Promise<void> {
  const ownedBytes = new Map<string, number>();
  for (const row of input.cases) {
    for (const field of ["initialMaterials", "evalInitialMaterials"] as const) {
      const references = row[field] ?? [];
      if (new Set(references.map(({ bundleId, materialId }) => `${bundleId}:${materialId}`)).size !== references.length) {
        throw new HttpError("REQUEST_INVALID_INPUT", "A Data resource field cannot repeat the same Material");
      }
      let bytes = 0;
      for (const selection of references) {
        const id = `${selection.bundleId}:${selection.materialId}`;
        let size = ownedBytes.get(id);
        if (size === undefined) {
          size = (await c.var.services.materialBundles.getResource(selection.bundleId, selection.materialId)).byteSize;
          ownedBytes.set(id, size);
        }
        bytes += size;
        requireInitializationBudget(bytes, field);
      }
    }
  }
}

async function promptContent(c: Context<AppBindings>, plan: PreparationPlan): Promise<string> {
  const bytes = await dependencies(c).files.read(c.var.user.id, plan.promptUploadRef, "prompt");
  if (bytes.byteLength !== plan.uploadFact.byteSize || digestBytes(bytes) !== plan.uploadFact.sha256) throw conflict();
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** A single owner-scoped DB snapshot proves metadata, original order, every member ID and its entire content. */
async function verifyPersistedDataset(c: Context<AppBindings>, plan: PreparationPlan, store: ManagementStore,
  boundOnly = false): Promise<boolean> {
  const snapshot = await store.inspectPreparedDataset(c.var.user.id, plan.datasetId);
  if (!snapshot) return false;
  if (snapshot.order !== "upload"
    || !equalJson(snapshot.dataset, { datasetId: plan.datasetId, name: plan.name, description: plan.description })
    || snapshot.data.length !== plan.dataIds.length) throw conflict();
  for (const [index, row] of snapshot.data.entries()) {
    if (row.dataId !== plan.dataIds[index]) throw conflict();
    const expected = plan.rowDigests[index]!;
    if (row.contentDigest !== expected.bound && (boundOnly || row.contentDigest !== expected.original)) throw conflict();
  }
  return true;
}

async function prepareDataset(c: Context<AppBindings>, plan: PreparationPlan, store: ManagementStore, key: string) {
  const claim = await store.attempt(c.var.user.id, key, "dataset");
  const receipt = { datasetId: plan.datasetId, dataIds: plan.dataIds };
  if (claim.status === "confirmed" && !equalJson(claim.receipt, receipt)) throw conflict();
  // A lost atomic import reply is recoverable from committed rows even if staging has expired.
  if (await verifyPersistedDataset(c, plan, store)) {
    if (claim.status !== "confirmed") await store.confirm(c.var.user.id, key, "dataset", receipt);
    return;
  }
  if (claim.status === "confirmed") throw conflict();
  // An attempted, absent Dataset may still be in an uncommitted first import. Give
  // a concurrent first caller a short read-only window to commit before considering
  // an identity-equal atomic replay under this exact operation and planned IDs.
  if (claim.status === "attempted") {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await delay(25, undefined, { signal: c.req.raw.signal });
      if (await verifyPersistedDataset(c, plan, store)) {
        await store.confirm(c.var.user.id, key, "dataset", receipt);
        return;
      }
    }
    const staged = await store.upload(c.var.user.id, plan.promptUploadRef);
    if (!staged || staged.expiresAt.getTime() <= Date.now()) throw new ManagementOutcomeUnknownError();
    if (staged.ownerUserId !== c.var.user.id || staged.uploadId !== plan.promptUploadRef
      || staged.claimedBy !== key || !equalJson(uploadFact(staged), plan.uploadFact)) throw conflict();
  }
  let content: string;
  try {
    content = await promptContent(c, plan);
  } catch (error) {
    // The upload may expire or its private file disappear after the ready-row check.
    // An absent attempted write is unknown without verified bytes, never a success.
    if (claim.status === "attempted" && error instanceof HttpError
      && (error.code === "REQUEST_INVALID_INPUT" || error.code === "BUNDLE_FILE_UNAVAILABLE")) {
      throw new ManagementOutcomeUnknownError();
    }
    throw error;
  }
  const upload = { name: plan.name, description: plan.description, format: plan.format, content };
  const rows = parsePromptDatasetUpload(upload).data;
  if (rows.length !== plan.dataIds.length) throw conflict();
  for (const [index, row] of rows.entries()) {
    const planned = plan.rowDigests[index]!;
    if (await digestJson(row) !== planned.original
      || await digestJson({ ...row, ...plannedCaseBindings(plan.cases[index]!) }) !== planned.bound) throw conflict();
  }
  try {
    await c.var.services.datasets.importPromptDataset(upload, { datasetId: plan.datasetId, dataIds: plan.dataIds });
  } catch (error) {
    // An in-flight first caller might commit and bind its rows before this
    // identity-equal import checks the now-bound Data. An attempted replay may
    // settle only if the *entire* committed Dataset is independently proven.
    if (claim.status !== "attempted" || !await verifyPersistedDataset(c, plan, store)) throw error;
  }
  if (!await verifyPersistedDataset(c, plan, store)) throw conflict();
  await store.confirm(c.var.user.id, key, "dataset", receipt);
}

/** Read back the *planned*, owner-scoped active catalog identity and actual bytes, never search by name/hash. */
export async function verifyResource(c: Context<AppBindings>, asset: PlannedAsset): Promise<void> {
  const services = c.var.services;
  const catalog = asset.kind === "material" ? services.materialBundles : services.sessionBundles;
  const labels = { name: asset.name, description: asset.name };
  const bundle = await catalog.get(asset.bundleId);
  if (!equalJson(bundle, { bundleId: asset.bundleId, ...labels })) throw conflict();
  if (asset.kind === "material") {
    const material = await services.materialBundles.getResource(asset.bundleId, asset.resourceId);
    const file = await services.materialBundles.getFile(asset.bundleId, asset.resourceId, `/${asset.name}`);
    if (material.name !== labels.name || material.description !== labels.description
      || material.byteSize !== asset.byteSize || file.mediaType !== asset.mediaType
      || digestBytes(file.bytes) !== asset.sha256) throw conflict();
  } else {
    const session = await services.sessionBundles.getResource(asset.bundleId, asset.resourceId);
    const file = await services.sessionBundles.getFile(asset.bundleId, asset.resourceId, `/context.${asset.format}`);
    if (session.name !== labels.name || session.description !== labels.description || session.format !== asset.format
      || digestBytes(file.bytes) !== asset.sha256) throw conflict();
  }
}

export async function prepareResource(c: Context<AppBindings>, asset: PlannedAsset,
  store: ManagementStore, key: string) {
  const stage = `resource:${asset.uploadRef}`;
  const claim = await store.attempt(c.var.user.id, key, stage);
  if (claim.status === "confirmed") {
    if (!equalJson(claim.receipt, { bundleId: asset.bundleId, resourceId: asset.resourceId })) throw conflict();
    await verifyResource(c, asset); // confirmed but not yet completed must still be active
    return;
  }
  const catalog = asset.kind === "material" ? c.var.services.materialBundles : c.var.services.sessionBundles;
  const existing = await catalog.get(asset.bundleId).catch((error: unknown) => {
    if (error instanceof BundleResourceNotFoundError) return null;
    throw error;
  });
  if (existing) await verifyResource(c, asset);
  else {
    // Once attempted, a missing planned ID cannot prove that an uncertain write did not
    // commit. Reconciliation is read-only; a new key/identity must never retry this upload.
    if (claim.status !== "started") throw new ManagementOutcomeUnknownError();
    const bytes = await dependencies(c).files.read(c.var.user.id, asset.uploadRef, asset.kind);
    const labels = { name: asset.name, description: asset.name };
    const identity = { bundleId: asset.bundleId, resourceIds: [asset.resourceId] };
    if (asset.kind === "material") {
      const files = [{ path: `/${asset.name}`, mediaType: asset.mediaType, contentBase64: Buffer.from(bytes).toString("base64") }];
      await c.var.services.materialBundles.create(labels, [{ ...labels, files: validateMaterialFiles(files).files }], identity);
    } else {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const context = validateSessionContent({ format: asset.format!, content });
      await c.var.services.sessionBundles.create(labels, [{ ...labels, ...context }], identity);
    }
    await verifyResource(c, asset);
  }
  await store.confirm(c.var.user.id, key, stage, { bundleId: asset.bundleId, resourceId: asset.resourceId });
}

async function bindCase(c: Context<AppBindings>, plan: PreparationPlan, index: number,
  store: ManagementStore, key: string) {
  const dataId = plan.dataIds[index]!;
  const stage = `data:${dataId}`;
  const claim = await store.attempt(c.var.user.id, key, stage);
  const row = plan.cases[index]!;
  const expected = plannedCaseBindings(row);
  if (claim.status === "confirmed" && !equalJson(claim.receipt, { dataId })) throw conflict();
  const read = async () => {
    const data = await c.var.services.datasets.getData(dataId);
    if (!data || data.dataId !== dataId) throw conflict();
    const { dataId: _id, ...content } = data;
    return { initialMaterials: data.initialMaterials, evalInitialMaterials: data.evalInitialMaterials,
      initialSession: data.initialSession, contentDigest: await digestJson(content) };
  };
  const same = (current: Awaited<ReturnType<typeof read>>) =>
    equalJson(current.initialMaterials ?? undefined, expected.initialMaterials ?? undefined)
    && equalJson(current.evalInitialMaterials ?? undefined, expected.evalInitialMaterials ?? undefined)
    && equalJson(current.initialSession ?? undefined, expected.initialSession ?? undefined);
  const current = await read();
  const digests = plan.rowDigests[index]!;
  if (current.contentDigest !== digests.original && current.contentDigest !== digests.bound) throw conflict();
  if (!same(current)) {
    // A confirmed binding altered by another user must never be silently restored.
    if (claim.status === "confirmed" || current.initialMaterials || current.evalInitialMaterials || current.initialSession) throw conflict();
    if (claim.status === "attempted") throw new ManagementOutcomeUnknownError();
    if (Object.keys(expected).length) await c.var.services.initialResources.bindData(dataId, expected);
    const bound = await read();
    if (!same(bound) || bound.contentDigest !== digests.bound) throw conflict();
  } else if (current.contentDigest !== digests.bound) {
    throw conflict();
  }
  if (claim.status !== "confirmed") await store.confirm(c.var.user.id, key, stage, { dataId });
}

/** Prepare without Project admission. Planned IDs make lost local-write responses safe to reconcile. */
export async function prepareInputs(c: Context<AppBindings>, input: PreparationInput) {
  const { store, files } = dependencies(c);
  const owner = c.var.user.id;
  const existing = await store.get(owner, input.operationKey);
  let plan: PreparationPlan;
  if (existing) {
    plan = storedPreparation(owner, input, existing);
  } else {
    const prompt = await files.info(owner, input.promptUploadRef, "prompt");
    if (prompt.expiresAt.getTime() <= Date.now()) {
      throw new HttpError("REQUEST_INVALID_INPUT", "The Prompt upload expired before preparation");
    }
    // A pending same-key replay uses its saved plan and receipts; a bound owned
    // Material may since have been soft-deleted without invalidating recovery.
    await preflightMaterials(c, input);
    plan = await planPreparation(owner, input, files, uploadFact(prompt));
  }
  if (!existing) {
    const checked = new Set<string>();
    for (const row of plan.cases) {
      const session = row.initialSession;
      if (session) {
        const id = `session:${session.bundleId}:${session.sessionId}`;
        if (!checked.has(id)) {
          await c.var.services.sessionBundles.getResource(session.bundleId, session.sessionId);
          checked.add(id);
        }
      }
    }
  }
  let operation: OperationReceipt;
  try {
    operation = await store.begin(owner, input.operationKey, "prepare",
      preparationFingerprint(owner, input, plan.uploadFact, plan.rowDigests),
      plan as unknown as Record<string, unknown>);
  } catch (error) {
    if (existing || !(error instanceof HttpError && error.code === "EVAL_SP_CONFLICT")) throw error;
    // Two first calls can have identical intent but different random Dataset/Data IDs.
    // Only the persisted winner may proceed, and only after comparing the full,
    // ID-independent row hashes and the immutable upload metadata.
    const winner = await store.get(owner, input.operationKey);
    if (!winner) throw error;
    const persisted = storedPreparation(owner, input, winner);
    if (!equalJson(persisted.uploadFact, plan.uploadFact)
      || !equalJson(persisted.rowDigests, plan.rowDigests)) throw conflict();
    plan = persisted;
    operation = await store.begin(owner, input.operationKey, "prepare", winner.fingerprint,
      plan as unknown as Record<string, unknown>);
  }
  plan = storedPreparation(owner, input, operation);
  if (operation.status === "completed") {
    if (!await verifyPersistedDataset(c, plan, store, true)) throw conflict();
  } else {
    await prepareDataset(c, plan, store, input.operationKey);
    for (const index of plan.cases.keys()) await bindCase(c, plan, index, store, input.operationKey);
    if (!await verifyPersistedDataset(c, plan, store, true)) throw conflict();
    await store.complete(owner, input.operationKey);
  }
  // The paginated case/resource receipts remain available only through get_preparation.
  const receipt = await getPreparation(c, input.operationKey, 1, 1);
  if (receipt.kind !== "prepare") throw conflict();
  return {
    operationKey: receipt.operationKey, kind: "prepare", status: receipt.status,
    datasetId: receipt.datasetId, totalCases: receipt.totalCases,
  };
}
