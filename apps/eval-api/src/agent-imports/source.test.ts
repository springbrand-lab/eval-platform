import { describe, expect, it, vi } from "vitest";
import { createAgentImportSource } from "./source.js";
import { ImportDependencyError } from "./errors.js";
import { canonicalSourceSettingFixture } from "./public-wire.test-support.js";

const user = "11111111-1111-4111-8111-111111111111";
const agent = "22222222-2222-4222-8222-222222222222";
const envelope = (msg: unknown) => Response.json({ success: true, msg, code: "", errMsg: "" });

describe("approved read-only export seam", () => {
  it.each(["springbrand-official", "oidc|MixedCase:42"])("reads and safely encodes source account %s without changing its identity", async (official) => {
    const calls: string[] = [];
    const source = createAgentImportSource({ origin: "https://dev.test", targetOrigin: "https://eval.test", token: "export",
      fetch: async (input) => {
        const path = new URL(new Request(input).url).pathname;
        calls.push(path);
        if (path.endsWith("/users")) return envelope({
          users: [{ id: official, name: "Source", email: "source@example.test", official: official === "springbrand-official" }], nextCursor: null,
        });
        if (path.endsWith("/agents")) return envelope({ items: [], nextCursor: null });
        return envelope({ version: 1, sourceUserId: official, agents: [{
          id: agent, name: "Official Agent", description: null, slug: "official-agent", revision: 1,
          setting: canonicalSourceSettingFixture(),
        }], skills: [], references: [] });
      } });
    expect((await source.users({})).users[0]).toMatchObject({ id: official, official: official === "springbrand-official" });
    await expect(source.agents(official, {})).resolves.toEqual({ items: [], nextCursor: null });
    await expect(source.snapshot(official, [agent])).resolves.toMatchObject({ sourceUserId: official });
    expect(calls).toEqual([
      "/api/agent-config-export/users",
      `/api/agent-config-export/users/${encodeURIComponent(official)}/agents`,
      `/api/agent-config-export/users/${encodeURIComponent(official)}/snapshot`,
    ]);
  });

  it("exposes only three scoped GETs and never shares a target session or write Origin", async () => {
    const calls: Request[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/users")) return envelope({
        users: [{ id: user, name: "User", email: "u@example.test" }], nextCursor: null,
      });
      if (path.endsWith("/agents")) return envelope({ items: [], nextCursor: "next-page" });
      return envelope({ version: 1, sourceUserId: user, agents: [{
        id: agent, name: "Agent", description: null, slug: "agent", revision: 1, setting: canonicalSourceSettingFixture(),
      }], skills: [], references: [] });
    });
    const source = createAgentImportSource({ origin: "https://dev.test", targetOrigin: "https://eval.test", token: "export-only", fetch });
    await expect(source.users({ q: "user", limit: 20 })).resolves.toEqual({
      users: [{ id: user, name: "User", email: "u@example.test" }], nextCursor: null,
    });
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

  it("browses complete source-user pages without a query and forwards 4096-character opaque cursors for later users", async () => {
    const cursor = "opaque+source/cursor==".padEnd(4096, "x");
    const calls: Request[] = [];
    const source = createAgentImportSource({ origin: "https://dev.test", targetOrigin: "https://eval.test", token: "export",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        calls.push(request);
        return envelope(new URL(request.url).searchParams.get("cursor") === cursor
          ? { users: [{ id: agent, name: "Later User", email: "later@example.test" }], nextCursor: null }
          : { users: [{ id: user, name: "User", email: "u@example.test" }], nextCursor: cursor });
      } });
    await expect(source.users({})).resolves.toEqual({
      users: [{ id: user, name: "User", email: "u@example.test" }], nextCursor: cursor,
    });
    await expect(source.users({ cursor, limit: 1 })).resolves.toEqual({
      users: [{ id: agent, name: "Later User", email: "later@example.test" }], nextCursor: null,
    });
    expect(new URL(calls[0]!.url).searchParams.get("limit")).toBe("20");
    expect(new URL(calls[1]!.url).searchParams.get("cursor")).toBe(cursor);
    expect(new URL(calls[1]!.url).searchParams.get("limit")).toBe("1");
    expect(calls.every((request) => request.method === "GET")).toBe(true);
  });

  it.each([
    { limit: 0 }, { limit: 21 }, { limit: 1.5 }, { cursor: "" }, { cursor: "x".repeat(4097) }, { q: "x".repeat(201) },
  ])("rejects invalid source-user query bounds before making an export request %#", async (query) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => envelope({ users: [], nextCursor: null }));
    const source = createAgentImportSource({ origin: "https://dev.test", targetOrigin: "https://eval.test", token: "export", fetch });
    await expect(source.users(query)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [{}, ""], [{ q: "" }, ""], [{ q: "  \t " }, ""], [{ q: "  User  " }, "User"],
  ] as const)("keeps optional source-user search compatible with no-typing browsing %#", async (query, expected) => {
    const calls: Request[] = [];
    const source = createAgentImportSource({ origin: "https://dev.test", targetOrigin: "https://eval.test", token: "export",
      fetch: async (input, init) => {
        calls.push(new Request(input, init));
        return envelope({ users: [], nextCursor: null });
      } });
    await source.users(query);
    expect(new URL(calls[0]!.url).searchParams.get("q")).toBe(expected);
  });

  it.each([401, 403, 404, 503])("translates export HTTP %i to a dependency failure, not login invalidation", async (status) => {
    const source = createAgentImportSource({ origin: "https://dev.test", targetOrigin: "https://eval.test", token: "export",
      fetch: async () => Response.json({ success: false, code: "NOT_FOUND", errMsg: "upstream" }, { status }) });
    await expect(source.agents(user, {})).rejects.toBeInstanceOf(ImportDependencyError);
    await expect(source.users({})).rejects.toMatchObject({ code: "EVAL_SP_UNAVAILABLE", status: 503, cause: { status } });
  });

  it.each([
    { users: [] }, { users: [], nextCursor: 1 }, { users: Array(21).fill({ id: user, name: "User", email: "u@example.test" }), nextCursor: null },
    { users: [], nextCursor: null, token: "not-public" }, { users: { users: [], nextCursor: null }, nextCursor: null },
  ])("rejects malformed source-user pages as dependency failures rather than truncating or dropping cursors %#", async (page) => {
    const source = createAgentImportSource({ origin: "https://dev.test", targetOrigin: "https://eval.test", token: "export",
      fetch: async () => envelope(page) });
    await expect(source.users({})).rejects.toBeInstanceOf(ImportDependencyError);
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
