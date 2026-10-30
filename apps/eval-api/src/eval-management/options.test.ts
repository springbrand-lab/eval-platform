import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { RuntimeInputError, digestJson } from "@eval-platform/eval-runtime";
import type { JsonChunk } from "./common.js";
import { AGENT, DATASET, OWNER, SCHEMA, project, setupManagement, toolValue } from "./test-fixture.js";

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
  it("reads only the owned Project's frozen evaluation choice and paged Dataset names", async () => {
    const app = setupManagement();
    const view = {
      project: { projectId: "project-1", name: "Project", ownerUserId: OWNER },
      datasets: [{ datasetId: DATASET, name: "Frozen Dataset", description: "PRIVATE_DATASET",
        projectSampleIds: ["sample-a", "sample-b"] }],
      execution: { subjectAgentConfig: { sourceUserAgentId: FIRST, name: "Subject",
        body: { setting: { systemPrompt: "PRIVATE_PROMPT" } } } },
      evaluation: { lockedAt: null, plan: {
        evaluatorAgentConfig: { sourceUserAgentId: SECOND, name: "Evaluator",
          body: { setting: { systemPrompt: "PRIVATE_EVAL" } } },
        outputSchema: { outputSchemaId: BUNDLE, digest: "PRIVATE_DIGEST" },
      } },
      projectSamples: [
        { projectSampleId: "sample-a", data: { userPrompt: "PRIVATE_PROMPT" } },
        { projectSampleId: "sample-b", data: { evalPrompt: "PRIVATE_EVAL" } },
      ],
    };
    Object.assign(app.services.projects, { get: vi.fn(async () => view) });
    const getOutputSchema = vi.fn(async () => ({
      outputSchemaId: BUNDLE, name: "Bound scoring standard", schema: { raw: "PRIVATE_SCHEMA" },
    }) as { outputSchemaId: string; name: string; schema: { raw: string } } | null);
    Object.assign(app.services.outputSchemas, { get: getOutputSchema });
    const input = { category: "project_detail", projectId: "project-1", pageSize: 1 };
    const result = await toolValue(await app.call("list_options", input));
    expect(result).toMatchObject({
      category: "project_detail", project: { projectId: "project-1", name: "Project" },
      totalCases: 2, datasets: { total: 1, pageSize: 1, items: [{ datasetId: DATASET, name: "Frozen Dataset" }] },
      executionAgent: { userAgentId: FIRST, name: "Subject" },
      evaluation: { userAgentId: SECOND, name: "Evaluator", outputSchemaId: BUNDLE,
        outputSchemaName: "Bound scoring standard", locked: false },
    });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|ownerUserId|projectSampleIds|userPrompt|schema.*raw/u);
    expect(await errorCode(await app.call("list_options", { category: "project_detail" })))
      .toContain("REQUEST_INVALID_INPUT");
    expect(await errorCode(await app.call("list_options", { ...input, q: "Project" })))
      .toContain("REQUEST_INVALID_INPUT");
    getOutputSchema.mockResolvedValueOnce(null);
    const deleted = await toolValue(await app.call("list_options", input));
    expect(deleted.evaluation).toMatchObject({ outputSchemaId: BUNDLE, outputSchemaName: null });
    view.project.ownerUserId = "other-owner";
    expect(await errorCode(await app.call("list_options", input))).toContain("PROJECT_NOT_FOUND");
  });

  it("reports a Project without an evaluation plan without inventing a scoring standard", async () => {
    const app = setupManagement();
    Object.assign(app.services.projects, { get: vi.fn(async () => ({
      project: { projectId: "project-1", name: "Execution-only", ownerUserId: OWNER },
      datasets: [], projectSamples: [],
      execution: { subjectAgentConfig: { sourceUserAgentId: FIRST, name: "Subject", body: {} } },
      evaluation: null,
    })) });
    const getOutputSchema = vi.fn();
    Object.assign(app.services.outputSchemas, { get: getOutputSchema });
    const detail = await toolValue(await app.call("list_options", {
      category: "project_detail", projectId: "project-1",
    }));
    expect(detail).toMatchObject({ category: "project_detail", totalCases: 0,
      evaluation: null, datasets: { total: 0, items: [] } });
    expect(getOutputSchema).not.toHaveBeenCalled();
  });

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
    app.services.projects.reviewSelection.mockImplementation(async (input: unknown) => {
      const selection = input as { datasetId: string; dataIds?: string[] };
      if (deleted || selection.dataIds?.some((id) => !members.some((item) => item.dataId === id))) {
        throw new HttpError("REQUEST_INVALID_INPUT");
      }
      const dataset = { datasetId: selection.datasetId, name: "Dataset", kind: "general" };
      const selected = selection.dataIds ? members.filter((item) => selection.dataIds!.includes(item.dataId)) : members;
      return { dataset, data: selected, digest: await digestJson({ dataset, selected }) };
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
    expect(app.services.projects.reviewSelection).toHaveBeenCalledWith({ datasetId: DATASET });
    expect(JSON.stringify([first, second])).not.toMatch(/PRIVATE_|private\.example|https:\/\//u);
    members[0]!.userPrompt = "changed";
    const changed = await toolValue(await app.call("list_options", params));
    expect(changed.digest).not.toBe(first.digest);
    expect(await errorCode(await app.call("list_options", { ...params, dataIds: [BUNDLE] })))
      .toContain("REQUEST_INVALID_INPUT");
    app.services.projects.reviewSelection.mockRejectedValueOnce(new RuntimeInputError("Selected Data was detached"));
    expect(await errorCode(await app.call("list_options", params))).toContain("REQUEST_INVALID_INPUT");
    expect(await errorCode(await app.call("list_options", { ...params, q: "PRIVATE_PROMPT" })))
      .toContain("REQUEST_INVALID_INPUT");
    expect(await errorCode(await app.call("list_options", { ...params, pageSize: 11 })))
      .toContain("REQUEST_INVALID_INPUT");
    deleted = true;
    expect(await errorCode(await app.call("list_options", params))).toContain("REQUEST_INVALID_INPUT");
  });

  it("reviews the immutable output Schema by its existing catalog ID and canonical digest, not its content", async () => {
    const app = setupManagement();
    const reviewed = await toolValue(await app.call("list_options", {
      category: "approval_output_schema", outputSchemaId: SCHEMA,
    }));
    expect(reviewed).toEqual({ category: "approval_output_schema", outputSchemaId: SCHEMA,
      name: "Output", digest: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(JSON.stringify(reviewed)).not.toContain("private");
    expect(await errorCode(await app.call("list_options", {
      category: "approval_output_schema", outputSchemaId: FIRST,
    }))).toContain("OUTPUT_SCHEMA_NOT_FOUND");
  });

  it("reads actual nested Schema field definitions by exact owned catalog ID, not a name or aggregate", async () => {
    const app = setupManagement();
    const schema = { type: "object", properties: {
      reason: { type: "string", description: "Actual free-text reason" },
      passed: { type: ["boolean", "null"] },
      checks: { type: "array", items: { $ref: "#/$defs/check" } },
    }, required: ["reason", "checks"],
    $defs: { check: { type: "object", properties: { label: { type: "string" }, score: { type: "number" } } } } };
    app.savedSchemas.set(SCHEMA, { outputSchemaId: SCHEMA, name: "Scoring", description: "Metadata", schema });
    const otherId = SECOND;
    app.savedSchemas.set(otherId, { outputSchemaId: otherId, name: "Scoring", description: "Same name",
      schema: { type: "boolean" } });
    const result = await toolValue(await app.call("list_options", {
      category: "output_schema_detail", outputSchemaId: SCHEMA,
    }));
    const chunk = result.schemaChunk as JsonChunk;
    expect(result).toMatchObject({ category: "output_schema_detail", outputSchemaId: SCHEMA,
      name: "Scoring", sourceRedacted: false });
    expect(chunk).toMatchObject({ offset: 0, totalBytes: Buffer.byteLength(JSON.stringify(schema), "utf8"),
      nextOffset: null, sha256: createHash("sha256").update(JSON.stringify(schema)).digest("hex") });
    expect(JSON.parse(chunk.text)).toEqual(schema);
    expect((await toolValue(await app.call("list_options", {
      category: "output_schema_detail", outputSchemaId: otherId,
    }))).schemaChunk).toMatchObject({ text: '{"type":"boolean"}' });
    expect(app.services.outputSchemas.get).toHaveBeenCalledWith(SCHEMA);
    expect(result).not.toHaveProperty("projectId");
  });

  it("pages owner-scoped Schema choices instead of letting Takt clip a large catalog page", async () => {
    const app = setupManagement();
    for (let index = 0; index < 50; index++) {
      const outputSchemaId = crypto.randomUUID();
      app.savedSchemas.set(outputSchemaId, { outputSchemaId, name: `Schema ${index} ${"中".repeat(140)}`,
        description: "Not a choice field", schema: { type: "object", properties: { reason: { type: "string" } } } });
    }
    expect(await errorCode(await app.call("list_options", {
      category: "output_schemas", pageSize: 50,
    }))).toContain("CATALOG_PAYLOAD_TOO_LARGE");
    const rpc = await (await app.call("list_options", {
      category: "output_schemas", page: 2, pageSize: 5,
    })).json() as { result: { content: [{ text: string }] } };
    expect(Buffer.byteLength(rpc.result.content[0].text, "utf8")).toBeLessThanOrEqual(4_800);
    const page = JSON.parse(rpc.result.content[0].text) as { total: number; page: number; items: unknown[] };
    expect(page).toMatchObject({ total: 51, page: 2 });
    expect(page.items).toHaveLength(5);
    expect(page.items[0]).not.toHaveProperty("schema");
  });

  it("continues a long UTF-8 Schema without clipping or mistaking a character offset for a byte offset", async () => {
    const app = setupManagement();
    const schema = { type: "object", title: "规则🧮".repeat(800),
      properties: { reason: { type: "string", description: "complete" } } };
    app.savedSchemas.set(SCHEMA, { outputSchemaId: SCHEMA, name: "Long", description: "Metadata", schema });
    const chunks: JsonChunk[] = [];
    let schemaOffset = 0;
    do {
      const response = await app.call("list_options", { category: "output_schema_detail", outputSchemaId: SCHEMA, schemaOffset });
      const rpc = await response.json() as { result: { content: [{ text: string }] } };
      expect(rpc.result.content[0].text.length).toBeLessThan(5_000);
      const value = JSON.parse(rpc.result.content[0].text) as { schemaChunk: JsonChunk; sourceRedacted: boolean };
      expect(value.sourceRedacted).toBe(false);
      expect(value.schemaChunk.offset).toBe(schemaOffset);
      expect(Buffer.byteLength(value.schemaChunk.text, "utf8")).toBeLessThanOrEqual(2_048);
      chunks.push(value.schemaChunk);
      schemaOffset = value.schemaChunk.nextOffset ?? 0;
    } while (schemaOffset !== 0 && chunks.length < 20);
    const canonical = JSON.stringify(schema);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.at(-1)!.nextOffset).toBeNull();
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(canonical);
    expect(chunks.every((chunk) => chunk.sha256 === chunks[0]!.sha256
      && chunk.totalBytes === Buffer.byteLength(canonical, "utf8"))).toBe(true);
    expect(chunks[0]!.sha256).toBe(createHash("sha256").update(canonical).digest("hex"));
    const insideCodePoint = Buffer.from(canonical).indexOf(Buffer.from("规")) + 1;
    expect(await errorCode(await app.call("list_options", {
      category: "output_schema_detail", outputSchemaId: SCHEMA, schemaOffset: insideCodePoint,
    }))).toContain("REQUEST_INVALID_INPUT");
    expect(await errorCode(await app.call("list_options", {
      category: "output_schema_detail", outputSchemaId: SCHEMA, schemaOffset: Buffer.byteLength(canonical, "utf8"),
    }))).toContain("REQUEST_INVALID_INPUT");
  });

  it("keeps escape-heavy Schema definitions within Takt's output budget without dropping a property", async () => {
    const app = setupManagement();
    const schema = { type: "object", description: '"\\'.repeat(3_000),
      properties: { reason: { type: "string" }, verdict: { type: "boolean" } } };
    app.savedSchemas.set(SCHEMA, { outputSchemaId: SCHEMA, name: "Scoring", description: "Metadata", schema });
    const chunks: JsonChunk[] = [];
    let schemaOffset = 0;
    do {
      const rpc = await (await app.call("list_options", {
        category: "output_schema_detail", outputSchemaId: SCHEMA, schemaOffset,
      })).json() as { result: { isError?: boolean; content: [{ text: string }] } };
      expect(rpc.result.isError).not.toBe(true);
      expect(rpc.result.content[0].text.length).toBeLessThanOrEqual(4_800);
      expect(Buffer.byteLength(rpc.result.content[0].text, "utf8")).toBeLessThanOrEqual(4_800);
      const { schemaChunk } = JSON.parse(rpc.result.content[0].text) as { schemaChunk: JsonChunk };
      expect(schemaChunk.offset).toBe(schemaOffset);
      expect(Buffer.byteLength(schemaChunk.text, "utf8")).toBeLessThanOrEqual(2_048);
      chunks.push(schemaChunk);
      schemaOffset = schemaChunk.nextOffset ?? 0;
    } while (schemaOffset !== 0 && chunks.length < 30);
    expect(chunks.at(-1)!.nextOffset).toBeNull();
    expect(JSON.parse(chunks.map((chunk) => chunk.text).join(""))).toEqual(schema);
    expect(chunks.every((chunk) => chunk.sha256 === chunks[0]!.sha256
      && chunk.totalBytes === Buffer.byteLength(JSON.stringify(schema), "utf8"))).toBe(true);
  });

  it("rejects foreign/deleted or mismatched Schema identities and cross-category cursors", async () => {
    const app = setupManagement();
    for (const input of [
      { category: "output_schema_detail" },
      { category: "output_schema_detail", outputSchemaId: SCHEMA, q: "Output" },
      { category: "output_schema_detail", outputSchemaId: SCHEMA, page: 2 },
      { category: "output_schema_detail", outputSchemaId: SCHEMA, pageSize: 5 },
      { category: "output_schema_detail", outputSchemaId: SCHEMA, projectId: project.projectId },
      { category: "output_schema_detail", outputSchemaId: SCHEMA, schemaOffset: -1 },
      { category: "output_schema_detail", outputSchemaId: SCHEMA, schemaOffset: 0.5 },
      { category: "output_schemas", schemaOffset: 0 },
      { category: "approval_output_schema", outputSchemaId: SCHEMA, schemaOffset: 0 },
    ]) {
      expect(await errorCode(await app.call("list_options", input))).toContain("REQUEST_INVALID_INPUT");
    }
    expect(app.services.outputSchemas.get).not.toHaveBeenCalled();
    expect(await errorCode(await app.call("list_options", {
      category: "output_schema_detail", outputSchemaId: FIRST,
    }))).toContain("OUTPUT_SCHEMA_NOT_FOUND");
    app.services.outputSchemas.get.mockResolvedValueOnce({
      outputSchemaId: SECOND, name: "Other", description: "Other", schema: {},
    });
    expect(await errorCode(await app.call("list_options", {
      category: "output_schema_detail", outputSchemaId: SCHEMA,
    }))).toContain("OUTPUT_SCHEMA_NOT_FOUND");
    app.savedSchemas.delete(SCHEMA); // The catalog hides deleted records; Project plan readers are a separate seam.
    expect(await errorCode(await app.call("list_options", {
      category: "output_schema_detail", outputSchemaId: SCHEMA,
    }))).toContain("OUTPUT_SCHEMA_NOT_FOUND");
  });

  it("marks Schema source-content redactions instead of silently omitting a field or leaking a URL/key", async () => {
    const app = setupManagement();
    app.savedSchemas.set(SCHEMA, { outputSchemaId: SCHEMA, name: "https://private.example", description: "Metadata",
      schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
        properties: { accessToken: { type: "string", default: "sk-abcdefghijk" } },
        description: "Bearer private-token" } });
    const result = await toolValue(await app.call("list_options", { category: "output_schema_detail", outputSchemaId: SCHEMA }));
    const display = JSON.parse((result.schemaChunk as JsonChunk).text) as Record<string, unknown>;
    expect(result.sourceRedacted).toBe(true);
    expect(result.name).toBe("[REDACTED: sensitive source content]");
    expect(display.$schema).toBe("[REDACTED: sensitive source content]");
    expect(JSON.stringify(display.properties)).toContain("accessToken");
    expect(JSON.stringify(result)).not.toMatch(/https:|sk-abcdefghijk|Bearer private-token/u);
    app.savedSchemas.set(SCHEMA, { outputSchemaId: SCHEMA, name: "Output", description: "Metadata",
      schema: { properties: { "https://unsafe.example": { type: "string" } } } });
    expect(await toolValue(await app.call("list_options", {
      category: "output_schema_detail", outputSchemaId: SCHEMA,
    }))).toMatchObject({ sourceRedacted: true, schemaChunk: null });
    expect(await errorCode(await app.call("list_options", {
      category: "output_schema_detail", outputSchemaId: SCHEMA, schemaOffset: 1,
    }))).toContain("REQUEST_INVALID_INPUT");
  });

  it("retains safe Schema property identities url/token/prompt while explicitly masking their values", async () => {
    const app = setupManagement();
    const schema = { type: "object", properties: {
      url: { type: "string", default: "https://private.example/file" },
      token: { type: "integer", const: 123456789 },
      prompt: { type: "string", example: "private instruction" },
      reason: { type: "string", description: "Safe reason" },
    }, required: ["url", "token", "prompt", "reason"] };
    app.savedSchemas.set(SCHEMA, { outputSchemaId: SCHEMA, name: "Scoring", description: "Metadata", schema });
    const result = await toolValue(await app.call("list_options", { category: "output_schema_detail", outputSchemaId: SCHEMA }));
    expect(result.sourceRedacted).toBe(true);
    expect(JSON.parse((result.schemaChunk as JsonChunk).text)).toEqual({
      type: "object", properties: {
        url: "[REDACTED: sensitive source content]", token: "[REDACTED: sensitive source content]",
        prompt: "[REDACTED: sensitive source content]",
        reason: { type: "string", description: "Safe reason" },
      }, required: schema.required,
    });
    expect(JSON.stringify(result)).not.toMatch(/https:|private\.example|123456789|private instruction/u);
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
