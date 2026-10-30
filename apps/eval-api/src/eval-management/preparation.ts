import { createHash } from "node:crypto";
import { equalJson } from "@eval-platform/eval-contracts";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { parsePromptDatasetUpload, type InitialMaterialsRef, type InitialSessionRef } from "@eval-platform/eval-dataset";
import type { Context } from "hono";
import { BundleResourceNotFoundError } from "../db/errors.js";
import type { AppBindings } from "../lib/types.js";
import { requireInitializationBudget, validateMaterialFiles, validateSessionContent } from "../sp/bundle-content.js";
import { record, short } from "./common.js";
import type { PreparationInput, PreparationPlan, PlannedAsset } from "./preparation-plan.js";
import { planPreparation, preparationUploads } from "./preparation-plan.js";
import type { ManagementStore, OperationReceipt, UploadReceipt } from "./store.js";

const conflict = () => new HttpError("EVAL_SP_CONFLICT", "The preparation no longer matches its planned resources");
const unavailable = () => new HttpError("INTERNAL_ERROR", "Management preparation has no durable store");
const digestBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const stageOf = (operation: OperationReceipt, name: string) => operation.stages[name]?.status ?? "pending";

function dependencies(c: Context<AppBindings>) {
  if (!c.env.evalManagement) throw unavailable();
  return c.env.evalManagement;
}

/** Read only the planned identities/statuses; never a prompt, ZIP, byte body or attachment URL. */
export async function getPreparation(c: Context<AppBindings>, operationKey: string, page = 1, pageSize = 10) {
  const operation = await dependencies(c).store.get(c.var.user.id, operationKey);
  if (!operation) throw new HttpError("REQUEST_NOT_FOUND", "Unknown preparation key");
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
  const plan = operation.plan as unknown as PreparationPlan;
  if (!plan || plan.version !== 1 || !Array.isArray(plan.dataIds) || !Array.isArray(plan.cases)
    || !Array.isArray(plan.assets) || plan.dataIds.length !== plan.cases.length || plan.cases.length > 50) {
    throw new HttpError("RESPONSE_INVALID", "Stored preparation plan is invalid");
  }
  const start = (page - 1) * pageSize;
  const pageCases = plan.cases.slice(start, start + pageSize);
  const pageUploads = new Set(pageCases.flatMap((row) => [
    ...(row.initialMaterials ?? []), ...(row.evalInitialMaterials ?? []),
    ...(row.initialSession ? [row.initialSession] : []),
  ].flatMap((selection) => "uploadRef" in selection ? [selection.uploadRef] : [])));
  return {
    operationKey, kind: "prepare", status: operation.status === "completed" ? "completed" : "preparing",
    datasetId: plan.datasetId, dataset: stageOf(operation, "dataset"),
    page, pageSize, totalCases: plan.dataIds.length,
    cases: plan.dataIds.slice(start, start + pageSize).map((dataId, offset) => {
      const index = start + offset;
      return {
        dataId, binding: stageOf(operation, `data:${dataId}`),
        initialMaterials: materialRefs(plan, plan.cases[index]!.initialMaterials),
        evalInitialMaterials: materialRefs(plan, plan.cases[index]!.evalInitialMaterials),
        ...(plan.cases[index]!.initialSession ? { initialSession: sessionRef(plan, plan.cases[index]!.initialSession!) } : {}),
      };
    }),
    resources: {
      total: plan.assets.length,
      confirmed: plan.assets.filter((asset) => stageOf(operation, `resource:${asset.uploadRef}`) === "confirmed").length,
      items: plan.assets.filter((asset) => pageUploads.has(asset.uploadRef)).map((asset) => ({
        kind: asset.kind, bundleId: asset.bundleId, resourceId: asset.resourceId,
        status: stageOf(operation, `resource:${asset.uploadRef}`),
      })),
    },
  };
}

function assetOf(plan: PreparationPlan, ref: string, kind: PlannedAsset["kind"]): PlannedAsset {
  const asset = plan.assets.find((item) => item.uploadRef === ref && item.kind === kind);
  if (!asset) throw conflict();
  return asset;
}

function materialRefs(plan: PreparationPlan, selections: PreparationInput["cases"][number]["initialMaterials"]): InitialMaterialsRef[] {
  return (selections ?? []).map((selection) => "uploadRef" in selection
    ? { bundleId: assetOf(plan, selection.uploadRef, "material").bundleId,
      materialId: assetOf(plan, selection.uploadRef, "material").resourceId } : selection);
}

