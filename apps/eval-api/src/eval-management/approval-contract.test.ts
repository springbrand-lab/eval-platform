import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DatasetEntityNotFoundError, dataSchema, type Data } from "@eval-platform/eval-dataset";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { RuntimeInputError, digestJson } from "@eval-platform/eval-runtime";
import type { PostgresProjectStore, SelectedDataset } from "../db/project-store.js";
import { resolveDatasetMemberOrder } from "../db/dataset-order.js";
import { parseEvaluationOutputSchema } from "../project-output-schema.js";
import { createProjectService } from "../projects/service.js";
import type { DatasetSelection } from "../projects/schemas.js";
import type { EvalSpAgentConfig } from "../sp/client.js";
import { AGENT, DATASET, OWNER, SCHEMA, setupManagement } from "./test-fixture.js";

const EVALUATOR = "55555555-5555-4555-8555-555555555555";
const FOREIGN = "66666666-6666-4666-8666-666666666666";
const BUNDLE = "77777777-7777-4777-8777-777777777777";
const MATERIAL = "88888888-8888-4888-8888-888888888888";
const dataIds = Array.from({ length: 34 }, (_, index) =>
  `10000000-0000-4000-8000-${String(34 - index).padStart(12, "0")}`);
const selectedId = dataIds[17]!;

