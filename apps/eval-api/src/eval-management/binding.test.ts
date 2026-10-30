import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { Data, InitialMaterialsRef } from "@eval-platform/eval-dataset";
import { digestJson } from "@eval-platform/eval-runtime";
import { EVAL_INITIAL_FILE_MAX_BYTES, EVAL_INITIALIZATION_MAX_BYTES } from "@springbrand/eval-harness";
import { describe, expect, it, vi } from "vitest";
import { BundleResourceNotFoundError } from "../db/errors.js";
import { patchedInitialResources, type DataInitialResourcePatch } from "../initial-resources.js";
import { DATASET, OWNER, setupManagement, toolValue } from "./test-fixture.js";

const DATA_ID = "55555555-5555-4555-8555-555555555555";
const EXISTING_BUNDLE = "77777777-7777-4777-8777-777777777777";
const EXISTING_MATERIAL = "88888888-8888-4888-8888-888888888888";
const OLD = { bundleId: EXISTING_BUNDLE, materialId: EXISTING_MATERIAL };
const encode = (text: string) => new TextEncoder().encode(text);
const session = `${JSON.stringify({
  id: "m1", message: { role: "user", content: "Earlier private context", timestamp: 1 }, createdAt: 1,
})}\n`;

async function errorCode(response: Response) {
  const rpc = await response.json() as { result: { isError?: boolean; content: [{ text: string }] } };
  expect(rpc.result.isError).toBe(true);
  return rpc.result.content[0].text;
}

