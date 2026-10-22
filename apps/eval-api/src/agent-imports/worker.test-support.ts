import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from "@zip.js/zip.js";
import { equalJson, type AgentImportPreview, type AgentImportTaskView } from "@eval-platform/eval-contracts";
import { vi } from "vitest";
import { createAgentConfigService } from "../agent-configs.js";
import type { AgentPurposeStore } from "../db/agent-purposes.js";
import { EvalSpApiError } from "../sp/http.js";
import type { EvalSpAgentConfig, EvalSpClient } from "../sp/client.js";
import { createEvalSpClient } from "../sp/client.js";
import { openImportStaging } from "./bytes.js";
import { ImportConflictError, ImportLeaseLostError } from "./errors.js";
import { digest, initialView, resourceKey, type ImportIntent, type ImportReceipt, type ImportResult, type ImportTask, type ResourceSource, type SourceSnapshot } from "./model.js";
import { createAgentImportSource } from "./source.js";
import type { AgentImportStore } from "./store.js";
import { createAgentImportTarget, type TargetAttachment, type TargetReference, type TargetSkill } from "./target.js";
import { createAgentImportWorker } from "./worker.js";
import { canonicalSourceSettingFixture } from "./public-wire.test-support.js";
import { dependencyKeys } from "./semantics.js";

