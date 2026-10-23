import type {
  EvidenceArtifact,
  EvidenceBundleRef,
  EvidenceExportProgress,
  EvidenceLimits,
  EvidenceManifest,
  EvidenceOmission,
} from "@eval-platform/eval-contracts";
import {
  EVIDENCE_OMISSION_REASONS,
  EVIDENCE_SCHEMA_VERSION,
  AGENT_FRAMEWORKS,
  canonicalJsonBytes,
  equalJson,
  sha256Hex,
} from "@eval-platform/eval-contracts";
import { z } from "zod";
import { evalTrajectoryScopeSchema, evalTrajectoryCursorSchema } from "@springbrand/eval-harness";
import { PI_TRAJECTORY_FORMAT, storedTrajectoryFormat } from "./trajectory.js";

import type {
  EvidenceBundleReader,
  EvidenceStore,
  ExportedArtifact,
  ExportedEvidence,
  ExportedTrajectoryEvent,
} from "./model.js";

/** Raw content-addressed storage; `createEvidenceStore` owns the bundle format on top of it. */
export interface EvidenceBlobStore {
  /**
   * Stores the bytes under their SHA-256, reading at most `maxBytes`; repeats are no-ops. An
   * implementation may buffer one blob (the R2 store must, to sign its payload hash).
   */
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

/**
 * Freezes the listing and export moment of a new export. Limits are checked once here, on the
 * listed sizes; every stored file must then have exactly its listed size.
 */
function planEvidenceExport(evidence: ExportedEvidence, limits: EvidenceLimits, exportedAt: string): EvidenceExportProgress {
  if (evidence.artifacts.length > limits.maxFiles) {
    throw new EvidenceIntegrityError("Exported evidence has more files than its limits allow");
  }
  if (evidence.artifacts.reduce((total, artifact) => total + artifact.size, 0) > limits.maxTotalBytes) {
    throw new EvidenceIntegrityError("Exported evidence is larger than its limits allow");
  }
  return {
    exportedAt,
    artifacts: evidence.artifacts.map(({ path, size, mediaType }) => ({ path, size, mediaType })),
    subjectInputs: evidence.subjectInputs.map(({ bundleId, materialId, path, size, mediaType }) => ({
      bundleId, materialId, path, size, mediaType,
    })),
    omitted: evidence.omitted.map(({ path, reason }) => ({ path, reason })),
    trajectory: { afterSeq: 0, parts: [],
      ...(evidence.trajectoryScope ? { scope: evidence.trajectoryScope } : {}),
      ...(evidence.trajectoryCursor ? { cursor: evidence.trajectoryCursor } : {}),
    },
  };
}

/** The manifest a complete progress finalizes; the same progress always yields the same bytes. */
async function finalizeEvidenceManifest(evidence: ExportedEvidence, progress: EvidenceExportProgress): Promise<{
  readonly evidenceHex: string;
  readonly bytes: Uint8Array;
  readonly ref: EvidenceBundleRef;
}> {
  const stored = <T extends { readonly sha256?: string; readonly path: string }>(file: T): T & { readonly sha256: string } => {
    if (file.sha256 === undefined) throw new EvidenceIntegrityError(`Evidence file ${file.path} is not stored yet`);
    return file as T & { readonly sha256: string };
  };
  if (!progress.trajectory.done) throw new EvidenceIntegrityError("Evidence trajectory is not stored yet");
  const parts = progress.trajectory.parts;
  const body = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    source: { ...evidence.source, exportedAt: progress.exportedAt },
    artifacts: progress.artifacts.map((file): EvidenceArtifact => {
      const { path, size, mediaType, sha256 } = stored(file);
      return { path, size, mediaType, sha256 };
    }),
    subjectInputs: progress.subjectInputs.map((file) => {
      const { bundleId, materialId, path, mediaType, sha256, size } = stored(file);
      return { bundleId, materialId, path, mediaType, sha256, size };
    }),
    trajectory: {
      format: evidence.trajectoryFormat,
      ...(progress.trajectory.scope ? { scope: progress.trajectory.scope } : {}),
      ...(progress.trajectory.cursor ? { cursor: progress.trajectory.cursor } : {}),
      parts: [...parts],
      events: parts.reduce((count, part) => count + part.events, 0),
      complete: evidence.trajectoryComplete,
      ...(evidence.trajectoryIncompleteReason === undefined
        ? {} : { incompleteReason: evidence.trajectoryIncompleteReason }),
    },
    omitted: [...progress.omitted],
  } satisfies Omit<EvidenceManifest, "evidenceId">;
  const evidenceHex = await sha256Hex(canonicalJsonBytes(body));
  const manifest: EvidenceManifest = { ...body, evidenceId: `sha256:${evidenceHex}` };
  const bytes = canonicalJsonBytes(manifest);
  return {
    evidenceHex,
    bytes,
    ref: { evidenceId: manifest.evidenceId, manifestSha256: await sha256Hex(bytes), exportedAt: progress.exportedAt },
  };
}

