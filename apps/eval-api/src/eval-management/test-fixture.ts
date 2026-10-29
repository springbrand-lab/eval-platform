import { vi } from "vitest";
import type { ApiRuntime, OwnerServices } from "../lib/types.js";
import type { OutputSchemaRecord } from "../db/output-schemas.js";
import type { EvalSpClient } from "../sp/client.js";
import type { SpObservationClient } from "../sp/observation.js";
import { nativeAssistantMessage } from "../sp/native-test-fixture.js";
import { parseEvaluationOutputSchema } from "../project-output-schema.js";
import type { ManagementFiles } from "./files.js";
import { requestApp, WEB_ORIGIN } from "../test-support.js";
import { EVAL_MANAGEMENT_MCP_PATH } from "./mcp.js";
import { fakeManagement } from "./management.test-support.js";

export const OWNER = "11111111-1111-4111-8111-111111111111";
export const DATASET = "22222222-2222-4222-8222-222222222222";
export const AGENT = "33333333-3333-4333-8333-333333333333";
export const SCHEMA = "44444444-4444-4444-8444-444444444444";
export const MANAGEMENT_TOKEN = "management".repeat(5);
export const RESULT_TOKEN = "result".repeat(7);
export const WEB_TOKEN = "web".repeat(12);
export const run = {
  runId: "run-1", projectId: "project-1", operation: "pipeline" as const,
  status: "succeeded" as const, phase: "evaluation" as const, phases: ["execution", "evaluation"] as const,
  samplingIds: ["sampling-1"], evaluationIds: ["evaluation-1"],
  selector: { all: true }, targets: { projectSampleIds: ["sample-1"], samplingIds: [] },
  sourceCommit: "a".repeat(40),
};
export const project = {
  projectId: "project-1", name: "Private project", ownerUserId: OWNER,
  sourceBranch: "eval", createdAt: "2026-01-01T00:00:00.000Z",
};
export const preview = {
  projectId: project.projectId, operation: "execution" as const, selector: { all: true },
  targets: { projectSampleIds: ["sample-1"], samplingIds: [] },
  replacedSamplingCount: 0, newSamplingCount: 2, evaluationCount: 0,
  executionPlanDigest: "digest", evaluationPlanDigest: null,
};

export async function toolValue(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json() as { result: { isError?: boolean; content: [{ text: string }] } };
  if (body.result.isError) throw new Error(`Unexpected MCP tool error: ${body.result.content[0].text}`);
  return JSON.parse(body.result.content[0].text) as Record<string, unknown>;
}

