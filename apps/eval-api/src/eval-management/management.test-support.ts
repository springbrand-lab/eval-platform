import { createHash } from "node:crypto";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { ManagementFiles } from "./files.js";
import type { ManagementStore, OperationReceipt, UploadKind, UploadReceipt } from "./store.js";

export function fakeManagement(owner: string) {
  const operations = new Map<string, OperationReceipt>();
  const uploads = new Map<string, UploadReceipt>();
  const bodies = new Map<string, Uint8Array>();
  const unavailable = () => new HttpError("REQUEST_INVALID_INPUT", "Upload reference unavailable");
  const conflict = () => new HttpError("EVAL_SP_CONFLICT", "Operation conflict");
  const saved = (ownerId: string, key: string) => {
    if (ownerId !== owner) throw conflict();
    const row = operations.get(key);
    if (!row) throw conflict();
    return row;
  };
  const store: ManagementStore = {
    async reserveUpload(ownerId, uploadId, meta) {
      if (ownerId !== owner) throw conflict();
      if (uploads.has(uploadId)) throw conflict();
      uploads.set(uploadId, { ownerUserId: owner, uploadId, ...meta, status: "reserved", claimedBy: null, createdAt: new Date() });
    },
    async releaseUpload(_ownerId, uploadId) { uploads.delete(uploadId); },
    async readyUpload(_ownerId, uploadId) { uploads.set(uploadId, { ...uploads.get(uploadId)!, status: "ready" }); },
    async upload(ownerId, uploadId) {
      const row = uploads.get(uploadId);
      return ownerId === owner && row?.status === "ready" ? row : null;
    },
    async begin(ownerId, key, kind, fingerprint, plan, skillName) {
      if (ownerId !== owner) throw conflict();
      let row = operations.get(key);
      const claimedSkillName = kind === "skill" ? skillName ?? null : null;
      if (row && (row.kind !== kind || row.fingerprint !== fingerprint
        || row.skillName !== claimedSkillName
        || JSON.stringify(row.plan) !== JSON.stringify(plan))) throw conflict();
      if (kind === "skill" && [...operations.values()].some((other) =>
        other.operationKey !== key && other.kind === kind && other.skillName === claimedSkillName
          && other.status !== "completed")) throw conflict();
      if (kind === "bind" && [...operations.values()].some((other) =>
        other.operationKey !== key && other.kind === "bind" && other.status === "pending"
          && other.plan.dataId === plan.dataId)) throw conflict();
      const refs = kind === "prepare"
        ? [plan.promptUploadRef, ...(plan.assets as Array<{ uploadRef: string }>).map((asset) => asset.uploadRef)]
        : kind === "bind" ? (plan.assets as Array<{ uploadRef: string }>).map((asset) => asset.uploadRef)
        : kind === "output_schema" ? [] : [plan.uploadRef];
      for (const ref of refs) {
        const upload = uploads.get(ref as string);
        if (!upload || upload.claimedBy && upload.claimedBy !== key) throw conflict();
      }
      for (const ref of refs) uploads.set(ref as string, { ...uploads.get(ref as string)!, claimedBy: key });
      row ??= {
        ownerUserId: owner, operationKey: key, kind, fingerprint, plan, stages: {},
        status: "pending", skillName: claimedSkillName, createdAt: new Date(),
      };
      operations.set(key, row);
      return row;
    },
    async get(ownerId, key) { return ownerId === owner ? operations.get(key) ?? null : null; },
    async attempt(ownerId, key, stage) {
      const row = saved(ownerId, key);
      const previous = row.stages[stage];
      if (previous?.status === "confirmed") return { status: "confirmed", receipt: previous.receipt };
      if (previous) return { status: "attempted" };
      operations.set(key, { ...row, stages: { ...row.stages, [stage]: { status: "attempted" } } });
      return { status: "started" };
    },
    async confirm(ownerId, key, stage, receipt) {
      const row = saved(ownerId, key);
      if (row.stages[stage]?.status !== "attempted") throw conflict();
      operations.set(key, { ...row, stages: { ...row.stages, [stage]: { status: "confirmed", receipt } } });
    },
    async complete(ownerId, key) {
      const row = saved(ownerId, key);
      if (row.kind === "bind" && (row.plan.version !== 2 || !Array.isArray(row.plan.assets)
        || typeof row.plan.dataId !== "string" || Array.isArray(row.plan.dataIds))) throw conflict();
      const required = row.kind === "skill" ? ["skill"] : row.kind === "reference" ? ["attachment", "reference"]
        : row.kind === "output_schema" ? ["output_schema"]
          : [...(row.kind === "prepare" ? ["dataset"] : []),
            ...(row.plan.assets as Array<{ uploadRef: string }>).map((asset) => `resource:${asset.uploadRef}`),
            ...(row.kind === "bind" ? [`data:${row.plan.dataId}`] : (row.plan.dataIds as string[]).map((id) => `data:${id}`))];
      if (required.some((stage) => row.stages[stage]?.status !== "confirmed")) throw conflict();
      operations.set(key, { ...row, status: "completed" });
    },
    async assertReadyDatasets(ownerId, ids) {
      if (ownerId !== owner || [...operations.values()].some((row) =>
        (row.kind === "prepare" || row.kind === "bind")
        && row.status === "pending" && ids.includes(row.plan.datasetId as string))) throw conflict();
    },
    async listDatasetData() {
      throw new HttpError("DATASET_NOT_FOUND");
    },
  };
  const files: ManagementFiles = {
    async ingest(ownerId, metadata, body, uploadId) {
      if (ownerId !== owner) throw conflict();
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      if (bytes.byteLength !== metadata.byteSize || createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) throw unavailable();
      const ref = addUpload(metadata.kind, metadata.name, bytes, metadata.mediaType, uploadId);
      return { uploadRef: ref, byteSize: metadata.byteSize, sha256: metadata.sha256,
        expiresAt: uploads.get(ref)!.expiresAt.toISOString() };
    },
    async recover(ownerId, uploadId) {
      const row = await store.upload(ownerId, uploadId);
      const bytes = bodies.get(uploadId);
      if (!row || !bytes || row.expiresAt.getTime() <= Date.now() || bytes.byteLength !== row.byteSize
        || createHash("sha256").update(bytes).digest("hex") !== row.sha256) {
        throw new HttpError("REQUEST_NOT_FOUND", "Upload receipt unavailable");
      }
      return { uploadRef: row.uploadId, kind: row.kind, name: row.name, mediaType: row.mediaType,
        byteSize: row.byteSize, sha256: row.sha256, expiresAt: row.expiresAt.toISOString() };
    },
    async info(ownerId, ref, kind) {
      const row = await store.upload(ownerId, ref);
      if (!row || row.kind !== kind) throw unavailable();
      return row;
    },
    async read(ownerId, ref, kind) {
      const row = await files.info(ownerId, ref, kind);
      if (row.expiresAt.getTime() <= Date.now()) throw unavailable();
      return bodies.get(ref)!;
    },
  };
  function addUpload(kind: UploadKind, name: string, bytes: Uint8Array,
    mediaType = kind === "skill" ? "application/zip" : "application/octet-stream", suppliedId?: string): string {
    const uploadId = suppliedId ?? crypto.randomUUID();
    if (uploads.has(uploadId)) throw conflict();
    bodies.set(uploadId, bytes);
    uploads.set(uploadId, {
      ownerUserId: owner, uploadId, kind, name, mediaType, byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"), status: "ready", claimedBy: null,
      createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    });
    return uploadId;
  }
  return { store, files, addUpload, uploads, operations };
}
