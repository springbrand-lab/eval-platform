import { describe, expect, it, vi } from "vitest";
import { BundleResourceNotFoundError } from "../db/errors.js";
import { OWNER, setupManagement, toolValue } from "./test-fixture.js";

const encode = (text: string) => new TextEncoder().encode(text);
const session = `${JSON.stringify({
  id: "m1", message: { role: "user", content: "Private earlier context", timestamp: 1 }, createdAt: 1,
})}\n`;

async function errorCode(response: Response) {
  const rpc = await response.json() as { result: { isError?: boolean; content: [{ text: string }] } };
  expect(rpc.result.isError).toBe(true);
  return rpc.result.content[0].text;
}

function fixture() {
  const app = setupManagement();
  type Saved = {
    bundle: { bundleId: string; name: string; description: string };
    resource: { bundleId: string; name: string; description: string; byteSize?: number;
      format?: "json" | "jsonl"; materialId?: string; sessionId?: string };
    bytes: Uint8Array; mediaType: string; deleted?: boolean;
  };
  const materials = new Map<string, Saved>(), sessions = new Map<string, Saved>();
  const notFound = (kind: ConstructorParameters<typeof BundleResourceNotFoundError>[0], id: string) =>
    new BundleResourceNotFoundError(kind, id);
  const list = (records: Map<string, Saved>) => [...records.values()].filter((row) => !row.deleted);
  const createMaterial = vi.fn(async (labels: { name: string; description: string },
    inputs: Array<{ files: Array<{ mediaType: string; contentBase64: string }> }>,
    identity: { bundleId: string; resourceIds: string[] }) => {
    if (materials.has(identity.bundleId)) throw Error("A second Material would be created");
    const file = inputs[0]!.files[0]!;
    const bytes = Buffer.from(file.contentBase64, "base64");
    materials.set(identity.bundleId, { bundle: { bundleId: identity.bundleId, ...labels },
      resource: { bundleId: identity.bundleId, materialId: identity.resourceIds[0]!, ...labels, byteSize: bytes.length },
      bytes, mediaType: file.mediaType });
    return {};
  });
  const createSession = vi.fn(async (labels: { name: string; description: string },
    inputs: Array<{ format: "json" | "jsonl"; content: string }>,
    identity: { bundleId: string; resourceIds: string[] }) => {
    if (sessions.has(identity.bundleId)) throw Error("A second Session would be created");
    sessions.set(identity.bundleId, { bundle: { bundleId: identity.bundleId, ...labels },
      resource: { bundleId: identity.bundleId, sessionId: identity.resourceIds[0]!, ...labels,
        format: inputs[0]!.format }, bytes: encode(inputs[0]!.content), mediaType: "application/x-ndjson" });
    return {};
  });
  Object.assign(app.services, {
    materialBundles: {
      create: createMaterial,
      list: async () => list(materials).map((row) => row.bundle),
      get: async (id: string) => {
        const row = materials.get(id);
        if (!row || row.deleted) throw notFound("Material Bundle", id);
        return row.bundle;
      },
      listResources: async (id: string) => {
        const row = materials.get(id);
        if (!row || row.deleted) throw notFound("Material Bundle", id);
        return [row.resource];
      },
      getResource: async (id: string, child: string) => {
        const row = materials.get(id);
        if (!row || row.deleted || row.resource.materialId !== child) throw notFound("Material", child);
        return row.resource;
      },
      listFiles: async (id: string, child: string) => {
        const row = materials.get(id);
        if (!row || row.deleted || row.resource.materialId !== child) throw notFound("Material", child);
        return [{ path: `/${row.bundle.name}`, mediaType: row.mediaType, byteSize: row.bytes.length }];
      },
      getFile: async (id: string, child: string, path: string) => {
        const row = materials.get(id);
        if (!row || row.deleted || row.resource.materialId !== child || path !== `/${row.bundle.name}`) {
          throw notFound("Material", child);
        }
        return { mediaType: row.mediaType, bytes: row.bytes };
      },
    },
    sessionBundles: {
      create: createSession,
      list: async () => list(sessions).map((row) => row.bundle),
      get: async (id: string) => {
        const row = sessions.get(id);
        if (!row || row.deleted) throw notFound("Session Bundle", id);
        return row.bundle;
      },
      listResources: async (id: string) => {
        const row = sessions.get(id);
        if (!row || row.deleted) throw notFound("Session Bundle", id);
        return [row.resource];
      },
      getResource: async (id: string, child: string) => {
        const row = sessions.get(id);
        if (!row || row.deleted || row.resource.sessionId !== child) throw notFound("Session", child);
        return row.resource;
      },
      listFiles: async (id: string, child: string) => {
        const row = sessions.get(id);
        if (!row || row.deleted || row.resource.sessionId !== child) throw notFound("Session", child);
        return [{ path: `/context.${row.resource.format}`, mediaType: row.mediaType, byteSize: row.bytes.length }];
      },
      getFile: async (id: string, child: string, path: string) => {
        const row = sessions.get(id);
        if (!row || row.deleted || row.resource.sessionId !== child || path !== `/context.${row.resource.format}`) {
          throw notFound("Session", child);
        }
        return { bytes: row.bytes };
      },
    },
  });
  return { app, materials, sessions, createMaterial, createSession };
}

