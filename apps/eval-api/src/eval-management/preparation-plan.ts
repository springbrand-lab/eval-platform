import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { parsePromptDatasetUpload } from "@eval-platform/eval-dataset";
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

const uploadRefs = (input: PreparationInput) => new Set([
  input.promptUploadRef,
  ...input.cases.flatMap((row) => [
    ...(row.initialMaterials ?? []), ...(row.evalInitialMaterials ?? []),
    ...(row.initialSession ? [row.initialSession] : []),
  ].flatMap((selection) => "uploadRef" in selection ? [selection.uploadRef] : [])),
]);

/** Bind the input to immutable *stored byte facts*, not to model-supplied hashes or URLs. */
export async function preparationUploads(owner: string, input: PreparationInput, files: ManagementFiles) {
  const refs = [...uploadRefs(input)].sort();
  if (refs.length > 101) throw new HttpError("REQUEST_INVALID_INPUT", "Too many separate uploaded resources");
  const uploads = new Map<string, UploadReceipt>();
  let bytes = 0;
  for (const ref of refs) {
    const kinds = new Set<AssetKind | "prompt">();
    if (ref === input.promptUploadRef) kinds.add("prompt");
    for (const row of input.cases) {
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
  for (const row of input.cases) {
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
  return {
    version: 1, promptUploadRef: input.promptUploadRef, name: input.name, description: input.description,
    format: input.format, datasetId: crypto.randomUUID(),
    dataIds: parsed.data.map(() => crypto.randomUUID()), cases: input.cases, assets: [...assets.values()],
  };
}
