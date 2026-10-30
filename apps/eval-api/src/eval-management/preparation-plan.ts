import { equalJson } from "@eval-platform/eval-contracts";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { parsePromptDatasetUpload, platformIdSchema } from "@eval-platform/eval-dataset";
import { digestJson } from "@eval-platform/eval-runtime";
import { z } from "zod";
import { digest } from "../agent-imports/model.js";
import { validateMaterialFiles, validateSessionContent } from "../sp/bundle-content.js";
import type { ManagementFiles } from "./files.js";
import { prepareInputsSchema, saveInitialResourceSchema } from "./schemas.js";
import type { UploadReceipt } from "./store.js";

export type PreparationInput = z.output<typeof prepareInputsSchema>;
export type InitialResourceInput = z.output<typeof saveInitialResourceSchema>;
type AssetKind = InitialResourceInput["kind"];
export interface UploadFact {
  readonly uploadRef: string;
  readonly kind: UploadReceipt["kind"];
  readonly name: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256: string;
}
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
  readonly version: 3;
  readonly promptUploadRef: string;
  readonly uploadFact: UploadFact;
  readonly name: string;
  readonly description: string;
  readonly format: "json" | "jsonl";
  readonly datasetId: string;
  readonly dataIds: readonly string[];
  readonly cases: PreparationInput["cases"];
  /** Canonical SHA-256 of every original Data field and of the complete planned bound Data. */
  readonly rowDigests: readonly PreparationRowDigests[];
}

export interface PreparationRowDigests {
  /** The full Prompt Data content, without its separately recorded planned dataId. */
  readonly original: string;
  /** The full Data content after exactly this case's existing resource refs are bound. */
  readonly bound: string;
}

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const planSchema = z.strictObject({
  version: z.literal(3),
  promptUploadRef: platformIdSchema,
  uploadFact: z.strictObject({
    uploadRef: platformIdSchema, kind: z.literal("prompt"),
    name: z.string().min(1), mediaType: z.string().min(1),
    byteSize: z.number().int().positive(), sha256,
  }),
  name: prepareInputsSchema.shape.name,
  description: prepareInputsSchema.shape.description,
  format: prepareInputsSchema.shape.format,
  datasetId: platformIdSchema,
  dataIds: z.array(platformIdSchema).min(1).max(50),
  cases: prepareInputsSchema.shape.cases,
  rowDigests: z.array(z.strictObject({ original: sha256, bound: sha256 })).min(1).max(50),
}).refine((plan) => plan.dataIds.length === plan.cases.length
  && plan.rowDigests.length === plan.dataIds.length
  && new Set([plan.datasetId, ...plan.dataIds]).size === plan.dataIds.length + 1
  && plan.promptUploadRef === plan.uploadFact.uploadRef);

/** Only existing owned, normalized UUID references are included; never stage a new resource here. */
export function plannedCaseBindings(row: PreparationInput["cases"][number]) {
  return {
    ...(row.initialMaterials?.length ? { initialMaterials: row.initialMaterials } : {}),
    ...(row.evalInitialMaterials?.length ? { evalInitialMaterials: row.evalInitialMaterials } : {}),
    ...(row.initialSession ? { initialSession: row.initialSession } : {}),
  };
}

/** Reject older/partial plans and altered hashes without ever reopening staged bytes. */
export function validPreparationPlan(owner: string, key: string, fingerprint: string,
  value: unknown): value is PreparationPlan {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success || !equalJson(value, parsed.data)) return false;
  const plan = parsed.data;
  const request = { operationKey: key, promptUploadRef: plan.promptUploadRef,
    name: plan.name, description: plan.description, format: plan.format, cases: plan.cases };
  return prepareInputsSchema.safeParse(request).success
    && fingerprint === preparationFingerprint(owner, request, plan.uploadFact, plan.rowDigests);
}

