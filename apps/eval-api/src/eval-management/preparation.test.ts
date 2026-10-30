import { parsePromptDatasetUpload } from "@eval-platform/eval-dataset";
import { EVAL_INITIAL_FILE_MAX_BYTES, EVAL_INITIALIZATION_MAX_BYTES } from "@springbrand/eval-harness";
import { describe, expect, it, vi } from "vitest";
import { IMPORT_LIMITS } from "../agent-imports/model.js";
import { BundleResourceNotFoundError } from "../db/errors.js";
import { AGENT, setupManagement, toolValue } from "./test-fixture.js";

const encode = (text: string) => new TextEncoder().encode(text);
const promptRow = (name: string) => ({
  name, description: `${name} case`, userPrompt: `private task ${name}`, evalPrompt: `Judge ${name}`,
});
const session = encode(`${JSON.stringify({
  id: "m1", message: { role: "user", content: "Earlier context", timestamp: 1 }, createdAt: 1,
})}\n`);

function preparedFixture() {
  const app = setupManagement();
  const subject = app.managed.addUpload("material", "subject.txt", encode("subject bytes"), "text/plain");
  const evaluator = app.managed.addUpload("material", "judge.txt", encode("evaluator bytes"), "text/plain");
  const context = app.managed.addUpload("session", "history.jsonl", session, "application/x-ndjson");
  const promptUploadRef = app.managed.addUpload("prompt", "cases.jsonl",
    encode(`${JSON.stringify(promptRow("one"))}\n${JSON.stringify(promptRow("two"))}\n`), "application/x-ndjson");
  const input = {
    operationKey: "prepare-1", promptUploadRef, name: "Dataset", description: "Requirements", format: "jsonl",
    cases: [
      { initialMaterials: [{ uploadRef: subject }], evalInitialMaterials: [{ uploadRef: evaluator }],
        initialSession: { uploadRef: context, format: "jsonl" } },
      { initialMaterials: [{ uploadRef: subject }] },
    ],
  };
  const datasets = new Map<string, { datasetId: string; name: string; description: string }>();
  const data = new Map<string, Record<string, unknown>>();
  const memberships = new Map<string, string[]>();
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
  let loseMaterialResponse = false;
  const createMaterials = vi.fn(async (labels: { name: string; description: string },
    inputs: Array<{ files: Array<{ path: string; mediaType: string; contentBase64: string }> }>,
    planned: { bundleId: string; resourceIds: readonly string[] }) => {
    materials.set(planned.bundleId, { bundle: { bundleId: planned.bundleId, ...labels },
      resource: { bundleId: planned.bundleId, materialId: planned.resourceIds[0], ...labels,
        byteSize: Buffer.byteLength(inputs[0]!.files[0]!.contentBase64, "base64") }, files: inputs[0]!.files });
    if (loseMaterialResponse) { loseMaterialResponse = false; throw new Error("material response lost after commit"); }
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
      get: async (id: string) => materials.get(id)?.bundle ?? null,
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
      get: async (id: string) => sessions.get(id)?.bundle ?? null,
      getResource: async (bundleId: string) => sessions.get(bundleId)!.resource,
      getFile: async (bundleId: string) => ({
        bytes: Buffer.from(sessions.get(bundleId)!.content, "utf8"),
      }),
    },
  });
  return { app, input, importPromptDataset, bindData, createMaterials, createSessions, addExistingMaterial, hideMaterial,
    loseDatasetResponse: () => { loseDatasetResponse = true; },
    loseMaterialResponse: () => { loseMaterialResponse = true; },
    loseBindingResponse: () => { loseBindingResponse = true; } };
}

