import { describe, expect, it, vi } from "vitest";
import { createAgentImportSource } from "./source.js";
import { ImportDependencyError } from "./errors.js";
import { canonicalSourceSettingFixture } from "./public-wire.test-support.js";

const user = "11111111-1111-4111-8111-111111111111";
const agent = "22222222-2222-4222-8222-222222222222";
const envelope = (msg: unknown) => Response.json({ success: true, msg, code: "", errMsg: "" });

describe("approved read-only export seam", () => {
  it("exposes only three scoped GETs and never shares a target session or write Origin", async () => {
    const calls: Request[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/users")) return envelope({ users: [{ id: user, name: "User", email: "u@example.test" }] });
      if (path.endsWith("/agents")) return envelope({ items: [], nextCursor: "next-page" });
      return envelope({ version: 1, sourceUserId: user, agents: [{
        id: agent, name: "Agent", description: null, slug: "agent", revision: 1, setting: canonicalSourceSettingFixture(),
      }], skills: [], references: [] });
    });
    const source = createAgentImportSource({ origin: "https://dev.test", targetOrigin: "https://eval.test", token: "export-only", fetch });
    await expect(source.users({ q: "user", limit: 20 })).resolves.toHaveLength(1);
    await expect(source.agents(user, { cursor: "old", q: "a", limit: 10 })).resolves.toMatchObject({ nextCursor: "next-page" });
    await source.snapshot(user, [agent]);
    expect(calls.map((r) => new URL(r.url).pathname)).toEqual([
      "/api/agent-config-export/users", `/api/agent-config-export/users/${user}/agents`, `/api/agent-config-export/users/${user}/snapshot`,
    ]);
    expect(new URL(calls[1]!.url).searchParams.get("cursor")).toBe("old");
    expect(Object.keys(source).sort()).toEqual(["agents", "connectionId", "origin", "snapshot", "users"]);
    for (const request of calls) {
      expect(request.method).toBe("GET");
      expect(request.headers.get("Authorization")).toBe("Bearer export-only");
      expect(request.headers.has("Origin")).toBe(false);
    }
  });

  it.each([401, 403, 404, 503])("translates export HTTP %i to a dependency failure, not login invalidation", async (status) => {
    const source = createAgentImportSource({ origin: "https://dev.test", targetOrigin: "https://eval.test", token: "export",
      fetch: async () => Response.json({ success: false, code: "NOT_FOUND", errMsg: "upstream" }, { status }) });
    await expect(source.agents(user, {})).rejects.toBeInstanceOf(ImportDependencyError);
  });

  it("rejects wrong source owner or a substituted selected set", async () => {
    const source = createAgentImportSource({ origin: "https://dev.test", targetOrigin: "https://eval.test", token: "export",
      fetch: async () => envelope({ version: 1, sourceUserId: agent, agents: [], skills: [], references: [] }) });
    await expect(source.snapshot(user, [agent])).rejects.toBeInstanceOf(ImportDependencyError);
    expect(() => createAgentImportSource({ origin: "https://dev.test", targetOrigin: "https://dev.test", token: "export" })).toThrow();
  });

  it("projects optional missing dependency evidence to an empty list only, never to target-derived versions", async () => {
    const source = createAgentImportSource({ origin: "https://dev.test", targetOrigin: "https://eval.test", token: "export",
      fetch: async () => envelope({ version: 1, sourceUserId: user, agents: [{
        id: agent, name: "Agent", description: null, slug: "agent", revision: 1,
        setting: { presetId: null, referenceFileIds: [], actionIds: [], connectorIds: [], extensionIds: [] },
      }], skills: [], references: [] }) });
    expect((await source.snapshot(user, [agent])).dependencies).toEqual([]);
  });

  it.each([
    { kind: "action", id: "outside-selected-roots", fingerprint: "a".repeat(64) },
    { kind: "connector", id: "selected-action", fingerprint: "a".repeat(64) },
    { kind: "action", id: "selected-action", fingerprint: "A".repeat(64) },
    { kind: "action", id: "selected-action", fingerprint: `${"a".repeat(64)}\n` },
    { kind: "action", id: "selected-action", fingerprint: "a".repeat(64), credentials: { apiKey: "must-not-be-carried" } },
  ])("rejects out-of-scope, wrong-kind, malformed or credential-bearing source proof %#", async (proof) => {
    const calls: Request[] = [];
    const source = createAgentImportSource({ origin: "https://dev.test", targetOrigin: "https://eval.test", token: "export",
      fetch: async (input, init) => {
        calls.push(new Request(input, init));
        return envelope({ version: 1, sourceUserId: user, agents: [{
          id: agent, name: "Agent", description: null, slug: "agent", revision: 1,
          setting: { presetId: null, referenceFileIds: [], actionIds: ["selected-action"], connectorIds: [], extensionIds: [] },
        }], skills: [], references: [], dependencies: [proof] });
      } });
    await expect(source.snapshot(user, [agent])).rejects.toBeInstanceOf(ImportDependencyError);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
  });
});
