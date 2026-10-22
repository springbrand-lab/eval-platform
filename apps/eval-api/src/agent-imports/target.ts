import { z } from "zod";
import { equalJson, jsonObjectSchema } from "@eval-platform/eval-contracts";
import { importOriginSchema } from "../config/agent-imports.js";
import { createImportDownloads } from "./bytes.js";
import { httpOriginSchema } from "../config/env.js";
import { createSpHttpClient, EvalSpApiError, throwSpClientError, type Fetch } from "../sp/http.js";
import type { EvalSpAgentConfig, EvalSpClient } from "../sp/client.js";
import { digest, exportFileSchema, receiptSchema, type ImportReceipt, type ImportResult, type PlannedImportResources, type PreparedAgent, type ResourceKind } from "./model.js";
import { ImportConflictError, ImportDependencyError, ImportOutcomeUnknownError, ImportTargetDisabledError, importConflict } from "./errors.js";
import { requireDefinitionEvidence, type DefinitionEvidence } from "./definition-evidence.js";
import { requirePlannedResources } from "./selection-facts.js";

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
  reference(id: string): Promise<TargetReference | null>;
  receipt(kind: ResourceKind, importKey: string): Promise<ImportResult | null>;
  importAgent(prepared: PreparedAgent, importKey: string): Promise<ImportResult>;
  importSkill(id: string, zip: Uint8Array, importKey: string): Promise<ImportResult>;
  uploadReference(id: string, name: string, mediaType: string, bytes: Uint8Array, importKey: string): Promise<TargetAttachment>;
  importReference(id: string, attachment: TargetAttachment, importKey: string): Promise<ImportResult>;
  validateSelections(setting: Record<string, unknown>, dependencies?: readonly DefinitionEvidence[], plannedResources?: PlannedImportResources): Promise<void>;
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
  const sourceOrigin = input.sourceOrigin === undefined ? undefined : importOriginSchema.parse(input.sourceOrigin);
  if (origin === sourceOrigin) throw new TypeError("source and target origins must differ");
  const writeOrigin = httpOriginSchema.parse(input.writeOrigin);
  const ownerUserId = z.uuid().parse(input.ownerUserId).toLowerCase();
  if (!input.sessionToken.trim()) throw new TypeError("Target session token is required");
  const http = createSpHttpClient({ origin, responseMode: "envelope", timeoutMs: 60_000, maxResponseBytes: 16 * 1024 * 1024, fetch: input.fetch });
  function referenceUploadId(id: string, importKey: string): string {
    const bytes = Buffer.from(digest(["eval-reference-upload/v1", ownerUserId, id, importKey]), "hex").subarray(0, 16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x80;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  function validateAttachment(attachment: TargetAttachment, id: string): void {
    const url = new URL(attachment.attachmentCdnUrl);
    createImportDownloads({ origin, purpose: "target" }).validateUrl(url.href);
    if (attachment.clientAttachmentId !== id || url.search || url.pathname !== `/uploads/v1/${ownerUserId}/${id}`
      || sourceOrigin === url.origin) throw new ImportConflictError("Reference attachment is not a target-owned upload");
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
    if (importConflict(error)) {
      throw new ImportConflictError("Target import conflicts with the current resource or dependency definitions", error);
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
      if (importConflict(error)) dependencyError(error);
      // The POST may have committed. Only its durable receipt can turn an uncertain write into success.
      let result: ImportResult | null = null;
      try { result = await target.receipt(kind, importKey); } catch (cause) {
        if (importConflict(cause)) throw cause;
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
    async uploadReference(id, name, mediaType, bytes, importKey) {
      // Ordinary attachment upload has no import guard on SP; probe immediately before this POST too.
      await target.requireEnabled();
      const clientAttachmentId = referenceUploadId(id, importKey);
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(bytes)], { type: mediaType }), name);
      form.append("name", name);
      form.append("clientAttachmentId", clientAttachmentId);
      const attachment = await dependency(() => request("/api/inbox/attachments", attachmentSchema, form));
      validateAttachment(attachment, clientAttachmentId);
      if (attachment.name !== name || attachment.mediaType !== mediaType || attachment.size !== bytes.byteLength) {
        throw new ImportConflictError("Target attachment does not match the frozen Reference");
      }
      return attachment;
    },
    importReference: (id, attachment, importKey) => {
      validateAttachment(attachment, attachment.clientAttachmentId === id ? id : referenceUploadId(id, importKey));
      return commit("reference", id, importKey, () => request(
        "/api/user-references/imports", resultSchema, { referenceId: id, attachment, importKey },
      ));
    },
    async validateSelections(setting, dependencies = [], plannedResources = { skills: [], references: [] }) {
      const frozen = requireDefinitionEvidence(setting, dependencies);
      const planned = requirePlannedResources(setting, plannedResources);
      await target.requireEnabled();
      try {
        const validated = await request("/api/agent-config-imports/validate", z.strictObject({
          version: z.literal(1), setting: jsonObjectSchema,
        }), { setting, dependencies: frozen, plannedResources: planned });
        if (!equalJson(validated.setting, setting)) {
          throw new ImportConflictError("Target Agent validation changed the frozen setting; update the target and preview again");
        }
      } catch (error) {
        const code = error instanceof EvalSpApiError ? record.safeParse(error.payload).data?.code : undefined;
        // Only documented status/code pairs prove an admission rejection, never an auth or proxy failure.
        if (error instanceof EvalSpApiError && (
          error.status === 422 && typeof code === "string"
            && ["REQUEST_VALIDATION_FAILED", "AGENT_CONFIG_IMPORT_INVALID", "AGENT_CONFIG_INVALID"].includes(code)
          || error.status === 403 && code === "MODEL_ACCESS_DENIED"
        )) {
          throw new ImportConflictError("Target rejected the complete Agent setting or its selected dependencies; preview again after checking target availability", error);
        }
        dependencyError(error);
      }
    },
  };
  return target;
}
