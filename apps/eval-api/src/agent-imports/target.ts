import { z } from "zod";
import { equalJson } from "@eval-platform/eval-contracts";
import { importOriginSchema } from "../config/agent-imports.js";
import { createImportDownloads } from "./bytes.js";
import { httpOriginSchema } from "../config/env.js";
import { createSpHttpClient, EvalSpApiError, throwSpClientError, type Fetch } from "../sp/http.js";
import type { EvalSpAgentConfig, EvalSpClient } from "../sp/client.js";
import { exportFileSchema, receiptSchema, type ImportReceipt, type ImportResult, type PreparedAgent, type ResourceKind } from "./model.js";
import { ImportConflictError, ImportDependencyError, ImportOutcomeUnknownError, ImportTargetDisabledError } from "./errors.js";
import { DEFINITION_PROBE_LIMIT, definitionEvidenceSchema, requireDefinitionEvidence, type DefinitionEvidence } from "./definition-evidence.js";

const record = z.record(z.string(), z.unknown());
const resultSchema = z.object({ receipt: receiptSchema, replayed: z.boolean(), resource: record });
const skillSummary = z.object({
  id: z.string(), name: z.string(), origin: z.enum(["upload", "marketplace"]), available: z.boolean(), deleted: z.boolean(),
});
const skillsPage = z.object({
  data: z.array(skillSummary), total: z.number().int().nonnegative(), page: z.number().int().positive(), pageSize: z.number().int().positive(),
});
const skillFiles = z.object({ id: z.string(), name: z.string(), files: z.array(exportFileSchema).min(1) });
const referenceSchema = z.object({
  id: z.uuid(), name: z.string(), mediaType: z.string(), size: z.number().int().nonnegative(),
  status: z.enum(["active", "disabled"]), attachmentCdnUrl: z.url(),
});
const attachmentSchema = z.strictObject({
  attachmentCdnUrl: z.url(), clientAttachmentId: z.uuid(), name: z.string(), mediaType: z.string(), size: z.number().int().nonnegative(),
});
export type TargetSkill = z.infer<typeof skillSummary> & z.infer<typeof skillFiles>;
export type TargetReference = z.infer<typeof referenceSchema>;
export type TargetAttachment = z.infer<typeof attachmentSchema>;

export interface AgentImportTarget {
  readonly origin: string;
  readonly ownerUserId: string;
  config(): Promise<{ version: 1; enabled: boolean }>;
  requireEnabled(): Promise<void>;
  listAgents(): Promise<readonly EvalSpAgentConfig[]>;
  agent(id: string): Promise<EvalSpAgentConfig | null>;
  skill(id: string): Promise<TargetSkill | null>;
  conflictingSkillName(id: string, name: string): Promise<boolean>;
  reference(id: string): Promise<TargetReference | null>;
  receipt(kind: ResourceKind, importKey: string): Promise<ImportResult | null>;
  importAgent(prepared: PreparedAgent, importKey: string): Promise<ImportResult>;
  importSkill(id: string, zip: Uint8Array, importKey: string): Promise<ImportResult>;
  uploadReference(id: string, name: string, mediaType: string, bytes: Uint8Array): Promise<TargetAttachment>;
  importReference(id: string, attachment: TargetAttachment, importKey: string): Promise<ImportResult>;
  validateSelections(setting: Record<string, unknown>, dependencies?: readonly DefinitionEvidence[]): Promise<void>;
}
export function checkReceipt(result: ImportResult, kind: ResourceKind, id: string, importKey: string, known?: ImportReceipt | null): void {
  const receipt = receiptSchema.parse(result.receipt);
  if (receipt.resourceKind !== kind || receipt.resourceId !== id || receipt.importKey !== importKey
    || result.resource.id !== id || known && !equalJson(receipt, known)) {
    throw new ImportConflictError("Target receipt does not match this resource intent");
  }
}
export function checkAgentResult(result: ImportResult, prepared: PreparedAgent, owner: string): void {
  const actual = result.resource;
  const expected = prepared.config;
  if (actual.user_id !== owner || actual.id !== expected.id || actual.slug !== expected.slug
    || actual.name !== expected.name || (actual.description ?? null) !== expected.description
    || !equalJson(actual.setting, expected.setting) || actual.is_default === true) {
    throw new ImportConflictError("Target Agent no longer matches the frozen import");
  }
}