function fixture() {
  const app = setupManagement();
  const row = { dataId: DATA_ID, userPrompt: "PRIVATE_USER_PROMPT", evalPrompt: "PRIVATE_EVAL_PROMPT",
    name: "Case 1", business: { url: "https://private.example", priority: 1 }, initialMaterials: [OLD] };
  let current: Data = { ...row };
  let member = true;
  let loseResponse = false;
  let writes = 0;
  const materials = new Map<string, {
    bundle: { bundleId: string; name: string; description: string };
    record: { bundleId: string; materialId: string; name: string; description: string; byteSize: number };
    bytes: Uint8Array; mediaType: string; deleted?: boolean;
  }>();
  materials.set(EXISTING_BUNDLE, {
    bundle: { bundleId: EXISTING_BUNDLE, name: "Existing", description: "Existing" },
    record: { ...OLD, name: "Existing", description: "Existing", byteSize: 7 },
    bytes: encode("already"), mediaType: "text/plain",
  });
  const sessions = new Map<string, {
    bundle: { bundleId: string; name: string; description: string };
    record: { bundleId: string; sessionId: string; name: string; description: string; format: "json" | "jsonl" };
    bytes: Uint8Array;
  }>();
  const createMaterials = vi.fn(async (labels: { name: string; description: string },
    inputs: Array<{ files: Array<{ path: string; mediaType: string; contentBase64: string }> }>,
    identity: { bundleId: string; resourceIds: string[] }) => {
    const file = inputs[0]!.files[0]!;
    const bytes = Buffer.from(file.contentBase64, "base64");
    if (materials.has(identity.bundleId)) throw new Error("A second Material was created");
    materials.set(identity.bundleId, { bundle: { bundleId: identity.bundleId, ...labels },
      record: { bundleId: identity.bundleId, materialId: identity.resourceIds[0]!, ...labels, byteSize: bytes.length },
      bytes, mediaType: file.mediaType });
    return {};
  });
  const createSessions = vi.fn(async (labels: { name: string; description: string },
    inputs: Array<{ format: "json" | "jsonl"; content: string }>,
    identity: { bundleId: string; resourceIds: string[] }) => {
    if (sessions.has(identity.bundleId)) throw new Error("A second Session was created");
    sessions.set(identity.bundleId, { bundle: { bundleId: identity.bundleId, ...labels },
      record: { bundleId: identity.bundleId, sessionId: identity.resourceIds[0]!, ...labels, format: inputs[0]!.format },
      bytes: encode(inputs[0]!.content) });
    return {};
  });
  const inspectBindTarget = vi.fn(async (datasetId: string, dataId: string, digest: string,
    attemptedResultDigest?: string) => {
    if (datasetId !== DATASET || dataId !== DATA_ID || !member) throw new HttpError("DATA_NOT_FOUND");
    if ([...app.managed.operations.values()].some((operation) => operation.kind === "prepare"
      && operation.status === "pending" && operation.plan.datasetId === datasetId)) throw new HttpError("EVAL_SP_CONFLICT");
    const contentDigest = await digestJson(current);
    if (contentDigest !== digest && contentDigest !== attemptedResultDigest) throw new HttpError("EVAL_SP_CONFLICT");
    return current;
  });
  const preflightBindMaterialBytes = vi.fn(async (datasetId: string, dataId: string, digest: string,
    references: { initialMaterials?: readonly InitialMaterialsRef[]; evalInitialMaterials?: readonly InitialMaterialsRef[] }) => {
    const data = await inspectBindTarget(datasetId, dataId, digest);
    const byteSizes = { initialMaterials: [] as number[], evalInitialMaterials: [] as number[] };
    for (const field of ["initialMaterials", "evalInitialMaterials"] as const) {
      for (const reference of references[field] ?? []) {
        const saved = materials.get(reference.bundleId);
        const retained = data[field]?.some((item) =>
          item.bundleId === reference.bundleId && item.materialId === reference.materialId);
        if (!saved || saved.record.materialId !== reference.materialId || saved.deleted && !retained) {
          throw new BundleResourceNotFoundError("Material", reference.materialId);
        }
        byteSizes[field].push(saved.record.byteSize);
      }
    }
    return { data, byteSizes };
  });
  const bindData = vi.fn(async (_id: string, patch: DataInitialResourcePatch, guard: {
    expectedContentDigest: string; resultContentDigest: string; replay?: boolean; confirmed?: boolean;
  }) => {
    const digest = await digestJson(current);
    if (digest === guard.resultContentDigest && digest !== guard.expectedContentDigest && guard.replay) return current;
    if (guard.confirmed && digest !== guard.resultContentDigest || digest !== guard.expectedContentDigest) {
      throw new HttpError("EVAL_SP_CONFLICT");
    }
    const next = patchedInitialResources(current, patch);
    if (await digestJson(next) !== guard.resultContentDigest) throw new HttpError("EVAL_SP_CONFLICT");
    if (digest === guard.resultContentDigest) return current;
    current = next;
    writes++;
    if (loseResponse) { loseResponse = false; throw new Error("Data committed; HTTP response lost"); }
    return current;
  });
  Object.assign(app.services, {
    initialResources: { inspectBindTarget, preflightBindMaterialBytes, bindData },
    materialBundles: {
      get: async (id: string) => {
        const bundle = materials.get(id)?.bundle;
        if (!bundle) throw new BundleResourceNotFoundError("Material Bundle", id);
        return bundle;
      },
      getResource: async (id: string, materialId: string) => {
        const saved = materials.get(id);
        if (!saved || saved.deleted || saved.record.materialId !== materialId) {
          throw new BundleResourceNotFoundError("Material", materialId);
        }
        return saved.record;
      },
      getFile: async (id: string) => {
        const saved = materials.get(id)!;
        return { mediaType: saved.mediaType, bytes: saved.bytes };
      },
      create: createMaterials,
    },
    sessionBundles: {
      get: async (id: string) => {
        const bundle = sessions.get(id)?.bundle;
        if (!bundle) throw new BundleResourceNotFoundError("Session Bundle", id);
        return bundle;
      },
      getResource: async (id: string, sessionId: string) => {
        const saved = sessions.get(id);
        if (!saved || saved.record.sessionId !== sessionId) throw new BundleResourceNotFoundError("Session", sessionId);
        return saved.record;
      },
      getFile: async (id: string) => ({ bytes: sessions.get(id)!.bytes }),
      create: createSessions,
    },
  });
  return {
    app, inspectBindTarget, preflightBindMaterialBytes, bindData, createMaterials, createSessions, materials, sessions,
    setExistingMaterial(byteSize: number, deleted = false) {
      const saved = materials.get(EXISTING_BUNDLE)!;
      materials.set(EXISTING_BUNDLE, { ...saved, record: { ...saved.record, byteSize }, deleted });
    },
    addExistingMaterial(byteSize: number) {
      const bundleId = crypto.randomUUID(), materialId = crypto.randomUUID();
      materials.set(bundleId, {
        bundle: { bundleId, name: "Owned", description: "Existing" },
        record: { bundleId, materialId, name: "Owned", description: "Existing", byteSize },
        bytes: encode("already"), mediaType: "text/plain",
      });
      return { bundleId, materialId };
    },
    current: () => current,
    change: (next: typeof current) => { current = next; },
    detach: () => { member = false; },
    loseResponse: () => { loseResponse = true; },
    writes: () => writes,
    digest: async () => digestJson(current),
    existingSession() {
      const bundleId = crypto.randomUUID(), sessionId = crypto.randomUUID();
      sessions.set(bundleId, { bundle: { bundleId, name: "Old Context", description: "Old Context" },
        record: { bundleId, sessionId, name: "Old Context", description: "Old Context", format: "jsonl" },
        bytes: encode(session) });
      return { bundleId, sessionId };
    },
  };
}

