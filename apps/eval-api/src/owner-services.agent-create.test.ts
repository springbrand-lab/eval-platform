import { describe, expect, it } from "vitest";
import { createOwnerServices } from "./owner-services.js";
import { createAgentImportSource } from "./agent-imports/source.js";
import { createAgentImportTarget } from "./agent-imports/target.js";
import type { EvalDb } from "./db/client.js";
import { agentConfigPurposes, resourceSources } from "./db/schema.js";
import { createEvalSpClient } from "./sp/client.js";
import type { BundleDirectory } from "./sp/bundle-directory.js";
import type { RunQueue } from "./run-worker-queue.js";

const owner = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const origin = "https://eval.test";
const writeOrigin = "https://eval-web.test";
const config = { id, user_id: owner, slug: "native", name: "Native", description: null, revision: 1, setting: { mcpServers: [] } };
const ok = (msg: unknown, headers: HeadersInit = {}) => Response.json({ success: true, msg, errMsg: "", code: "" }, { headers });

/** Actual owner-service composition and real public HTTP client; only the database driver and network are fake. */
function fixture(input: {
  source: boolean; header: "true" | "false" | null; existingOrigin?: "dev_import" | "eval_native";
  failPurpose?: boolean; failSource?: boolean;
}) {
  const nativeRows = new Map<string, Record<string, unknown>>();
  const purposeRows = new Map<string, Record<string, unknown>>();
  const inserts: { table: unknown; values: Record<string, unknown> }[] = [];
  const requests: Request[] = [];
  if (input.existingOrigin) nativeRows.set(id, { ownerUserId: owner, kind: "agent", id, origin: input.existingOrigin,
    connectionId: "dev-connection", sourceUserId: "source-user", sourceDigest: "source-digest", targetDigest: "target-digest", receipt: { id: "proof" } });
  const db = {
    insert(table: unknown) {
      return { values(values: Record<string, unknown>) {
        inserts.push({ table, values });
        return {
          async onConflictDoUpdate() {
            if (table !== agentConfigPurposes) throw new Error("Unexpected purpose write");
            if (input.failPurpose) throw new Error("purpose DB failure");
            purposeRows.set(String(values.userAgentId), values);
          },
          async onConflictDoNothing() {
            if (table !== resourceSources) throw new Error("Unexpected source write");
            if (input.failSource) throw new Error("source DB failure");
            if (!nativeRows.has(String(values.id))) nativeRows.set(String(values.id), values);
          },
        };
      } };
    },
    select() {
      return { from(table: unknown) {
        return { async where() {
          if (table === agentConfigPurposes) return [...purposeRows.values()];
          if (table === resourceSources) return [...nativeRows.values()];
          throw new Error("Unexpected query");
        } };
      } };
    },
  } as unknown as EvalDb;
  const fetch: typeof globalThis.fetch = async (inputUrl, init) => {
    const request = new Request(inputUrl, init);
    requests.push(request.clone());
    const url = new URL(request.url);
    if (url.origin !== origin) throw new Error("Unexpected source access");
    if (url.pathname === "/api/mcp-servers") return ok({ data: [], total: 0, page: 1, pageSize: 100 });
    if (url.pathname === "/api/agent-config-imports/config") return ok({ version: 1, enabled: false });
    if (url.pathname.includes("/imports")) return Response.json({ code: "AGENT_CONFIG_IMPORT_UNAVAILABLE", errMsg: "disabled" }, { status: 503 });
    if (url.pathname === "/api/user-agent-configs" && request.method === "POST") {
      return ok(config, input.header === null ? {} : { "X-Agent-Config-Created": input.header });
    }
    if (url.pathname === `/api/user-agent-configs/${id}` && request.method === "DELETE") return ok({ id });
    throw new Error(`Unexpected ${request.method} ${url.pathname}`);
  };
  const sp = createEvalSpClient({ origin, writeOrigin, fetch });
  const target = createAgentImportTarget({ origin, writeOrigin, ownerUserId: owner, sessionToken: "fixed-session", sp, fetch });
  const ownerServices = createOwnerServices({
    db, sp, agentImportTarget: target, bundles: {} as BundleDirectory,
    release: { sourceBranch: "sp/eval", sourceCommit: "a".repeat(40) }, runQueue: {} as RunQueue,
    ...(input.source ? { agentImports: {
      source: createAgentImportSource({ origin: "https://dev.test", targetOrigin: origin, token: "export-only", fetch }),
      queue: { enqueue: async () => { throw new Error("Ordinary create must not enqueue imports"); } },
    } } : {}),
  });
  const scope = ownerServices({ id: owner, role: "user" }, "fixed-session");
  return { ...scope, requests, inserts, nativeRows };
}

