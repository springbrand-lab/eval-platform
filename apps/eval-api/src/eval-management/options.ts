import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { Data } from "@eval-platform/eval-dataset";
import { RuntimeInputError, digestJson } from "@eval-platform/eval-runtime";
import type { Context } from "hono";
import type { AppBindings } from "../lib/types.js";
import { INPUT_LIMITS } from "../limits.js";
import { fitsTaktResult, jsonChunk, pageOf, record, redactLiteral, short, type JsonChunkResult } from "./common.js";
import { resourceOptions } from "./resource-options.js";
import { resourceIdSchema, type listOptionsSchema } from "./schemas.js";
import type { z } from "zod";

type Options = z.output<typeof listOptionsSchema>;
type Choice = { readonly id: string; readonly name: string; readonly purpose?: "execution" | "evaluation" };
const MAX_APPROVAL_CASES = 50;
const KNOWN_SETTING_FIELDS = new Set(["model", "presetId", "thinking", "executionLevel", "systemPrompt",
  "toolPolicy", "subagentNames", "memoryDefaults", "sandbox", "skillIds", "actionIds", "referenceFileIds",
  "mcpServers", "connectorIds", "extensionIds", "authoring", "preferredSupplierIds", "referenceNotes"]);

/** Only public editor selection IDs, never instructions, endpoints, credentials or unknown config fields. */
function selectedAgentResources(body: unknown) {
  const setting = record(record(body)?.setting);
  const invalid = () => new HttpError("RESPONSE_INVALID", "Agent resource selection cannot be reviewed");
  if (!setting || Object.keys(setting).some((key) => !KNOWN_SETTING_FIELDS.has(key))) throw invalid();
  const safeId = (value: unknown) => {
    const parsed = resourceIdSchema.safeParse(value);
    if (!parsed.success || parsed.data.includes("://") || parsed.data.includes("\\")
      || parsed.data.split("/").some((part) => !part || part === "." || part === "..")) throw invalid();
    return parsed.data;
  };
  const ids = (value: unknown, limit = 50): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > limit) throw invalid();
    return value.map(safeId);
  };
  const modelId = setting.presetId == null ? null : safeId(setting.presetId);
  const model = setting.model == null ? null : safeId(setting.model);
  if (setting.authoring !== undefined && !record(setting.authoring)
    || setting.referenceNotes !== undefined && typeof setting.referenceNotes !== "string") throw invalid();
  const mcpServers = setting.mcpServers === undefined ? [] : setting.mcpServers;
  if (!Array.isArray(mcpServers) || mcpServers.length > 50) throw invalid();
  const selectedMcp = mcpServers.map((item) => {
    const selection = record(item);
    if (!selection || Object.keys(selection).some((key) => key !== "kind" && key !== "serverId")
      || selection.kind !== undefined && selection.kind !== "connector_toolkit") throw invalid();
    return { kind: selection.kind === "connector_toolkit" ? "connector_toolkit" : "managed",
      serverId: safeId(selection.serverId) };
  });
  const policy: Record<string, unknown> | null = setting.toolPolicy === undefined ? {} : record(setting.toolPolicy);
  if (!policy || Object.keys(policy).some((key) => key !== "allow" && key !== "deny")) throw invalid();
  return {
    modelId, model, skillIds: ids(setting.skillIds), referenceFileIds: ids(setting.referenceFileIds),
    actionIds: ids(setting.actionIds), connectorIds: ids(setting.connectorIds),
    extensionIds: ids(setting.extensionIds), subagentNames: ids(setting.subagentNames),
    preferredSupplierIds: ids(setting.preferredSupplierIds, 64),
    referenceNotesChars: typeof setting.referenceNotes === "string" ? setting.referenceNotes.length : 0,
    authoringPresent: setting.authoring !== undefined,
    mcpServers: selectedMcp, toolPolicy: { allow: ids(policy.allow), deny: ids(policy.deny) },
  };
}

async function bindings(row: Data) {
  return {
    dataId: row.dataId, initialMaterials: row.initialMaterials ?? [],
    evalInitialMaterials: row.evalInitialMaterials ?? [], initialSession: row.initialSession ?? null,
    contentDigest: await digestJson(row),
  };
}

