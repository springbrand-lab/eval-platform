import { createHash } from "node:crypto";
import { canonicalJsonBytes, type AgentImportPreview, type AgentImportTaskView } from "@eval-platform/eval-contracts";
import { z } from "zod";
import { jsonObjectSchema } from "@eval-platform/eval-contracts";
import { DEFINITION_PROBE_LIMIT, definitionEvidenceSchema, type DefinitionEvidence } from "./definition-evidence.js";

export const IMPORT_LIMITS = {
  agents: 50, files: 1_000, fileBytes: 20 * 1024 * 1024, totalBytes: 200 * 1024 * 1024,
  stagingBytes: 2 * 1024 * 1024 * 1024, ttlMs: 24 * 60 * 60 * 1000, leaseMs: 5 * 60 * 1000,
} as const;
export const IMPORT_VERSION = 1;
export const uuid = z.uuid().transform((value) => value.toLowerCase());
export const skillId = z.string().min(1).max(255).refine((value) =>
  value === value.trim() && !/[\u0000-\u001f\u007f,]/u.test(value));
const size = z.number().int().nonnegative();
export const exportFileSchema = z.strictObject({ path: z.string().min(1).max(240), size, url: z.url() });
export const sourceAgentSchema = z.strictObject({
  id: uuid, name: z.string().min(1).max(200), description: z.string().max(2000).nullable(),
  slug: z.string().min(1).max(100), revision: z.number().int().positive(), setting: jsonObjectSchema,
});
export const sourceSkillSchema = z.strictObject({
  id: skillId, name: z.string().min(1).max(120), kind: z.enum(["platform", "user"]),
  contentHash: z.string().nullable(), files: z.array(exportFileSchema).min(1).max(IMPORT_LIMITS.files),
});
export const sourceReferenceSchema = z.strictObject({
  id: uuid, name: z.string().min(1).max(255), mediaType: z.string().min(1).max(200),
  size, status: z.enum(["active", "disabled"]), url: z.url(),
});
export const sourceSnapshotSchema = z.strictObject({
  version: z.literal(1), sourceUserId: uuid,
  agents: z.array(sourceAgentSchema).max(IMPORT_LIMITS.agents),
  skills: z.array(sourceSkillSchema).max(IMPORT_LIMITS.files),
  references: z.array(sourceReferenceSchema).max(IMPORT_LIMITS.files),
  dependencies: z.array(definitionEvidenceSchema).max(DEFINITION_PROBE_LIMIT).default([]),
});
export const receiptSchema = z.object({
  id: uuid, resourceKind: z.enum(["agent", "skill", "reference"]), resourceId: z.string().min(1).max(255),
  importKey: z.string().min(1).max(200), fingerprint: z.string().min(1).max(256), createdAt: z.iso.datetime(),
});
export type ResourceKind = "agent" | "skill" | "reference";
export type ImportReceipt = z.infer<typeof receiptSchema>;
export type SourceAgent = z.infer<typeof sourceAgentSchema>;
export type SourceSkill = z.infer<typeof sourceSkillSchema>;
export type SourceReference = z.infer<typeof sourceReferenceSchema>;
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;
export type ExportFile = z.infer<typeof exportFileSchema>;
export interface FrozenFile extends ExportFile { sha256: string }
/** Read-only target preflight facts; derived from the frozen snapshot, never a second persisted resource state. */
export const plannedImportResourcesSchema = z.strictObject({
  skills: z.array(sourceSkillSchema.pick({ id: true, name: true }).readonly()).max(256).readonly(),
  references: z.array(sourceReferenceSchema.pick({ id: true, size: true }).readonly()).max(256).readonly(),
}).readonly();
export type PlannedImportResources = z.infer<typeof plannedImportResourcesSchema>;
export interface PreparedAgent {
  config: { id: string; slug: string; name: string; description: string | null; setting: Record<string, unknown> };
  purpose: "execution" | "evaluation";
  evaluationMcpServerId: string | null;
  dependencies: DefinitionEvidence[];
}
export interface PlannedResource {
  kind: ResourceKind;
  id: string;
  name: string;
  sourceDigest: string;
  targetDigest: string;
  importKey: string;
  files: FrozenFile[];
  source: SourceSkill | SourceReference | SourceAgent;
  prepared?: PreparedAgent;
  overwrite?: boolean;
  platform?: boolean;
  error?: string;
}
export interface ImportPlan {
  version: 1 | 2;
  snapshot: SourceSnapshot;
  resources: PlannedResource[];
  eligibleAgentIds: string[];
  digest: string;
}
export interface ImportTask {
  id: string;
  ownerUserId: string;
  actorId: string | null;
  connectionId: string;
  request: AgentImportPreview;
  fingerprint: string;
  view: AgentImportTaskView;
  snapshot: SourceSnapshot | null;
  plan: ImportPlan | null;
  expiresAt: string;
  applyKey: string | null;
  leaseToken: string | null;
  revision: number;
  attempts: number;
}
export interface ResourceSource {
  ownerUserId: string;
  kind: ResourceKind;
  id: string;
  origin: "eval_native" | "dev_import" | "platform_catalog";
  connectionId: string | null;
  sourceUserId: string | null;
  sourceDigest: string | null;
  targetDigest: string | null;
  receipt: ImportReceipt | null;
}
export interface ImportIntent extends Omit<PlannedResource, "source" | "files" | "prepared" | "platform" | "error"> {
  ownerUserId: string;
  connectionId: string;
  sourceUserId: string;
  status: "planned" | "submitting" | "confirmed" | "completed" | "conflict" | "outcome_unknown";
  receipt: ImportReceipt | null;
  attachment: {
    attachmentCdnUrl: string; clientAttachmentId: string; name: string; mediaType: string; size: number;
  } | null;
}
export interface ImportResult { receipt: ImportReceipt; replayed: boolean; resource: Record<string, unknown> }
export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");
}
export function connectionId(origin: string): string { return `sp-export-v1:${digest(origin)}`; }
export function resourceKey(kind: ResourceKind, id: string): string { return `${kind}:${id}`; }
export function initialView(id: string, request: AgentImportPreview, expiresAt: string): AgentImportTaskView {
  return {
    id, status: "checking", sourceUserId: request.sourceUserId, purpose: request.purpose, expiresAt,
    agents: request.agentIds.map((id) => ({ id, name: id, status: "pending", skillCount: 0, referenceCount: 0 })),
    progress: { stage: "checking", completed: 0, total: request.agentIds.length, bytesRead: 0, totalBytes: 0 },
    summary: { created: 0, overwritten: 0, skipped: 0, failed: 0, conflicts: 0 },
  };
}
export function summarize(view: AgentImportTaskView): AgentImportTaskView {
  return { ...view, summary: {
    created: view.agents.filter((item) => item.status === "created").length,
    overwritten: view.agents.filter((item) => item.status === "overwritten").length,
    skipped: view.agents.filter((item) => item.status === "skipped").length,
    failed: view.agents.filter((item) => item.status === "failed" || item.status === "outcome_unknown").length,
    conflicts: view.agents.filter((item) => item.status === "conflict").length,
  } };
}