// Pin the private-review wire to datasetReview, agentReview and outputSchemaReview
// in Takt packages/company-agent/src/eval.ts.
// Do not import Takt's agent implementation or weaken its strict object/size checks.
const uuid = z.uuid();
const hex = z.string().regex(/^[0-9a-f]{64}$/u);
const label = z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/u);
const resourceId = z.string().min(1).max(255).regex(/^[^\u0000-\u001f\u007f\\]+$/u)
  .refine((value) => value === value.trim()
    && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."));
const resourceIds = z.array(resourceId).max(50);
const agentResources = z.strictObject({
  modelId: resourceId.nullable(), model: resourceId.nullable().optional(),
  skillIds: resourceIds, referenceFileIds: resourceIds, actionIds: resourceIds,
  connectorIds: resourceIds, extensionIds: resourceIds, subagentNames: resourceIds,
  preferredSupplierIds: z.array(resourceId).max(64).optional(),
  referenceNotesChars: z.number().int().min(0).max(32_000).optional(),
  authoringPresent: z.boolean().optional(),
  mcpServers: z.array(z.strictObject({
    kind: z.enum(["managed", "connector_toolkit"]), serverId: resourceId,
  })).max(50),
  toolPolicy: z.strictObject({ allow: resourceIds, deny: resourceIds }),
});
const datasetReview = z.strictObject({
  category: z.literal("approval_dataset"), datasetId: uuid, name: label,
  page: z.number().int().min(1).max(10), pageSize: z.literal(5),
  total: z.number().int().min(1).max(50), digest: hex,
  items: z.array(z.strictObject({
    dataId: uuid, contentDigest: hex,
    initialMaterials: z.array(z.strictObject({ bundleId: uuid, materialId: uuid })).max(50),
    evalInitialMaterials: z.array(z.strictObject({ bundleId: uuid, materialId: uuid })).max(50),
    initialSession: z.strictObject({ bundleId: uuid, sessionId: uuid }).nullable(),
  })).max(5),
});
const agentReview = z.strictObject({
  category: z.literal("approval_agent"), userAgentId: uuid, name: label,
  purpose: z.enum(["execution", "evaluation"]), configDigest: hex, resources: agentResources,
});
const outputSchemaReview = z.strictObject({
  category: z.literal("approval_output_schema"), outputSchemaId: uuid, name: label, digest: hex,
});
const datasetDataPage = z.strictObject({
  category: z.literal("dataset_data"), datasetId: uuid, name: z.string().max(160),
  sourceRedacted: z.literal(true).optional(), order: z.enum(["upload", "unknown"]),
  page: z.number().int().min(1).max(10_000), pageSize: z.number().int().min(1).max(20),
  total: z.number().int().min(0),
  items: z.array(z.strictObject({
    dataId: uuid, name: z.string().max(160).nullable(),
    sourceRedacted: z.literal(true).optional(), nameTruncated: z.literal(true).optional(),
  })).max(20),
});

async function reviewed<Schema extends z.ZodType>(response: Response, schema: Schema): Promise<z.output<Schema>> {
  expect(response.status).toBe(200);
  const rpc = await response.json() as {
    jsonrpc: string; id: number; result: { isError?: boolean; content: Array<{ type: string; text: string }> };
  };
  expect(rpc).toEqual({ jsonrpc: "2.0", id: 7,
    result: { content: [{ type: "text", text: expect.any(String) }] } });
  const text = rpc.result.content[0]!.text;
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(30_000);
  const value: unknown = JSON.parse(text);
  const parsed = schema.parse(value) as z.output<Schema>;
  expect(parsed).toEqual(value); // Strict schema: no extra private fields hidden by a projection.
  return parsed;
}

async function toolError(response: Response): Promise<string> {
  expect(response.status).toBe(200);
  const rpc = await response.json() as {
    jsonrpc: string; id: number; result: { isError?: boolean; content: Array<{ type: string; text: string }> };
  };
  expect(rpc).toEqual({ jsonrpc: "2.0", id: 7, result: {
    content: [{ type: "text", text: expect.any(String) }], isError: true,
  } });
  const text = rpc.result.content[0]!.text;
  expect(text).not.toMatch(/PRIVATE_|postgres:|https?:\/\//u);
  return text;
}

function noProjectOrRun(app: ReturnType<typeof setupManagement>) {
  expect(app.services.projects.create).not.toHaveBeenCalled();
  expect(app.services.admission.submit).not.toHaveBeenCalled();
  expect(app.services.agentConfigs.create).not.toHaveBeenCalled();
  expect(app.services.outputSchemas.create).not.toHaveBeenCalled();
  expect(app.managed.operations.size).toBe(0);
}

/** The real ProjectService computes the reviewed digest; only its PostgreSQL selection port is faked. */
function datasetSource(app: ReturnType<typeof setupManagement>, provenance: "upload" | "unknown") {
  const dataset = { datasetId: DATASET, name: "Moss 34-case Dataset",
    description: "PRIVATE_DATASET_DESCRIPTION", kind: "prompt" as const };
  const rows: Data[] = dataIds.map((dataId, index) => dataSchema.parse({
    dataId, name: `Case ${index + 1}`, description: `Row ${index + 1}`,
    userPrompt: `PRIVATE_USER_PROMPT_${index}`, evalPrompt: `PRIVATE_EVAL_PROMPT_${index}`,
    privateField: "PRIVATE_BUSINESS_FIELD",
    ...(dataId === selectedId ? {
      initialMaterials: [{ bundleId: BUNDLE, materialId: MATERIAL }],
      evalInitialMaterials: [{ bundleId: BUNDLE, materialId: MATERIAL }],
      initialSession: { bundleId: BUNDLE, sessionId: MATERIAL },
    } : {}),
  }));
  const ordered = resolveDatasetMemberOrder(OWNER, { datasetId: DATASET, kind: "prompt",
    originalOrderIntact: provenance === "upload" ? true : null },
  rows.map((row, position) => ({ dataId: row.dataId, row, position: provenance === "upload" ? position : null })), []);
  const list = vi.spyOn(app.managed.store, "listDatasetData").mockImplementation(async (owner, datasetId, page, pageSize) => {
    expect(owner).toBe(OWNER);
    if (datasetId !== DATASET) throw new HttpError("DATASET_NOT_FOUND", "PRIVATE foreign Dataset");
    return { name: dataset.name, order: ordered.order, total: rows.length,
      items: ordered.members.slice((page - 1) * pageSize, page * pageSize).map(({ row }) => {
        const { dataId, ...content } = row;
        return { dataId, content };
      }) };
  });
  const readSelection = vi.fn(async (selections: readonly DatasetSelection[]): Promise<SelectedDataset[]> =>
    selections.map((selection, index) => {
      if (selection.datasetId !== DATASET) throw new DatasetEntityNotFoundError("dataset", selection.datasetId);
      const wanted = new Set(selection.dataIds ?? ordered.members.map(({ dataId }) => dataId));
      const data = ordered.members.filter(({ dataId }) => wanted.delete(dataId)).map(({ row }) => row);
      if (wanted.size) throw new RuntimeInputError("PRIVATE detached Data", `datasets.${index}.dataIds`);
      return { dataset, data };
    }));
  const noWrite = async (): Promise<never> => { throw new Error("A review must not create a Project or Run"); };
  const projects = createProjectService({
    ownerUserId: OWNER, sourceBranch: "test-only",
    store: { readSelection } as unknown as PostgresProjectStore,
    outputSchemas: { get: noWrite },
    agentConfigs: { freeze: noWrite, discard: noWrite },
    admission: { preview: noWrite, submit: noWrite },
  });
  app.services.projects.reviewSelection.mockImplementation((selection: unknown) =>
    projects.reviewSelection(selection as DatasetSelection));
  return { dataset, rows, ordered, list, readSelection };
}

describe("Moss private Project pre-approval reads at EP MCP tools/call", () => {
  it.each(["upload", "unknown"] as const)(
    "reviews one explicit Data ID out of 34 with %s membership order, not an inferred first row", async (provenance) => {
      const app = setupManagement();
      const source = datasetSource(app, provenance);
      const first = await reviewed(await app.call("list_options", {
        category: "dataset_data", datasetId: DATASET,
      }), datasetDataPage);
      expect(first).toEqual({
        category: "dataset_data", datasetId: DATASET, name: source.dataset.name, order: provenance,
        page: 1, pageSize: 20, total: 34,
        items: source.ordered.members.slice(0, 20).map(({ row }) => ({ dataId: row.dataId, name: row.name })),
      });
      expect(source.ordered.members[0]!.dataId).toBe(provenance === "upload" ? dataIds[0] : dataIds[33]);
      const selected = source.rows.find(({ dataId }) => dataId === selectedId)!;
      const choice = await reviewed(await app.call("list_options", {
        category: "approval_dataset", datasetId: DATASET, dataIds: [selectedId], page: 1, pageSize: 5,
      }), datasetReview);
      expect(choice).toEqual({
        category: "approval_dataset", datasetId: DATASET, name: source.dataset.name,
        page: 1, pageSize: 5, total: 1,
        digest: await digestJson({ dataset: source.dataset, selected: [selected] }),
        items: [{ dataId: selectedId, contentDigest: await digestJson(selected),
          initialMaterials: selected.initialMaterials, evalInitialMaterials: selected.evalInitialMaterials,
          initialSession: selected.initialSession }],
      });
      expect(source.readSelection).toHaveBeenCalledWith([{ datasetId: DATASET, dataIds: [selectedId] }]);
      expect(source.list).toHaveBeenCalledWith(OWNER, DATASET, 1, 20);
      expect(JSON.stringify(choice)).not.toMatch(/PRIVATE_|Case 18|privateField|userPrompt|evalPrompt/u);

      // Takt's unfiltered review reads every five-case page and compares full-selection metadata.
      const pages: Array<z.output<typeof datasetReview>> = [];
      for (let page = 1; page <= 7; page++) {
        pages.push(await reviewed(await app.call("list_options", {
          category: "approval_dataset", datasetId: DATASET, page, pageSize: 5,
        }), datasetReview));
      }
      expect(pages.map(({ page, pageSize, total, digest }) => ({ page, pageSize, total, digest }))).toEqual(
        Array.from({ length: 7 }, (_, index) => ({ page: index + 1, pageSize: 5, total: 34, digest: pages[0]!.digest })),
      );
      expect(pages.map(({ items }) => items.length)).toEqual([5, 5, 5, 5, 5, 5, 4]);
      expect(pages.flatMap(({ items }) => items.map(({ dataId }) => dataId)))
        .toEqual(source.ordered.members.map(({ dataId }) => dataId));
      expect(pages[0]!.digest).toBe(await digestJson({
        dataset: source.dataset, selected: source.ordered.members.map(({ row }) => row),
      }));
      expect(JSON.stringify(pages)).not.toMatch(/PRIVATE_|privateField|userPrompt|evalPrompt/u);
      noProjectOrRun(app);
    });

  it("rejects malformed, foreign, pending and detached Dataset selections with safe EP errors", async () => {
    const app = setupManagement();
    const source = datasetSource(app, "unknown");
    const approval = { category: "approval_dataset", datasetId: DATASET, pageSize: 5 };
    for (const args of [
      { ...approval, dataIds: [] },
      { ...approval, dataIds: [selectedId, selectedId] },
      { ...approval, dataIds: ["not-a-uuid"] },
      { ...approval, pageSize: 11 },
      { ...approval, ownerUserId: FOREIGN },
      { ...approval, q: "PRIVATE_PROMPT" },
    ]) {
      expect(await toolError(await app.call("list_options", args)))
        .toBe("REQUEST_INVALID_INPUT: Check the tool's input schema.");
    }
    expect(source.readSelection).not.toHaveBeenCalled();
    expect(await toolError(await app.call("list_options", {
      category: "approval_dataset", datasetId: FOREIGN, dataIds: [selectedId], pageSize: 5,
    }))).toBe("DATASET_NOT_FOUND: The requested resource is not available to this account.");
    expect(await toolError(await app.call("list_options", {
      category: "dataset_data", datasetId: FOREIGN,
    }))).toBe("DATASET_NOT_FOUND: The requested resource is not available to this account.");
    expect(await toolError(await app.call("list_options", {
      category: "approval_dataset", datasetId: DATASET, dataIds: [FOREIGN], pageSize: 5,
    }))).toBe("REQUEST_INVALID_INPUT: The operation could not be completed.");
    const ready = vi.spyOn(app.managed.store, "assertReadyDatasets");
    source.readSelection.mockClear();
    ready.mockRejectedValueOnce(new HttpError("EVAL_SP_CONFLICT", "PRIVATE pending preparation"));
    expect(await toolError(await app.call("list_options", {
      category: "approval_dataset", datasetId: DATASET, dataIds: [selectedId], pageSize: 5,
    }))).toBe("EVAL_SP_CONFLICT: The requested facts conflict with current state.");
    expect(ready).toHaveBeenCalledWith(OWNER, [DATASET]);
    expect(source.readSelection).not.toHaveBeenCalled();
    noProjectOrRun(app);
  });

  it("emits only Takt's strict owned Agent review for the default execution Agent and one Evaluator", async () => {
    const app = setupManagement();
    const defaultSetting = {
      presetId: null, model: null, thinking: "medium", executionLevel: "safe",
      systemPrompt: "PRIVATE_DEFAULT_PROMPT", toolPolicy: { allow: [], deny: [] },
      subagentNames: [], memoryDefaults: { enabled: true, memoryTokens: 2_000, preferencesTokens: 500 },
      sandbox: { enabled: false }, skillIds: [], actionIds: [], referenceFileIds: [],
      mcpServers: [], connectorIds: [], extensionIds: [],
    };
    const execution = { id: AGENT, user_id: OWNER, name: "SpringBrand Assistant",
      slug: "default", revision: 1, is_default: true, setting: defaultSetting };
    const evaluator = { id: EVALUATOR, user_id: OWNER, name: "Evaluator",
      slug: "eval-evaluator", revision: 2, is_default: false,
      setting: { ...defaultSetting, presetId: "model-1", model: "provider/model",
        systemPrompt: "PRIVATE_EVALUATION_PROMPT",
        authoring: { goal: "PRIVATE_GOAL", inputs: "", exampleInput: "", instructionsMode: "manual" },
        referenceNotes: "PRIVATE_NOTES", preferredSupplierIds: ["supplier/team"],
        skillIds: ["sp/skill"], referenceFileIds: [BUNDLE], actionIds: ["sp/action"],
        mcpServers: [{ serverId: "eval-results-mcp" }, { kind: "connector_toolkit", serverId: "sp/toolkit" }],
      } };
    const configs = new Map<string, EvalSpAgentConfig>([[AGENT, execution], [EVALUATOR, evaluator]]);
    app.services.agentConfigs.listAgents.mockImplementation(async () => [...configs].map(([userAgentId, config]) => ({
      agentConfig: { ownerUserId: OWNER, userAgentId }, name: config.name,
      purpose: userAgentId === AGENT ? "execution" : "evaluation", role: "subject" as const,
    })));
    const get = vi.fn(async (id: string) => configs.get(id)!);
    Object.assign(app.services.agentConfigs, { get });

    const first = await reviewed(await app.call("list_options", {
      category: "approval_agent", userAgentId: AGENT,
    }), agentReview);
    expect(first).toEqual({
      category: "approval_agent", userAgentId: AGENT, name: execution.name, purpose: "execution",
      configDigest: await digestJson(execution),
      resources: { modelId: null, model: null, skillIds: [], referenceFileIds: [], actionIds: [],
        connectorIds: [], extensionIds: [], subagentNames: [], preferredSupplierIds: [],
        referenceNotesChars: 0, authoringPresent: false, mcpServers: [], toolPolicy: { allow: [], deny: [] } },
    });
    const second = await reviewed(await app.call("list_options", {
      category: "approval_agent", userAgentId: EVALUATOR,
    }), agentReview);
    expect(second).toEqual({
      category: "approval_agent", userAgentId: EVALUATOR, name: evaluator.name, purpose: "evaluation",
      configDigest: await digestJson(evaluator),
      resources: { modelId: "model-1", model: "provider/model", skillIds: ["sp/skill"], referenceFileIds: [BUNDLE],
        actionIds: ["sp/action"], connectorIds: [], extensionIds: [], subagentNames: [],
        preferredSupplierIds: ["supplier/team"], referenceNotesChars: "PRIVATE_NOTES".length, authoringPresent: true,
        mcpServers: [{ kind: "managed", serverId: "eval-results-mcp" },
          { kind: "connector_toolkit", serverId: "sp/toolkit" }],
        toolPolicy: { allow: [], deny: [] } },
    });
    expect(JSON.stringify([first, second])).not.toMatch(/PRIVATE_|"systemPrompt":|"referenceNotes":|"authoring":/u);
    expect(get).toHaveBeenNthCalledWith(1, AGENT);
    expect(get).toHaveBeenNthCalledWith(2, EVALUATOR);
    configs.set(EVALUATOR, { ...evaluator, setting: { ...evaluator.setting, systemPrompt: "PRIVATE_CHANGED_PROMPT" } });
    const changed = await reviewed(await app.call("list_options", {
      category: "approval_agent", userAgentId: EVALUATOR,
    }), agentReview);
    expect(changed.configDigest).not.toBe(second.configDigest);
    expect(changed.resources).toEqual(second.resources);

    for (const args of [
      { category: "approval_agent", userAgentId: AGENT, purpose: "evaluation" },
      { category: "approval_agent", userAgentId: AGENT, ownerUserId: FOREIGN },
      { category: "approval_agent", userAgentId: AGENT, page: 2 },
    ]) expect(await toolError(await app.call("list_options", args)))
      .toBe("REQUEST_INVALID_INPUT: Check the tool's input schema.");
    get.mockClear();
    expect(await toolError(await app.call("list_options", {
      category: "approval_agent", userAgentId: FOREIGN,
    }))).toBe("REQUEST_INVALID_INPUT: The operation could not be completed.");
    expect(get).not.toHaveBeenCalled();
    get.mockResolvedValueOnce({ ...execution, name: "Stale SP body" });
    expect(await toolError(await app.call("list_options", {
      category: "approval_agent", userAgentId: AGENT,
    }))).toBe("RESPONSE_INVALID: The operation could not be completed.");
    get.mockResolvedValueOnce({ ...execution, user_id: FOREIGN });
    expect(await toolError(await app.call("list_options", {
      category: "approval_agent", userAgentId: AGENT,
    }))).toBe("RESPONSE_INVALID: The operation could not be completed.");
    get.mockResolvedValueOnce({ ...execution, setting: { ...defaultSetting, extra: "PRIVATE_UNREVIEWABLE_FIELD" } });
    expect(await toolError(await app.call("list_options", {
      category: "approval_agent", userAgentId: AGENT,
    }))).toBe("RESPONSE_INVALID: The operation could not be completed.");
    noProjectOrRun(app);
  });

  it("emits only Takt's strict digest of the named, owned 0–100 output Schema record", async () => {
    const app = setupManagement();
    const schema = parseEvaluationOutputSchema(JSON.stringify({
      type: "object", required: ["score", "reason"], additionalProperties: false,
      properties: { score: { type: "integer", minimum: 0, maximum: 100 },
        reason: { type: "string" } },
    }));
    const record = { outputSchemaId: SCHEMA, name: "评分 0-100", description: "PRIVATE_RUBRIC_DESCRIPTION", schema };
    app.savedSchemas.set(SCHEMA, record);
    const initial = await reviewed(await app.call("list_options", {
      category: "approval_output_schema", outputSchemaId: SCHEMA,
    }), outputSchemaReview);
    expect(initial).toEqual({ category: "approval_output_schema", outputSchemaId: SCHEMA,
      name: record.name, digest: await digestJson(record) });
    expect(JSON.stringify(initial)).not.toMatch(/PRIVATE_|properties|minimum|maximum|reason/u);
    app.savedSchemas.set(SCHEMA, { ...record, description: "Changed private rubric" });
    const changed = await reviewed(await app.call("list_options", {
      category: "approval_output_schema", outputSchemaId: SCHEMA,
    }), outputSchemaReview);
    expect(changed.name).toBe(initial.name);
    expect(changed.digest).not.toBe(initial.digest);
    expect(app.services.outputSchemas.get).toHaveBeenCalledWith(SCHEMA);

    for (const args of [
      { category: "approval_output_schema", outputSchemaId: SCHEMA, name: "Model-supplied rubric" },
      { category: "approval_output_schema", outputSchemaId: SCHEMA, ownerUserId: FOREIGN },
      { category: "approval_output_schema", outputSchemaId: SCHEMA, schemaOffset: 0 },
    ]) expect(await toolError(await app.call("list_options", args)))
      .toBe("REQUEST_INVALID_INPUT: Check the tool's input schema.");
    expect(await toolError(await app.call("list_options", {
      category: "approval_output_schema", outputSchemaId: FOREIGN,
    }))).toBe("OUTPUT_SCHEMA_NOT_FOUND: The requested resource is not available to this account.");
    app.services.outputSchemas.get.mockResolvedValueOnce({
      ...record, outputSchemaId: FOREIGN, name: "Foreign Schema",
    });
    expect(await toolError(await app.call("list_options", {
      category: "approval_output_schema", outputSchemaId: SCHEMA,
    }))).toBe("OUTPUT_SCHEMA_NOT_FOUND: The requested resource is not available to this account.");
    app.savedSchemas.delete(SCHEMA);
    expect(await toolError(await app.call("list_options", {
      category: "approval_output_schema", outputSchemaId: SCHEMA,
    }))).toBe("OUTPUT_SCHEMA_NOT_FOUND: The requested resource is not available to this account.");
    noProjectOrRun(app);
  });
});
