import { z } from "zod";

/** Control-plane contract only. No source credentials, internal provenance or target-owner input. */
export const AGENT_IMPORT_MAX_AGENTS = 50;
const id = z.uuid().transform((value) => value.toLowerCase());
export const agentImportSourceUserIdSchema = z.string().min(1).max(200).regex(/^[^\s/\\?#\u0000-\u001f\u007f]+$/u)
  .refine((value) => value !== "." && value !== "..", "Invalid source account");
const count = z.number().int().nonnegative();
const purpose = z.enum(["execution", "evaluation"]);
const idempotencyKey = z.string().min(1).max(200).refine(
  (value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value), "Invalid idempotency key",
);

export const agentImportConfigSchema = z.strictObject({
  enabled: z.boolean(), maxAgents: z.number().int().positive(),
});
export const agentImportSourceUserSchema = z.strictObject({
  id: agentImportSourceUserIdSchema, name: z.string(), email: z.string(), official: z.boolean().optional(),
});
export const agentImportSourceUserPageSchema = z.strictObject({
  users: z.array(agentImportSourceUserSchema).max(20), nextCursor: z.string().nullable(),
});
export const agentImportCandidateSchema = z.strictObject({
  id, name: z.string(), description: z.string(), revision: count,
  skillCount: count, referenceCount: count, exists: z.boolean(),
});
export const agentImportCandidatePageSchema = z.strictObject({
  items: z.array(agentImportCandidateSchema), nextCursor: z.string().nullable(),
});
export const agentImportPreviewSchema = z.strictObject({
  sourceUserId: agentImportSourceUserIdSchema,
  agentIds: z.array(id).min(1).max(AGENT_IMPORT_MAX_AGENTS).refine(
    (ids) => new Set(ids).size === ids.length, "Duplicate Agent IDs are not allowed",
  ),
  purpose,
  idempotencyKey,
});
export const agentImportApplySchema = z.strictObject({ idempotencyKey });
export const agentImportTaskViewSchema = z.strictObject({
  id,
  // Automatic reconciliation remains importing; task-level outcome_unknown requires manual recovery.
  status: z.enum([
    "checking", "ready", "queued", "importing", "completed", "completed_with_errors", "failed", "outcome_unknown",
  ]),
  sourceUserId: agentImportSourceUserIdSchema,
  purpose,
  agents: z.array(z.strictObject({
    id, name: z.string(),
    status: z.enum(["pending", "ready", "created", "overwritten", "skipped", "conflict", "failed", "outcome_unknown"]),
    overwrite: z.boolean().optional(),
    message: z.string().optional(), skillCount: count, referenceCount: count,
  })),
  progress: z.strictObject({
    stage: z.string(), completed: count, total: count, bytesRead: count, totalBytes: count,
  }),
  summary: z.strictObject({ created: count, overwritten: count.optional(), skipped: count, failed: count, conflicts: count }),
  error: z.string().optional(),
  expiresAt: z.iso.datetime().optional(),
});

export type AgentImportConfig = z.infer<typeof agentImportConfigSchema>;
export type AgentImportSourceUser = z.infer<typeof agentImportSourceUserSchema>;
export type AgentImportSourceUserPage = z.infer<typeof agentImportSourceUserPageSchema>;
export type AgentImportCandidate = z.infer<typeof agentImportCandidateSchema>;
export type AgentImportCandidatePage = z.infer<typeof agentImportCandidatePageSchema>;
export type AgentImportPreview = z.infer<typeof agentImportPreviewSchema>;
export type AgentImportApply = z.infer<typeof agentImportApplySchema>;
export type AgentImportTaskView = z.infer<typeof agentImportTaskViewSchema>;
