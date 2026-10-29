import { parsePromptDatasetUpload } from "@eval-platform/eval-dataset";
import { describe, expect, it, vi } from "vitest";
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
      getResource: async (bundleId: string) => materials.get(bundleId)!.resource,
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
  return { app, input, importPromptDataset, bindData, createMaterials, createSessions,
    loseDatasetResponse: () => { loseDatasetResponse = true; },
    loseMaterialResponse: () => { loseMaterialResponse = true; },
    loseBindingResponse: () => { loseBindingResponse = true; } };
}

describe("durable management preparation", () => {
  it("imports raw Prompt rows first, binds Subject/Evaluator separately, and reuses shared Materials once", async () => {
    const f = preparedFixture();
    const result = await toolValue(await f.app.call("prepare_inputs", f.input));
    expect(result).toMatchObject({ kind: "prepare", status: "completed", cases: [
      { initialMaterials: [expect.objectContaining({ bundleId: expect.any(String), materialId: expect.any(String) })],
        evalInitialMaterials: [expect.objectContaining({ bundleId: expect.any(String), materialId: expect.any(String) })],
        initialSession: { bundleId: expect.any(String), sessionId: expect.any(String) } },
      { initialMaterials: [expect.objectContaining({ materialId: expect.any(String) })], evalInitialMaterials: [] },
    ] });
    const args = f.importPromptDataset.mock.calls[0]!;
    expect(args[0].content).not.toContain("initialMaterials");
    expect(args[1].dataIds).toEqual((result.cases as Array<{ dataId: string }>).map((row) => row.dataId));
    expect(f.createMaterials).toHaveBeenCalledTimes(2);
    expect(f.createSessions).toHaveBeenCalledTimes(1);
    expect(f.bindData).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ resources: { total: 3, confirmed: 3,
      items: expect.arrayContaining([{ kind: "session", status: "confirmed",
        bundleId: expect.any(String), resourceId: expect.any(String) }]) } });
    expect(f.app.services.projects.create).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private task");
    const second = await toolValue(await f.app.call("get_preparation", {
      operationKey: f.input.operationKey, page: 2, pageSize: 1,
    }));
    expect(second).toMatchObject({ page: 2, pageSize: 1, totalCases: 2,
      cases: [{ dataId: (result.cases as Array<{ dataId: string }>)[1]!.dataId }] });
    expect(await toolValue(await f.app.call("prepare_inputs", f.input))).toEqual(result);
    expect(f.importPromptDataset).toHaveBeenCalledTimes(1);
    expect(f.createMaterials).toHaveBeenCalledTimes(2);
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