function sessionRef(plan: PreparationPlan,
  selection: NonNullable<PreparationInput["cases"][number]["initialSession"]>): InitialSessionRef {
  if (!("uploadRef" in selection)) return selection;
  const asset = assetOf(plan, selection.uploadRef, "session");
  if (asset.format !== selection.format) throw conflict();
  return { bundleId: asset.bundleId, sessionId: asset.resourceId };
}

/** Check each new preparation's Subject/Evaluator fields before its first operation or catalog write. */
async function preflightMaterials(c: Context<AppBindings>, input: PreparationInput,
  uploads: ReadonlyMap<string, UploadReceipt>): Promise<void> {
  const ownedBytes = new Map<string, number>();
  for (const row of input.cases) {
    for (const field of ["initialMaterials", "evalInitialMaterials"] as const) {
      let bytes = 0;
      for (const selection of row[field] ?? []) {
        if ("uploadRef" in selection) {
          const upload = uploads.get(selection.uploadRef);
          if (!upload || upload.kind !== "material") throw conflict();
          bytes += upload.byteSize;
        } else {
          const id = `${selection.bundleId}:${selection.materialId}`;
          let size = ownedBytes.get(id);
          if (size === undefined) {
            size = (await c.var.services.materialBundles.getResource(selection.bundleId, selection.materialId)).byteSize;
            ownedBytes.set(id, size);
          }
          bytes += size;
        }
        requireInitializationBudget(bytes, field);
      }
    }
  }
}