/** Fixed Eval target. Nothing here accepts an origin, owner or credential from a browser or source payload. */
export function createAgentImportTarget(input: {
  origin: string; sourceOrigin?: string; writeOrigin: string; ownerUserId: string; sessionToken: string;
  sp: EvalSpClient; fetch?: Fetch;
}): AgentImportTarget {
  const origin = httpOriginSchema.parse(input.origin);
  if (input.sourceOrigin && origin === importOriginSchema.parse(input.sourceOrigin)) throw new TypeError("source and target origins must differ");
  const writeOrigin = httpOriginSchema.parse(input.writeOrigin);
  const ownerUserId = z.uuid().parse(input.ownerUserId).toLowerCase();
  if (!input.sessionToken.trim()) throw new TypeError("Target session token is required");
  const http = createSpHttpClient({ origin, responseMode: "envelope", timeoutMs: 60_000, maxResponseBytes: 16 * 1024 * 1024, fetch: input.fetch });
  function validateAttachment(attachment: TargetAttachment, id: string): void {
    const url = new URL(attachment.attachmentCdnUrl);
    createImportDownloads({ origin, purpose: "target" }).validateUrl(url.href);
    if (attachment.clientAttachmentId !== id || url.search || url.pathname !== `/uploads/v1/${ownerUserId}/${id}`
      || input.sourceOrigin === url.origin) throw new ImportConflictError("Reference attachment is not a target-owned upload");
  }
  async function request<T>(path: string, schema: z.ZodType<T>, body?: unknown, contentType?: string): Promise<T> {
    try {
      const result = await http.request(path, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${input.sessionToken}`, ...(body === undefined ? {} : { Origin: writeOrigin }),
          ...(contentType === undefined ? {} : { "Content-Type": contentType }) },
        ...(body === undefined ? {} : { body }),
      });
      return schema.parse(result.data);
    } catch (error) { throwSpClientError(error); }
  }
  function dependencyError(error: unknown): never {
    if (error instanceof ImportConflictError) throw error;
    if (error instanceof EvalSpApiError && error.status === 409) {
      const code = record.safeParse(error.payload).data?.code;
      if (code === "AGENT_CONFIG_IMPORT_CONFLICT" || code === "REQUEST_CONFLICT") {
        throw new ImportConflictError("Target import conflicts with the current resource or dependency definitions", error);
      }
    }
    throw new ImportDependencyError(undefined, error);
  }
  async function dependency<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); } catch (error) { dependencyError(error); }
  }
  async function nullable<T>(action: () => Promise<T>): Promise<T | null> {
    try { return await action(); } catch (error) {
      if (error instanceof EvalSpApiError && error.status === 404) return null;
      dependencyError(error);
    }
  }
  async function commit(kind: ResourceKind, id: string, importKey: string, write: () => Promise<ImportResult>): Promise<ImportResult> {
    const previous = await target.receipt(kind, importKey);
    if (previous) { checkReceipt(previous, kind, id, importKey); return previous; }
    // Never cache this authorization fact: a preview probe cannot authorize a later mutation.
    await target.requireEnabled();
    try {
      const result = await write();
      checkReceipt(result, kind, id, importKey);
      return result;
    } catch (error) {
      if (error instanceof ImportConflictError) throw error;
      if (error instanceof EvalSpApiError && [400, 409, 422].includes(error.status)) {
        throw new ImportConflictError("Target rejected the create-only import; existing resources were not changed", error);
      }
      // The POST may have committed. Only its durable receipt can turn an uncertain write into success.
      let result: ImportResult | null = null;
      try { result = await target.receipt(kind, importKey); } catch (cause) {
        if (cause instanceof ImportConflictError) throw cause;
        // An unavailable receipt lookup remains uncertain; queue recovery will retry it.
      }
      if (result) { checkReceipt(result, kind, id, importKey); return result; }
      throw new ImportOutcomeUnknownError(error);
    }
  }
  const target: AgentImportTarget = {
    origin, ownerUserId,
    config: () => dependency(() => request("/api/agent-config-imports/config", z.object({ version: z.literal(1), enabled: z.boolean() }))),
    async requireEnabled() {
      if (!(await target.config()).enabled) throw new ImportTargetDisabledError();
    },
    listAgents: () => dependency(() => input.sp.listAgentConfigs(input.sessionToken)),
    agent: (id) => nullable(() => input.sp.getAgentConfig(input.sessionToken, id)),
    async skill(id) {
      const page = await dependency(() => request(`/api/skills?${new URLSearchParams({ view: "selected", ids: id, pageSize: "100" })}`, skillsPage));
      const summary = page.data.find((item) => item.id === id);
      if (!summary) return null;
      if (!summary.available || summary.deleted) throw new ImportConflictError("Target Skill is not selectable");
      const files = await dependency(() => request(`/api/skills/${encodeURIComponent(id)}/files`, skillFiles));
      if (files.id !== id || files.name !== summary.name) throw new ImportConflictError("Target Skill identity changed");
      return { ...summary, ...files };
    },
    async conflictingSkillName(id, name) {
      const query = new URLSearchParams({ view: "library", q: name, pageSize: "100" });
      let expected: number | undefined;
      for (let page = 1; page <= 100; page++) {
        query.set("page", String(page));
        const result = await dependency(() => request(`/api/skills?${query}`, skillsPage));
        if (result.page !== page || expected !== undefined && result.total !== expected) throw new ImportDependencyError("Target Skill catalog changed during checking");
        expected = result.total;
        if (result.data.some((item) => item.id !== id && item.origin === "upload" && !item.deleted && item.name.toLowerCase() === name.toLowerCase())) return true;
        if (page * result.pageSize >= result.total) return false;
      }
      throw new ImportDependencyError("Target Skill catalog exceeds bounded search");
    },
    reference: (id) => nullable(() => request(`/api/user-references/${encodeURIComponent(id)}`, referenceSchema)),
    receipt: (kind, key) => nullable(() => request(`/api/agent-config-imports/receipts/${encodeURIComponent(key)}?kind=${kind}`, resultSchema)),
    async importAgent(prepared, importKey) {
      requireDefinitionEvidence(prepared.config.setting, prepared.dependencies);
      const result = await commit("agent", prepared.config.id, importKey, () => request(
        "/api/user-agent-configs/imports", resultSchema, { ...prepared.config, dependencies: prepared.dependencies, importKey },
      ));
      checkAgentResult(result, prepared, ownerUserId);
      return result;
    },
    importSkill: (id, zip, importKey) => commit("skill", id, importKey, () => request(
      `/api/skills/imports?${new URLSearchParams({ skillId: id, importKey })}`, resultSchema,
      zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength), "application/zip",
    )),
    async uploadReference(id, name, mediaType, bytes) {
      // Ordinary attachment upload has no import guard on SP; probe immediately before this POST too.
      await target.requireEnabled();
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(bytes)], { type: mediaType }), name);
      form.append("name", name);
      form.append("clientAttachmentId", id);
      const attachment = await dependency(() => request("/api/inbox/attachments", attachmentSchema, form));
      validateAttachment(attachment, id);
      if (attachment.clientAttachmentId !== id || attachment.name !== name || attachment.mediaType !== mediaType || attachment.size !== bytes.byteLength) {
        throw new ImportConflictError("Target attachment does not match the frozen Reference");
      }
      return attachment;
    },
    importReference: (id, attachment, importKey) => {
      validateAttachment(attachment, id);
      return commit("reference", id, importKey, () => request(
        "/api/user-references/imports", resultSchema, { referenceId: id, attachment, importKey },
      ));
    },
    async validateSelections(setting, dependencies = []) {
      const frozen = requireDefinitionEvidence(setting, dependencies);
      if (frozen.length > 0) {
        await target.requireEnabled();
        const { items } = await dependency(() => request("/api/agent-config-imports/dependencies", z.strictObject({
          items: z.array(definitionEvidenceSchema).max(DEFINITION_PROBE_LIMIT),
        }), { resources: frozen.map(({ kind, id }) => ({ kind, id })) }));
        const current = requireDefinitionEvidence(setting, items);
        if (!equalJson(current, frozen)) throw new ImportConflictError("Target capability definitions differ from the frozen source proofs");
      }
      // Target creation also validates the public setting schema and selection permissions atomically.
      // Preview catches unavailable catalogs early, without silently dropping unsupported capabilities.
      const selections = [
        ["connectorIds", "/api/components?kind=connector"],
        ["extensionIds", "/api/components?kind=extension"],
      ] as const;
      const actions = setting.actionIds ?? [];
      if (!Array.isArray(actions) || actions.some((id) => typeof id !== "string")) throw new ImportConflictError("Unsupported actionIds");
      for (const id of actions) {
        const action = await nullable(() => request(`/api/actions/${encodeURIComponent(id)}`, record));
        if (!action || action.id !== id || action.selectable !== true) throw new ImportConflictError("Target Action is unavailable");
      }
      for (const [field, route] of selections) {
        const ids = setting[field];
        if (ids === undefined) continue;
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw new ImportConflictError(`Unsupported ${field}`);
        if (ids.length === 0) continue;
        const available = new Set<string>();
        let expected: number | undefined;
        for (let page = 1; page <= 100; page++) {
          const result = await dependency(() => request(`${route}&page=${page}&pageSize=100`, z.object({
            data: z.array(record), total: z.number().int().nonnegative(), page: z.number().int().positive(), pageSize: z.number().int().positive(),
          })));
          if (result.page !== page || expected !== undefined && result.total !== expected) throw new ImportDependencyError("Target Component catalog changed during checking");
          expected = result.total;
          for (const item of result.data) if (typeof item.id === "string" && item.selectable === true) available.add(item.id);
          if (page * result.pageSize >= result.total) break;
          if (page === 100) throw new ImportDependencyError("Target Component catalog exceeds bounded search");
        }
        if (ids.some((id) => !available.has(id))) throw new ImportConflictError(`Target ${field} are unavailable or cannot be verified`);
      }
      const toolkits = (Array.isArray(setting.mcpServers) ? setting.mcpServers : [])
        .map((selection) => record.safeParse(selection))
        .filter((selection) => selection.success && selection.data.kind === "connector_toolkit")
        .map((selection) => selection.success ? selection.data.serverId : undefined);
      if (toolkits.length > 0) {
        const available = new Set<string>();
        const cursors = new Set<string>();
        let cursor: string | null = null;
        for (let page = 0; page < 100; page++) {
          // The public Connector page is cursor-based. It is not a Component or managed MCP collection.
          const result = await dependency(() => request(`/api/connectors${cursor === null ? "" : `?${new URLSearchParams({ cursor })}`}`, z.object({
            items: z.array(z.object({ toolkitId: z.string(), status: z.string() })),
            nextCursor: z.string().min(1).max(4096).nullable(),
          })));
          for (const item of result.items) if (item.status !== "configuration_required") available.add(item.toolkitId);
          cursor = result.nextCursor;
          if (cursor === null) break;
          if (cursors.has(cursor) || page === 99) throw new ImportDependencyError("Target Toolkit catalog cannot be fully checked");
          cursors.add(cursor);
        }
        if (toolkits.some((id) => typeof id !== "string" || !available.has(id))) throw new ImportConflictError("Target Connector Toolkit is unavailable");
      }
      if (typeof setting.model === "string" || typeof setting.presetId === "string") {
        const models = await dependency(() => request("/api/model-catalog", z.array(record)));
        if (typeof setting.model === "string" && !models.some((item) => item.providerModel === setting.model && item.available === true)
          || typeof setting.presetId === "string" && !models.some((item) => item.id === setting.presetId && item.available === true)) {
          throw new ImportConflictError("Target model/preset is unavailable or cannot be verified");
        }
      }
    },
  };
  return target;
}