describe("durable binding of existing Dataset Data", () => {
  it("reuses uploaded Materials across Subject/Evaluator, plans a Session once and retains unrelated Data fields", async () => {
    const f = fixture();
    const before = await f.digest();
    const material = f.app.managed.addUpload("material", "new.txt", encode("new asset bytes"), "text/plain");
    const context = f.app.managed.addUpload("session", "context.jsonl", encode(session), "application/x-ndjson");
    const input = {
      operationKey: "old-data-new-resources", datasetId: DATASET, dataId: DATA_ID, expectedContentDigest: before,
      initialMaterials: [OLD, { uploadRef: material }],
      evalInitialMaterials: [{ uploadRef: material }],
      initialSession: { uploadRef: context, format: "jsonl" },
    };
    const receipt = await toolValue(await f.app.call("bind_data_resources", input));
    expect(receipt).toEqual({ operationKey: input.operationKey, kind: "bind", status: "completed",
      datasetId: DATASET, dataId: DATA_ID, contentDigest: await f.digest(),
      resources: { total: 2, confirmed: 2 } });
    expect(f.current()).toMatchObject({ name: "Case 1", userPrompt: "PRIVATE_USER_PROMPT",
      evalPrompt: "PRIVATE_EVAL_PROMPT", business: { url: "https://private.example", priority: 1 },
      initialMaterials: [OLD, expect.objectContaining({ bundleId: expect.any(String), materialId: expect.any(String) })],
      evalInitialMaterials: [expect.objectContaining({ bundleId: expect.any(String), materialId: expect.any(String) })],
      initialSession: { bundleId: expect.any(String), sessionId: expect.any(String) } });
    expect(f.current().initialMaterials![1]).toEqual(f.current().evalInitialMaterials![0]);
    expect(f.createMaterials).toHaveBeenCalledTimes(1);
    expect(f.createSessions).toHaveBeenCalledTimes(1);
    const detail = await toolValue(await f.app.call("get_preparation", { operationKey: input.operationKey }));
    expect(detail).toMatchObject({ kind: "bind", status: "completed", binding: "confirmed",
      expectedContentDigest: before, contentDigest: receipt.contentDigest,
      initialMaterials: f.current().initialMaterials, evalInitialMaterials: f.current().evalInitialMaterials,
      initialSession: f.current().initialSession,
      resources: { total: 2, confirmed: 2, items: [
        { kind: "material", status: "confirmed" }, { kind: "session", status: "confirmed" },
      ] } });
    expect(JSON.stringify(detail)).not.toMatch(/PRIVATE_|https?:\/\/|new asset bytes|Earlier private context|uploadRef/u);
    const plan = f.app.managed.operations.get(input.operationKey)!.plan;
    expect(plan).toMatchObject({ version: 2, datasetId: DATASET, dataId: DATA_ID });
    expect(plan).not.toHaveProperty("dataIds"); // bind must not become a prepare v1 original-file order proof.
    expect(await toolValue(await f.app.call("bind_data_resources", input))).toEqual(receipt);
    expect(f.createMaterials).toHaveBeenCalledTimes(1);
    expect(f.createSessions).toHaveBeenCalledTimes(1);
    expect(f.writes()).toBe(1);
    expect(f.app.services.projects.create).not.toHaveBeenCalled();
  });

  it.each([{ deleted: false, label: "active" }, { deleted: true, label: "soft-deleted" }])(
    "rejects over-budget $label retained Materials before planning or creating a Bundle",
    async ({ deleted }) => {
      const f = fixture();
      f.setExistingMaterial(EVAL_INITIAL_FILE_MAX_BYTES, deleted);
      const retained = [OLD, ...Array.from({ length: 3 }, () => f.addExistingMaterial(EVAL_INITIAL_FILE_MAX_BYTES))];
      f.change({ ...f.current(), initialMaterials: retained });
      const uploadRef = f.app.managed.addUpload("material", "one-byte.txt", encode("x"), "text/plain");
      const input = {
        operationKey: `over-budget-${deleted ? "deleted" : "active"}`,
        datasetId: DATASET, dataId: DATA_ID, expectedContentDigest: await f.digest(),
        initialMaterials: [...retained, { uploadRef }],
      };
      expect(retained.length * EVAL_INITIAL_FILE_MAX_BYTES).toBe(EVAL_INITIALIZATION_MAX_BYTES);
      expect(await errorCode(await f.app.call("bind_data_resources", input))).toContain("BUNDLE_FILE_TOO_LARGE");
      expect(f.preflightBindMaterialBytes).toHaveBeenCalledOnce();
      expect(f.createMaterials).not.toHaveBeenCalled();
      expect(f.createSessions).not.toHaveBeenCalled();
      expect(f.bindData).not.toHaveBeenCalled();
      expect(f.app.managed.operations.size).toBe(0);
      expect(f.app.managed.uploads.get(uploadRef)?.claimedBy).toBeNull();
      expect(f.current().initialMaterials).toEqual(retained);
    });

  it("rechecks retained bytes before a pending-key replay writes an outstanding Bundle", async () => {
    const f = fixture();
    const retained = [OLD, ...Array.from({ length: 3 }, () => f.addExistingMaterial(EVAL_INITIAL_FILE_MAX_BYTES))];
    f.change({ ...f.current(), initialMaterials: retained });
    const uploadRef = f.app.managed.addUpload("material", "outstanding.txt", encode("x"), "text/plain");
    const input = { operationKey: "old-pending-bind", datasetId: DATASET, dataId: DATA_ID,
      expectedContentDigest: await f.digest(), initialMaterials: [...retained, { uploadRef }] };
    f.createMaterials.mockImplementationOnce(async () => { throw new Error("catalog write not completed"); });
    expect(await errorCode(await f.app.call("bind_data_resources", input))).toContain("INTERNAL_ERROR");
    expect(f.app.managed.operations.get(input.operationKey)?.status).toBe("pending");
    expect(f.createMaterials).toHaveBeenCalledOnce();
    // Model an older pending plan admitted without counting its retained byte size.
    // The owned catalog now reports the full size; replay must not issue another create.
    f.setExistingMaterial(EVAL_INITIAL_FILE_MAX_BYTES);
    expect(await errorCode(await f.app.call("bind_data_resources", input))).toContain("BUNDLE_FILE_TOO_LARGE");
    expect(f.createMaterials).toHaveBeenCalledOnce();
    expect(f.app.managed.operations.get(input.operationKey)?.status).toBe("pending");
    expect(f.bindData).not.toHaveBeenCalled();
  });

  it("allows a full separate byte budget per role, but never treats a deleted ref in the other field as retained", async () => {
    const f = fixture();
    f.setExistingMaterial(EVAL_INITIAL_FILE_MAX_BYTES);
    const retained = [OLD, f.addExistingMaterial(EVAL_INITIAL_FILE_MAX_BYTES),
      f.addExistingMaterial(EVAL_INITIAL_FILE_MAX_BYTES), f.addExistingMaterial(EVAL_INITIAL_FILE_MAX_BYTES - 1)];
    f.change({ ...f.current(), initialMaterials: retained, evalInitialMaterials: retained });
    const uploadRef = f.app.managed.addUpload("material", "last-byte.txt", encode("x"), "text/plain");
    const input = {
      operationKey: "independent-role-budgets", datasetId: DATASET, dataId: DATA_ID,
      expectedContentDigest: await f.digest(),
      initialMaterials: [...retained, { uploadRef }], evalInitialMaterials: [...retained, { uploadRef }],
    };
    expect(await toolValue(await f.app.call("bind_data_resources", input))).toMatchObject({
      kind: "bind", status: "completed", resources: { total: 1, confirmed: 1 },
    });
    expect(f.createMaterials).toHaveBeenCalledOnce();
    expect(f.current().initialMaterials).toHaveLength(5);
    expect(f.current().evalInitialMaterials).toHaveLength(5);
    expect(f.current().initialMaterials?.[4]).toEqual(f.current().evalInitialMaterials?.[4]);

    const deleted = fixture();
    deleted.setExistingMaterial(EVAL_INITIAL_FILE_MAX_BYTES, true);
    const newUpload = deleted.app.managed.addUpload("material", "blocked.txt", encode("x"), "text/plain");
    expect(await errorCode(await deleted.app.call("bind_data_resources", {
      operationKey: "different-role-deleted-ref", datasetId: DATASET, dataId: DATA_ID,
      expectedContentDigest: await deleted.digest(), evalInitialMaterials: [OLD, { uploadRef: newUpload }],
    }))).toContain("BUNDLE_RESOURCE_NOT_FOUND");
    expect(deleted.createMaterials).not.toHaveBeenCalled();
    expect(deleted.app.managed.operations.size).toBe(0);
  });

  it("pages 17 new-resource receipts by five without clipping the complete post-bind reference lists", async () => {
    const f = fixture();
    const uploads = (role: string) => Array.from({ length: 8 }, (_, index) => ({
      uploadRef: f.app.managed.addUpload("material", `${role}-${index}.txt`, encode("tiny"), "text/plain"),
    }));
    const input = {
      operationKey: "b".repeat(200), datasetId: DATASET, dataId: DATA_ID, expectedContentDigest: await f.digest(),
      initialMaterials: uploads("subject"), evalInitialMaterials: uploads("evaluator"),
      initialSession: { uploadRef: f.app.managed.addUpload("session", "history.jsonl", encode(session)),
        format: "jsonl" },
    };
    const completed = await toolValue(await f.app.call("bind_data_resources", input));
    expect(completed).toMatchObject({ resources: { total: 17, confirmed: 17 } });
    for (const page of [1, 2, 3, 4, 5]) {
      const rpc = await (await f.app.call("get_preparation", { operationKey: input.operationKey, page })).json() as {
        result: { isError?: boolean; content: [{ text: string }] };
      };
      expect(rpc.result.isError).not.toBe(true);
      const text = rpc.result.content[0].text;
      expect(text.length).toBeLessThanOrEqual(4_800);
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(4_800);
      const detail = JSON.parse(text) as {
        page: number; pageSize: number; initialMaterials: unknown[]; evalInitialMaterials: unknown[];
        resources: { total: number; confirmed: number; items: unknown[] };
      };
      expect(detail).toMatchObject({ page, pageSize: 5, resources: { total: 17, confirmed: 17 } });
      expect(detail.resources.items).toHaveLength(page < 4 ? 5 : page === 4 ? 2 : 0);
      expect(detail.initialMaterials).toHaveLength(8);
      expect(detail.evalInitialMaterials).toHaveLength(8);
      expect(text).not.toContain("uploadRef");
    }
  });

  it("replaces with old resources, clears only explicit null fields and leaves omitted refs unchanged", async () => {
    const f = fixture();
    const existingSession = f.existingSession();
    const before = await f.digest();
    const input = {
      operationKey: "old-data-old-resources", datasetId: DATASET, dataId: DATA_ID, expectedContentDigest: before,
      evalInitialMaterials: [OLD], initialSession: existingSession,
    };
    const receipt = await toolValue(await f.app.call("bind_data_resources", input));
    expect(receipt).toMatchObject({ kind: "bind", status: "completed", resources: { total: 0, confirmed: 0 } });
    expect(f.current()).toMatchObject({ initialMaterials: [OLD], evalInitialMaterials: [OLD],
      initialSession: existingSession });
    const detail = await toolValue(await f.app.call("get_preparation", { operationKey: input.operationKey }));
    expect(detail).not.toHaveProperty("initialMaterials"); // omitted, not implicitly cleared or replaced.
    expect(detail).toMatchObject({ evalInitialMaterials: [OLD], initialSession: existingSession,
      resources: { items: [] } });
    expect(f.createMaterials).not.toHaveBeenCalled();
    expect(f.createSessions).not.toHaveBeenCalled();

    const clear = await toolValue(await f.app.call("bind_data_resources", {
      operationKey: "clear-fields", datasetId: DATASET, dataId: DATA_ID,
      expectedContentDigest: receipt.contentDigest, evalInitialMaterials: null, initialSession: null,
    }));
    expect(clear.status).toBe("completed");
    expect(f.current().initialMaterials).toEqual([OLD]);
    expect(f.current()).not.toHaveProperty("evalInitialMaterials");
    expect(f.current()).not.toHaveProperty("initialSession");
  });

  it("fences pending work, reconciles a lost Data response by full post-bind digest and never replans assets", async () => {
    const f = fixture();
    const uploadRef = f.app.managed.addUpload("material", "lost.txt", encode("new bytes"), "text/plain");
    const input = {
      operationKey: "response-lost", datasetId: DATASET, dataId: DATA_ID, expectedContentDigest: await f.digest(),
      initialMaterials: [{ uploadRef }],
    };
    f.loseResponse();
    expect(await errorCode(await f.app.call("bind_data_resources", input))).toContain("INTERNAL_ERROR");
    expect(f.writes()).toBe(1);
    const pending = await toolValue(await f.app.call("get_preparation", { operationKey: input.operationKey }));
    expect(pending).toMatchObject({ kind: "bind", status: "outcome_unknown", binding: "attempted",
      resources: { total: 1, confirmed: 1 } });
    await expect(f.app.managed.store.assertReadyDatasets(OWNER, [DATASET])).rejects.toThrow();
    // The trusted staged bytes may have expired; planned IDs and the committed Data are enough to reconcile.
    f.app.managed.uploads.set(uploadRef, { ...f.app.managed.uploads.get(uploadRef)!, expiresAt: new Date(0) });
    const recovered = await toolValue(await f.app.call("bind_data_resources", input));
    expect(recovered).toMatchObject({ status: "completed", contentDigest: await f.digest() });
    expect(f.writes()).toBe(1);
    expect(f.createMaterials).toHaveBeenCalledTimes(1);
    await expect(f.app.managed.store.assertReadyDatasets(OWNER, [DATASET])).resolves.toBeUndefined();
    expect(await toolValue(await f.app.call("get_preparation", { operationKey: input.operationKey })))
      .toMatchObject({ status: "completed", binding: "confirmed" });
  });

  it("reads back a planned Material after a lost catalog write, without a second create or Data mutation", async () => {
    const f = fixture();
    const uploadRef = f.app.managed.addUpload("material", "uncertain.txt", encode("verified bytes"), "text/plain");
    const input = { operationKey: "resource-response-lost", datasetId: DATASET, dataId: DATA_ID,
      expectedContentDigest: await f.digest(), evalInitialMaterials: [{ uploadRef }] };
    const write = f.createMaterials.getMockImplementation()!;
    f.createMaterials.mockImplementationOnce(async (...args) => {
      await write(...args);
      throw new Error("catalog committed but response was lost");
    });
    expect(await errorCode(await f.app.call("bind_data_resources", input))).toContain("INTERNAL_ERROR");
    expect(f.writes()).toBe(0);
    expect(await toolValue(await f.app.call("get_preparation", { operationKey: input.operationKey })))
      .toMatchObject({ status: "outcome_unknown", binding: "pending", resources: {
        total: 1, confirmed: 0, items: [{ status: "attempted" }],
      } });
    const receipt = await toolValue(await f.app.call("bind_data_resources", input));
    expect(receipt).toMatchObject({ status: "completed", resources: { total: 1, confirmed: 1 } });
    expect(f.createMaterials).toHaveBeenCalledTimes(1);
    expect(f.writes()).toBe(1);
    expect(f.current().evalInitialMaterials).toEqual([expect.objectContaining({
      bundleId: expect.any(String), materialId: expect.any(String),
    })]);
  });

  it("fails closed if Data changes after an uncertain binding, leaving the planned receipt historical", async () => {
    const f = fixture();
    const uploadRef = f.app.managed.addUpload("material", "unknown.txt", encode("new bytes"), "text/plain");
    const input = { operationKey: "stale-after-write", datasetId: DATASET, dataId: DATA_ID,
      expectedContentDigest: await f.digest(), initialMaterials: [{ uploadRef }] };
    f.loseResponse();
    await f.app.call("bind_data_resources", input);
    expect(await errorCode(await f.app.call("bind_data_resources", {
      ...input, operationKey: "other-while-pending", expectedContentDigest: await f.digest(),
    }))).toContain("EVAL_SP_CONFLICT");
    expect(f.app.managed.operations.has("other-while-pending")).toBe(false);
    f.change({ ...f.current(), userPrompt: "Edited after lost response" });
    expect(await errorCode(await f.app.call("bind_data_resources", input))).toContain("EVAL_SP_CONFLICT");
    expect(f.current().userPrompt).toBe("Edited after lost response");
    expect(f.writes()).toBe(1);
    expect(f.createMaterials).toHaveBeenCalledTimes(1);
    expect(await toolValue(await f.app.call("get_preparation", { operationKey: input.operationKey })))
      .toMatchObject({ kind: "bind", status: "outcome_unknown", binding: "attempted" });
  });

  it("rejects stale Data, wrong membership, changed operation bodies and reuse of an upload under another key", async () => {
    const f = fixture();
    const digest = await f.digest();
    const uploadRef = f.app.managed.addUpload("material", "claimed.txt", encode("new bytes"), "text/plain");
    const input = { operationKey: "claimed", datasetId: DATASET, dataId: DATA_ID, expectedContentDigest: digest,
      initialMaterials: [{ uploadRef }] };
    const changed = { ...f.current(), name: "Changed after review" };
    f.change(changed);
    expect(await errorCode(await f.app.call("bind_data_resources", input))).toContain("EVAL_SP_CONFLICT");
    expect(f.app.managed.operations.size).toBe(0);
    f.change({ ...changed, name: "Case 1" });
    f.detach();
    expect(await errorCode(await f.app.call("bind_data_resources", input))).toContain("DATA_NOT_FOUND");
    expect(f.app.managed.operations.size).toBe(0);
    const f2 = fixture();
    const upload = f2.app.managed.addUpload("material", "claimed.txt", encode("new bytes"), "text/plain");
    const first = { ...input, uploadRef: undefined, initialMaterials: [{ uploadRef: upload }] };
    await toolValue(await f2.app.call("bind_data_resources", first));
    expect(await errorCode(await f2.app.call("bind_data_resources", {
      ...first, initialMaterials: null,
    }))).toContain("EVAL_SP_CONFLICT");
    expect(await errorCode(await f2.app.call("bind_data_resources", {
      ...first, operationKey: "other-key", expectedContentDigest: await f2.digest(),
    }))).toContain("EVAL_SP_CONFLICT");
    expect(f2.createMaterials).toHaveBeenCalledTimes(1);
    f2.change({ ...f2.current(), name: "Edited after the completed receipt" });
    expect(await errorCode(await f2.app.call("bind_data_resources", first))).toContain("EVAL_SP_CONFLICT");
    expect(f2.current().name).toBe("Edited after the completed receipt");
    expect(f2.writes()).toBe(1);
  });

  it("rejects malformed, duplicate or empty resource patches before any catalog or upload read", async () => {
    const f = fixture();
    const base = { operationKey: "bad", datasetId: DATASET, dataId: DATA_ID, expectedContentDigest: await f.digest() };
    for (const input of [
      base,
      { ...base, initialMaterials: [] },
      { ...base, initialMaterials: [OLD, OLD] },
      { ...base, evalInitialMaterials: [OLD, OLD] },
      { ...base, expectedContentDigest: "A".repeat(64), initialSession: null },
      { ...base, initialSession: { uploadRef: crypto.randomUUID() } },
      { ...base, initialMaterials: [{ ...OLD, url: "https://private.example" }] },
      { ...base, initialMaterials: [{ uploadRef: "https://private.example" }] },
      { ...base, initialSession: null, dataContent: "PRIVATE_USER_PROMPT" },
    ]) expect(await errorCode(await f.app.call("bind_data_resources", input))).toContain("REQUEST_INVALID_INPUT");
    expect(f.inspectBindTarget).not.toHaveBeenCalled();
    expect(f.bindData).not.toHaveBeenCalled();
    expect(f.app.managed.operations.size).toBe(0);
  });
});