/** A confirmed stage must carry the exact planned identity, not merely the stage name. */
export function validPreparationStages(plan: PreparationPlan, value: unknown, completed: boolean): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const stages = value as Record<string, unknown>;
  const required = new Map<string, unknown>([
    ["dataset", { datasetId: plan.datasetId, dataIds: plan.dataIds }],
    ...plan.dataIds.map((dataId): [string, unknown] => [`data:${dataId}`, { dataId }]),
  ]);
  for (const [name, stage] of Object.entries(stages)) {
    if (!required.has(name) || stage === null || typeof stage !== "object" || Array.isArray(stage)) return false;
    const entry = stage as Record<string, unknown>;
    if (entry.status !== "attempted" && entry.status !== "confirmed") return false;
    if (entry.status === "confirmed" && !equalJson(entry.receipt, required.get(name))
      || entry.status === "attempted" && entry.receipt !== undefined) return false;
  }
  return !completed || [...required.keys()].every((name) =>
    (stages[name] as { status?: unknown } | undefined)?.status === "confirmed");
}

/** Only trusted ingress metadata, never a model assertion or file bytes. */
export function uploadFact(row: UploadReceipt): UploadFact {
  return { uploadRef: row.uploadId, kind: row.kind, name: row.name, mediaType: row.mediaType,
    byteSize: row.byteSize, sha256: row.sha256 };
}

export function preparationFingerprint(owner: string, input: PreparationInput, fact: UploadFact,
  rowDigests: readonly PreparationRowDigests[]) {
  return digest(["management-preparation/v3", owner, input, fact, rowDigests]);
}

export function initialResourceFingerprint(owner: string, input: InitialResourceInput, fact: UploadFact) {
  return digest(["management-initial-resource/v1", owner, input, fact]);
}

export async function planPreparation(owner: string, input: PreparationInput, files: ManagementFiles,
  fact: UploadFact): Promise<PreparationPlan> {
  const content = new TextDecoder("utf-8", { fatal: true }).decode(await files.read(owner, input.promptUploadRef, "prompt"));
  const parsed = parsePromptDatasetUpload({
    name: input.name, description: input.description, format: input.format, content,
  });
  if (parsed.data.length !== input.cases.length) {
    throw new HttpError("REQUEST_INVALID_INPUT", "Specify exactly one file mapping for each Prompt row");
  }
  const rowDigests = await Promise.all(parsed.data.map(async (row, index) => ({
    original: await digestJson(row),
    bound: await digestJson({ ...row, ...plannedCaseBindings(input.cases[index]!) }),
  })));
  return {
    version: 3, promptUploadRef: input.promptUploadRef, uploadFact: fact,
    name: input.name, description: input.description,
    format: input.format, datasetId: crypto.randomUUID(),
    dataIds: parsed.data.map(() => crypto.randomUUID()), cases: input.cases, rowDigests,
  };
}

/** Plan and validate a single standalone Bundle + child, using the shared SP content rules. */
export async function planResource(owner: string, input: InitialResourceInput,
  files: ManagementFiles, upload: UploadReceipt): Promise<PlannedAsset> {
  if (upload.uploadId !== input.uploadRef || upload.kind !== input.kind || upload.expiresAt.getTime() <= Date.now()) {
    throw new HttpError("REQUEST_INVALID_INPUT", "The staged resource is unavailable or expired");
  }
  const asset: PlannedAsset = {
    uploadRef: input.uploadRef, kind: input.kind, bundleId: crypto.randomUUID(), resourceId: crypto.randomUUID(),
    name: upload.name, mediaType: upload.mediaType, byteSize: upload.byteSize, sha256: upload.sha256,
    ...(input.kind === "session" ? { format: input.format } : {}),
  };
  const raw = await files.read(owner, input.uploadRef, input.kind);
  if (input.kind === "material") validateMaterialFiles([{
    path: `/${asset.name}`, mediaType: asset.mediaType, contentBase64: Buffer.from(raw).toString("base64"),
  }]);
  else validateSessionContent({ format: input.format, content: new TextDecoder("utf-8", { fatal: true }).decode(raw) });
  return asset;
}