export const owner = "11111111-1111-4111-8111-111111111111";
export const sourceUser = "22222222-2222-4222-8222-222222222222";
export const agentId = "33333333-3333-4333-8333-333333333333";
export const otherAgentId = "44444444-4444-4444-8444-444444444444";
export const referenceId = "55555555-5555-4555-8555-555555555555";
export function snapshotFixture(): SourceSnapshot {
  return {
    version: 1, sourceUserId: sourceUser, dependencies: [],
    agents: [{ id: agentId, slug: "source", name: "Source", description: null, revision: 1,
      setting: { ...canonicalSourceSettingFixture(), skillIds: ["private-skill", "builtin-demo"], referenceFileIds: [referenceId] } },
    { id: otherAgentId, slug: "independent", name: "Independent", description: null, revision: 1, setting: canonicalSourceSettingFixture() }],
    skills: [
      { id: "private-skill", name: "private-skill", kind: "user", contentHash: null, files: [
        { path: "SKILL.md", size: 3, url: "https://dev.test/files/skill-md" },
        { path: "scripts/run.py", size: 3, url: "https://dev.test/files/script" },
      ] },
      { id: "builtin-demo", name: "builtin-demo", kind: "platform", contentHash: null,
        files: [{ path: "SKILL.md", size: 3, url: "https://dev.test/files/builtin" }] },
      { id: "unused", name: "unused", kind: "user", contentHash: null,
        files: [{ path: "SKILL.md", size: 3, url: "https://dev.test/files/unused" }] },
    ],
    references: [{ id: referenceId, name: "brief.txt", mediaType: "text/plain", size: 3, status: "active", url: "https://dev.test/files/reference" }],
  };
}
/** Test-only durable port fake; production always uses the PostgreSQL adapter. */
export async function workerFixture(snapshot = snapshotFixture()) {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-import-worker-"));
  const sources = new Map<string, ResourceSource>();
  const intents = new Map<string, ImportIntent>();
  const tasks = new Map<string, ImportTask>();
  const memberships = new Map<string, Set<string>>();
  const targetAgents = new Map<string, EvalSpAgentConfig>();
  const archivedAgents = new Set<string>();
  const targetSkills = new Map<string, TargetSkill>();
  const targetReferences = new Map<string, TargetReference>();
  const targetUploads = new Map<string, { attachment: TargetAttachment; bytes: Uint8Array }>();
  const fileBytes = new Map<string, Uint8Array>();
  const receipts = new Map<string, ImportResult>();
  const events: string[] = [];
  const savedViews: AgentImportTaskView[] = [];
  const requests: Request[] = [];
  const zipFiles: string[][] = [];
  let task: ImportTask | undefined;
  let previewSequence = 0;
  let lostSkillResponse = false;
  let failPurpose = false;
  let failSourceOnce = false;
  let failCompletion = false;
  let targetEnabled = true;
  const store: AgentImportStore = {
    sources: {
      get: async (kind, id) => sources.get(resourceKey(kind, id)) ?? null,
      recordNative: async (id) => { sources.set(resourceKey("agent", id), { ownerUserId: owner, kind: "agent", id,
        origin: "eval_native", connectionId: null, sourceUserId: null, sourceDigest: null, targetDigest: null, receipt: null }); },
      pendingAgentIds: async (ids) => new Set(ids.filter((id) => {
        const intent = intents.get(resourceKey("agent", id));
        return intent?.status === "confirmed" && intent.receipt !== null;
      })),
    },
    async create(request, connectionId, actorId) {
      if (task) {
        if (!equalJson(task.request, request)) throw new ImportConflictError("Idempotency conflict");
        return task;
      }
      const id = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      task = { id, ownerUserId: owner, actorId: actorId ?? null, connectionId, request, fingerprint: digest(request),
        view: initialView(id, request, expiresAt), snapshot: null, plan: null, expiresAt, applyKey: null, leaseToken: null, revision: 0, attempts: 0 };
      tasks.set(id, task);
      events.push("enqueue:preview");
      return task;
    },
    get: async (id) => tasks.get(id) ?? null,
    async apply(id, key) {
      const active = tasks.get(id);
      if (!active?.plan) throw new Error("Not ready");
      const plan = active.plan;
      const needed = new Set(plan.eligibleAgentIds.flatMap((id) => [
        resourceKey("agent", id), ...dependencyKeys(plan.snapshot.agents.find((agent) => agent.id === id)!),
      ]));
      const resources = plan.resources.filter((resource) => !resource.platform && needed.has(resourceKey(resource.kind, resource.id)));
      for (const resource of resources) {
        const identity = resourceKey(resource.kind, resource.id);
        const current = intents.get(identity);
        if (current && current.importKey !== resource.importKey
          && (!["planned", "completed", "conflict", "confirmed"].includes(current.status)
            || current.status === "confirmed" && !current.receipt
            || [...memberships.get(identity) ?? []].some((id) => !["completed", "completed_with_errors", "failed"].includes(tasks.get(id)!.view.status)))) {
          throw new ImportConflictError("Previous import is unfinished");
        }
      }
      active.applyKey = key; active.view.status = "queued";
      for (const resource of resources) {
        const identity = resourceKey(resource.kind, resource.id);
        const members = memberships.get(identity) ?? new Set<string>();
        members.add(id); memberships.set(identity, members);
        if (intents.get(identity)?.importKey === resource.importKey) continue;
        intents.set(identity, { ...resource, ownerUserId: owner,
          connectionId: active.connectionId, sourceUserId: active.request.sourceUserId, status: "planned", receipt: null, attachment: null });
        events.push(`intent:${resource.kind}:${resource.id}`);
      }
      events.push("enqueue:apply");
      return active;
    },
    async claim(id, token) {
      const active = tasks.get(id);
      if (!active || ["completed", "completed_with_errors", "ready", "failed"].includes(active.view.status)) return null;
      if (active.leaseToken) throw new ImportLeaseLostError();
      active.leaseToken = token; active.attempts++; return active;
    },
    heartbeat: async () => {},
    async save(current, update) {
      if (failCompletion && update.view && ["completed", "completed_with_errors"].includes(update.view.status)) {
        failCompletion = false; throw new Error("task DB offline");
      }
      Object.assign(current, update, { revision: current.revision + 1 });
      if (update.view) savedViews.push(structuredClone(update.view));
    },
    async release(current) { current.leaseToken = null; },
    intent: async (kind, id) => intents.get(resourceKey(kind, id)) ?? null,
    async markIntent(_task, resource, status, receipt) {
      const intent = intents.get(resourceKey(resource.kind, resource.id))!;
      intent.status = status;
      if (receipt) intent.receipt = receipt;
      events.push(`local:${resource.kind}:${status}`);
    },
    async saveAttachment(_task, resource, attachment) { intents.get(resourceKey(resource.kind, resource.id))!.attachment = attachment; events.push("local:attachment"); },
    async complete(current, resource, receipt) {
      if (failSourceOnce && resource.kind === "agent") { failSourceOnce = false; throw new Error("source DB offline"); }
      sources.set(resourceKey(resource.kind, resource.id), { ownerUserId: owner, kind: resource.kind, id: resource.id,
        origin: resource.platform ? "platform_catalog" : "dev_import", connectionId: current.connectionId,
        sourceUserId: current.request.sourceUserId, sourceDigest: resource.sourceDigest, targetDigest: resource.targetDigest, receipt });
      const intent = intents.get(resourceKey(resource.kind, resource.id));
      if (intent) intent.status = "completed";
    },
  };
  const missing = () => Response.json({ code: "IMPORT_RECEIPT_NOT_FOUND", errMsg: "missing" }, { status: 404 });
  const ok = (msg: unknown) => Response.json({ success: true, msg, errMsg: "", code: "" });
  const sp = {
    getAgentConfig: vi.fn(async (_token: string, id: string) => {
      const record = targetAgents.get(id); if (!record) throw new EvalSpApiError(404, null); return record;
    }),
    listAgentConfigs: vi.fn(async () => [...targetAgents.values()].filter((agent) => !archivedAgents.has(agent.id))),
    listMcpServers: vi.fn(async () => []),
    deleteAgentConfig: vi.fn(), createAgentConfig: vi.fn(),
  };
  function result(kind: ImportReceipt["resourceKind"], id: string, key: string, resource: Record<string, unknown>) {
    const value: ImportResult = { receipt: { id: crypto.randomUUID(), resourceKind: kind, resourceId: id, importKey: key,
      fingerprint: digest(resource), createdAt: new Date().toISOString() }, replayed: false, resource };
    receipts.set(`${kind}:${key}`, value);
    return value;
  }
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init); requests.push(request.clone());
    const url = new URL(request.url);
    if (url.pathname.startsWith("/files/") || url.pathname.startsWith("/target-files/") || url.pathname.startsWith("/uploads/v1/")) {
      if (request.headers.has("Authorization")) throw new Error("CDN credential leak");
      if (url.pathname.endsWith("unused")) throw new Error("Unselected dependency downloaded");
      return new Response(fileBytes.has(url.href) ? new Uint8Array(fileBytes.get(url.href)!) : "abc");
    }
    if (url.origin === "https://dev.test") {
      if (request.method !== "GET") throw new Error("Dev write");
      const ids = url.searchParams.get("agentIds")?.split(",") ?? [];
      return ok({ ...snapshot, agents: snapshot.agents.filter((agent) => ids.includes(agent.id)) });
    }
    if (url.pathname === "/api/agent-config-imports/config") return ok({ version: 1, enabled: targetEnabled });
    if (url.pathname === "/api/agent-config-imports/validate") {
      const { setting } = await request.json();
      return ok({ version: 1, setting }); // Public preflight wire; SP owns the setting schema.
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/user-agent-configs/")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      return targetAgents.has(id) ? ok(targetAgents.get(id)) : missing();
    }
    if (url.pathname.includes("/receipts/")) {
      const key = url.pathname.split("/").at(-1)!;
      return receipts.has(`${url.searchParams.get("kind")}:${key}`) ? ok(receipts.get(`${url.searchParams.get("kind")}:${key}`)) : missing();
    }
    if (url.pathname === "/api/skills") {
      const selected = url.searchParams.get("ids");
      const items = [...targetSkills.values()].filter((item) => !selected || item.id === selected);
      return ok({ data: items, total: items.length, page: 1, pageSize: 100 });
    }
    if (url.pathname.endsWith("/files")) return ok(targetSkills.get(decodeURIComponent(url.pathname.split("/")[3]!)));
    if (url.pathname.startsWith("/api/user-references/") && request.method === "GET") return targetReferences.has(referenceId) ? ok(targetReferences.get(referenceId)) : missing();
    if (request.method !== "POST") throw new Error(`Unexpected ${request.method} ${url.pathname}`);
    events.push(`remote:${url.pathname}`);
    if (url.pathname === "/api/skills/imports") {
      const id = url.searchParams.get("skillId")!;
      if (!intents.has(resourceKey("skill", id))) throw new Error("No write-ahead intent");
      const zip = new ZipReader(new Uint8ArrayReader(new Uint8Array(await request.arrayBuffer())));
      const entries = await zip.getEntries(); zipFiles.push(entries.map((entry) => entry.filename));
      for (const entry of entries) if (!entry.directory && new TextDecoder().decode(await entry.getData(new Uint8ArrayWriter())) !== "abc") throw new Error("ZIP bytes changed");
      await zip.close();
      const files = snapshot.skills.find((item) => item.id === id)!.files.map((file) => ({
        ...file, url: `https://eval.test/target-files/${file.path.split("/").map(encodeURIComponent).join("/")}`,
      }));
      targetSkills.set(id, { id, name: id, origin: "upload", available: true, deleted: false, files });
      const value = result("skill", id, url.searchParams.get("importKey")!, { id, name: id });
      if (lostSkillResponse) { lostSkillResponse = false; throw new TypeError("response lost after insert"); }
      return ok(value);
    }
    if (url.pathname === "/api/inbox/attachments") {
      const form = await request.formData();
      const file = form.get("file") as File;
      const clientAttachmentId = form.get("clientAttachmentId") as string;
      const attachment: TargetAttachment = {
        attachmentCdnUrl: `https://eval.test/uploads/v1/${owner}/${clientAttachmentId}`, clientAttachmentId,
        name: form.get("name") as string, mediaType: file.type, size: file.size,
      };
      const bytes = new Uint8Array(await file.arrayBuffer());
      const existing = targetUploads.get(clientAttachmentId);
      if (existing && (!equalJson(existing.attachment, attachment) || !Buffer.from(existing.bytes).equals(bytes))) {
        return Response.json({ code: "REQUEST_CONFLICT", errMsg: "Attachment identity already exists" }, { status: 409 });
      }
      if (!existing) {
        targetUploads.set(clientAttachmentId, { attachment, bytes });
        fileBytes.set(attachment.attachmentCdnUrl, bytes);
      }
      return ok(attachment);
    }
    if (url.pathname === "/api/user-references/imports") {
      const body = await request.json();
      if (!body.attachment.attachmentCdnUrl.startsWith("https://eval.test/")) throw new Error("Source Reference URL was copied");
      const uploaded = targetUploads.get(body.attachment.clientAttachmentId);
      if (!uploaded || !equalJson(uploaded.attachment, body.attachment)) throw new Error("Reference upload was not verified");
      const value: TargetReference = { id: body.referenceId, ...body.attachment, status: "active",
        attachmentCdnUrl: `https://eval.test/target-files/references/${encodeURIComponent(body.importKey)}` };
      fileBytes.set(value.attachmentCdnUrl, new Uint8Array(uploaded.bytes));
      targetReferences.set(value.id, value);
      return ok(result("reference", value.id, body.importKey, value));
    }
    if (url.pathname === "/api/user-agent-configs/imports") {
      const { importKey, dependencies: _dependencies, ...body } = await request.json();
      if (!intents.has(resourceKey("agent", body.id))) throw new Error("No write-ahead Agent intent");
      const agent: EvalSpAgentConfig = { ...body, user_id: owner };
      targetAgents.set(body.id, agent);
      return ok(result("agent", body.id, importKey, agent));
    }
    throw new Error("Unexpected import write");
  });
  targetSkills.set("builtin-demo", { id: "builtin-demo", name: "builtin-demo", origin: "marketplace", available: true, deleted: false,
    files: [{ path: "SKILL.md", size: 3, url: "https://eval.test/target-files/builtin" }] });
  const currentClient = createEvalSpClient({ origin: "https://eval.test", writeOrigin: "https://web.test", fetch });
  sp.getAgentConfig.mockImplementation((token, id) => currentClient.getAgentConfig(token, id));
  const source = createAgentImportSource({ origin: "https://dev.test", targetOrigin: "https://eval.test", token: "export-only", fetch });
  const target = createAgentImportTarget({ origin: "https://eval.test", sourceOrigin: source.origin, writeOrigin: "https://web.test",
    ownerUserId: owner, sessionToken: "target-session", sp: sp as unknown as EvalSpClient, fetch });
  const purposes = { upsert: vi.fn(async (record) => {
    if (failPurpose) { failPurpose = false; throw new Error("purpose DB offline"); } return record;
  }) } as unknown as AgentPurposeStore;
  const agents = createAgentConfigService({ ownerUserId: owner, sessionToken: "target-session", sp: sp as unknown as EvalSpClient,
    projects: { frozenAgentConfigIds: async () => new Set<string>() }, purposes, sources: store.sources, imports: target });
  const staging = await openImportStaging(directory);
  const worker = createAgentImportWorker({ source, target, store, agents, staging, fetch });
  return { store, worker, source, target, agents, purposes, sources, intents, targetAgents, targetSkills, targetReferences, targetUploads, requests, events, savedViews, zipFiles, sp, fetch,
    loseSkillResponse: () => { lostSkillResponse = true; }, failNextPurpose: () => { failPurpose = true; },
    failNextSource: () => { failSourceOnce = true; },
    failNextCompletion: () => { failCompletion = true; },
    setTargetEnabled: (enabled: boolean) => { targetEnabled = enabled; },
    setSourceFileBytes: (url: string, bytes: Uint8Array) => { fileBytes.set(url, new Uint8Array(bytes)); },
    archiveAgent: (id: string) => { archivedAgents.add(id); },
    resetTask: () => { task = undefined; previewSequence++; },
    async preview(ids = [agentId, otherAgentId]) {
      const request: AgentImportPreview = { sourceUserId: sourceUser, agentIds: ids, purpose: "execution", idempotencyKey: `preview-${previewSequence}-${ids.join(",")}` };
      const current = await store.create(request, source.connectionId);
      await worker.run(current.id); return current;
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