async function promptContent(c: Context<AppBindings>, plan: PreparationPlan): Promise<string> {
  const bytes = await dependencies(c).files.read(c.var.user.id, plan.promptUploadRef, "prompt");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function prepareDataset(c: Context<AppBindings>, plan: PreparationPlan, store: ManagementStore, key: string) {
  const services = c.var.services;
  const claim = await store.attempt(c.var.user.id, key, "dataset");
  if (claim.status === "confirmed") return;
  const content = await promptContent(c, plan);
  const upload = { name: plan.name, description: plan.description, format: plan.format, content };
  const rows = parsePromptDatasetUpload(upload).data;
  if (rows.length !== plan.dataIds.length) throw conflict();
  const check = async () => {
    const dataset = await services.datasets.getDataset(plan.datasetId);
    if (!dataset) return false;
    if (!equalJson(dataset, { datasetId: plan.datasetId, name: plan.name, description: plan.description })) throw conflict();
    const data = await services.datasets.listData(plan.datasetId);
    const byId = new Map(data.map((row) => [row.dataId, row]));
    if (byId.size !== plan.dataIds.length || plan.dataIds.some((id, index) =>
      !equalJson(byId.get(id), { ...rows[index], dataId: id }))) throw conflict();
    return true;
  };
  // The previous response may have been lost after the Store's atomic Prompt import commit.
  if (!await check()) {
    await services.datasets.importPromptDataset(upload, { datasetId: plan.datasetId, dataIds: plan.dataIds });
    if (!await check()) throw conflict();
  }
  await store.confirm(c.var.user.id, key, "dataset", { datasetId: plan.datasetId, dataIds: plan.dataIds });
}

async function prepareResource(c: Context<AppBindings>, asset: PlannedAsset,
  store: ManagementStore, key: string) {
  const stage = `resource:${asset.uploadRef}`;
  const claim = await store.attempt(c.var.user.id, key, stage);
  if (claim.status === "confirmed") return;
  const services = c.var.services;
  const catalog = asset.kind === "material" ? services.materialBundles : services.sessionBundles;
  const existing = await catalog.get(asset.bundleId).catch((error: unknown) => {
    if (error instanceof BundleResourceNotFoundError) return null;
    throw error;
  });
  const labels = { name: asset.name, description: asset.name };
  const check = async () => {
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
  };
  if (existing) await check();
  else {
    const bytes = await dependencies(c).files.read(c.var.user.id, asset.uploadRef, asset.kind);
    const identity = { bundleId: asset.bundleId, resourceIds: [asset.resourceId] };
    if (asset.kind === "material") {
      const files = [{ path: `/${asset.name}`, mediaType: asset.mediaType, contentBase64: Buffer.from(bytes).toString("base64") }];
      await services.materialBundles.create(labels, [{ ...labels, files: validateMaterialFiles(files).files }], identity);
    } else {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const context = validateSessionContent({ format: asset.format!, content });
      await services.sessionBundles.create(labels, [{ ...labels, ...context }], identity);
    }
    await check();
  }
  await store.confirm(c.var.user.id, key, stage, { bundleId: asset.bundleId, resourceId: asset.resourceId });
}

async function bindCase(c: Context<AppBindings>, plan: PreparationPlan, index: number,
  store: ManagementStore, key: string) {
  const dataId = plan.dataIds[index]!;
  const stage = `data:${dataId}`;
  const claim = await store.attempt(c.var.user.id, key, stage);
  const row = plan.cases[index]!;
  const subject = materialRefs(plan, row.initialMaterials);
  const evaluator = materialRefs(plan, row.evalInitialMaterials);
  const session = row.initialSession ? sessionRef(plan, row.initialSession) : undefined;
  const expected = {
    ...(subject.length ? { initialMaterials: subject } : {}),
    ...(evaluator.length ? { evalInitialMaterials: evaluator } : {}),
    ...(session ? { initialSession: session } : {}),
  };
  const read = async () => {
    const data = await c.var.services.datasets.getData(dataId);
    if (!data) throw conflict();
    return { initialMaterials: data.initialMaterials, evalInitialMaterials: data.evalInitialMaterials,
      initialSession: data.initialSession };
  };
  const same = (current: Awaited<ReturnType<typeof read>>) =>
    equalJson(current.initialMaterials ?? undefined, expected.initialMaterials ?? undefined)
    && equalJson(current.evalInitialMaterials ?? undefined, expected.evalInitialMaterials ?? undefined)
    && equalJson(current.initialSession ?? undefined, expected.initialSession ?? undefined);
  const current = await read();
  if (!same(current)) {
    // A confirmed binding altered by another user must never be silently restored.
    if (claim.status === "confirmed" || current.initialMaterials || current.evalInitialMaterials || current.initialSession) throw conflict();
    if (Object.keys(expected).length) await c.var.services.initialResources.bindData(dataId, expected);
    if (!same(await read())) throw conflict();
  }
  if (claim.status !== "confirmed") await store.confirm(c.var.user.id, key, stage, { dataId });
}

/** Prepare without Project admission. Planned IDs make lost local-write responses safe to reconcile. */
export async function prepareInputs(c: Context<AppBindings>, input: PreparationInput) {
  const { store, files } = dependencies(c);
  const owner = c.var.user.id;
  const { uploads, fingerprint } = await preparationUploads(owner, input, files);
  const existing = await store.get(owner, input.operationKey);
  if (existing && (existing.kind !== "prepare" || existing.fingerprint !== fingerprint)) throw conflict();
  // Preflight before the first begin/write. A pending same-key replay uses its saved plan and receipts:
  // an already-bound owned Material can since have been soft-deleted without invalidating recovery.
  if (!existing) await preflightMaterials(c, input, uploads);
  const plan = existing ? existing.plan as unknown as PreparationPlan : await planPreparation(owner, input, files, uploads);
  if (!existing) {
    const checked = new Set<string>();
    for (const row of plan.cases) {
      const session = row.initialSession;
      if (session && !("uploadRef" in session)) {
        const id = `session:${session.bundleId}:${session.sessionId}`;
        if (!checked.has(id)) {
          await c.var.services.sessionBundles.getResource(session.bundleId, session.sessionId);
          checked.add(id);
        }
      }
    }
  }
  const operation = await store.begin(owner, input.operationKey, "prepare", fingerprint, plan as unknown as Record<string, unknown>);
  if (operation.status !== "completed") {
    await prepareDataset(c, plan, store, input.operationKey);
    for (const asset of plan.assets) await prepareResource(c, asset, store, input.operationKey);
    for (const index of plan.cases.keys()) await bindCase(c, plan, index, store, input.operationKey);
    await store.complete(owner, input.operationKey);
  }
  // The paginated case/resource receipts remain available only through get_preparation.
  const receipt = await getPreparation(c, input.operationKey, 1, 1);
  if (receipt.kind !== "prepare") throw conflict();
  return {
    operationKey: receipt.operationKey, kind: "prepare", status: receipt.status,
    datasetId: receipt.datasetId, totalCases: receipt.totalCases,
    resources: { total: receipt.resources.total, confirmed: receipt.resources.confirmed },
  };
}