describe("durable management preparation", () => {
  it("imports raw Prompt rows first, binds Subject/Evaluator separately, and reuses shared Materials once", async () => {
    const f = preparedFixture();
    const result = await toolValue(await f.app.call("prepare_inputs", f.input));
    expect(result).toEqual({ operationKey: f.input.operationKey, kind: "prepare", status: "completed",
      datasetId: expect.any(String), totalCases: 2, resources: { total: 3, confirmed: 3 } });
    const detail = await toolValue(await f.app.call("get_preparation", {
      operationKey: f.input.operationKey, pageSize: 1,
    }));
    expect(detail).toMatchObject({ page: 1, pageSize: 1, totalCases: 2, cases: [
      { initialMaterials: [expect.objectContaining({ bundleId: expect.any(String), materialId: expect.any(String) })],
        evalInitialMaterials: [expect.objectContaining({ bundleId: expect.any(String), materialId: expect.any(String) })],
        initialSession: { bundleId: expect.any(String), sessionId: expect.any(String) } },
    ], resources: { total: 3, confirmed: 3,
      items: expect.arrayContaining([{ kind: "session", status: "confirmed",
        bundleId: expect.any(String), resourceId: expect.any(String) }]) } });
    const args = f.importPromptDataset.mock.calls[0]!;
    expect(args[0].content).not.toContain("initialMaterials");
    expect(args[1].dataIds[0]).toBe((detail.cases as Array<{ dataId: string }>)[0]!.dataId);
    expect(f.createMaterials).toHaveBeenCalledTimes(2);
    expect(f.createSessions).toHaveBeenCalledTimes(1);
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
    expect(f.createMaterials).toHaveBeenCalledTimes(2);
  });

  it("returns a compact exact-replay receipt for five cases with 85 distinct resources, leaving detail to one-case pages", async () => {
    const f = preparedFixture();
    const cases = Array.from({ length: 5 }, (_, index) => {
      const materials = (role: string) => Array.from({ length: 8 }, (_, item) => ({
        uploadRef: f.app.managed.addUpload("material", `${role}-${index}-${item}.txt`, encode("small"), "text/plain"),
      }));
      return {
        initialMaterials: materials("subject"),
        evalInitialMaterials: materials("evaluator"),
        initialSession: { uploadRef: f.app.managed.addUpload("session", `session-${index}.jsonl`, session),
          format: "jsonl" as const },
      };
    });
    const promptUploadRef = f.app.managed.addUpload("prompt", "five.jsonl",
      encode(Array.from({ length: cases.length }, (_, index) => JSON.stringify(promptRow(`case-${index}`))).join("\n")));
    const input = { ...f.input, promptUploadRef, cases, operationKey: "prepare-85" };
    const refs = new Set([promptUploadRef, ...cases.flatMap((row) => [
      ...row.initialMaterials, ...row.evalInitialMaterials, row.initialSession,
    ].map((item) => item.uploadRef))]);
    expect(refs.size).toBe(86); // Within the existing 101-ref bound.
    expect([...refs].reduce((total, ref) => total + f.app.managed.uploads.get(ref)!.byteSize, 0))
      .toBeLessThan(IMPORT_LIMITS.totalBytes);

    const result = await toolValue(await f.app.call("prepare_inputs", input));
    expect(result).toEqual({ operationKey: input.operationKey, kind: "prepare", status: "completed",
      datasetId: expect.any(String), totalCases: 5, resources: { total: 85, confirmed: 85 } });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(5 * 1024);
    expect(JSON.stringify(result)).not.toMatch(/"cases"|"items"|"uploadRef"|"initialMaterials"/u);
    const detail = await toolValue(await f.app.call("get_preparation", { operationKey: input.operationKey, pageSize: 1 }));
    expect(detail).toMatchObject({ page: 1, pageSize: 1, totalCases: 5, cases: [expect.objectContaining({
      initialMaterials: expect.any(Array), evalInitialMaterials: expect.any(Array),
    })], resources: { total: 85, confirmed: 85, items: expect.any(Array) } });
    expect((detail.cases as unknown[]).length).toBe(1);
    expect((detail.resources as { items: unknown[] }).items.length).toBe(17);
    expect(await toolValue(await f.app.call("prepare_inputs", input))).toEqual(result);
    expect(f.importPromptDataset).toHaveBeenCalledTimes(1);
    expect(f.createMaterials).toHaveBeenCalledTimes(80);
    expect(f.createSessions).toHaveBeenCalledTimes(5);
  });

  it.each(["initialMaterials", "evalInitialMaterials"] as const)(
    "rejects five 5 MB existing+uploaded Materials in one %s before any operation or Bundle write", async (field) => {
      const f = preparedFixture();
      const existing = Array.from({ length: 2 }, () => f.addExistingMaterial(EVAL_INITIAL_FILE_MAX_BYTES));
      const uploaded = Array.from({ length: 3 }, (_, index) => ({
        uploadRef: f.app.managed.addUpload("material", `${field}-${index}.bin`,
          new Uint8Array(EVAL_INITIAL_FILE_MAX_BYTES), "application/octet-stream"),
      }));
      const promptUploadRef = f.app.managed.addUpload("prompt", "budget.jsonl", encode(JSON.stringify(promptRow("budget"))));
      const input = { ...f.input, operationKey: `over-budget-${field}`, promptUploadRef,
        cases: [{ [field]: [...existing, ...uploaded] }] };
      expect((existing.length + uploaded.length) * EVAL_INITIAL_FILE_MAX_BYTES).toBeGreaterThan(EVAL_INITIALIZATION_MAX_BYTES);

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
    const existing = Array.from({ length: 2 }, () => f.addExistingMaterial(EVAL_INITIAL_FILE_MAX_BYTES));
    const uploaded = Array.from({ length: 2 }, (_, index) => ({
      uploadRef: f.app.managed.addUpload("material", `allowed-${index}.bin`,
        new Uint8Array(EVAL_INITIAL_FILE_MAX_BYTES), "application/octet-stream"),
    }));
    const promptUploadRef = f.app.managed.addUpload("prompt", "budget.jsonl", encode(JSON.stringify(promptRow("budget"))));
    const selections = [...existing, ...uploaded];
    const input = { ...f.input, operationKey: "within-budget", promptUploadRef,
      cases: [{ initialMaterials: selections, evalInitialMaterials: selections }] };
    expect(selections.length * EVAL_INITIAL_FILE_MAX_BYTES).toBe(EVAL_INITIALIZATION_MAX_BYTES);
    expect(await toolValue(await f.app.call("prepare_inputs", input))).toMatchObject({
      kind: "prepare", status: "completed", totalCases: 1, resources: { total: 2, confirmed: 2 },
    });
    expect(f.createMaterials).toHaveBeenCalledTimes(2);
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

  it("reconciles a committed Dataset, Material and Data binding after lost responses without another write", async () => {
    const f = preparedFixture();
    f.loseDatasetResponse();
    expect((await f.app.call("prepare_inputs", f.input)).status).toBe(200);
    const progress = await toolValue(await f.app.call("get_preparation", { operationKey: f.input.operationKey }));
    expect(progress).toMatchObject({ status: "preparing", dataset: "attempted" });
    f.loseMaterialResponse();
    await f.app.call("prepare_inputs", f.input);
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
    expect(f.createMaterials).toHaveBeenCalledTimes(2);
    expect(f.bindData).toHaveBeenCalledTimes(2);
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
    expect(first.status).toBe("completed");
    expect(invalid.importPromptDataset).not.toHaveBeenCalled();
    expect(invalid.app.managed.operations.size).toBe(0);
  });
});
