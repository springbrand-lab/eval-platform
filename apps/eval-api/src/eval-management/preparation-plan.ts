import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { parsePromptDatasetUpload, type InitialMaterialsRef, type InitialSessionRef } from "@eval-platform/eval-dataset";
import { z } from "zod";
import { digest, IMPORT_LIMITS } from "../agent-imports/model.js";
import { validateMaterialFiles, validateSessionContent } from "../sp/bundle-content.js";
import type { ManagementFiles } from "./files.js";
import { prepareInputsSchema } from "./schemas.js";
import type { UploadReceipt } from "./store.js";

export type PreparationInput = z.output<typeof prepareInputsSchema>;
type AssetKind = "material" | "session";
export interface PlannedAsset {
  readonly uploadRef: string;
  readonly kind: AssetKind;
  readonly bundleId: string;
  readonly resourceId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly format?: "json" | "jsonl";
}
export interface PreparationPlan {
  readonly version: 1;
  readonly promptUploadRef: string;
  readonly name: string;
  readonly description: string;
  readonly format: "json" | "jsonl";
  readonly datasetId: string;
  readonly dataIds: readonly string[];
  readonly cases: PreparationInput["cases"];
  readonly assets: readonly PlannedAsset[];
}

export type ResourceCase = PreparationInput["cases"][number];
const uploadRefs = (cases: readonly ResourceCase[], promptUploadRef?: string) => new Set([
  ...(promptUploadRef ? [promptUploadRef] : []),
  ...cases.flatMap((row) => [
    ...(row.initialMaterials ?? []), ...(row.evalInitialMaterials ?? []),
    ...(row.initialSession ? [row.initialSession] : []),
  ].flatMap((selection) => "uploadRef" in selection ? [selection.uploadRef] : [])),
]);

/** Immutable, owner-scoped staged byte facts shared by Prompt preparation and existing Data binding. */
export async function resourceUploads(owner: string, cases: readonly ResourceCase[], files: ManagementFiles,
  promptUploadRef?: string) {
  const refs = [...uploadRefs(cases, promptUploadRef)].sort();
  if (refs.length > 101) throw new HttpError("REQUEST_INVALID_INPUT", "Too many separate uploaded resources");
  const uploads = new Map<string, UploadReceipt>();
  let bytes = 0;
  for (const ref of refs) {
    const kinds = new Set<AssetKind | "prompt">();
    if (ref === promptUploadRef) kinds.add("prompt");
    for (const row of cases) {
      for (const item of [...(row.initialMaterials ?? []), ...(row.evalInitialMaterials ?? [])]) {
        if ("uploadRef" in item && item.uploadRef === ref) kinds.add("material");
      }
      if (row.initialSession && "uploadRef" in row.initialSession && row.initialSession.uploadRef === ref) kinds.add("session");
    }
    if (kinds.size !== 1) throw new HttpError("REQUEST_INVALID_INPUT", "An upload ref cannot serve multiple resource kinds");
    const [kind] = kinds;
    const upload = await files.info(owner, ref, kind!);
    uploads.set(ref, upload);
    bytes += upload.byteSize;
  }
  if (bytes > IMPORT_LIMITS.totalBytes) throw new HttpError("REQUEST_PAYLOAD_TOO_LARGE", "Preparation exceeds its byte budget");
  const facts = refs.map((ref) => {
    const { kind, name, mediaType, byteSize, sha256 } = uploads.get(ref)!;
    return { uploadRef: ref, kind, name, mediaType, byteSize, sha256 };
  });
  return { uploads, facts };
}

/** Keep prepare_inputs' v1 fingerprint exactly as before. */
export async function preparationUploads(owner: string, input: PreparationInput, files: ManagementFiles) {
  const { uploads, facts } = await resourceUploads(owner, input.cases, files, input.promptUploadRef);
  return { uploads, fingerprint: digest(["management-preparation/v1", owner, input, facts]) };
}

