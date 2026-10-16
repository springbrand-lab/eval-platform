import type {
  EvidenceArtifact,
  EvidenceLimits,
  EvidenceManifest,
  EvidenceOmission,
  EvidenceTrajectoryPart,
  JsonValue,
} from "@eval-platform/eval-contracts";
import {
  EVIDENCE_OMISSION_REASONS,
  EVIDENCE_SCHEMA_VERSION,
  AGENT_FRAMEWORKS,
  canonicalJsonBytes,
  sha256Hex,
} from "@eval-platform/eval-contracts";
import { z } from "zod";

import type { EvidenceBundleReader, EvidenceStore, ExportedArtifact } from "./model.js";

/** Raw content-addressed storage; `createEvidenceStore` owns the bundle format on top of it. */
export interface EvidenceBlobStore {
  /** Stores the bytes under their SHA-256 without buffering them whole; repeats are no-ops. */
  putBlob(content: ReadableStream<Uint8Array>, maxBytes: number): Promise<{ readonly sha256: string; readonly size: number }>;
  readBlob(sha256: string): Promise<ReadableStream<Uint8Array> | undefined>;
  /** Writes once; an existing manifest under the same ID keeps its bytes. */
  putManifest(evidenceHex: string, bytes: Uint8Array): Promise<void>;
  readManifest(evidenceHex: string): Promise<Uint8Array | undefined>;
}

/** A stored bundle does not match its reference, or an export broke its own limits. */
export class EvidenceIntegrityError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "EvidenceIntegrityError";
  }
}

const UPLOAD_CONCURRENCY = 8;

/**
 * Applies the limits in path order, so a truncated bundle always keeps the same prefix.
 * Every artifact left out is reported with its reason; none is dropped silently.
 */
export function applyEvidenceLimits(
  artifacts: readonly ExportedArtifact[],
  limits: EvidenceLimits,
): { readonly artifacts: readonly ExportedArtifact[]; readonly omitted: readonly EvidenceOmission[] } {
  const kept: ExportedArtifact[] = [];
  const omitted: EvidenceOmission[] = [];
  let total = 0;
  const excluded = new Set(limits.excludedSegments);
  for (const artifact of [...artifacts].sort((left, right) => compare(left.path, right.path))) {
    if (artifact.path.split("/").some((segment) => excluded.has(segment))) {
      omitted.push({ path: artifact.path, reason: "excluded" });
    } else if (artifact.size > limits.maxFileBytes) {
      omitted.push({ path: artifact.path, reason: "too-large" });
    } else if (kept.length >= limits.maxFiles || total + artifact.size > limits.maxTotalBytes) {
      omitted.push({ path: artifact.path, reason: "limit" });
    } else {
      kept.push(artifact);
      total += artifact.size;
    }
  }
  return { artifacts: kept, omitted };
}

