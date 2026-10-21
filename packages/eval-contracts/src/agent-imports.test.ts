import { describe, expect, it } from "vitest";
import {
  agentImportApplySchema, agentImportPreviewSchema, agentImportTaskViewSchema,
  type AgentImportCandidatePage, type AgentImportConfig, type AgentImportSourceUser,
} from "./index.js";

const id = "c16bcc47-a03b-4b22-a276-bb6177c229b1";

describe("Agent import public contract", () => {
  it("exports the frozen frontend DTOs without provenance or credentials", () => {
    const config: AgentImportConfig = { enabled: false, maxAgents: 50 };
    const user: AgentImportSourceUser = { id, name: "Source", email: "source@example.test" };
    const page: AgentImportCandidatePage = { items: [{
      id, name: "Agent", description: "", revision: 1, skillCount: 1, referenceCount: 0, exists: false,
    }], nextCursor: null };
    expect({ config, user, page }).toMatchObject({ config: { enabled: false }, page: { nextCursor: null } });
  });

  it("binds one source user, ordered unique UUIDs, purpose and an idempotency key", () => {
    const body = { sourceUserId: id, agentIds: [id], purpose: "execution", idempotencyKey: "preview-1" };
    expect(agentImportPreviewSchema.parse(body)).toEqual(body);
    for (const change of [
      { agentIds: [] }, { agentIds: [id, id] }, { agentIds: Array(51).fill(id) },
      { purpose: "dev_import" }, { origin: "https://evil.test" }, { targetOwner: id }, { token: "secret" },
    ]) expect(agentImportPreviewSchema.safeParse({ ...body, ...change }).success).toBe(false);
    expect(agentImportApplySchema.safeParse({ idempotencyKey: "apply-1", sourceUserId: id }).success).toBe(false);
  });

  it("describes durable progress, partial failures and unknown outcomes", () => {
    const view = {
      id, status: "outcome_unknown", sourceUserId: id, purpose: "evaluation",
      agents: [{ id, name: "Agent", status: "outcome_unknown", message: "Awaiting receipt", skillCount: 1, referenceCount: 2 }],
      progress: { stage: "receipts", completed: 2, total: 4, bytesRead: 100, totalBytes: 100 },
      summary: { created: 0, skipped: 0, failed: 1, conflicts: 0 }, expiresAt: "2026-10-22T00:00:00.000Z",
    };
    expect(agentImportTaskViewSchema.parse(view)).toEqual(view);
    expect(agentImportTaskViewSchema.safeParse({ ...view, origin: "dev_import" }).success).toBe(false);
  });
});