export function createEvidenceStore(blobs: EvidenceBlobStore, now: () => string = () => new Date().toISOString()): EvidenceStore {
  return {
    async resume({ evidence, limits, progress: saved, onProgress }) {
      if (evidence.trajectoryFormat === PI_TRAJECTORY_FORMAT) {
        evalTrajectoryScopeSchema.parse(evidence.trajectoryScope);
        evalTrajectoryCursorSchema.parse(evidence.trajectoryCursor);
        if (saved && (!equalJson(saved.trajectory.scope, evidence.trajectoryScope) ||
          !equalJson(saved.trajectory.cursor, evidence.trajectoryCursor))) {
          throw new EvidenceIntegrityError("Native evidence scope or fixed cursor changed during resume");
        }
      }
      const persist = serialProgress(onProgress);
      let progress = saved ?? planEvidenceExport(evidence, limits, now());
      if (saved === undefined) await persist(progress);

      // Files: only those without a stored hash are read. Every started read settles before failing.
      const artifacts = [...progress.artifacts];
      const subjectInputs = [...progress.subjectInputs];
      const update = () => {
        progress = { ...progress, artifacts: [...artifacts], subjectInputs: [...subjectInputs] };
        return persist(progress);
      };
      const readers = new Map(evidence.subjectInputs.map((file) => [subjectInputKey(file), file]));
      const pending = [
        ...artifacts.flatMap((file, index) => file.sha256 === undefined ? [async () => {
          const { sha256, size } = await blobs.putBlob(await evidence.readFile(file.path), limits.maxFileBytes);
          if (size !== file.size) throw new EvidenceIntegrityError(`Evidence file ${file.path} size changed during export`);
          artifacts[index] = { ...file, sha256 };
          await update();
        }] : []),
        ...subjectInputs.flatMap((file, index) => file.sha256 === undefined ? [async () => {
          const reader = readers.get(subjectInputKey(file));
          if (!reader) throw new EvidenceIntegrityError(`Subject input ${file.path} is no longer exported`);
          const { sha256, size } = await blobs.putBlob(await reader.read(), limits.maxFileBytes);
          if (size !== file.size) throw new EvidenceIntegrityError(`Subject input ${file.path} size changed during export`);
          subjectInputs[index] = { ...file, sha256 };
          await update();
        }] : []),
      ];
      await runSettled(pending, UPLOAD_CONCURRENCY);

      if (!progress.trajectory.done) {
        const parts = [...progress.trajectory.parts];
        let afterSeq = progress.trajectory.afterSeq;
        const save = async (part: TrajectoryPartBuffer, done: boolean) => {
          if (part.chunks.length > 0) {
            const storedPart = await blobs.putBlob(new ReadableStream({
              start(controller) {
                for (const bytes of part.chunks) controller.enqueue(bytes);
                controller.close();
              },
            }), limits.maxFileBytes);
            parts.push({ ...storedPart, events: part.chunks.length });
            afterSeq = part.lastSeq;
          }
          progress = { ...progress, trajectory: { ...progress.trajectory, afterSeq, parts: [...parts], ...(done ? { done: true as const } : {}) } };
          await persist(progress);
        };
        for await (const part of trajectoryParts(evidence.readTrajectory(afterSeq), afterSeq, limits.maxFileBytes)) {
          await save(part, false);
        }
        await save({ chunks: [], size: 0, lastSeq: afterSeq }, true);
      }

      const manifest = await finalizeEvidenceManifest(evidence, progress);
      // Write-once: replaying a lost response writes the identical manifest under the same ID.
      await blobs.putManifest(manifest.evidenceHex, manifest.bytes);
      return manifest.ref;
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
      storedTrajectoryFormat(manifest.trajectory.format);
      if (manifest.trajectory.format === PI_TRAJECTORY_FORMAT) {
        if (!manifest.trajectory.scope || !manifest.trajectory.cursor) throw new EvidenceIntegrityError("Native evidence has no explicit scope or fixed cursor");
      }
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
    scope: evalTrajectoryScopeSchema.optional(),
    cursor: evalTrajectoryCursorSchema.optional(),
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

function subjectInputKey(file: { readonly bundleId: string; readonly materialId: string; readonly path: string }): string {
  return JSON.stringify([file.bundleId, file.materialId, file.path]);
}

interface TrajectoryPartBuffer {
  readonly chunks: readonly Uint8Array[];
  readonly size: number;
  /** Source cursor of the part's last event. */
  readonly lastSeq: number;
}

/**
 * Parts retain complete lines and order, with at most one file's bytes buffered. A part ends only
 * at an event boundary, so the same events after a part boundary always split the same way. An
 * event larger than one file can be neither split nor imported, so the export fails on it.
 */
async function* trajectoryParts(
  events: AsyncIterable<ExportedTrajectoryEvent>,
  afterSeq: number,
  maxBytes: number,
): AsyncGenerator<TrajectoryPartBuffer> {
  const encoder = new TextEncoder();
  let chunks: Uint8Array[] = [];
  let size = 0;
  let lastSeq = afterSeq;
  for await (const { seq, record } of events) {
    if (!Number.isSafeInteger(seq) || seq <= lastSeq) {
      throw new EvidenceIntegrityError("Exported trajectory events are out of order");
    }
    const bytes = encoder.encode(`${JSON.stringify(record)}\n`);
    if (bytes.byteLength > maxBytes) {
      throw new EvidenceIntegrityError(`Trajectory event ${seq} is ${bytes.byteLength} bytes, above the ${maxBytes}-byte evidence file limit`);
    }
    if (chunks.length > 0 && size + bytes.byteLength > maxBytes) {
      yield { chunks, size, lastSeq };
      chunks = [];
      size = 0;
    }
    chunks.push(bytes);
    size += bytes.byteLength;
    lastSeq = seq;
  }
  if (chunks.length > 0) yield { chunks, size, lastSeq };
}

/**
 * Hands progress to `onProgress` one call at a time. A caller waits until a write including its
 * progress has finished; progress queued behind a running write is coalesced into the next one.
 */
function serialProgress(
  onProgress: ((progress: EvidenceExportProgress) => Promise<void>) | undefined,
): (progress: EvidenceExportProgress) => Promise<void> {
  if (onProgress === undefined) return async () => undefined;
  let queued: EvidenceExportProgress | undefined;
  let chain: Promise<void> = Promise.resolve();
  return (progress) => {
    const scheduled = queued !== undefined;
    queued = progress;
    if (!scheduled) {
      chain = chain.then(async () => {
        const next = queued!;
        queued = undefined;
        await onProgress(next);
      });
    }
    return chain;
  };
}

/** Runs tasks with bounded concurrency; after a failure no new task starts, and every started one settles. */
async function runSettled(tasks: readonly (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (!failed && next < tasks.length) {
      const task = tasks[next++]!;
      try {
        await task();
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  }));
  if (failed) throw failure;
}
