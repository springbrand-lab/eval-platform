import { parsePromptDatasetUpload } from "@eval-platform/eval-dataset";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { digestJson } from "@eval-platform/eval-runtime";
import { EVAL_INITIAL_FILE_MAX_BYTES, EVAL_INITIALIZATION_MAX_BYTES } from "@springbrand/eval-harness";
import { describe, expect, it, vi } from "vitest";
import { BundleResourceNotFoundError } from "../db/errors.js";
import { preparationFingerprint, type PreparationRowDigests, type UploadFact } from "./preparation-plan.js";
import { prepareInputsSchema } from "./schemas.js";
import { AGENT, OWNER, setupManagement, toolValue } from "./test-fixture.js";

const encode = (text: string) => new TextEncoder().encode(text);
const promptRow = (name: string) => ({
  name, description: `${name} case`, userPrompt: `private task ${name}`, evalPrompt: `Judge ${name}`,
});
const session = encode(`${JSON.stringify({
  id: "m1", message: { role: "user", content: "Earlier context", timestamp: 1 }, createdAt: 1,
})}\n`);

function preparedFixture() {
  const app = setupManagement();
  const subject = { bundleId: crypto.randomUUID(), materialId: crypto.randomUUID() };
  const evaluator = { bundleId: crypto.randomUUID(), materialId: crypto.randomUUID() };
  const context = { bundleId: crypto.randomUUID(), sessionId: crypto.randomUUID() };
  const promptUploadRef = app.managed.addUpload("prompt", "cases.jsonl",
    encode(`${JSON.stringify(promptRow("one"))}\n${JSON.stringify(promptRow("two"))}\n`), "application/x-ndjson");
  const input = {
    operationKey: "prepare-1", promptUploadRef, name: "Dataset", description: "Requirements", format: "jsonl",
    cases: [
      { initialMaterials: [subject], evalInitialMaterials: [evaluator], initialSession: context },
      { initialMaterials: [subject] },
    ],
  };
  const datasets = new Map<string, { datasetId: string; name: string; description: string }>();
  const data = new Map<string, Record<string, unknown>>();
  const memberships = new Map<string, string[]>();
  const foreignDatasets = new Set<string>();
  const deletedDatasets = new Set<string>();
  const deletedData = new Set<string>();
  const unprovenOrder = new Set<string>();
  // Mirror the management Store's owner-scoped, consistent persisted read rather than
  // reparsing a staged Prompt. The import below commits the full fake snapshot before throwing.
  Object.assign(app.managed.store, {
    async inspectPreparedDataset(owner: string, datasetId: string) {
      const dataset = datasets.get(datasetId);
      if (!dataset) return null;
      if (owner !== OWNER || foreignDatasets.has(datasetId) || deletedDatasets.has(datasetId)) {
        throw new HttpError("EVAL_SP_CONFLICT", "Dataset unavailable to the owner");
      }
      const ids = memberships.get(datasetId) ?? [];
      if (ids.some((id) => deletedData.has(id) || !data.has(id))) {
        throw new HttpError("EVAL_SP_CONFLICT", "A Dataset member is unavailable");
      }
      return { dataset, data: await Promise.all(ids.map(async (id) => {
        const { dataId: _id, ...content } = data.get(id)!;
        return { dataId: id, contentDigest: await digestJson(content) };
      })),
        order: unprovenOrder.has(datasetId) ? "unknown" as const : "upload" as const };
    },
  });
  let loseDatasetResponse = false;
  let loseBindingResponse = false;
  const importPromptDataset = vi.fn(async (upload: { name: string; description: string; format: "json" | "jsonl"; content: string },
    planned: { datasetId: string; dataIds: readonly string[] }) => {
    const parsed = parsePromptDatasetUpload(upload);
    datasets.set(planned.datasetId, { datasetId: planned.datasetId, name: upload.name, description: upload.description });
    memberships.set(planned.datasetId, [...planned.dataIds]);
    for (const [index, row] of parsed.data.entries()) data.set(planned.dataIds[index]!, { ...row, dataId: planned.dataIds[index]! });
    if (loseDatasetResponse) { loseDatasetResponse = false; throw new Error("dataset commit succeeded but response was lost"); }
    return { dataset: datasets.get(planned.datasetId), data: planned.dataIds.map((id) => data.get(id)) };
  });
  const bindData = vi.fn(async (dataId: string, patch: Record<string, unknown>) => {
    data.set(dataId, { ...data.get(dataId), ...patch });
    if (loseBindingResponse) { loseBindingResponse = false; throw new Error("binding response lost after commit"); }
    return data.get(dataId);
  });
  Object.assign(app.services.datasets, {
    getDataset: async (id: string) => datasets.get(id) ?? null,
    listData: async (id: string) => (memberships.get(id) ?? []).map((key) => data.get(key)),
    getData: async (id: string) => data.get(id) ?? null,
    importPromptDataset,
  });
  const materials = new Map<string, { bundle: { bundleId: string; name: string; description: string };
    resource: Record<string, unknown>; files: Array<{ path: string; mediaType: string; contentBase64: string }> }>();
  for (const [ref, name, text] of [[subject, "subject.txt", "subject bytes"],
    [evaluator, "judge.txt", "evaluator bytes"]] as const) {
    materials.set(ref.bundleId, { bundle: { bundleId: ref.bundleId, name, description: name },
      resource: { ...ref, name, description: name, byteSize: encode(text).byteLength },
      files: [{ path: `/${name}`, mediaType: "text/plain", contentBase64: Buffer.from(text).toString("base64") }] });
  }
  const addExistingMaterial = (byteSize: number) => {
    const bundleId = crypto.randomUUID();
    const materialId = crypto.randomUUID();
    materials.set(bundleId, { bundle: { bundleId, name: "Owned", description: "Existing material" },
      resource: { bundleId, materialId, name: "Owned", description: "Existing material", byteSize }, files: [] });
    return { bundleId, materialId };
  };
  const hideMaterial = (bundleId: string) => { materials.delete(bundleId); };
  const sessions = new Map<string, { bundle: { bundleId: string; name: string; description: string };
    resource: Record<string, unknown>; format: "json" | "jsonl"; content: string }>();
  sessions.set(context.bundleId, { bundle: { bundleId: context.bundleId, name: "history.jsonl", description: "history.jsonl" },
    resource: { ...context, name: "history.jsonl", description: "history.jsonl", format: "jsonl" },
    format: "jsonl", content: new TextDecoder().decode(session) });
  const createMaterials = vi.fn(async (labels: { name: string; description: string },
    inputs: Array<{ files: Array<{ path: string; mediaType: string; contentBase64: string }> }>,
    planned: { bundleId: string; resourceIds: readonly string[] }) => {
    materials.set(planned.bundleId, { bundle: { bundleId: planned.bundleId, ...labels },
      resource: { bundleId: planned.bundleId, materialId: planned.resourceIds[0], ...labels,
        byteSize: Buffer.byteLength(inputs[0]!.files[0]!.contentBase64, "base64") }, files: inputs[0]!.files });
    return {};
  });
  const createSessions = vi.fn(async (labels: { name: string; description: string },
    inputs: Array<{ format: "json" | "jsonl"; content: string }>,
    planned: { bundleId: string; resourceIds: readonly string[] }) => {
    sessions.set(planned.bundleId, { bundle: { bundleId: planned.bundleId, ...labels },
      resource: { bundleId: planned.bundleId, sessionId: planned.resourceIds[0], ...labels, format: inputs[0]!.format },
      ...inputs[0]! });
    return {};
  });
  Object.assign(app.services, {
    initialResources: { bindData },
    materialBundles: {
      create: createMaterials,
      list: async () => [...materials.values()].map((item) => item.bundle),
      listResources: async (id: string) => materials.get(id) ? [materials.get(id)!.resource] : [],
      listFiles: async (id: string) => (materials.get(id)?.files ?? []).map(({ path, mediaType, contentBase64 }) => ({
        path, mediaType, byteSize: Buffer.byteLength(contentBase64, "base64"),
      })),
      get: async (id: string) => {
        const saved = materials.get(id);
        if (!saved) throw new BundleResourceNotFoundError("Material Bundle", id);
        return saved.bundle;
      },
      getResource: async (bundleId: string, materialId: string) => {
        const resource = materials.get(bundleId)?.resource;
        if (!resource || resource.materialId !== materialId) throw new BundleResourceNotFoundError("Material", materialId);
        return resource;
      },
      getFile: async (bundleId: string, _id: string, filePath: string) => {
        const file = materials.get(bundleId)!.files.find((entry) => entry.path === filePath)!;
        return { path: file.path, mediaType: file.mediaType, bytes: Buffer.from(file.contentBase64, "base64") };
      },
    },
    sessionBundles: {
      create: createSessions,
      list: async () => [...sessions.values()].map((item) => item.bundle),
      listResources: async (id: string) => sessions.get(id) ? [sessions.get(id)!.resource] : [],
      listFiles: async (id: string) => sessions.get(id) ? [{ path: `/context.${sessions.get(id)!.format}`,
        mediaType: "application/x-ndjson", byteSize: Buffer.byteLength(sessions.get(id)!.content) }] : [],
      get: async (id: string) => {
        const saved = sessions.get(id);
        if (!saved) throw new BundleResourceNotFoundError("Session Bundle", id);
        return saved.bundle;
      },
      getResource: async (bundleId: string, sessionId: string) => {
        const saved = sessions.get(bundleId);
        if (!saved || saved.resource.sessionId !== sessionId) throw new BundleResourceNotFoundError("Session", sessionId);
        return saved.resource;
      },
      getFile: async (bundleId: string) => ({
        bytes: Buffer.from(sessions.get(bundleId)!.content, "utf8"),
      }),
    },
  });
  return { app, input, importPromptDataset, bindData, createMaterials, createSessions, addExistingMaterial, hideMaterial,
    persisted: { datasets, data, memberships, foreignDatasets, deletedDatasets, deletedData, unprovenOrder },
    loseDatasetResponse: () => { loseDatasetResponse = true; },
    loseBindingResponse: () => { loseBindingResponse = true; } };
}

