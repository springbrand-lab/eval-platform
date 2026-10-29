import { describe, expect, it, vi } from "vitest";
import { AGENT, DATASET, OWNER, setupManagement, toolValue } from "./test-fixture.js";

const FIRST = "55555555-5555-4555-8555-555555555555";
const SECOND = "66666666-6666-4666-8666-666666666666";
const BUNDLE = "77777777-7777-4777-8777-777777777777";
const MATERIAL = "88888888-8888-4888-8888-888888888888";

async function errorCode(response: Response) {
  const rpc = await response.json() as { result: { isError: boolean; content: [{ text: string }] } };
  expect(rpc.result.isError).toBe(true);
  return rpc.result.content[0].text;
}

describe("trusted approval selections through the existing list_options tool", () => {
  it("binds a selectable Agent's purpose to the complete owned SP config without exposing its body", async () => {
    const app = setupManagement();
    const config = { id: AGENT, user_id: OWNER, name: "Agent",
      setting: { presetId: null, model: "provider/model", systemPrompt: "PRIVATE_PROMPT",
        authoring: { goal: "PRIVATE_GOAL", inputs: "", exampleInput: "", instructionsMode: "manual" },
        referenceNotes: "PRIVATE_NOTES", preferredSupplierIds: ["supplier/team"], skillIds: ["sp/skill"],
        mcpServers: [{ serverId: "private-mcp" }], sandbox: { url: "https://private.example", token: "PRIVATE_TOKEN" } } };
    Object.assign(app.services.agentConfigs, { get: vi.fn(async () => config) });
    const input = { category: "approval_agent", userAgentId: AGENT };
    const initial = await toolValue(await app.call("list_options", input));
    expect(initial).toEqual({
      category: "approval_agent", userAgentId: AGENT, name: "Agent", purpose: "execution",
      configDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      resources: {
        modelId: null, model: "provider/model",
        preferredSupplierIds: ["supplier/team"], referenceNotesChars: "PRIVATE_NOTES".length, authoringPresent: true,
        skillIds: ["sp/skill"], referenceFileIds: [], actionIds: [],
        connectorIds: [], extensionIds: [], subagentNames: [],
        mcpServers: [{ kind: "managed", serverId: "private-mcp" }],
        toolPolicy: { allow: [], deny: [] },
      },
    });
    expect(JSON.stringify(initial)).not.toMatch(/PRIVATE_|https:\/\//u);
    config.setting.systemPrompt = "changed";
    expect((await toolValue(await app.call("list_options", input))).configDigest).not.toBe(initial.configDigest);
    Object.assign(config.setting, { extraResourceSelections: ["PRIVATE_TOKEN"] });
    expect(await errorCode(await app.call("list_options", input))).toContain("RESPONSE_INVALID");
    config.user_id = "another-owner";
    expect(await errorCode(await app.call("list_options", input))).toContain("RESPONSE_INVALID");
    expect(await errorCode(await app.call("list_options", { ...input, q: "Agent" })))
      .toContain("REQUEST_INVALID_INPUT");
  });

  it("pages all selected owned Data bindings with a stable digest of their full contents, never prompts or URLs", async () => {
    const app = setupManagement();
    const members = [
      { dataId: FIRST, name: "first", userPrompt: "PRIVATE_PROMPT", evalPrompt: "PRIVATE_EVAL",
        initialMaterials: [{ bundleId: BUNDLE, materialId: MATERIAL }], privateUrl: "https://private.example" },
      { dataId: SECOND, name: "second", userPrompt: "second prompt", evalPrompt: "second eval",
        evalInitialMaterials: [{ bundleId: BUNDLE, materialId: MATERIAL }],
        initialSession: { bundleId: BUNDLE, sessionId: MATERIAL } },
    ];
    let deleted = false;
    Object.assign(app.services.datasets, {
      getDataset: vi.fn(async () => ({ datasetId: DATASET, name: "Dataset" })),
      getData: vi.fn(async (id: string) => deleted && id === FIRST ? null : members.find((item) => item.dataId === id) ?? null),
      listData: vi.fn(async () => members),
    });
    const params = { category: "approval_dataset", datasetId: DATASET, pageSize: 1 };
    const first = await toolValue(await app.call("list_options", params));
    const second = await toolValue(await app.call("list_options", { ...params, page: 2 }));
    expect(first).toMatchObject({
      total: 2, page: 1, items: [{ dataId: FIRST,
        contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        initialMaterials: [{ bundleId: BUNDLE, materialId: MATERIAL }], evalInitialMaterials: [], initialSession: null }],
    });
    expect(second).toMatchObject({ total: 2, items: [{ dataId: SECOND,
      evalInitialMaterials: [{ bundleId: BUNDLE, materialId: MATERIAL }],
      initialSession: { bundleId: BUNDLE, sessionId: MATERIAL } }] });
    expect(first.digest).toBe(second.digest);
    expect(JSON.stringify([first, second])).not.toMatch(/PRIVATE_|private\.example|https:\/\//u);
    members[0]!.userPrompt = "changed";
    const changed = await toolValue(await app.call("list_options", params));
    expect(changed.digest).not.toBe(first.digest);
    expect(await errorCode(await app.call("list_options", { ...params, dataIds: [BUNDLE] })))
      .toContain("REQUEST_INVALID_INPUT");
    expect(await errorCode(await app.call("list_options", { ...params, q: "PRIVATE_PROMPT" })))
      .toContain("REQUEST_INVALID_INPUT");
    expect(await errorCode(await app.call("list_options", { ...params, pageSize: 11 })))
      .toContain("REQUEST_INVALID_INPUT");
    deleted = true;
    expect(await errorCode(await app.call("list_options", params))).toContain("REQUEST_INVALID_INPUT");
  });

  it("reviews only frozen, owner-scoped ProjectSample/Sampling selections and their actual Agent identities", async () => {
    const app = setupManagement();
    const body = { dataId: FIRST, userPrompt: "PRIVATE_FROZEN", evalPrompt: "PRIVATE_EVAL",
      initialMaterials: [{ bundleId: BUNDLE, materialId: MATERIAL }] };
    const setting = { presetId: "provider/model", systemPrompt: "PRIVATE_PROMPT",
      skillIds: ["sp/skill"], mcpServers: [{ kind: "connector_toolkit", serverId: "sp/toolkit" }],
      sandbox: { token: "PRIVATE_TOKEN", url: "https://private.example" } };
    const view = {
      project: { projectId: "project-1", name: "Project", ownerUserId: OWNER },
      executionPlanDigest: "a".repeat(64), execution: {
        subjectAgentConfig: { sourceUserAgentId: FIRST, name: "Subject", body: { setting } },
      },
      evaluation: { digest: "b".repeat(64), plan: {
        evaluatorAgentConfig: { sourceUserAgentId: SECOND, name: "Evaluator", body: { setting } },
        outputSchema: { outputSchemaId: BUNDLE },
      } },
      projectSamples: [
        { projectSampleId: "sample-a", dataId: FIRST, datasetIds: [DATASET], samplingCount: 3, data: body },
        { projectSampleId: "sample-b", dataId: SECOND, datasetIds: [DATASET], samplingCount: 1,
          data: { dataId: SECOND, userPrompt: "not selected" } },
      ],
    };
    Object.assign(app.services.projects, { get: vi.fn(async () => view) });
    Object.assign(app.services.results, { getSampling: vi.fn(async () => ({
      samplingId: "sampling-a", projectId: "project-1", projectSampleId: "sample-a",
    })) });
    const params = { category: "approval_project", projectId: "project-1",
      projectSampleIds: [], samplingIds: ["sampling-a"], pageSize: 1 };
    const selected = await toolValue(await app.call("list_options", params));
    expect(selected).toMatchObject({
      total: 1, executionAgent: { userAgentId: FIRST, name: "Subject",
        resources: { modelId: "provider/model", skillIds: ["sp/skill"],
          mcpServers: [{ kind: "connector_toolkit", serverId: "sp/toolkit" }] } },
      evaluationAgent: { userAgentId: SECOND, outputSchemaId: BUNDLE,
        resources: { modelId: "provider/model", skillIds: ["sp/skill"] } },
      items: [{ dataId: FIRST, projectSampleId: "sample-a", samplingCount: 3,
        targetSamplingIds: ["sampling-a"], initialMaterials: [{ bundleId: BUNDLE, materialId: MATERIAL }] }],
    });
    expect(JSON.stringify(selected)).not.toMatch(/PRIVATE_|not selected|https:\/\//u);
    Object.assign(setting, { unknownResourceSelection: ["PRIVATE_TOKEN"] });
    expect(await errorCode(await app.call("list_options", params))).toContain("RESPONSE_INVALID");
    expect(await errorCode(await app.call("list_options", {
      ...params, projectSampleIds: ["missing"], samplingIds: [],
    }))).toContain("RUN_TARGETS_STALE");
    expect(await errorCode(await app.call("list_options", { ...params, projectId: "other" })))
      .toContain("PROJECT_NOT_FOUND");
    expect(await errorCode(await app.call("list_options", {
      category: "agents", projectId: "project-1",
    }))).toContain("REQUEST_INVALID_INPUT");
  });
});