export async function planPreparation(owner: string, input: PreparationInput, files: ManagementFiles,
  uploads: ReadonlyMap<string, UploadReceipt>): Promise<PreparationPlan> {
  if ([...uploads.values()].some((item) => item.expiresAt.getTime() <= Date.now())) {
    throw new HttpError("REQUEST_INVALID_INPUT", "Upload refs must be unexpired before starting a preparation");
  }
  const content = new TextDecoder("utf-8", { fatal: true }).decode(await files.read(owner, input.promptUploadRef, "prompt"));
  const parsed = parsePromptDatasetUpload({
    name: input.name, description: input.description, format: input.format, content,
  });
  if (parsed.data.length !== input.cases.length) {
    throw new HttpError("REQUEST_INVALID_INPUT", "Specify exactly one file mapping for each Prompt row");
  }
  const assets = await planResources(owner, input.cases, files, uploads);
  return {
    version: 1, promptUploadRef: input.promptUploadRef, name: input.name, description: input.description,
    format: input.format, datasetId: crypto.randomUUID(),
    dataIds: parsed.data.map(() => crypto.randomUUID()), cases: input.cases, assets,
  };
}

/** Each upload has exactly one stable planned Bundle/resource identity, shared by both preparation kinds. */
export async function planResources(owner: string, cases: readonly ResourceCase[], files: ManagementFiles,
  uploads: ReadonlyMap<string, UploadReceipt>): Promise<readonly PlannedAsset[]> {
  const assets = new Map<string, PlannedAsset>();
  const add = (ref: string, kind: AssetKind, format?: "json" | "jsonl") => {
    const previous = assets.get(ref);
    if (previous) {
      if (previous.kind !== kind || previous.format !== format) {
        throw new HttpError("REQUEST_INVALID_INPUT", "One Session upload cannot have two formats");
      }
      return;
    }
    const upload = uploads.get(ref)!;
    assets.set(ref, {
      uploadRef: ref, kind, bundleId: crypto.randomUUID(), resourceId: crypto.randomUUID(),
      name: upload.name, mediaType: upload.mediaType, byteSize: upload.byteSize, sha256: upload.sha256,
      ...(format === undefined ? {} : { format }),
    });
  };
  for (const row of cases) {
    for (const selections of [row.initialMaterials ?? [], row.evalInitialMaterials ?? []]) {
      const identities = selections.map((item) => "uploadRef" in item
        ? `upload:${item.uploadRef}` : `material:${item.bundleId}:${item.materialId}`);
      if (new Set(identities).size !== identities.length) {
        throw new HttpError("REQUEST_INVALID_INPUT", "A Data resource field cannot repeat the same Material");
      }
    }
    for (const item of [...(row.initialMaterials ?? []), ...(row.evalInitialMaterials ?? [])]) {
      if ("uploadRef" in item) add(item.uploadRef, "material");
    }
    if (row.initialSession && "uploadRef" in row.initialSession) {
      add(row.initialSession.uploadRef, "session", row.initialSession.format);
    }
  }
  // Validate all bytes and SP content before any Dataset or Bundle write.
  for (const asset of assets.values()) {
    const raw = await files.read(owner, asset.uploadRef, asset.kind);
    if (asset.kind === "material") validateMaterialFiles([{
      path: `/${asset.name}`, mediaType: asset.mediaType, contentBase64: Buffer.from(raw).toString("base64"),
    }]);
    else validateSessionContent({ format: asset.format!, content: new TextDecoder("utf-8", { fatal: true }).decode(raw) });
  }
  return [...assets.values()];
}

export function materialRefs(plan: Pick<PreparationPlan, "assets">,
  selections: ResourceCase["initialMaterials"]): InitialMaterialsRef[] {
  return (selections ?? []).map((selection) => "uploadRef" in selection
    ? { bundleId: assetOf(plan, selection.uploadRef, "material").bundleId,
      materialId: assetOf(plan, selection.uploadRef, "material").resourceId } : selection);
}

export function sessionRef(plan: Pick<PreparationPlan, "assets">,
  selection: NonNullable<ResourceCase["initialSession"]>): InitialSessionRef {
  if (!("uploadRef" in selection)) return selection;
  const asset = assetOf(plan, selection.uploadRef, "session");
  if (asset.format !== selection.format) throw new HttpError("EVAL_SP_CONFLICT", "The planned Session format changed");
  return { bundleId: asset.bundleId, sessionId: asset.resourceId };
}

function assetOf(plan: Pick<PreparationPlan, "assets">, ref: string, kind: AssetKind): PlannedAsset {
  const asset = plan.assets.find((item) => item.uploadRef === ref && item.kind === kind);
  if (!asset) throw new HttpError("EVAL_SP_CONFLICT", "The planned resource identity changed");
  return asset;
}