describe("durable management preparation", () => {
  it("imports raw Prompt rows and binds owned existing Material/Session references, without another Bundle", async () => {
    const f = preparedFixture();
    const result = await toolValue(await f.app.call("prepare_inputs", f.input));
    expect(result).toEqual({ operationKey: f.input.operationKey, kind: "prepare", status: "completed",
      datasetId: expect.any(String), totalCases: 2 });
    const detail = await toolValue(await f.app.call("get_preparation", {
      operationKey: f.input.operationKey, pageSize: 1,
    }));
    expect(detail).toMatchObject({ page: 1, pageSize: 1, totalCases: 2, cases: [
      { initialMaterials: [expect.objectContaining({ bundleId: expect.any(String), materialId: expect.any(String) })],
        evalInitialMaterials: [expect.objectContaining({ bundleId: expect.any(String), materialId: expect.any(String) })],
        initialSession: { bundleId: expect.any(String), sessionId: expect.any(String) } },
    ] });
    const args = f.importPromptDataset.mock.calls[0]!;
    expect(args[0].content).not.toContain("initialMaterials");
    expect(args[1].dataIds[0]).toBe((detail.cases as Array<{ dataId: string }>)[0]!.dataId);
    expect(f.createMaterials).not.toHaveBeenCalled();
    expect(f.createSessions).not.toHaveBeenCalled();
    expect(f.bindData).toHaveBeenCalledTimes(2);
    expect(f.app.services.projects.create).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private task");
    const second = await toolValue(await f.app.call("get_preparation", {
      operationKey: f.input.operationKey, page: 2, pageSize: 1,
    }));
    expect(second).toMatchObject({ page: 2, pageSize: 1, totalCases: 2,
      cases: [{ dataId: args[1].dataIds[1] }] });
    expect(await toolValue(await f.app.call("prepare_inputs", f.input))).toEqual(result);
    expect(f.importPromptDataset).toHaveBeenCalledTimes(1);
    expect(f.createMaterials).not.toHaveBeenCalled();
  });

  it("returns a compact exact-replay receipt for 50 Prompt cases; details page only Data bindings", async () => {
    const f = preparedFixture();
    const cases = Array.from({ length: 50 }, () => f.input.cases[0]!);
    const promptUploadRef = f.app.managed.addUpload("prompt", "fifty.jsonl",
      encode(Array.from({ length: cases.length }, (_, index) => JSON.stringify(promptRow(`case-${index}`))).join("\n")));
    const input = { ...f.input, promptUploadRef, cases, operationKey: "prepare-50" };
    const result = await toolValue(await f.app.call("prepare_inputs", input));
    expect(result).toEqual({ operationKey: input.operationKey, kind: "prepare", status: "completed",
      datasetId: expect.any(String), totalCases: 50 });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(5 * 1024);
    expect(JSON.stringify(result)).not.toMatch(/"cases"|"items"|"uploadRef"|"initialMaterials"/u);
    const detail = await toolValue(await f.app.call("get_preparation", { operationKey: input.operationKey, pageSize: 1 }));
    expect(detail).toMatchObject({ page: 1, pageSize: 1, totalCases: 50, cases: [expect.objectContaining({
      initialMaterials: expect.any(Array), evalInitialMaterials: expect.any(Array),
    })] });
    expect((detail.cases as unknown[]).length).toBe(1);
    expect(detail).not.toHaveProperty("resources");
    expect(await toolValue(await f.app.call("prepare_inputs", input))).toEqual(result);
    expect(f.importPromptDataset).toHaveBeenCalledTimes(1);
    expect(f.createMaterials).not.toHaveBeenCalled();
    expect(f.createSessions).not.toHaveBeenCalled();
  });

  it.each(["initialMaterials", "evalInitialMaterials"] as const)(
    "rejects five owned 5 MB Materials in one %s before any operation or write", async (field) => {
      const f = preparedFixture();
      const existing = Array.from({ length: 5 }, () => f.addExistingMaterial(EVAL_INITIAL_FILE_MAX_BYTES));
      const promptUploadRef = f.app.managed.addUpload("prompt", "budget.jsonl", encode(JSON.stringify(promptRow("budget"))));
      const input = { ...f.input, operationKey: `over-budget-${field}`, promptUploadRef,
        cases: [{ [field]: existing }] };
      expect(existing.length * EVAL_INITIAL_FILE_MAX_BYTES).toBeGreaterThan(EVAL_INITIALIZATION_MAX_BYTES);

      const result = await (await f.app.call("prepare_inputs", input)).json();
      expect(result).toMatchObject({ result: { isError: true,
        content: [{ text: expect.stringContaining("BUNDLE_FILE_TOO_LARGE") }] } });
      expect(f.app.managed.operations.size).toBe(0);
      expect(f.importPromptDataset).not.toHaveBeenCalled();
      expect(f.createMaterials).not.toHaveBeenCalled();
      expect(f.createSessions).not.toHaveBeenCalled();
      expect(f.bindData).not.toHaveBeenCalled();
    },
  );

  it("allows exactly 20 MB of Materials independently for Subject and Evaluator", async () => {
    const f = preparedFixture();
    const selections = Array.from({ length: 4 }, () => f.addExistingMaterial(EVAL_INITIAL_FILE_MAX_BYTES));
    const promptUploadRef = f.app.managed.addUpload("prompt", "budget.jsonl", encode(JSON.stringify(promptRow("budget"))));
    const input = { ...f.input, operationKey: "within-budget", promptUploadRef,
      cases: [{ initialMaterials: selections, evalInitialMaterials: selections }] };
    expect(selections.length * EVAL_INITIAL_FILE_MAX_BYTES).toBe(EVAL_INITIALIZATION_MAX_BYTES);
    expect(await toolValue(await f.app.call("prepare_inputs", input))).toMatchObject({
      kind: "prepare", status: "completed", totalCases: 1,
    });
    expect(f.createMaterials).not.toHaveBeenCalled();
    expect(f.bindData).toHaveBeenCalledTimes(1);
  });

  it("still requires an owned existing Material before beginning the operation", async () => {
    const f = preparedFixture();
    const promptUploadRef = f.app.managed.addUpload("prompt", "foreign.jsonl", encode(JSON.stringify(promptRow("foreign"))));
    const input = { ...f.input, operationKey: "foreign-material", promptUploadRef,
      cases: [{ initialMaterials: [{ bundleId: crypto.randomUUID(), materialId: crypto.randomUUID() }] }] };
    const response = await (await f.app.call("prepare_inputs", input)).json();
    expect(response).toMatchObject({ result: { isError: true,
      content: [{ text: expect.stringContaining("BUNDLE_RESOURCE_NOT_FOUND") }] } });
    expect(f.app.managed.operations.size).toBe(0);
    expect(f.importPromptDataset).not.toHaveBeenCalled();
    expect(f.createMaterials).not.toHaveBeenCalled();
  });

  it("reconciles a stored same-key binding even when its previously owned Material is later deleted", async () => {
    const f = preparedFixture();
    const material = f.addExistingMaterial(5);
    const promptUploadRef = f.app.managed.addUpload("prompt", "retained.jsonl", encode(JSON.stringify(promptRow("retained"))));
    const input = { ...f.input, operationKey: "retained-binding", promptUploadRef,
      cases: [{ initialMaterials: [material] }] };
    const completed = await toolValue(await f.app.call("prepare_inputs", input));
    const operation = f.app.managed.operations.get(input.operationKey)!;
    // All writes committed, but the completion response/status was uncertain.
    f.app.managed.operations.set(input.operationKey, { ...operation, status: "pending" });
    f.hideMaterial(material.bundleId);

    expect(await toolValue(await f.app.call("prepare_inputs", input))).toEqual(completed);
    expect(f.importPromptDataset).toHaveBeenCalledTimes(1);
    expect(f.bindData).toHaveBeenCalledTimes(1);
  });

  it("keeps new Data + old Material selection in the original prepare_inputs path", async () => {
    const f = preparedFixture();
    const owned = f.addExistingMaterial(5);
    const promptUploadRef = f.app.managed.addUpload("prompt", "old-material.jsonl",
      encode(JSON.stringify(promptRow("new Data"))));
    const input = { ...f.input, operationKey: "new-data-old-resources", promptUploadRef,
      cases: [{ initialMaterials: [owned], evalInitialMaterials: [owned] }] };
    const created = await toolValue(await f.app.call("prepare_inputs", input));
    expect(created).toMatchObject({ kind: "prepare", status: "completed",
      totalCases: 1 });
    const readback = await toolValue(await f.app.call("get_preparation", { operationKey: input.operationKey }));
    expect(readback).toMatchObject({ kind: "prepare", status: "completed",
      cases: [{ binding: "confirmed", initialMaterials: [owned], evalInitialMaterials: [owned] }] });
    expect(f.createMaterials).not.toHaveBeenCalled();
    expect(f.createSessions).not.toHaveBeenCalled();
    expect(f.bindData).toHaveBeenCalledOnce();
  });

  it("reconciles a committed Dataset and Data binding after lost replies, without another write", async () => {
    const f = preparedFixture();
    f.loseDatasetResponse();
    expect((await f.app.call("prepare_inputs", f.input)).status).toBe(200);
    const progress = await toolValue(await f.app.call("get_preparation", { operationKey: f.input.operationKey }));
    expect(progress).toMatchObject({ status: "preparing", dataset: "attempted" });
    f.loseBindingResponse();
    await f.app.call("prepare_inputs", f.input);
    const blocked = await (await f.app.call("create_project", {
      idempotencyKey: "first-run", name: "Blocked", datasets: [{ datasetId: progress.datasetId }],
      samplingCount: 1, execution: { userAgentId: AGENT, framework: "sp", executionConcurrency: 1 },
      run: { operation: "execution" },
      expectedSnapshots: { datasets: [{ datasetId: progress.datasetId, digest: "a".repeat(64) }],
        executionAgent: "b".repeat(64) },
    })).json();
    expect(blocked).toMatchObject({ result: { isError: true } });
    expect(f.app.services.projects.create).not.toHaveBeenCalled();
    const completed = await toolValue(await f.app.call("prepare_inputs", f.input));
    expect(completed.status).toBe("completed");
    expect(f.importPromptDataset).toHaveBeenCalledTimes(1);
    expect(f.createMaterials).not.toHaveBeenCalled();
    expect(f.bindData).toHaveBeenCalledTimes(2);
  });

  it("recovers an atomically imported Prompt Dataset after the lost response and 24-hour upload expiry", async () => {
    const f = preparedFixture();
    f.loseDatasetResponse();
    const lost = await (await f.app.call("prepare_inputs", f.input)).json();
    expect(lost).toMatchObject({ result: { isError: true } });
    const progress = await toolValue(await f.app.call("get_preparation", { operationKey: f.input.operationKey }));
    expect(progress).toMatchObject({ status: "preparing", dataset: "attempted", totalCases: 2 });
    const plan = f.app.managed.operations.get(f.input.operationKey)!.plan;
    const parsed = parsePromptDatasetUpload(f.importPromptDataset.mock.calls[0]![0]).data;
    expect(plan.version).toBe(3);
    expect(plan.dataIds).toHaveLength(2);
    expect(plan.rowDigests).toEqual(await Promise.all(parsed.map(async (row, index) => ({
      original: await digestJson(row),
      bound: await digestJson({ ...row, ...f.input.cases[index] }),
    }))));
    expect(JSON.stringify(plan)).not.toContain("private task");

    const upload = f.app.managed.uploads.get(f.input.promptUploadRef)!;
    f.app.managed.uploads.set(f.input.promptUploadRef, { ...upload, expiresAt: new Date(0) });
    const read = vi.spyOn(f.app.managed.files, "read");
    const completed = await toolValue(await f.app.call("prepare_inputs", f.input));
    expect(completed).toEqual({ operationKey: f.input.operationKey, kind: "prepare", status: "completed",
      datasetId: progress.datasetId, totalCases: 2 });
    expect(read).not.toHaveBeenCalled();
    expect(f.importPromptDataset).toHaveBeenCalledTimes(1);
    expect(f.bindData).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.app.managed.operations.get(f.input.operationKey)?.plan)).not.toContain("private task");
    // A completed receipt must also be replayable without reopening the expired Prompt.
    expect(await toolValue(await f.app.call("prepare_inputs", f.input))).toEqual(completed);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects a changed persisted full Data row after a lost import reply even when the Prompt has expired", async () => {
    const f = preparedFixture();
    f.loseDatasetResponse();
    await f.app.call("prepare_inputs", f.input);
    const planned = f.app.managed.operations.get(f.input.operationKey)!.plan.dataIds as string[];
    const original = f.persisted.data.get(planned[1]!)!;
    // A change to an arbitrary Data field, not only the Prompt or binding refs, must fail closed.
    f.persisted.data.set(planned[1]!, { ...original, evaluationMetadata: { altered: true } });
    const upload = f.app.managed.uploads.get(f.input.promptUploadRef)!;
    f.app.managed.uploads.set(f.input.promptUploadRef, { ...upload, expiresAt: new Date(0) });
    const read = vi.spyOn(f.app.managed.files, "read");
    const result = await (await f.app.call("prepare_inputs", f.input)).json();
    expect(result).toMatchObject({ result: { isError: true,
      content: [{ text: expect.stringContaining("EVAL_SP_CONFLICT") }] } });
    expect(read).not.toHaveBeenCalled();
    expect(f.importPromptDataset).toHaveBeenCalledTimes(1);
    expect((await toolValue(await f.app.call("get_preparation", { operationKey: f.input.operationKey }))).dataset)
      .toBe("attempted");
  });

  it("fails closed on partial, reordered, foreign, soft-deleted or unproven persisted imports", async () => {
    for (const violation of ["partial", "order", "name", "foreign", "deleted-dataset", "deleted-data", "unknown-order"]) {
      const f = preparedFixture();
      f.loseDatasetResponse();
      await f.app.call("prepare_inputs", f.input);
      const operation = f.app.managed.operations.get(f.input.operationKey)!;
      const datasetId = operation.plan.datasetId as string;
      const ids = operation.plan.dataIds as string[];
      switch (violation) {
        case "partial": f.persisted.memberships.set(datasetId, [ids[0]!]); break;
        case "order": f.persisted.memberships.set(datasetId, [...ids].reverse()); break;
        case "name": f.persisted.datasets.set(datasetId, { ...f.persisted.datasets.get(datasetId)!, name: "Wrong" }); break;
        case "foreign": f.persisted.foreignDatasets.add(datasetId); break;
        case "deleted-dataset": f.persisted.deletedDatasets.add(datasetId); break;
        case "deleted-data": f.persisted.deletedData.add(ids[1]!); break;
        case "unknown-order": f.persisted.unprovenOrder.add(datasetId); break;
      }
      const upload = f.app.managed.uploads.get(f.input.promptUploadRef)!;
      f.app.managed.uploads.set(f.input.promptUploadRef, { ...upload, expiresAt: new Date(0) });
      const read = vi.spyOn(f.app.managed.files, "read");
      const result = await (await f.app.call("prepare_inputs", f.input)).json();
      expect(result, violation).toMatchObject({ result: { isError: true,
        content: [{ text: expect.stringContaining("EVAL_SP_CONFLICT") }] } });
      expect(read, violation).not.toHaveBeenCalled();
      expect(f.importPromptDataset, violation).toHaveBeenCalledTimes(1);
      expect(f.bindData, violation).not.toHaveBeenCalled();
    }
  });

  it("replays a rolled-back atomic import under the same planned IDs while Prompt staging is valid", async () => {
    const f = preparedFixture();
    f.importPromptDataset.mockRejectedValueOnce(new Error("atomic import rolled back before a receipt"));
    const first = await (await f.app.call("prepare_inputs", f.input)).json();
    expect(first).toMatchObject({ result: { isError: true } });
    const pending = f.app.managed.operations.get(f.input.operationKey)!;
    expect(pending.stages.dataset?.status).toBe("attempted");
    const datasetId = pending.plan.datasetId as string;
    const dataIds = pending.plan.dataIds as string[];
    const read = vi.spyOn(f.app.managed.files, "read");
    const recovered = await toolValue(await f.app.call("prepare_inputs", f.input));
    expect(recovered).toEqual({ operationKey: f.input.operationKey, kind: "prepare", status: "completed",
      datasetId, totalCases: dataIds.length });
    expect(read).toHaveBeenCalledOnce();
    expect(f.importPromptDataset).toHaveBeenCalledTimes(2);
    expect(f.importPromptDataset.mock.calls[1]![0]).toEqual(f.importPromptDataset.mock.calls[0]![0]);
    expect(f.importPromptDataset.mock.calls[0]![1]).toEqual({ datasetId, dataIds });
    expect(f.importPromptDataset.mock.calls[1]![1]).toEqual(f.importPromptDataset.mock.calls[0]![1]);
    expect(f.persisted.datasets.size).toBe(1);
    expect(f.persisted.memberships.get(datasetId)).toEqual(dataIds);
    expect(f.persisted.data.size).toBe(dataIds.length);
    expect(f.app.managed.operations.get(f.input.operationKey)?.status).toBe("completed");
  });

  it("keeps an absent attempted import outcome unknown when its staged Prompt has expired", async () => {
    const f = preparedFixture();
    f.importPromptDataset.mockRejectedValueOnce(new Error("atomic import rolled back before a receipt"));
    expect((await (await f.app.call("prepare_inputs", f.input)).json())).toMatchObject({
      result: { isError: true },
    });
    const upload = f.app.managed.uploads.get(f.input.promptUploadRef)!;
    f.app.managed.uploads.set(f.input.promptUploadRef, { ...upload, expiresAt: new Date(0) });
    const read = vi.spyOn(f.app.managed.files, "read");
    const uncertain = await (await f.app.call("prepare_inputs", f.input)).json();
    expect(uncertain).toMatchObject({ result: { isError: true,
      content: [{ text: expect.stringContaining("OPERATION_OUTCOME_UNKNOWN") }] } });
    expect(read).not.toHaveBeenCalled();
    expect(f.importPromptDataset).toHaveBeenCalledOnce();
    expect(f.persisted.datasets.size).toBe(0);
    expect(f.app.managed.operations.get(f.input.operationKey)?.stages.dataset?.status).toBe("attempted");
  });

  it.each(["sha256", "byteSize"] as const)(
    "does not locally replay an absent attempted import with changed staged Prompt %s", async (field) => {
      const f = preparedFixture();
      f.importPromptDataset.mockRejectedValueOnce(new Error("atomic import rolled back before a receipt"));
      expect((await (await f.app.call("prepare_inputs", f.input)).json())).toMatchObject({
        result: { isError: true },
      });
      const upload = f.app.managed.uploads.get(f.input.promptUploadRef)!;
      f.app.managed.uploads.set(f.input.promptUploadRef, {
        ...upload, [field]: field === "sha256" ? "f".repeat(64) : upload.byteSize + 1,
      });
      const read = vi.spyOn(f.app.managed.files, "read");
      const replay = await (await f.app.call("prepare_inputs", f.input)).json();
      expect(replay).toMatchObject({ result: { isError: true,
        content: [{ text: expect.stringContaining("EVAL_SP_CONFLICT") }] } });
      expect(read).not.toHaveBeenCalled();
      expect(f.importPromptDataset).toHaveBeenCalledOnce();
    },
  );

  it("confirms a concurrent first import that bound rows before the atomic same-ID replay returned a conflict", async () => {
    const f = preparedFixture();
    f.importPromptDataset.mockRejectedValueOnce(new Error("first attempt rolled back"));
    expect((await (await f.app.call("prepare_inputs", f.input)).json())).toMatchObject({
      result: { isError: true },
    });
    const plan = f.app.managed.operations.get(f.input.operationKey)!.plan;
    const datasetId = plan.datasetId as string;
    const dataIds = plan.dataIds as string[];
    const importOnce = f.importPromptDataset.getMockImplementation()!;
    f.importPromptDataset.mockImplementationOnce(async (upload, planned) => {
      // Model the *other* caller committing an atomic import and binding its rows
      // before this replay's identity check sees those now-bound Data contents.
      await importOnce(upload, planned);
      for (const [index, dataId] of planned.dataIds.entries()) {
        f.persisted.data.set(dataId, { ...f.persisted.data.get(dataId)!, ...f.input.cases[index]! });
      }
      throw new Error("atomic identity replay sees another caller's already-bound Data");
    });
    expect(await toolValue(await f.app.call("prepare_inputs", f.input))).toEqual({
      operationKey: f.input.operationKey, kind: "prepare", status: "completed", datasetId, totalCases: 2,
    });
    expect(f.importPromptDataset).toHaveBeenCalledTimes(2);
    expect(f.importPromptDataset.mock.calls[1]![1]).toEqual({ datasetId, dataIds });
    expect(f.persisted.datasets.size).toBe(1);
    expect(f.persisted.memberships.get(datasetId)).toEqual(dataIds);
    expect(f.bindData).not.toHaveBeenCalled();
  });

  it("rejects a v2 preparation receipt instead of finalizing it with unverified row content", async () => {
    const f = preparedFixture();
    await toolValue(await f.app.call("prepare_inputs", f.input));
    const completed = f.app.managed.operations.get(f.input.operationKey)!;
    f.app.managed.operations.set(f.input.operationKey, {
      ...completed, status: "pending", plan: { ...completed.plan, version: 2 },
    });
    const detail = await (await f.app.call("get_preparation", { operationKey: f.input.operationKey })).json();
    expect(detail).toMatchObject({ result: { isError: true,
      content: [{ text: expect.stringContaining("RESPONSE_INVALID") }] } });
    const replay = await (await f.app.call("prepare_inputs", f.input)).json();
    expect(replay).toMatchObject({ result: { isError: true,
      content: [{ text: expect.stringContaining("EVAL_SP_CONFLICT") }] } });
    await expect(f.app.managed.store.complete(OWNER, f.input.operationKey)).rejects.toThrow();
    expect(f.importPromptDataset).toHaveBeenCalledOnce();
  });

  it("rejects an incomplete row-hash plan from get_preparation, completion and replay", async () => {
    const f = preparedFixture();
    await toolValue(await f.app.call("prepare_inputs", f.input));
    const completed = f.app.managed.operations.get(f.input.operationKey)!;
    f.app.managed.operations.set(f.input.operationKey, { ...completed, status: "pending",
      plan: { ...completed.plan, rowDigests: [] } });
    expect((await (await f.app.call("get_preparation", { operationKey: f.input.operationKey })).json()))
      .toMatchObject({ result: { isError: true,
        content: [{ text: expect.stringContaining("RESPONSE_INVALID") }] } });
    expect((await (await f.app.call("prepare_inputs", f.input)).json()))
      .toMatchObject({ result: { isError: true,
        content: [{ text: expect.stringContaining("EVAL_SP_CONFLICT") }] } });
    await expect(f.app.managed.store.complete(OWNER, f.input.operationKey)).rejects.toThrow();
  });

  it("reconciles a bound row when the Dataset stage's confirmation was lost, without reopening the Prompt", async () => {
    const f = preparedFixture();
    const completed = await toolValue(await f.app.call("prepare_inputs", f.input));
    const operation = f.app.managed.operations.get(f.input.operationKey)!;
    f.app.managed.operations.set(f.input.operationKey, { ...operation, status: "pending",
      stages: { ...operation.stages, dataset: { status: "attempted" } } });
    const upload = f.app.managed.uploads.get(f.input.promptUploadRef)!;
    f.app.managed.uploads.set(f.input.promptUploadRef, { ...upload, expiresAt: new Date(0) });
    const read = vi.spyOn(f.app.managed.files, "read");
    expect(await toolValue(await f.app.call("prepare_inputs", f.input))).toEqual(completed);
    expect(read).not.toHaveBeenCalled();
    expect(f.importPromptDataset).toHaveBeenCalledTimes(1);
    expect(f.bindData).toHaveBeenCalledTimes(2);
  });

  it("does not replay a completed Dataset whose persisted Data content has since changed", async () => {
    const f = preparedFixture();
    await toolValue(await f.app.call("prepare_inputs", f.input));
    const id = (f.app.managed.operations.get(f.input.operationKey)!.plan.dataIds as string[])[0]!;
    f.persisted.data.set(id, { ...f.persisted.data.get(id)!, extraField: "changed after completion" });
    const upload = f.app.managed.uploads.get(f.input.promptUploadRef)!;
    f.app.managed.uploads.set(f.input.promptUploadRef, { ...upload, expiresAt: new Date(0) });
    const read = vi.spyOn(f.app.managed.files, "read");
    expect((await (await f.app.call("prepare_inputs", f.input)).json())).toMatchObject({
      result: { isError: true, content: [{ text: expect.stringContaining("EVAL_SP_CONFLICT") }] },
    });
    expect(read).not.toHaveBeenCalled();
    expect(f.importPromptDataset).toHaveBeenCalledOnce();
  });

  it("does not adopt a forged same-key winner with different upload bytes, row hashes or request", async () => {
    for (const violation of ["byteSize", "sha256", "originalHash", "boundHash", "description"]) {
      const f = preparedFixture();
      await toolValue(await f.app.call("prepare_inputs", f.input));
      const saved = f.app.managed.operations.get(f.input.operationKey)!;
      const plan = saved.plan as unknown as { uploadFact: UploadFact; rowDigests: PreparationRowDigests[];
        description: string };
      const fact = { ...plan.uploadFact };
      const digests = plan.rowDigests.map((row) => ({ ...row }));
      const forged = { ...saved.plan, uploadFact: fact, rowDigests: digests, description: plan.description };
      if (violation === "byteSize") fact.byteSize += 1;
      if (violation === "sha256") fact.sha256 = "f".repeat(64);
      if (violation === "originalHash") digests[0]!.original = "f".repeat(64);
      if (violation === "boundHash") digests[0]!.bound = "f".repeat(64);
      if (violation === "description") forged.description = "Another intent";
      const request = prepareInputsSchema.parse({ ...f.input, description: forged.description });
      const fingerprint = preparationFingerprint(OWNER, request, fact, digests);
      f.app.managed.operations.set(f.input.operationKey, { ...saved, plan: forged, fingerprint });

      // The other caller already generated new random IDs before learning about this winner.
      const get = f.app.managed.store.get.bind(f.app.managed.store);
      let firstRead = true;
      vi.spyOn(f.app.managed.store, "get").mockImplementation(async (...args) => {
        if (firstRead) { firstRead = false; return null; }
        return get(...args);
      });
      const replay = await (await f.app.call("prepare_inputs", f.input)).json();
      expect(replay, violation).toMatchObject({ result: { isError: true,
        content: [{ text: expect.stringContaining("EVAL_SP_CONFLICT") }] } });
      expect(f.importPromptDataset, violation).toHaveBeenCalledOnce();
    }
  });

  it("uses the persisted winner of two concurrent first plans with random IDs and imports only once", async () => {
    const f = preparedFixture();
    const originalBegin = f.app.managed.store.begin.bind(f.app.managed.store);
    const proposed: Record<string, unknown>[] = [];
    let arrived = 0;
    let bothReady!: () => void;
    let winnerFinished!: () => void;
    const bothPlanned = new Promise<void>((resolve) => { bothReady = resolve; });
    const winnerComplete = new Promise<void>((resolve) => { winnerFinished = resolve; });
    vi.spyOn(f.app.managed.store, "begin").mockImplementation(async (...args) => {
      if (args[2] === "prepare" && arrived < 2) {
        proposed.push(args[4]);
        const position = ++arrived;
        if (position === 2) bothReady();
        await bothPlanned; // Both calls planned different random IDs before the first begin.
        if (position === 2) await winnerComplete; // The loser reaches begin after the atomic winner commits.
      }
      return originalBegin(...args);
    });

    const first = f.app.call("prepare_inputs", f.input);
    const second = f.app.call("prepare_inputs", f.input);
    let winner: Record<string, unknown>;
    try {
      winner = await toolValue(await first);
    } finally {
      winnerFinished();
    }
    const replay = await toolValue(await second);
    expect(proposed).toHaveLength(2);
    expect(proposed[0]!.datasetId).not.toBe(proposed[1]!.datasetId);
    expect(proposed[0]!.dataIds).not.toEqual(proposed[1]!.dataIds);
    expect(replay).toEqual(winner);
    expect(f.importPromptDataset).toHaveBeenCalledTimes(1);
    expect(f.bindData).toHaveBeenCalledTimes(2);
    const changed = await (await f.app.call("prepare_inputs", { ...f.input, description: "different" })).json();
    expect(changed).toMatchObject({ result: { isError: true,
      content: [{ text: expect.stringContaining("EVAL_SP_CONFLICT") }] } });
  });

  it("waits read-only for an in-flight winner rather than importing the same Prompt twice", async () => {
    const f = preparedFixture();
    const store = f.app.managed.store;
    const originalBegin = store.begin.bind(store);
    const originalInspect = store.inspectPreparedDataset.bind(store);
    const originalImport = f.importPromptDataset.getMockImplementation()!;
    let bothReady!: () => void;
    let importStarted!: () => void;
    let finishImport!: () => void;
    const bothPlanned = new Promise<void>((resolve) => { bothReady = resolve; });
    const duringImport = new Promise<void>((resolve) => { importStarted = resolve; });
    const canCommit = new Promise<void>((resolve) => { finishImport = resolve; });
    let arrived = 0;
    let importing = false;
    let sawAbsentDuringImport = false;
    vi.spyOn(store, "begin").mockImplementation(async (...args) => {
      if (args[2] === "prepare" && arrived < 2) {
        const position = ++arrived;
        if (position === 2) bothReady();
        await bothPlanned;
        if (position === 2) await duringImport;
      }
      return originalBegin(...args);
    });
    f.importPromptDataset.mockImplementation(async (...args) => {
      importing = true;
      importStarted();
      await canCommit;
      return originalImport(...args);
    });
    vi.spyOn(store, "inspectPreparedDataset").mockImplementation(async (...args) => {
      const snapshot = await originalInspect(...args);
      if (!snapshot && importing) {
        sawAbsentDuringImport = true;
        finishImport(); // The winner's atomic commit becomes visible only after the loser saw absence.
      }
      return snapshot;
    });

    const first = f.app.call("prepare_inputs", f.input);
    const second = f.app.call("prepare_inputs", f.input);
    const later = await second;
    finishImport();
    const winner = await toolValue(await first);
    expect(sawAbsentDuringImport).toBe(true);
    expect(await toolValue(later)).toEqual(winner);
    expect(f.importPromptDataset).toHaveBeenCalledTimes(1);
  });

  it("does not let a preparation key adopt an initial-resource operation or reimport its claimed Prompt", async () => {
    const f = preparedFixture();
    await toolValue(await f.app.call("prepare_inputs", f.input));
    const newUpload = f.app.managed.addUpload("material", "separate.txt", encode("already saved"), "text/plain");
    const otherKind = await (await f.app.call("save_initial_resource", {
      operationKey: f.input.operationKey, kind: "material", uploadRef: newUpload,
    })).json();
    expect(otherKind).toMatchObject({ result: { isError: true,
      content: [{ text: expect.stringContaining("EVAL_SP_CONFLICT") }] } });
    const newKey = await (await f.app.call("prepare_inputs", { ...f.input, operationKey: "another-key" })).json();
    expect(newKey).toMatchObject({ result: { isError: true,
      content: [{ text: expect.stringContaining("EVAL_SP_CONFLICT") }] } });
    expect(f.importPromptDataset).toHaveBeenCalledOnce();
    expect(f.createMaterials).not.toHaveBeenCalled();
  });

  it("saves Material and Session without a case, lists their active IDs, then imports new Prompt Data using only those IDs", async () => {
    const f = preparedFixture();
    const materialRef = f.app.managed.addUpload("material", "new.txt", encode("staged private material"), "text/plain");
    const sessionRef = f.app.managed.addUpload("session", "new.jsonl", session, "application/x-ndjson");
    const material = await toolValue(await f.app.call("save_initial_resource", {
      operationKey: "standalone-material", kind: "material", uploadRef: materialRef,
    }));
    const context = await toolValue(await f.app.call("save_initial_resource", {
      operationKey: "standalone-session", kind: "session", uploadRef: sessionRef, format: "jsonl",
    }));
    expect(material).toEqual({ operationKey: "standalone-material", kind: "initial_resource",
      resourceKind: "material", status: "completed", bundleId: expect.any(String), materialId: expect.any(String) });
    expect(context).toEqual({ operationKey: "standalone-session", kind: "initial_resource",
      resourceKind: "session", status: "completed", bundleId: expect.any(String), sessionId: expect.any(String) });
    const listedMaterials = await toolValue(await f.app.call("list_options", {
      category: "materials", bundleId: material.bundleId,
    }));
    const listedSessions = await toolValue(await f.app.call("list_options", {
      category: "sessions", bundleId: context.bundleId,
    }));
    expect(listedMaterials).toMatchObject({ total: 1, items: [
      { bundleId: material.bundleId, materialId: material.materialId, byteSize: 23 },
    ] });
    expect(listedSessions).toMatchObject({ total: 1, items: [
      { bundleId: context.bundleId, sessionId: context.sessionId, format: "jsonl" },
    ] });
    const materialChoice = { bundleId: material.bundleId, materialId: material.materialId };
    const sessionChoice = { bundleId: context.bundleId, sessionId: context.sessionId };
    const input = { ...f.input, operationKey: "new-with-independent-resources",
      cases: [{ initialMaterials: [materialChoice], evalInitialMaterials: [materialChoice], initialSession: sessionChoice },
        { initialMaterials: [materialChoice] }] };
    const created = await toolValue(await f.app.call("prepare_inputs", input));
    expect(created).toEqual({ operationKey: input.operationKey, kind: "prepare", status: "completed",
      datasetId: expect.any(String), totalCases: 2 });
    const detail = await toolValue(await f.app.call("get_preparation", { operationKey: input.operationKey }));
    expect(detail).toMatchObject({ cases: [
      { binding: "confirmed", initialMaterials: [materialChoice], evalInitialMaterials: [materialChoice],
        initialSession: sessionChoice },
      { binding: "confirmed", initialMaterials: [materialChoice] },
    ] });
    expect(f.createMaterials).toHaveBeenCalledTimes(1); // save, not prepare_inputs
    expect(f.createSessions).toHaveBeenCalledTimes(1);
    expect(f.importPromptDataset).toHaveBeenCalledOnce();
    expect(f.bindData).toHaveBeenCalledTimes(2);
    expect(JSON.stringify([created, detail])).not.toMatch(/staged private material|Earlier context|uploadRef|https?:\/\//u);
  });

  it("rejects modified facts and Prompt rows with initial refs before starting the operation", async () => {
    const f = preparedFixture();
    const first = await toolValue(await f.app.call("prepare_inputs", f.input));
    const changed = await (await f.app.call("prepare_inputs", { ...f.input, description: "different" })).json();
    expect(changed).toMatchObject({ result: { isError: true } });
    const invalid = preparedFixture();
    const badRef = invalid.app.managed.addUpload("prompt", "bad.jsonl", encode(JSON.stringify({
      ...promptRow("bad"), initialSession: { bundleId: crypto.randomUUID(), sessionId: crypto.randomUUID() },
    })));
    const rejected = await (await invalid.app.call("prepare_inputs", {
      ...invalid.input, promptUploadRef: badRef, cases: [{}],
    })).json();
    expect(rejected).toMatchObject({ result: { isError: true } });
    const inlineUpload = invalid.app.managed.addUpload("material", "inline.txt", encode("not a case attachment"));
    for (const caseInput of [
      { initialMaterials: [{ uploadRef: inlineUpload }] },
      { initialSession: { uploadRef: crypto.randomUUID(), format: "jsonl" } },
    ]) {
      const inline = await (await invalid.app.call("prepare_inputs", {
        ...invalid.input, cases: [caseInput, {}],
      })).json();
      expect(inline).toMatchObject({ result: { isError: true,
        content: [{ text: expect.stringContaining("REQUEST_INVALID_INPUT") }] } });
    }
    expect(first.status).toBe("completed");
    expect(invalid.importPromptDataset).not.toHaveBeenCalled();
    expect(invalid.app.managed.operations.size).toBe(0);
  });
});