export function createEvidenceStore(blobs: EvidenceBlobStore, now: () => string = () => new Date().toISOString()): EvidenceStore {
  return {
    async save({ evidence, limits }) {
      if (evidence.artifacts.length > limits.maxFiles) {
        throw new EvidenceIntegrityError("Exported evidence has more files than its limits allow");
      }
      const exportedAt = now();
      const stored = await mapLimited(evidence.artifacts, UPLOAD_CONCURRENCY, async (artifact): Promise<EvidenceArtifact> => {
        const { sha256, size } = await blobs.putBlob(await evidence.readFile(artifact.path), limits.maxFileBytes);
        if (size !== artifact.size) throw new EvidenceIntegrityError(`Evidence file ${artifact.path} size changed during export`);
        return { path: artifact.path, size, mediaType: artifact.mediaType, sha256 };
      });
      if (stored.reduce((total, artifact) => total + artifact.size, 0) > limits.maxTotalBytes) {
        throw new EvidenceIntegrityError("Exported evidence is larger than its limits allow");
      }
      const subjectInputs = await mapLimited(evidence.subjectInputs, UPLOAD_CONCURRENCY, async (file) => {
        const { sha256, size } = await blobs.putBlob(await file.read(), limits.maxFileBytes);
        if (size !== file.size) throw new EvidenceIntegrityError(`Subject input ${file.path} size changed during export`);
        return { bundleId: file.bundleId, materialId: file.materialId, path: file.path, mediaType: file.mediaType, sha256, size };
      });
      const parts: EvidenceTrajectoryPart[] = [];
      for await (const part of trajectoryParts(evidence.trajectory, limits.maxFileBytes)) {
        const storedPart = await blobs.putBlob(new ReadableStream({
          start(controller) {
            for (const bytes of part.chunks) controller.enqueue(bytes);
            controller.close();
          },
        }), limits.maxFileBytes);
        parts.push({ ...storedPart, events: part.events });
      }
      const body = {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        source: { ...evidence.source, exportedAt },
        artifacts: stored,
        subjectInputs,
        trajectory: {
          format: evidence.trajectoryFormat,
          parts,
          events: parts.reduce((count, part) => count + part.events, 0),
          complete: evidence.trajectoryComplete,
          ...(evidence.trajectoryIncompleteReason === undefined
            ? {} : { incompleteReason: evidence.trajectoryIncompleteReason }),
        },
        omitted: [...evidence.omitted],
      } satisfies Omit<EvidenceManifest, "evidenceId">;
      const evidenceHex = await sha256Hex(canonicalJsonBytes(body));
      const manifest: EvidenceManifest = { ...body, evidenceId: `sha256:${evidenceHex}` };
      const bytes = canonicalJsonBytes(manifest);
      await blobs.putManifest(evidenceHex, bytes);
      return { evidenceId: manifest.evidenceId, manifestSha256: await sha256Hex(bytes), exportedAt };
    },

    async open(ref): Promise<EvidenceBundleReader> {
      const evidenceHex = /^sha256:([0-9a-f]{64})$/u.exec(ref.evidenceId)?.[1];
      if (!evidenceHex) throw new EvidenceIntegrityError(`Invalid evidence ID ${ref.evidenceId}`);
      const manifestBytes = await blobs.readManifest(evidenceHex);
      if (!manifestBytes) throw new EvidenceIntegrityError(`Evidence bundle ${ref.evidenceId} was not found`);
      if (await sha256Hex(manifestBytes) !== ref.manifestSha256) {
        throw new EvidenceIntegrityError(`Evidence bundle ${ref.evidenceId} manifest does not match its reference`);
      }
      const parsed = manifestSchema.safeParse(JSON.parse(new TextDecoder().decode(manifestBytes)));
      if (!parsed.success || parsed.data.evidenceId !== ref.evidenceId) {
        throw new EvidenceIntegrityError(`Evidence bundle ${ref.evidenceId} manifest is invalid`);
      }
      const manifest = parsed.data as EvidenceManifest;
      return {
        ref,
        manifest,
        manifestBytes,
        async readBlob(sha256) {
          const blob = await blobs.readBlob(sha256);
          if (!blob) throw new EvidenceIntegrityError(`Evidence bundle ${ref.evidenceId} is missing blob ${sha256}`);
          return blob;
        },
      };
    },
  };
}

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);

const manifestSchema = z.object({
  schemaVersion: z.literal(EVIDENCE_SCHEMA_VERSION),
  evidenceId: z.string(),
  source: z.object({
    framework: z.enum(AGENT_FRAMEWORKS),
    samplingId: z.string().min(1),
    agentRef: z.record(z.string(), z.string()),
    exportedAt: z.string().min(1),
  }),
  artifacts: z.array(z.object({
    path: z.string().startsWith("/"),
    size: z.number().int().nonnegative(),
    mediaType: z.string().min(1),
    sha256,
  })),
  subjectInputs: z.array(z.object({
    bundleId: z.string().min(1),
    materialId: z.string().min(1),
    path: z.string().startsWith("/"),
    size: z.number().int().nonnegative(),
    mediaType: z.string().min(1),
    sha256,
  })),
  trajectory: z.object({
    format: z.string().min(1),
    parts: z.array(z.object({ sha256, size: z.number().int().positive(), events: z.number().int().positive() })),
    events: z.number().int().nonnegative(),
    complete: z.boolean(),
    incompleteReason: z.string().optional(),
  }),
  omitted: z.array(z.object({ path: z.string(), reason: z.enum(EVIDENCE_OMISSION_REASONS) })),
});

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Parts retain complete lines and order, with at most one file's bytes buffered. */
async function* trajectoryParts(events: AsyncIterable<JsonValue>, maxBytes: number): AsyncGenerator<{
  readonly chunks: readonly Uint8Array[];
  readonly events: number;
}> {
  const encoder = new TextEncoder();
  let chunks: Uint8Array[] = [];
  let size = 0;
  for await (const event of events) {
    const bytes = encoder.encode(`${JSON.stringify(event)}\n`);
    if (bytes.byteLength > maxBytes) throw new EvidenceIntegrityError("One trajectory event exceeds the evidence file byte limit");
    if (size + bytes.byteLength > maxBytes) {
      yield { chunks, events: chunks.length };
      chunks = [];
      size = 0;
    }
    chunks.push(bytes);
    size += bytes.byteLength;
  }
  if (chunks.length > 0) yield { chunks, events: chunks.length };
}

async function mapLimited<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]!);
    }
  }));
  return results;
}
