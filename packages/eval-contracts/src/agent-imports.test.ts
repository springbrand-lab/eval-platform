import { describe, expect, it } from "vitest";
import {
  agentImportApplySchema, agentImportPreviewSchema, agentImportSourceUserPageSchema, agentImportTaskViewSchema,
  type AgentImportCandidatePage, type AgentImportConfig, type AgentImportSourceUser, type AgentImportSourceUserPage,
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

  it("exports an exact bounded source-user page with an explicit continuation cursor", () => {
    const user = { id, name: "Source", email: "source@example.test" };
    const page: AgentImportSourceUserPage = { users: [user], nextCursor: "opaque-source-cursor" };
    expect(agentImportSourceUserPageSchema.parse(page)).toEqual(page);
    expect(agentImportSourceUserPageSchema.parse({ users: [], nextCursor: null })).toEqual({ users: [], nextCursor: null });
    expect(agentImportSourceUserPageSchema.parse({ users: [], nextCursor: "more" })).toEqual({ users: [], nextCursor: "more" });
    expect(agentImportSourceUserPageSchema.parse({ users: Array(20).fill(user), nextCursor: "more" }).users).toHaveLength(20);
    for (const invalid of [
      [user], { users: [user] }, { users: [], nextCursor: 1 }, { users: Array(21).fill(user), nextCursor: null },
      { users: page, nextCursor: null }, { ...page, token: "secret" }, { ...page, users: [{ ...user, ownerUserId: id }] },
    ]) expect(agentImportSourceUserPageSchema.safeParse(invalid).success).toBe(false);
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

  it("accepts the official source account while retaining one required owner and UUID Agent IDs", () => {
    const sourceUserId = "springbrand-official";
    expect(agentImportSourceUserPageSchema.safeParse({
      users: [{ id: sourceUserId, name: "SpringBrand", email: "official@example.test", official: true }], nextCursor: null,
    }).success).toBe(true);
    const request = { sourceUserId, agentIds: [id], purpose: "execution", idempotencyKey: "official-preview" };
    expect(agentImportPreviewSchema.safeParse(request).success).toBe(true);
    expect(agentImportPreviewSchema.safeParse({ ...request, sourceUserId: undefined }).success).toBe(false);
    expect(agentImportPreviewSchema.safeParse({ ...request, agentIds: [sourceUserId] }).success).toBe(false);
    for (const invalid of ["", " ", ".", "..", "a/b", "a\\b", "a?b", "a#b", "a\nb", "https://attacker.example", "x".repeat(201)]) {
      expect(agentImportPreviewSchema.safeParse({ ...request, sourceUserId: invalid }).success).toBe(false);
    }
  });

  it("describes durable progress, partial failures and unknown outcomes", () => {
    const view = {
      id, status: "outcome_unknown", sourceUserId: id, purpose: "evaluation",
      agents: [{ id, name: "Agent", status: "outcome_unknown", message: "Awaiting receipt", skillCount: 1, referenceCount: 2 }],
      progress: { stage: "receipts", completed: 2, total: 4, bytesRead: 100, totalBytes: 100 },
      summary: { created: 0, skipped: 0, failed: 1, conflicts: 0 }, expiresAt: "2026-10-22T00:00:00.000Z",
    };
    expect(agentImportTaskViewSchema.parse(view)).toEqual(view);
    expect(agentImportTaskViewSchema.parse({ ...view, sourceUserId: "springbrand-official" }).sourceUserId).toBe("springbrand-official");
    expect(agentImportTaskViewSchema.safeParse({ ...view, sourceUserId: null }).success).toBe(false);
    expect(agentImportTaskViewSchema.safeParse({ ...view, origin: "dev_import" }).success).toBe(false);
  });

  it.each(["oidc|MixedCase:42", id.toUpperCase()])("preserves opaque source identity %s without relaxing Agent IDs or choosing another target", (sourceUserId) => {
    const user = { id: sourceUserId, name: "Legacy user", email: "" };
    expect(agentImportSourceUserPageSchema.parse({ users: [user], nextCursor: null }).users).toEqual([user]);
    const request = { sourceUserId, agentIds: [id], purpose: "execution", idempotencyKey: "legacy-preview" };
    expect(agentImportPreviewSchema.parse(request)).toEqual(request);
    expect(agentImportPreviewSchema.safeParse({ ...request, agentIds: ["oidc|MixedCase:42"] }).success).toBe(false);
    expect(agentImportPreviewSchema.safeParse({ ...request, targetOwner: sourceUserId }).success).toBe(false);
  });
});
