import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearVerificationCacheForTest, handle, type Env } from "../../worker/index";

// HTTP fixtures exercise real retry counts; deletion-retry.test.ts verifies actual timing.
vi.mock("@eval-platform/eval-contracts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@eval-platform/eval-contracts")>()),
  idempotentRetryBackoffMs: () => 0,
}));

const env: Env = {
  ASSETS: { fetch: async () => new Response("assets") },
  TAKT_ORIGIN: "https://takt.test", TAKT_EVAL_MENU_ID: "eval",
  EVAL_API_ORIGIN: "https://eval-api.test", EVAL_WEB_ORIGIN: "https://eval-web.test",
  EVAL_WEB_API_TOKEN: "fixture-key", FRAME_ANCESTORS: "https://takt.test",
};

const resources = [
  { name: "Project", path: "/api/projects/item", code: "PROJECT_NOT_FOUND",
    remove: async () => (await import("./projects-api")).deleteProject("item") },
  { name: "Dataset", path: "/api/datasets/item", code: "DATASET_NOT_FOUND",
    remove: async () => (await import("./datasets-api")).deleteDataset("item") },
  { name: "Data", path: "/api/data/item", code: "DATA_NOT_FOUND",
    remove: async () => (await import("./data-api")).deleteData("item") },
  { name: "Agent Config", path: "/api/agent-configs/item", readPath: "/api/agent-configs", code: "EVAL_SP_NOT_FOUND",
    remove: async () => (await import("./agent-configs-api")).deleteAgentConfig("item") },
  { name: "Output Schema", path: "/api/evaluation-output-schemas/item", code: "OUTPUT_SCHEMA_NOT_FOUND",
    remove: async () => (await import("./output-schemas-api")).deleteOutputSchema("item") },
  { name: "Material Bundle", path: "/api/material-bundles/item", code: "BUNDLE_RESOURCE_NOT_FOUND",
    remove: async () => (await import("./bundles-api")).materialBundles.delete("item") },
  { name: "Session Bundle", path: "/api/session-bundles/item", code: "BUNDLE_RESOURCE_NOT_FOUND",
    remove: async () => (await import("./bundles-api")).sessionBundles.delete("item") },
  { name: "Material", path: "/api/material-bundles/bundle/materials/item", code: "BUNDLE_RESOURCE_NOT_FOUND",
    remove: async () => (await import("./bundles-api")).materialBundles.deleteResource("bundle", "item") },
  { name: "Session", path: "/api/session-bundles/bundle/sessions/item", code: "BUNDLE_RESOURCE_NOT_FOUND",
    remove: async () => (await import("./bundles-api")).sessionBundles.deleteResource("bundle", "item") },
];

async function installApi(upstream: typeof fetch, loseDeleteResponse = true) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const response = await handle(request, env, upstream);
    if (request.method === "DELETE" && loseDeleteResponse) throw new TypeError("Connection closed after deletion");
    return response;
  }));
  (await import("@/auth/session")).resetAuthForTest({ status: "ready", token: "fixture-token" });
}

function authenticatedApi(handler: (url: string, init: RequestInit) => Promise<Response> | Response): typeof fetch {
  return async (input, init) => String(input).startsWith(env.TAKT_ORIGIN)
    ? Response.json({ user: { userId: "operator", access: { menuIds: ["eval"] } } })
    : handler(String(input), init!);
}

