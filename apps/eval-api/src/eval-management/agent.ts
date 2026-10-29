import { createHash } from "node:crypto";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { Context } from "hono";
import type { z } from "zod";
import type { AppBindings } from "../lib/types.js";
import { collection, readLibrary, record, short } from "./common.js";
import type { createAgentSchema } from "./schemas.js";

type AgentInput = z.output<typeof createAgentSchema>;

function unavailable(): never {
  throw new HttpError("EVAL_SP_CONFLICT", "A selected Agent resource is no longer available");
}

async function requireComponents(c: Context<AppBindings>, kind: "connector" | "extension", ids: readonly string[]) {
  if (!ids.length) return;
  const wanted = new Set(ids);
  const found = new Set<string>();
  for (let page = 1; page <= 10 && found.size < wanted.size; page++) {
    const query = new URLSearchParams({ kind, page: String(page), pageSize: "50" });
    const { data, total } = collection(await readLibrary(c, "/components", query));
    if (total > 500) unavailable();
    for (const item of data) {
      if (!wanted.has(String(item.id))) continue;
      if (item.status !== "active" || item.selectable !== true || found.has(String(item.id))) unavailable();
      found.add(String(item.id));
    }
    if (page * 50 >= total) break;
  }
  if (found.size !== wanted.size) unavailable();
}

async function requireToolkits(c: Context<AppBindings>, ids: readonly string[]) {
  if (!ids.length) return;
  const wanted = new Set(ids);
  const found = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10 && found.size < wanted.size; page++) {
    const query = new URLSearchParams();
    if (cursor) query.set("cursor", cursor);
    const result = record(await readLibrary(c, "/connectors", query));
    if (!result || !Array.isArray(result.items) || result.items.length > 200) unavailable();
    for (const candidate of result.items) {
      const item = record(candidate);
      if (!item || !wanted.has(String(item.toolkitId))) continue;
      if (item.status !== "connected" || found.has(String(item.toolkitId))) unavailable();
      found.add(String(item.toolkitId));
    }
    if (found.size === wanted.size || result.nextCursor === null) break;
    if (typeof result.nextCursor !== "string" || !result.nextCursor || cursors.has(result.nextCursor)) unavailable();
    cursor = result.nextCursor;
    cursors.add(cursor);
  }
  if (found.size !== wanted.size) unavailable();
}

async function requireResources(c: Context<AppBindings>, input: AgentInput) {
  const models = await readLibrary(c, "/models");
  if (!Array.isArray(models) || models.length > 1000) throw new HttpError("RESPONSE_INVALID", "Invalid model catalog");
  const matches = models.filter((value) => record(value)?.id === input.modelId);
  if (matches.length !== 1) unavailable();
  const model = record(matches[0])!;
  if (model.available !== true || typeof model.providerModel !== "string" || !model.providerModel
    || typeof model.thinking !== "string" || typeof model.executionLevel !== "string") unavailable();

  if (input.skillIds.length) {
    const query = new URLSearchParams({ view: "selected", ids: input.skillIds.join(","), pageSize: "50" });
    const { data } = collection(await readLibrary(c, "/skills", query));
    for (const id of input.skillIds) {
      if (data.filter((item) => item.id === id && item.available === true && item.deleted === false).length !== 1) unavailable();
    }
  }
  for (const id of input.referenceFileIds) {
    const item = record(await readLibrary(c, "/user-references/{id}", new URLSearchParams(), id));
    if (!item || item.id !== id || item.status !== "active") unavailable();
  }
  for (const id of input.actionIds) {
    const item = record(await readLibrary(c, "/actions/{id}", new URLSearchParams(), id));
    if (!item || item.id !== id || item.status !== "active" || item.selectable !== true) unavailable();
  }
  await requireComponents(c, "connector", input.connectorIds);
  await requireComponents(c, "extension", input.extensionIds);
  await requireToolkits(c, input.connectorToolkitIds);
  return model;
}

/** A stable owner-scoped slug; no name/content-based deduplication or arbitrary Config inputs. */
export function agentSlug(ownerUserId: string, operationKey: string): string {
  return `eval-mgmt-${createHash("sha256").update(JSON.stringify(["eval-mgmt-agent/v1", ownerUserId, operationKey])).digest("hex")}`;
}

export async function createAgent(c: Context<AppBindings>, input: AgentInput) {
  const model = await requireResources(c, input);
  const template = record(await readLibrary(c, "/default-template"));
  const defaults = record(template?.setting);
  if (!defaults) throw new HttpError("RESPONSE_INVALID", "SP returned an invalid Agent template");
  const created = await c.var.services.agentConfigs.create({
    slug: agentSlug(c.var.user.id, input.operationKey),
    name: input.name,
    description: input.description ?? null,
    purpose: input.purpose,
    setting: {
      ...defaults,
      // The live preset determines the full model selection; the caller cannot inject other settings.
      presetId: input.modelId, model: model.providerModel,
      thinking: model.thinking, executionLevel: model.executionLevel,
      systemPrompt: input.instructions,
      skillIds: input.skillIds, referenceFileIds: input.referenceFileIds, actionIds: input.actionIds,
      // Only explicitly selected Connector Toolkits are added; Eval handles the result MCP by purpose.
      mcpServers: input.connectorToolkitIds.map((serverId) => ({ kind: "connector_toolkit", serverId })),
      connectorIds: input.connectorIds, extensionIds: input.extensionIds,
    },
  }, { verifyReplay: true });
  // The ordinary Agent service owns purpose persistence and evaluation-result MCP reconciliation.
  return { agentId: created.id, name: short(created.name, 200), purpose: input.purpose };
}