/** A full selected-member digest, not just a page: callers must compare it across all pages. */
async function approvalDataset(c: Context<AppBindings>, input: Options) {
  const datasetId = input.datasetId!;
  if (!c.env.evalManagement) throw new HttpError("INTERNAL_ERROR", "Management preparation is unavailable");
  await c.env.evalManagement.store.assertReadyDatasets(c.var.user.id, [datasetId]);
  const { dataset, data: selected, digest } = await c.var.services.projects.reviewSelection({
    datasetId, ...(input.dataIds ? { dataIds: input.dataIds } : {}),
  }).catch((error: unknown) => {
    if (error instanceof RuntimeInputError) {
      throw new HttpError("REQUEST_INVALID_INPUT", "A selected Data is not a current Dataset member");
    }
    throw error;
  });
  if (!selected.length || selected.length > MAX_APPROVAL_CASES) {
    throw new HttpError("CATALOG_PAYLOAD_TOO_LARGE", "Select between 1 and 50 Data for approval");
  }
  return {
    category: "approval_dataset", datasetId, name: short(dataset.name),
    // Digest covers the complete same-snapshot Data/metadata ProjectService will actually freeze.
    digest,
    ...pageOf(await Promise.all(selected.map(bindings)), input.page, input.pageSize),
  };
}

/** A name-only page. The Store proves order and gates pending preparations in the same owner snapshot. */
async function datasetDataOptions(c: Context<AppBindings>, input: Options) {
  if (!c.env.evalManagement) throw new HttpError("INTERNAL_ERROR", "Management preparation is unavailable");
  const datasetId = input.datasetId!;
  const { page } = input;
  const pageSize = Math.min(input.pageSize, 20); // Match Eval Web's Data page, not Material/Session directories.
  const listing = await c.env.evalManagement.store.listDatasetData(c.var.user.id, datasetId, page, pageSize);
  const names = listing.items.map(({ dataId, content }) => {
    if (typeof content.name !== "string") return { dataId, name: null, redacted: false };
    // A user-authored name can itself contain a prompt or credential. Never project other Data fields.
    const safe = redactLiteral(content.name, "", [
      typeof content.userPrompt === "string" ? content.userPrompt : "",
      typeof content.evalPrompt === "string" ? content.evalPrompt : "",
    ]);
    return { dataId, name: safe.value, redacted: safe.redacted };
  });
  const datasetName = redactLiteral(listing.name);
  const render = (nameLimit: number) => {
    const items = names.map(({ dataId, name, redacted }) => {
      if (name === null) return { dataId, name: null };
      // Sensitive names stay fully masked. Safe names share one per-page adaptive
      // display limit, so JSON escaping/UTF-8 never drops an identity from the page.
      const limit = redacted ? 80 : nameLimit;
      let value = short(name, limit);
      if (value.length < name.length && /[\ud800-\udbff]$/u.test(value)) value = value.slice(0, -1);
      return { dataId, name: value,
        ...(redacted ? { sourceRedacted: true } : {}),
        ...(value.length < name.length ? { nameTruncated: true } : {}) };
    });
    return {
      category: "dataset_data", datasetId, name: short(datasetName.value, 100),
      ...(datasetName.redacted ? { sourceRedacted: true } : {}),
      order: listing.order, page, pageSize, total: listing.total, items,
    };
  };
  let result = render(80);
  if (!fitsTaktResult(result)) {
    // 20 UUID identities and the bounded Dataset label fit even at zero displayed
    // Data-name characters. Select the longest *uniform* prefix that actually fits.
    result = render(0);
    if (!fitsTaktResult(result)) throw new HttpError("CATALOG_PAYLOAD_TOO_LARGE", "Dataset member page is too large");
    let low = 1, high = 79;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = render(middle);
      if (fitsTaktResult(candidate)) { result = candidate; low = middle + 1; }
      else high = middle - 1;
    }
  }
  return result;
}

async function approvalOutputSchema(c: Context<AppBindings>, input: Options) {
  const outputSchemaId = input.outputSchemaId!;
  const schema = await c.var.services.outputSchemas.get(outputSchemaId);
  if (!schema || schema.outputSchemaId !== outputSchemaId) throw new HttpError("OUTPUT_SCHEMA_NOT_FOUND");
  return { category: "approval_output_schema", outputSchemaId, name: short(schema.name, 200),
    digest: await digestJson(schema) };
}

/** The same active owner-catalog selection is used by the MCP and the trusted one-shot GET. */
export async function readOwnedOutputSchema(c: Context<AppBindings>, outputSchemaId: string) {
  const schema = await c.var.services.outputSchemas.get(outputSchemaId);
  if (!schema || schema.outputSchemaId !== outputSchemaId) throw new HttpError("OUTPUT_SCHEMA_NOT_FOUND");
  if (typeof schema.name !== "string" || schema.name.length > 200) {
    throw new HttpError("RESPONSE_INVALID", "The output Schema name is invalid");
  }
  return schema;
}

