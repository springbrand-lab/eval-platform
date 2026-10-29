import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { EVAL_INITIAL_FILE_MAX_BYTES, EVAL_SESSION_CONTENT_MAX_CHARS } from "@springbrand/eval-harness";
import { z } from "zod";
import type { ImportStaging } from "../agent-imports/bytes.js";
import { safeImportPath } from "../agent-imports/bytes.js";
import { ImportConflictError } from "../agent-imports/errors.js";
import { IMPORT_LIMITS, uuid } from "../agent-imports/model.js";
import { PROMPT_DATASET_FILE_BYTES } from "../limits.js";
import type { ManagementStore, UploadKind, UploadReceipt } from "./store.js";

const hash = z.string().regex(/^[0-9a-f]{64}$/u);
export const uploadMetadataSchema = z.strictObject({
  kind: z.enum(["prompt", "material", "session", "skill", "reference"]),
  name: z.string().min(1).max(240).refine((value) => {
    try {
      return value.trim().length > 0 && value === value.trim()
        && !value.includes("/") && safeImportPath(value) === value;
    } catch { return false; }
  }, "The uploaded name must be a filename, not a path"),
  mediaType: z.string().min(3).max(200).regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu),
  byteSize: z.number().int().positive().max(IMPORT_LIMITS.fileBytes),
  sha256: hash,
}).superRefine(({ kind, byteSize, mediaType }, ctx) => {
  const max = kind === "prompt" ? PROMPT_DATASET_FILE_BYTES
    : kind === "material" ? EVAL_INITIAL_FILE_MAX_BYTES
      : kind === "session" ? EVAL_SESSION_CONTENT_MAX_CHARS * 4 : IMPORT_LIMITS.fileBytes;
  if (byteSize > max) ctx.addIssue({ code: "custom", message: "The upload exceeds its resource limit" });
  if (kind === "skill" && mediaType !== "application/zip") {
    ctx.addIssue({ code: "custom", message: "Skills require a ZIP archive" });
  }
});
export type UploadMetadata = z.output<typeof uploadMetadataSchema>;
export interface UploadRecoveryReceipt extends UploadMetadata {
  readonly uploadRef: string;
  readonly expiresAt: string;
}

export interface ManagementFiles {
  ingest(owner: string, metadata: UploadMetadata, body: ReadableStream<Uint8Array>, uploadId?: string): Promise<{
    uploadRef: string; byteSize: number; sha256: string; expiresAt: string;
  }>;
  /** Read-only recovery of one READY, unexpired owner receipt after verifying its staged bytes. */
  recover(owner: string, uploadId: string): Promise<UploadRecoveryReceipt>;
  info(owner: string, ref: string, kind: UploadKind): Promise<UploadReceipt>;
  read(owner: string, ref: string, kind: UploadKind): Promise<Uint8Array>;
}

const notAvailable = () => new HttpError("REQUEST_INVALID_INPUT", "The upload reference is unavailable, expired or the wrong kind");
const notRecoverable = () => new HttpError("REQUEST_NOT_FOUND", "The upload receipt is unavailable");
const stagedFile = (row: UploadReceipt) => ({
  path: "upload", url: "", size: row.byteSize, sha256: row.sha256,
});

export function createManagementFiles(store: ManagementStore, staging: ImportStaging): ManagementFiles {
  const files: ManagementFiles = {
    async ingest(owner, metadata, body, uploadId) {
      const { kind, name, mediaType, byteSize, sha256 } = uploadMetadataSchema.parse(metadata);
      // Absent for legacy clients. A supplied UUID is correlation, not permission
      // to retry a POST: the DB reservation must be new before writing any bytes.
      const uploadRef = uploadId === undefined ? crypto.randomUUID() : uuid.parse(uploadId);
      await staging.prune();
      const expiresAt = new Date(Date.now() + IMPORT_LIMITS.ttlMs);
      await store.reserveUpload(owner, uploadRef, { kind, name, mediaType, byteSize, sha256, expiresAt });
      try {
        const saved = await staging.write(uploadRef, { path: "upload", url: "", size: byteSize }, body,
          expiresAt.toISOString());
        if (saved.sha256 !== sha256) throw new HttpError("REQUEST_INVALID_INPUT", "Uploaded bytes do not match the declared SHA-256");
        await store.readyUpload(owner, uploadRef);
        return { uploadRef, byteSize, sha256, expiresAt: expiresAt.toISOString() };
      } catch (cause) {
        await store.releaseUpload(owner, uploadRef).catch(() => {});
        if (cause instanceof HttpError) throw cause;
        if (cause instanceof ImportConflictError) {
          throw new HttpError("REQUEST_INVALID_INPUT", "The bounded upload was invalid or staging is full", { cause });
        }
        throw cause;
      }
    },
    async recover(owner, uploadId) {
      const row = await store.upload(owner, uploadId);
      if (!row || row.ownerUserId !== owner || row.uploadId !== uploadId || row.status !== "ready"
        || !(row.expiresAt.getTime() > Date.now())
        || !uploadMetadataSchema.safeParse({
          kind: row.kind, name: row.name, mediaType: row.mediaType, byteSize: row.byteSize, sha256: row.sha256,
        }).success) throw notRecoverable();
      // ImportStaging.read() writes an expiry file (and could create a directory).
      // A receipt GET must instead only check the existing hashed file, without
      // returning its contents or fabricating a fresh staging entry.
      try {
        await staging.verify(uploadId, stagedFile(row), row.expiresAt.toISOString());
      } catch {
        throw notRecoverable();
      }
      if (!(row.expiresAt.getTime() > Date.now())) throw notRecoverable();
      return {
        uploadRef: row.uploadId, kind: row.kind, name: row.name, mediaType: row.mediaType,
        byteSize: row.byteSize, sha256: row.sha256, expiresAt: row.expiresAt.toISOString(),
      };
    },
    async info(owner, ref, kind) {
      const row = await store.upload(owner, ref);
      if (!row || row.kind !== kind) throw notAvailable();
      return row;
    },
    async read(owner, ref, kind) {
      const row = await files.info(owner, ref, kind);
      if (row.expiresAt.getTime() <= Date.now()) throw notAvailable();
      try {
        return await staging.read(ref, stagedFile(row), row.expiresAt.toISOString());
      } catch (cause) {
        throw new HttpError("BUNDLE_FILE_UNAVAILABLE", "Staged bytes could not be verified", { cause });
      }
    },
  };
  return files;
}