describe("deletion outcome confirmation", () => {
  beforeEach(() => { vi.resetModules(); clearVerificationCacheForTest(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); clearVerificationCacheForTest(); });

  it.each(resources)("$name confirms absence after a lost response without repeating DELETE", async (resource) => {
    const methods: string[] = [];
    const readPath = "readPath" in resource ? resource.readPath : resource.path;
    const upstream: typeof fetch = async (input, init) => {
      if (String(input).startsWith(env.TAKT_ORIGIN)) {
        return Response.json({ user: { userId: "operator", access: { menuIds: ["eval"] } } });
      }
      expect(String(input)).toBe(`${env.EVAL_API_ORIGIN}${init?.method === "DELETE" ? resource.path : readPath}`);
      methods.push(init!.method!);
      return init?.method === "DELETE" ? new Response(null, { status: 204 })
        : "readPath" in resource ? Response.json({ success: true, msg: [] })
          : Response.json({ code: resource.code, errMsg: "Resource not found" }, { status: 404 });
    };
    await installApi(upstream);

    await expect(resource.remove()).resolves.toBeUndefined();
    expect(methods).toEqual(["DELETE", "GET"]);
  });

  it("confirms a retained Agent Config from the active list after its deletion response is lost", async () => {
    const retained = { id: "item", user_id: "owner", name: "Deleted Agent", slug: "item" };
    const other = { ...retained, id: "other", name: "Other Agent", slug: "other" };
    const requests: string[] = [];
    let deleted = false;
    await installApi(authenticatedApi((url, init) => {
      const path = new URL(url).pathname;
      requests.push(`${init.method} ${path}`);
      if (init.method === "DELETE") {
        expect(path).toBe("/api/agent-configs/item");
        deleted = true;
        return new Response(null, { status: 204 });
      }
      if (path === "/api/agent-configs") {
        return Response.json({ success: true, msg: deleted ? [other] : [retained, other] });
      }
      expect(path).toBe("/api/agent-configs/item");
      return Response.json({ success: true, msg: retained });
    }));
    const { deleteAgentConfig, getAgentConfig } = await import("./agent-configs-api");

    await expect(deleteAgentConfig("item")).resolves.toBeUndefined();
    await expect(getAgentConfig("item")).resolves.toEqual(retained);
    expect(requests).toEqual([
      "DELETE /api/agent-configs/item",
      "GET /api/agent-configs",
      "GET /api/agent-configs/item",
    ]);
  });

  it("confirms an Agent Config once it disappears from a temporarily unavailable active list", async () => {
    const methods: string[] = [];
    let reads = 0;
    await installApi(authenticatedApi((url, init) => {
      methods.push(init.method!);
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      expect(url).toBe(`${env.EVAL_API_ORIGIN}/api/agent-configs`);
      reads += 1;
      if (reads === 1) return Response.json({ code: "EVAL_API_UNAVAILABLE", errMsg: "Unavailable" }, { status: 503 });
      return Response.json({ success: true, msg: reads === 2 ? [{ id: "item" }] : [] });
    }));
    const { deleteAgentConfig } = await import("./agent-configs-api");

    await expect(deleteAgentConfig("item")).resolves.toBeUndefined();
    expect(methods).toEqual(["DELETE", "GET", "GET", "GET"]);
  });

  it.each([null, {}, { data: [] }])("does not confirm an Agent Config from a malformed active list (%j)", async (body) => {
    const methods: string[] = [];
    await installApi(authenticatedApi((url, init) => {
      methods.push(init.method!);
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      expect(url).toBe(`${env.EVAL_API_ORIGIN}/api/agent-configs`);
      return Response.json({ success: true, msg: body });
    }));
    const { deleteAgentConfig } = await import("./agent-configs-api");

    await expect(deleteAgentConfig("item")).rejects.toMatchObject({
      code: "NETWORK_ERROR", context: { method: "DELETE" },
    });
    expect(methods).toEqual(["DELETE", "GET"]);
  });

  it.each(resources)("$name needs no confirmation after a normal successful deletion", async (resource) => {
    const methods: string[] = [];
    await installApi(authenticatedApi((url, init) => {
      expect(url).toBe(`${env.EVAL_API_ORIGIN}${resource.path}`);
      methods.push(init.method!);
      return new Response(null, { status: 204 });
    }), false);

    await expect(resource.remove()).resolves.toBeUndefined();
    expect(methods).toEqual(["DELETE"]);
  });

  it.each(resources)("$name preserves a known rejected deletion without confirmation", async (resource) => {
    const methods: string[] = [];
    await installApi(authenticatedApi((_url, init) => {
      methods.push(init.method!);
      return Response.json({ code: "REQUEST_VALIDATION_FAILED", errMsg: "Deletion rejected" }, { status: 422 });
    }), false);

    await expect(resource.remove()).rejects.toMatchObject({ code: "REQUEST_VALIDATION_FAILED", status: 422 });
    expect(methods).toEqual(["DELETE"]);
  });

  describe.each([
    { state: "present", status: 200, body: { success: true, msg: {} } },
    { state: "unrelated 404", status: 404, body: { code: "REQUEST_NOT_FOUND", errMsg: "Wrong endpoint" } },
    { state: "forbidden", status: 403, body: { code: "EVAL_ACCESS_DENIED", errMsg: "Access denied" } },
    { state: "unavailable", status: 503, body: { code: "EVAL_API_UNAVAILABLE", errMsg: "Unavailable" } },
  ])("verification is $state", ({ status, body }) => {
    it.each(resources)("$name keeps the original write error without replaying DELETE", async (resource) => {
      const methods: string[] = [];
      const readPath = "readPath" in resource ? resource.readPath : resource.path;
      await installApi(authenticatedApi((url, init) => {
        expect(url).toBe(`${env.EVAL_API_ORIGIN}${init.method === "DELETE" ? resource.path : readPath}`);
        methods.push(init.method!);
        const readBody = status === 200 && "readPath" in resource ? { success: true, msg: [{ id: "item" }] } : body;
        return init.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(readBody, { status });
      }));

      await expect(resource.remove()).rejects.toMatchObject({
        code: "NETWORK_ERROR", status: 0, context: { method: "DELETE" },
      });
      expect(methods).toEqual(["DELETE", ...Array(status === 200 || status === 503 ? 10 : 1).fill("GET")]);
    });
  });

  it.each([
    { remaining: [] }, { remaining: ["other"] }, { remaining: ["a"] },
    { remaining: ["b"] }, { remaining: ["a", "b"] },
  ])("confirms a batch detach only if every requested member is gone ($remaining)", async ({ remaining }) => {
    const methods: string[] = [];
    await installApi(authenticatedApi(async (url, init) => {
      expect(url).toBe(`${env.EVAL_API_ORIGIN}/api/datasets/dataset/data`);
      methods.push(init.method!);
      if (init.method === "DELETE") {
        expect(await new Response(init.body).json()).toEqual({ dataIds: ["a", "b"] });
        return new Response(null, { status: 204 });
      }
      return Response.json({ success: true, msg: remaining.map((dataId) => ({ dataId })) });
    }));
    const { detachData } = await import("./datasets-api");
    const result = detachData("dataset", ["a", "b"]);

    if (remaining.some((id) => id === "a" || id === "b")) {
      await expect(result).rejects.toMatchObject({ code: "NETWORK_ERROR", context: { method: "DELETE" } });
    } else {
      await expect(result).resolves.toBeUndefined();
    }
    const reads = remaining.some((id) => id === "a" || id === "b") ? 10 : 1;
    expect(methods).toEqual(["DELETE", ...Array(reads).fill("GET")]);
  });

  const editorResources = [
    { name: "Skill", path: "/api/agent-library/skills/item", readPath: "/api/agent-library/skills?view=selected&ids=item",
      missing: () => Response.json({ success: true, msg: { data: [{ id: "item", deleted: true }], total: 1 } }),
      remove: async () => (await import("./agent-editor-api")).agentEditorClient.skills.removeSkill("item") },
    { name: "Reference", path: "/api/agent-library/user-references/item", readPath: "/api/agent-library/user-references/item",
      missing: () => Response.json({ code: "EVAL_SP_NOT_FOUND", errMsg: "Reference not found" }, { status: 404 }),
      remove: async () => (await import("./agent-editor-api")).agentEditorClient.references.removeReference("item") },
  ];

  it.each(editorResources)("$name confirms deletion through its public read and preserves the editor result", async (resource) => {
    const methods: string[] = [];
    await installApi(authenticatedApi((url, init) => {
      methods.push(init.method!);
      expect(url).toBe(`${env.EVAL_API_ORIGIN}${init.method === "DELETE" ? resource.path : resource.readPath}`);
      return init.method === "DELETE" ? Response.json({ success: true, msg: { id: "item" } }) : resource.missing();
    }));

    await expect(resource.remove()).resolves.toEqual({ id: "item" });
    expect(methods).toEqual(["DELETE", "GET"]);
  });

  it.each(editorResources)("$name keeps the original successful response without another read", async (resource) => {
    const methods: string[] = [];
    await installApi(authenticatedApi((_url, init) => {
      methods.push(init.method!);
      return Response.json({ success: true, msg: { id: "item", original: true } });
    }), false);

    await expect(resource.remove()).resolves.toEqual({ id: "item", original: true });
    expect(methods).toEqual(["DELETE"]);
  });

  it.each([
    { data: [], total: 0 },
    { data: [], total: 100 },
    { data: [{ id: "item", available: false, deleted: false }], total: 1 },
    { data: [{ id: "other", deleted: true }], total: 1 },
  ])("does not confuse a missing page, unavailable or unrelated Skill with a deleted target (%j)", async (body) => {
    const methods: string[] = [];
    await installApi(authenticatedApi((_url, init) => {
      methods.push(init.method!);
      return init.method === "DELETE" ? Response.json({ success: true, msg: { id: "item" } })
        : Response.json({ success: true, msg: body });
    }));
    const { agentEditorClient } = await import("./agent-editor-api");

    await expect(agentEditorClient.skills.removeSkill("item")).rejects.toMatchObject({
      code: "NETWORK_ERROR", context: { method: "DELETE" },
    });
    expect(methods).toEqual(["DELETE", ...Array(10).fill("GET")]);
  });

  it("does not confuse a disabled Reference with a deleted Reference", async () => {
    const methods: string[] = [];
    await installApi(authenticatedApi((_url, init) => {
      methods.push(init.method!);
      return Response.json({ success: true, msg: { id: "item", status: "disabled" } });
    }));
    const { agentEditorClient } = await import("./agent-editor-api");

    await expect(agentEditorClient.references.removeReference("item")).rejects.toMatchObject({
      code: "NETWORK_ERROR", context: { method: "DELETE" },
    });
    expect(methods).toEqual(["DELETE", ...Array(10).fill("GET")]);
  });

  it("does not confirm an empty batch from an empty membership list", async () => {
    await installApi(authenticatedApi((_url, init) => init.method === "DELETE"
      ? new Response(null, { status: 204 }) : Response.json({ success: true, msg: [] })));
    const { detachData } = await import("./datasets-api");

    await expect(detachData("dataset", [])).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("does not turn a programming error into successful deletion", async () => {
    const { deleteWithConfirmation } = await import("./delete-confirmation");
    const error = new TypeError("Unexpected caller failure");
    const confirm = vi.fn().mockResolvedValue(true);

    await expect(deleteWithConfirmation(async () => { throw error; }, confirm)).rejects.toBe(error);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not confirm or replay a cancelled deletion", async () => {
    await installApi(authenticatedApi(() => new Response(null, { status: 204 })), false);
    const { api } = await import("./client");
    const { deleteWithConfirmation } = await import("./delete-confirmation");
    const confirm = vi.fn().mockResolvedValue(true);
    const remove = vi.fn(() => api.delete("/api/data/item", { signal: AbortSignal.abort() }));

    await expect(deleteWithConfirmation(remove, confirm)).rejects.toBeInstanceOf(Error);
    expect(remove).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
  });
});