/** One owned catalog record, not a Schema guessed by its (non-unique) name or a Project-scoped prompt. */
async function outputSchemaDetail(c: Context<AppBindings>, input: Options) {
  const outputSchemaId = input.outputSchemaId!;
  const schema = await readOwnedOutputSchema(c, outputSchemaId);
  const name = redactLiteral(schema.name);
  const modelResult = ({ chunk, sourceRedacted, streamRequired, display }: JsonChunkResult) => ({
    category: "output_schema_detail", outputSchemaId, name: short(name.value, 80),
    ...(name.value.length > 80 ? { nameTruncated: true } : {}),
    sourceRedacted: name.redacted || sourceRedacted, schemaChunk: chunk,
    ...(streamRequired ? { streamRequired, display } : {}),
  });
  const result = jsonChunk(schema.schema, input.schemaOffset ?? 0, [],
    (chunk, sourceRedacted) => fitsTaktResult(modelResult({ chunk, sourceRedacted })));
  return modelResult(result);
}

/** The Project service checks owner, soft deletion and the plan's original body digest in one read. */
export async function readOwnedProjectSchema(c: Context<AppBindings>, projectId: string) {
  const document = await c.var.services.projects.getEvaluationOutputSchema(projectId);
  if (!document) throw new HttpError("OUTPUT_SCHEMA_NOT_FOUND", "This Project has no evaluation output Schema");
  return document;
}

/** Never substitute an active/mutable catalog Schema for the Project's frozen evaluation plan. */
async function projectSchemaDetail(c: Context<AppBindings>, input: Options) {
  const projectId = input.projectId!;
  const { reference, content } = await readOwnedProjectSchema(c, projectId);
  const modelResult = ({ chunk, sourceRedacted, streamRequired, display }: JsonChunkResult) => ({
    category: "project_schema_detail", projectId,
    outputSchemaId: reference.outputSchemaId, digest: reference.digest,
    sourceRedacted, schemaChunk: chunk, ...(streamRequired ? { streamRequired, display } : {}),
  });
  const result = jsonChunk(content, input.schemaOffset ?? 0, [],
    (chunk, sourceRedacted) => fitsTaktResult(modelResult({ chunk, sourceRedacted })));
  return modelResult(result);
}

/** Only an active owned Agent is selectable. Hash its whole public SP body, but never return it. */
async function approvalAgent(c: Context<AppBindings>, input: Options) {
  const userAgentId = input.userAgentId!;
  const options = (await c.var.services.agentConfigs.listAgents("subject"))
    .filter((option) => option.agentConfig.userAgentId === userAgentId);
  if (options.length !== 1) throw new HttpError("REQUEST_INVALID_INPUT", "Agent is not selectable");
  const config = await c.var.services.agentConfigs.get(userAgentId);
  if (config.id !== userAgentId || config.user_id !== c.var.user.id || config.name !== options[0]!.name) {
    throw new HttpError("RESPONSE_INVALID", "Selected Agent body changed during review");
  }
  return { category: "approval_agent", userAgentId, name: short(config.name, 200),
    purpose: options[0]!.purpose, configDigest: await digestJson(config),
    resources: selectedAgentResources(config) };
}

/** Use the frozen Project and owned Sampling reads, not mutable Dataset membership or model claims. */
async function approvalProject(c: Context<AppBindings>, input: Options) {
  const projectId = input.projectId!;
  const view = await c.var.services.projects.get(projectId);
  if (!view || view.project.projectId !== projectId) throw new HttpError("PROJECT_NOT_FOUND");
  const samplingIds = input.samplingIds ?? [];
  const samplings = await Promise.all(samplingIds.map((id) => c.var.services.results.getSampling(id)));
  if (samplings.some((item) => item.projectId !== projectId)) throw new HttpError("RUN_TARGETS_STALE");
  const selectedIds = new Set([...(input.projectSampleIds ?? []), ...samplings.map((item) => item.projectSampleId)]);
  const selected = view.projectSamples.filter((item) => selectedIds.delete(item.projectSampleId));
  if (selectedIds.size || !selected.length || selected.length > MAX_APPROVAL_CASES) {
    throw new HttpError("RUN_TARGETS_STALE", "Cannot review the complete Project selection");
  }
  if (selected.some((item) => item.dataId !== item.data.dataId)) {
    throw new HttpError("RESPONSE_INVALID", "The Project snapshot is inconsistent");
  }
  const items = await Promise.all(selected.map(async (sample) => ({
    projectSampleId: sample.projectSampleId, datasetIds: sample.datasetIds, samplingCount: sample.samplingCount,
    ...await bindings(sample.data),
    targetSamplingIds: samplings.filter((item) => item.projectSampleId === sample.projectSampleId)
      .map((item) => item.samplingId),
  })));
  const executionAgent = {
    userAgentId: view.execution.subjectAgentConfig.sourceUserAgentId,
    name: short(view.execution.subjectAgentConfig.name, 200),
    resources: selectedAgentResources(view.execution.subjectAgentConfig.body),
  };
  const evaluationAgent = view.evaluation ? {
    userAgentId: view.evaluation.plan.evaluatorAgentConfig.sourceUserAgentId,
    name: short(view.evaluation.plan.evaluatorAgentConfig.name, 200),
    outputSchemaId: view.evaluation.plan.outputSchema.outputSchemaId,
    resources: selectedAgentResources(view.evaluation.plan.evaluatorAgentConfig.body),
  } : null;
  return {
    category: "approval_project", projectId, name: short(view.project.name), executionAgent, evaluationAgent,
    executionPlanDigest: view.executionPlanDigest, evaluationPlanDigest: view.evaluation?.digest ?? null,
    digest: await digestJson({ projectId, executionPlanDigest: view.executionPlanDigest,
      evaluationPlanDigest: view.evaluation?.digest ?? null, items,
      projectSampleIds: input.projectSampleIds ?? [], samplingIds }),
    ...pageOf(items, input.page, input.pageSize),
  };
}