describe("independent, owner-scoped initial resource save", () => {
  it("returns only exact Material/Session IDs after a confirmed write, with stage and active list choices", async () => {
    const { app, createMaterial, createSession } = fixture();
    const materialRef = app.managed.addUpload("material", "private.txt", encode("never in a tool result"), "text/plain");
    const contextRef = app.managed.addUpload("session", "context.jsonl", encode(session), "application/x-ndjson");
    const materialInput = { operationKey: "material-1", kind: "material", uploadRef: materialRef };
    const sessionInput = { operationKey: "session-1", kind: "session", uploadRef: contextRef, format: "jsonl" };
    const material = await toolValue(await app.call("save_initial_resource", materialInput));
    const context = await toolValue(await app.call("save_initial_resource", sessionInput));
    expect(material).toEqual({ operationKey: "material-1", kind: "initial_resource",
      resourceKind: "material", status: "completed", bundleId: expect.any(String), materialId: expect.any(String) });
    expect(context).toEqual({ operationKey: "session-1", kind: "initial_resource",
      resourceKind: "session", status: "completed", bundleId: expect.any(String), sessionId: expect.any(String) });
    for (const [key, identity] of [["material-1", material], ["session-1", context]] as const) {
      expect(await toolValue(await app.call("get_preparation", { operationKey: key })))
        .toEqual({ ...identity, stage: "confirmed" });
    }
    expect(await toolValue(await app.call("list_options", { category: "material_bundles" })))
      .toMatchObject({ total: 1, items: [{ bundleId: material.bundleId }] });
    expect(await toolValue(await app.call("list_options", { category: "session_bundles" })))
      .toMatchObject({ total: 1, items: [{ bundleId: context.bundleId }] });
    expect(await toolValue(await app.call("list_options", { category: "material_files",
      bundleId: material.bundleId, materialId: material.materialId }))).toMatchObject({ total: 1 });
    expect(await toolValue(await app.call("list_options", { category: "session_files",
      bundleId: context.bundleId, sessionId: context.sessionId }))).toMatchObject({ total: 1 });
    expect(await toolValue(await app.call("save_initial_resource", materialInput))).toEqual(material);
    expect(await toolValue(await app.call("save_initial_resource", sessionInput))).toEqual(context);
    expect(createMaterial).toHaveBeenCalledOnce();
    expect(createSession).toHaveBeenCalledOnce();
    expect(JSON.stringify([material, context])).not.toMatch(/never in a tool result|Private earlier context|uploadRef|format|https?:\/\//u);
    expect(app.services.datasets.listDatasets).not.toHaveBeenCalled();
  });

  it("recovers a lost Material commit reply by the original planned IDs and stored bytes, never a second write", async () => {
    const { app, createMaterial } = fixture();
    const uploadRef = app.managed.addUpload("material", "lost.txt", encode("opaque committed bytes"), "text/plain");
    const input = { operationKey: "lost-save", kind: "material", uploadRef };
    const read = vi.spyOn(app.managed.files, "read");
    const commit = createMaterial.getMockImplementation()!;
    createMaterial.mockImplementationOnce(async (...args) => {
      await commit(...args);
      throw new Error("catalog committed but reply was lost");
    });
    expect(await errorCode(await app.call("save_initial_resource", input))).toContain("INTERNAL_ERROR");
    const pending = await toolValue(await app.call("get_preparation", { operationKey: input.operationKey }));
    expect(pending).toEqual({ operationKey: input.operationKey, kind: "initial_resource",
      resourceKind: "material", status: "outcome_unknown", stage: "attempted",
      bundleId: expect.any(String), materialId: expect.any(String) });
    expect(await errorCode(await app.call("save_initial_resource", { ...input, operationKey: "new-key" })))
      .toContain("EVAL_SP_CONFLICT");
    expect(app.managed.operations.has("new-key")).toBe(false);
    const reads = read.mock.calls.length;
    app.managed.uploads.set(uploadRef, { ...app.managed.uploads.get(uploadRef)!, expiresAt: new Date(0) });
    const recovered = await toolValue(await app.call("save_initial_resource", input));
    expect(recovered).toEqual({ operationKey: input.operationKey, kind: "initial_resource",
      resourceKind: "material", status: "completed",
      bundleId: pending.bundleId, materialId: pending.materialId });
    expect(await toolValue(await app.call("get_preparation", { operationKey: input.operationKey })))
      .toEqual({ ...recovered, stage: "confirmed" });
    expect(read).toHaveBeenCalledTimes(reads); // same-key recovery never reopens expired staging bytes
    expect(createMaterial).toHaveBeenCalledOnce();
    expect(await errorCode(await app.call("save_initial_resource", {
      ...input, kind: "session", format: "jsonl",
    }))).toContain("EVAL_SP_CONFLICT");
  });

  it("keeps a missing attempted write outcome_unknown and never reissues it under the same or another key", async () => {
    const { app, createMaterial } = fixture();
    const uploadRef = app.managed.addUpload("material", "unknown.txt", encode("maybe committed"), "text/plain");
    const input = { operationKey: "unknown-save", kind: "material", uploadRef };
    createMaterial.mockRejectedValueOnce(new Error("connection closed during the write"));
    expect(await errorCode(await app.call("save_initial_resource", input))).toContain("INTERNAL_ERROR");
    const pending = await toolValue(await app.call("get_preparation", { operationKey: input.operationKey }));
    expect(pending).toMatchObject({ status: "outcome_unknown", stage: "attempted",
      bundleId: expect.any(String), materialId: expect.any(String) });
    expect(await errorCode(await app.call("save_initial_resource", input))).toContain("OPERATION_OUTCOME_UNKNOWN");
    expect(await errorCode(await app.call("save_initial_resource", { ...input, operationKey: "unknown-new-key" })))
      .toContain("EVAL_SP_CONFLICT");
    expect(createMaterial).toHaveBeenCalledOnce();
    expect(await toolValue(await app.call("get_preparation", { operationKey: input.operationKey })))
      .toEqual(pending);
  });

  it("fences an identical concurrent key while its first catalog write is still in flight", async () => {
    const { app, createMaterial } = fixture();
    const uploadRef = app.managed.addUpload("material", "race.txt", encode("one write"), "text/plain");
    const input = { operationKey: "concurrent-save", kind: "material", uploadRef };
    let release!: () => void;
    let writing!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { writing = resolve; });
    const create = createMaterial.getMockImplementation()!;
    createMaterial.mockImplementationOnce(async (...args) => {
      writing();
      await hold;
      return create(...args);
    });
    const first = app.call("save_initial_resource", input);
    await started;
    expect(await errorCode(await app.call("save_initial_resource", input))).toContain("OPERATION_OUTCOME_UNKNOWN");
    release();
    const completed = await toolValue(await first);
    expect(completed.status).toBe("completed");
    expect(await toolValue(await app.call("save_initial_resource", input))).toEqual(completed);
    expect(createMaterial).toHaveBeenCalledOnce();
  });

  it("refuses to confirm an attempted write if its planned resource bytes no longer match the staged digest", async () => {
    const { app, createMaterial, materials } = fixture();
    const uploadRef = app.managed.addUpload("material", "tampered.txt", encode("original bytes"), "text/plain");
    const input = { operationKey: "tampered-save", kind: "material", uploadRef };
    const commit = createMaterial.getMockImplementation()!;
    createMaterial.mockImplementationOnce(async (...args) => {
      await commit(...args);
      throw Error("reply lost");
    });
    await app.call("save_initial_resource", input);
    const pending = await toolValue(await app.call("get_preparation", { operationKey: input.operationKey }));
    materials.get(pending.bundleId as string)!.bytes = encode("changed bytes");
    expect(await errorCode(await app.call("save_initial_resource", input))).toContain("EVAL_SP_CONFLICT");
    expect(await toolValue(await app.call("get_preparation", { operationKey: input.operationKey })))
      .toEqual(pending);
    expect(createMaterial).toHaveBeenCalledOnce();
  });

  it("accepts Pi-native JSON Session content with the required format, independent of any Dataset", async () => {
    const { app, createSession } = fixture();
    const bytes = encode(JSON.stringify({ entries: [{
      id: "m1", message: { role: "user", content: "Private JSON history", timestamp: 1 }, createdAt: 1,
    }] }));
    const uploadRef = app.managed.addUpload("session", "context.json", bytes, "application/json");
    const saved = await toolValue(await app.call("save_initial_resource", {
      operationKey: "json-session", kind: "session", uploadRef, format: "json",
    }));
    expect(saved).toEqual({ operationKey: "json-session", kind: "initial_resource",
      resourceKind: "session", status: "completed", bundleId: expect.any(String), sessionId: expect.any(String) });
    expect(createSession).toHaveBeenCalledOnce();
    expect(JSON.stringify(saved)).not.toContain("Private JSON history");
  });

  it("reports pending and confirmed-but-unfinalized stages without falsely completing", async () => {
    const { app, createSession } = fixture();
    const uploadRef = app.managed.addUpload("session", "state.jsonl", encode(session), "application/x-ndjson");
    const input = { operationKey: "stage-state", kind: "session", uploadRef, format: "jsonl" };
    vi.spyOn(app.managed.store, "attempt").mockRejectedValueOnce(new Error("interrupted before write-ahead attempt"));
    expect(await errorCode(await app.call("save_initial_resource", input))).toContain("INTERNAL_ERROR");
    expect(await toolValue(await app.call("get_preparation", { operationKey: input.operationKey })))
      .toMatchObject({ resourceKind: "session", status: "preparing", stage: "pending",
        bundleId: expect.any(String), sessionId: expect.any(String) });
    expect(createSession).not.toHaveBeenCalled();
    vi.spyOn(app.managed.store, "complete").mockRejectedValueOnce(new Error("reply lost before finalization"));
    expect(await errorCode(await app.call("save_initial_resource", input))).toContain("INTERNAL_ERROR");
    expect(await toolValue(await app.call("get_preparation", { operationKey: input.operationKey })))
      .toMatchObject({ status: "finalizing", stage: "confirmed" });
    const result = await toolValue(await app.call("save_initial_resource", input));
    expect(result).toMatchObject({ status: "completed", resourceKind: "session" });
    expect(createSession).toHaveBeenCalledOnce();
  });

  it("cannot finalize a confirmed stage if its planned resource was soft-deleted before finalization", async () => {
    const { app, materials, createMaterial } = fixture();
    const uploadRef = app.managed.addUpload("material", "between.txt", encode("not yet finalized"), "text/plain");
    const input = { operationKey: "delete-between", kind: "material", uploadRef };
    vi.spyOn(app.managed.store, "complete").mockRejectedValueOnce(Error("finalization interrupted"));
    await app.call("save_initial_resource", input);
    const pending = await toolValue(await app.call("get_preparation", { operationKey: input.operationKey }));
    expect(pending).toMatchObject({ status: "finalizing", stage: "confirmed" });
    materials.get(pending.bundleId as string)!.deleted = true;
    expect(await errorCode(await app.call("save_initial_resource", input))).toContain("BUNDLE_RESOURCE_NOT_FOUND");
    expect(await toolValue(await app.call("get_preparation", { operationKey: input.operationKey })))
      .toEqual(pending);
    expect(createMaterial).toHaveBeenCalledOnce();
  });

  it("rejects wrong kinds, format mistakes, invalid staged bytes and expired refs before any Bundle write", async () => {
    const { app, createMaterial, createSession } = fixture();
    const materialRef = app.managed.addUpload("material", "file.txt", encode("valid"), "text/plain");
    const contextRef = app.managed.addUpload("session", "bad.jsonl", encode("not a Pi Session"), "application/x-ndjson");
    for (const input of [
      { operationKey: "wrong-kind", kind: "material", uploadRef: contextRef },
      { operationKey: "material-format", kind: "material", uploadRef: materialRef, format: "json" },
      { operationKey: "missing-session-format", kind: "session", uploadRef: contextRef },
      { operationKey: "unknown-ref", kind: "material", uploadRef: crypto.randomUUID() },
      { operationKey: "unsafe-url", kind: "material", uploadRef: "https://file.invalid" },
      { operationKey: "inline", kind: "material", uploadRef: materialRef, bytes: "private" },
    ]) expect(await errorCode(await app.call("save_initial_resource", input))).toContain("REQUEST_INVALID_INPUT");
    expect(await errorCode(await app.call("save_initial_resource", {
      operationKey: "bad-session", kind: "session", uploadRef: contextRef, format: "jsonl",
    }))).toMatch(/BUNDLE_FILE_INVALID|REQUEST_INVALID_INPUT/u);
    app.managed.uploads.set(materialRef, { ...app.managed.uploads.get(materialRef)!, expiresAt: new Date(0) });
    expect(await errorCode(await app.call("save_initial_resource", {
      operationKey: "expired", kind: "material", uploadRef: materialRef,
    }))).toContain("REQUEST_INVALID_INPUT");
    expect(app.managed.operations.size).toBe(0);
    expect(createMaterial).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("keeps a historical confirmed receipt but hides soft-deleted resources and refuses to replay them as active", async () => {
    const { app, materials, createMaterial } = fixture();
    const uploadRef = app.managed.addUpload("material", "deleted.txt", encode("owned bytes"), "text/plain");
    const input = { operationKey: "deleted-save", kind: "material", uploadRef };
    const saved = await toolValue(await app.call("save_initial_resource", input));
    materials.get(saved.bundleId as string)!.deleted = true;
    expect(await toolValue(await app.call("list_options", { category: "material_bundles" })))
      .toMatchObject({ total: 0, items: [] });
    expect(await errorCode(await app.call("list_options", { category: "materials", bundleId: saved.bundleId })))
      .toContain("BUNDLE_RESOURCE_NOT_FOUND");
    expect(await toolValue(await app.call("get_preparation", { operationKey: input.operationKey })))
      .toEqual({ ...saved, stage: "confirmed" }); // historical, not active catalog selection
    expect(await errorCode(await app.call("save_initial_resource", input))).toContain("BUNDLE_RESOURCE_NOT_FOUND");
    expect(createMaterial).toHaveBeenCalledOnce();
    expect(await app.managed.store.get("foreign-owner", input.operationKey)).toBeNull();
    await expect(app.managed.files.info("foreign-owner", uploadRef, "material")).rejects.toThrow();
    expect((await app.managed.store.get(OWNER, input.operationKey))?.status).toBe("completed");
  });
});