export function setupManagement(configured = true, files?: ManagementFiles) {
  const managed = fakeManagement(OWNER);
  const savedSchemas = new Map<string, OutputSchemaRecord>([[
    SCHEMA, { outputSchemaId: SCHEMA, name: "Output", description: "Existing output",
      schema: { secret: "private" } },
  ]]);
  const services = {
    agentConfigs: {
      listAgents: vi.fn(async () => [{ agentConfig: { ownerUserId: OWNER, userAgentId: AGENT },
        name: "Agent", purpose: "execution", role: "subject" }]),
      create: vi.fn(async (body: Record<string, unknown>) => ({
        id: AGENT, name: body.name, user_id: OWNER, setting: body.setting, slug: body.slug,
      })),
    },
    datasets: { listDatasets: vi.fn(async () => [{ datasetId: DATASET, name: "Dataset" }]) },
    projects: {
      list: vi.fn(async () => [project]),
      create: vi.fn(async (_body: unknown) => ({ project, run: { runId: run.runId, samplingIds: run.samplingIds } })),
    },
    outputSchemas: {
      list: vi.fn(async () => [...savedSchemas.values()]),
      get: vi.fn(async (id: string) => savedSchemas.get(id) ?? null),
      create: vi.fn(async (input: { name: string; description: string; content: string }, plannedId?: string) => {
        const row = { outputSchemaId: plannedId ?? crypto.randomUUID(), name: input.name,
          description: input.description, schema: parseEvaluationOutputSchema(input.content) };
        if (savedSchemas.has(row.outputSchemaId)) throw new Error("An output Schema with this ID already exists");
        savedSchemas.set(row.outputSchemaId, row);
        return row;
      }),
      updateMetadata: vi.fn(async (id: string, patch: { name?: string; description?: string }) => {
        const row = savedSchemas.get(id);
        if (!row) throw new Error("Unknown output Schema");
        const updated = { ...row, ...patch };
        savedSchemas.set(id, updated);
        return updated;
      }),
    },
    admission: {
      preview: vi.fn(async (_input: unknown) => preview),
      submit: vi.fn(async (_input: unknown) => ({ runId: "run-2", samplingIds: ["sampling-2"] })),
    },
    projectRuns: {
      readRun: vi.fn(async (projectId: string, runId: string) => projectId === project.projectId && runId === run.runId
        ? { run, samplings: [{ samplingId: "sampling-1", execution: { status: "succeeded" } }],
          evaluations: [{ evaluationId: "evaluation-1", samplingId: "sampling-1", status: { status: "succeeded" } }] }
        : null),
      stopRun: vi.fn(async (projectId: string, runId: string) => projectId === project.projectId && runId === run.runId
        ? { runId, stopRequested: true as const } : null),
    },
    results: { getRun: vi.fn(async (_runId: string) => run) },
    metrics: {
      getProjectOverview: vi.fn(async (_query: unknown): Promise<unknown> => undefined),
      getDatasetOverview: vi.fn(async (_query: unknown): Promise<unknown> => undefined),
      getSampleOverview: vi.fn(async (_query: unknown): Promise<unknown> => undefined),
      getSamplingDetail: vi.fn(async (_query: unknown): Promise<unknown> => undefined),
    },
    observations: {
      subject: vi.fn(async (projectId: string, samplingId: string) => ({
        role: "subject", projectId, samplingId, ownerUserId: OWNER,
        chatId: "subject-chat" as string | undefined, state: "available",
      })),
      evaluator: vi.fn(async (projectId: string, evaluationId: string) => ({
        role: "evaluator", projectId, samplingId: "sampling-1", evaluationId,
        ownerUserId: OWNER, chatId: "evaluator-chat", state: "available",
      })),
    },
  };
  const template = { name: "Default", setting: {
    model: null, presetId: null, thinking: "medium", executionLevel: "safe", systemPrompt: null,
    toolPolicy: { allow: [], deny: [] }, subagentNames: [], memoryDefaults: { enabled: true, memoryTokens: 2000, preferencesTokens: 500 },
    sandbox: { enabled: false }, skillIds: [], actionIds: [], referenceFileIds: [],
    mcpServers: [{ serverId: "old-server" }], connectorIds: ["old-connector"], extensionIds: [],
  } };
  const sp = {
    getCreditBalance: vi.fn(async () => ({ availableUnits: 5, topupRemainingUnits: 1, otherRemainingUnits: 4 })),
    requestAgentLibrary: vi.fn(async (_token: string, input: { route: { path: string }; search: string; id?: string }): Promise<unknown> => {
      if (input.route.path === "/default-template") return template;
      if (input.route.path === "/models") return [{ id: "model-1", name: "Model", providerModel: "provider/model",
        thinking: "medium", executionLevel: "safe", available: true, thinkingLevels: ["medium"], requiredPlan: "free" }];
      if (input.route.path === "/skills") return { data: [{ id: "skill-1", name: "Skill", description: "safe",
        available: true, deleted: false }], total: 1 };
      if (input.route.path === "/actions/{id}") return { id: input.id, name: "Action", status: "active", selectable: true };
      if (input.route.path === "/user-references/{id}") return { id: input.id, name: "Reference", status: "active", size: 10 };
      throw new Error(`Unexpected public library path ${input.route.path}`);
    }),
  };
  const observation = {
    trajectory: vi.fn(async (chat: { chatId: string }, _query: unknown): Promise<unknown> => ({
    format: "sp-pi-trajectory/v1", cursor: { throughSeq: 4 },
    records: [nativeAssistantMessage(4, chat.chatId, "submission-1",
      [{ type: "text", text: "private prompt / private response" }])], nextAfterSeq: null,
    })),
    trajectoryRecord: vi.fn(async (_chat: unknown, _row: unknown): Promise<unknown> => {
      throw new Error("Unexpected SAFE Pi record-byte read");
    }),
  };
  const release = vi.fn();
  const ownerServices = vi.fn((_user: { id: string }, _sessionToken: string) => ({
    services: services as unknown as OwnerServices, release,
  }));
  const runtime = {
    webOrigin: WEB_ORIGIN, webApiToken: WEB_TOKEN,
    spAdminToken: "unused",
    ...(configured ? { evalManagement: {
      token: MANAGEMENT_TOKEN, files: files ?? managed.files, store: managed.store, spOrigin: "https://evalrapi.springbrand.ai",
    } } : {}),
    evaluationResults: { token: RESULT_TOKEN, submissions: { target: vi.fn(), save: vi.fn() } },
    serviceAccount: { user: { id: OWNER, role: "user" }, email: "fixed@example.test", sessionToken: "fixed-session" },
    ownerServices, sp: sp as unknown as EvalSpClient, observation: observation as unknown as SpObservationClient,
  } as ApiRuntime;
  const request = requestApp(runtime);
  const rpc = (body: unknown, token = MANAGEMENT_TOKEN) => request(EVAL_MANAGEMENT_MCP_PATH, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const call = (name: string, args: unknown) => rpc({
    jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args },
  });
  return { request, rpc, call, services, sp, observation, release, ownerServices, runtime, managed, savedSchemas };
}