/** Display-only Project plan; prospective Run counts and raw frozen bodies stay out of model context. */
async function projectDetail(c: Context<AppBindings>, input: Options) {
  const projectId = input.projectId!;
  const view = await c.var.services.projects.get(projectId);
  if (!view || view.project.projectId !== projectId || view.project.ownerUserId !== c.var.user.id) {
    throw new HttpError("PROJECT_NOT_FOUND");
  }
  const schemaId = view.evaluation?.plan.outputSchema.outputSchemaId;
  const schema = schemaId ? await c.var.services.outputSchemas.get(schemaId) : null;
  if (schema && schema.outputSchemaId !== schemaId) {
    throw new HttpError("RESPONSE_INVALID", "The Project's output Schema identity changed");
  }
  return {
    category: "project_detail",
    project: { projectId, name: short(view.project.name) },
    totalCases: view.projectSamples.length,
    datasets: pageOf(view.datasets.map((dataset) => ({
      datasetId: dataset.datasetId, name: short(dataset.name),
    })), input.page, input.pageSize),
    executionAgent: {
      userAgentId: view.execution.subjectAgentConfig.sourceUserAgentId,
      name: short(view.execution.subjectAgentConfig.name),
    },
    evaluation: view.evaluation ? {
      userAgentId: view.evaluation.plan.evaluatorAgentConfig.sourceUserAgentId,
      name: short(view.evaluation.plan.evaluatorAgentConfig.name),
      outputSchemaId: schemaId, outputSchemaName: schema ? short(schema.name) : null,
      locked: view.evaluation.lockedAt !== null,
    } : null,
  };
}

export async function listOptions(c: Context<AppBindings>, input: Options) {
  const { category, q, page, pageSize } = input;
  if (["material_bundles", "session_bundles", "materials", "sessions", "material_files", "session_files"].includes(category)) {
    return resourceOptions(c, input);
  }
  if (category === "dataset_data") return datasetDataOptions(c, input);
  if (category === "approval_dataset") return approvalDataset(c, input);
  if (category === "approval_agent") return approvalAgent(c, input);
  if (category === "approval_output_schema") return approvalOutputSchema(c, input);
  if (category === "output_schema_detail") return outputSchemaDetail(c, input);
  if (category === "project_schema_detail") return projectSchemaDetail(c, input);
  if (category === "approval_project") return approvalProject(c, input);
  if (category === "project_detail") return projectDetail(c, input);
  if (category === "input_limits") return { category, limits: INPUT_LIMITS };
  if (category === "credits") {
    const { availableUnits, topupRemainingUnits, otherRemainingUnits } =
      await c.env.sp.getCreditBalance(c.var.sessionToken);
    return { category, balance: { availableUnits, topupRemainingUnits, otherRemainingUnits } };
  }

  let choices: Choice[] = [];
  switch (category) {
    case "agents":
      // One row per Agent, not the duplicate Subject/Evaluator role choices of /api/agents.
      choices = (await c.var.services.agentConfigs.listAgents("subject")).map((item) => ({
        id: item.agentConfig.userAgentId, name: short(item.name), purpose: item.purpose,
      }));
      break;
    case "datasets":
      choices = (await c.var.services.datasets.listDatasets()).map((item) => ({
        id: item.datasetId, name: short(item.name),
      }));
      break;
    case "projects":
      choices = (await c.var.services.projects.list()).map((item) => ({
        id: item.projectId, name: short(item.name),
      }));
      break;
    case "output_schemas":
      // The catalog record also contains the entire JSON Schema; never include it in a choice.
      choices = (await c.var.services.outputSchemas.list()).map((item) => ({
        id: item.outputSchemaId, name: short(item.name),
      }));
      break;
  }
  const needle = q?.toLocaleLowerCase();
  const filtered = choices.filter(({ id, name }) =>
    !needle || id.toLocaleLowerCase().includes(needle) || name.toLocaleLowerCase().includes(needle));
  filtered.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { category, ...pageOf(filtered, page, pageSize) };
}