describe("ordinary Agent create in the real owner-service composition", () => {
  for (const source of [false, true]) {
    it.each(["true", "false", null] as const)(`source configured=${source}, insertion header=%s: ordinary POST works with target import disabled`, async (header) => {
      const f = fixture({ source, header });
      try {
        const body = { slug: "native", name: "Native", description: null, setting: { mcpServers: [] }, purpose: "execution" };
        const result = await f.services.agentConfigs.create(body);
        expect(result).toEqual(config);
        expect(Object.keys(result)).not.toContain("created");
        for (const privateField of ["origin", "sourceUserId", "connectionId", "receipt"]) expect(Object.keys(result)).not.toContain(privateField);
        expect(f.requests.some((request) => request.url.includes("/imports") || request.url.includes("agent-config-imports"))).toBe(false);
        const writes = f.requests.filter((request) => request.method !== "GET");
        expect(writes.map((request) => [request.method, new URL(request.url).pathname])).toEqual([["POST", "/api/user-agent-configs"]]);
        expect(await writes[0]!.json()).toEqual({ slug: "native", name: "Native", description: null, setting: { mcpServers: [] } });
        expect(writes[0]!.headers.get("Authorization")).toBe("Bearer fixed-session");
        expect(writes[0]!.headers.get("Origin")).toBe(writeOrigin);
        expect(f.nativeRows.get(id)?.origin).toBe(header === "true" ? "eval_native" : undefined);
        expect(f.inserts.filter((insert) => insert.table === resourceSources)).toHaveLength(header === "true" ? 1 : 0);
      } finally { f.release(); }
    });
  }

  it.each(["false", null] as const)("slug/race replay header=%s does not adopt an existing dev_import binding", async (header) => {
    const f = fixture({ source: true, header, existingOrigin: "dev_import" });
    const before = structuredClone(f.nativeRows.get(id));
    try {
      await expect(f.services.agentConfigs.create({ slug: "native", name: "Native", purpose: "execution" })).resolves.toEqual(config);
      expect(f.nativeRows.get(id)).toEqual(before);
      expect(f.inserts.filter((insert) => insert.table === resourceSources)).toHaveLength(0);
    } finally { f.release(); }
  });

  it.each(["true", "false", null] as const)("retains the ordinary purpose-failure DELETE compensation for header=%s", async (header) => {
    const f = fixture({ source: false, header, failPurpose: true });
    try {
      await expect(f.services.agentConfigs.create({ slug: "native", name: "Native", purpose: "execution" })).rejects.toThrow("purpose DB failure");
      expect(f.requests.filter((request) => request.method === "DELETE").map((request) => new URL(request.url).pathname))
        .toEqual([`/api/user-agent-configs/${id}`]);
      expect(f.requests.some((request) => request.url.includes("/imports"))).toBe(false);
    } finally { f.release(); }
  });

  it("retains ordinary compensation when proven native registration fails locally", async () => {
    const f = fixture({ source: true, header: "true", failSource: true });
    try {
      await expect(f.services.agentConfigs.create({ slug: "native", name: "Native", purpose: "execution" })).rejects.toThrow("source DB failure");
      expect(f.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
    } finally { f.release(); }
  });
});
