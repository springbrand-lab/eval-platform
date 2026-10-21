import type { AgentConfigService } from "../agent-configs.js";
import { AgentConfigPurposeUnavailableError } from "../db/errors.js";
import type { Fetch } from "../sp/http.js";
import { createImportDownloads, safeImportPath, type ImportStaging } from "./bytes.js";
import { ImportConflictError, ImportDependencyError } from "./errors.js";
import { digest, IMPORT_LIMITS, resourceKey, summarize, type ImportPlan, type ImportTask } from "./model.js";
import { agentSourceDigest, dependencyKeys, planDigest, requireCanonicalSourceSetting, requireReusable, resourceDigests } from "./semantics.js";
import { dependencies, plannedResourcesForAgent } from "./selection-facts.js";
import { sourceDefinitionEvidence, type DefinitionEvidence } from "./definition-evidence.js";
import type { AgentImportSource } from "./source.js";
import type { AgentImportStore } from "./store.js";
import type { AgentImportTarget } from "./target.js";
import { checkReceipt } from "./target.js";
import { createImportVerification } from "./verification.js";

export function createImportPlanner(input: {
  source: AgentImportSource; target: AgentImportTarget; agents: AgentConfigService;
  store: AgentImportStore; staging: ImportStaging; fetch?: Fetch;
}) {
  const { source, target, store, staging, agents } = input;
  return async function preview(task: ImportTask): Promise<void> {
    await target.requireEnabled();
    if (task.connectionId !== source.connectionId || task.ownerUserId !== target.ownerUserId) {
      throw new ImportConflictError("Import task belongs to a different connection or target owner");
    }
    if (Date.parse(task.expiresAt) <= Date.now()) throw new ImportConflictError("Import preview expired");
    if (!task.snapshot) {
      const snapshot = await source.snapshot(task.request.sourceUserId, task.request.agentIds);
      await store.save(task, { snapshot }); // freeze before reading any dependency bytes
    }
    const snapshot = task.snapshot!;
    const byAgent = new Map(snapshot.agents.map((item) => [item.id, item]));
    const bySkill = new Map(snapshot.skills.map((item) => [item.id, item]));
    const byReference = new Map(snapshot.references.map((item) => [item.id, item]));
    if (bySkill.size !== snapshot.skills.length || byReference.size !== snapshot.references.length) throw new ImportConflictError("Duplicate source resource identities");
    const plan: ImportPlan = task.plan ?? { version: 1, snapshot, resources: [], eligibleAgentIds: [], digest: "" };
    if (digest(plan.snapshot) !== digest(snapshot)) throw new ImportConflictError("Frozen export snapshot changed");
    const resources = new Map(plan.resources.map((item) => [resourceKey(item.kind, item.id), item]));
    const view = structuredClone(task.view);
    delete view.error;
    function block(id: string, message: string) {
      const item = view.agents.find((item) => item.id === id)!;
      item.status = "conflict"; item.message = message;
    }
    for (const item of view.agents) {
      const agent = byAgent.get(item.id);
      if (!agent) throw new ImportDependencyError("Export did not return the selected Agent");
      item.name = agent.name;
      item.status = "pending";
      delete item.message;
      let selected: ReturnType<typeof dependencies>;
      try {
        requireCanonicalSourceSetting(agent.setting);
        selected = dependencies(agent);
      } catch (error) {
        block(item.id, error instanceof ImportConflictError ? error.message : "Unsupported or duplicate resource selections"); continue;
      }
      item.skillCount = selected.skills.length;
      item.referenceCount = selected.references.length;
      let proofs: DefinitionEvidence[];
      try { proofs = sourceDefinitionEvidence(agent.setting, snapshot.dependencies); } catch (error) {
        if (!(error instanceof ImportConflictError)) throw error;
        block(item.id, error.message); continue;
      }
      const existing = await target.agent(item.id);
      const binding = await store.sources.get("agent", item.id);
      if (existing || binding) {
        if (existing && binding?.origin === "dev_import" && binding.connectionId === task.connectionId
          && binding.sourceUserId === task.request.sourceUserId && binding.receipt && existing.user_id === task.ownerUserId) {
          try {
            const result = await target.receipt("agent", binding.receipt.importKey);
            if (!result) { block(item.id, "Existing Agent has no valid target receipt"); continue; }
            checkReceipt(result, "agent", item.id, binding.receipt.importKey, binding.receipt);
            item.status = "skipped";
            item.message = binding.sourceDigest === agentSourceDigest(agent, proofs)
              ? "Agent already exists; it will not be changed" : "Source changed; the existing Agent will not be updated";
          } catch (error) {
            if (!(error instanceof ImportConflictError)) throw error;
            block(item.id, error.message);
          }
        } else block(item.id, "Target ID is occupied, unavailable or has no matching proven import");
        continue;
      }
      try {
        const plannedResources = plannedResourcesForAgent(snapshot, agent);
        const key = resourceKey("agent", item.id);
        let prepared = resources.get(key)?.prepared;
        if (prepared) await target.validateSelections(prepared.config.setting, prepared.dependencies, plannedResources);
        else prepared = await agents.prepareImport(agent, task.request.purpose, proofs, plannedResources);
        resources.set(key, { kind: "agent", id: item.id, name: agent.name, source: agent, files: [],
          sourceDigest: "", targetDigest: "", importKey: "", prepared });
        for (const id of selected.skills) {
          const skill = bySkill.get(id);
          if (!skill) throw new ImportConflictError("Export is missing a selected Skill");
          if (!resources.has(resourceKey("skill", id))) resources.set(resourceKey("skill", id), {
            kind: "skill", id, name: skill.name, source: skill, platform: skill.kind === "platform",
            files: [], sourceDigest: "", targetDigest: "", importKey: "",
          });
        }
        for (const id of selected.references) {
          const reference = byReference.get(id);
          if (!reference || reference.status !== "active") throw new ImportConflictError("Selected Reference is missing or disabled");
          if (!/^[^/\\\u0000-\u001f\u007f]+$/u.test(reference.name)) throw new ImportConflictError("Unsupported Reference filename");
          if (!resources.has(resourceKey("reference", id))) resources.set(resourceKey("reference", id), {
            kind: "reference", id, name: reference.name, source: reference, files: [], sourceDigest: "", targetDigest: "", importKey: "",
          });
        }
      } catch (error) {
        if (error instanceof ImportDependencyError) throw error;
        block(item.id, error instanceof AgentConfigPurposeUnavailableError ? "Target purpose/MCP connection is unavailable" : "Agent or dependency cannot be imported without changes");
      }
    }
    const needed = new Set(view.agents.filter((item) => item.status === "pending").flatMap((item) =>
      [resourceKey("agent", item.id), ...dependencyKeys(byAgent.get(item.id)!) ]));
    plan.resources = [...resources.values()].filter((resource) => needed.has(resourceKey(resource.kind, resource.id)));
    let totalBytes = 0;
    let fileCount = 0;
    for (const resource of plan.resources) {
      if (resource.kind === "agent") continue;
      const files = "files" in resource.source ? resource.source.files : [{ path: "reference", size: "size" in resource.source ? resource.source.size : 0, url: "url" in resource.source ? resource.source.url : "" }];
      fileCount += files.length;
      totalBytes += files.reduce((sum, file) => sum + file.size, 0);
    }
    if (fileCount > IMPORT_LIMITS.files || totalBytes > IMPORT_LIMITS.totalBytes) throw new ImportConflictError("Selected dependency union exceeds import limits");
    view.progress = { stage: "files", completed: 0, total: fileCount, bytesRead: 0, totalBytes };
    await store.save(task, { plan, view: summarize(view) });
    const downloads = createImportDownloads({ origin: source.origin, purpose: "source", ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
    const verify = createImportVerification({ target, staging, heartbeat: () => store.heartbeat(task), ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
    for (const resource of plan.resources.filter((item) => item.kind !== "agent")) {
      if (resource.error) continue;
      try {
        const files = "files" in resource.source ? resource.source.files
          : [{ path: "reference", size: "size" in resource.source ? resource.source.size : 0, url: "url" in resource.source ? resource.source.url : "" }];
        if (resource.kind === "skill" && (!files.some((file) => file.path === "SKILL.md") ||
          new Set(files.map((file) => safeImportPath(file.path))).size !== files.length)) {
          throw new ImportConflictError("Skill package paths are incomplete or duplicated");
        }
        for (const file of files) {
          await store.heartbeat(task);
          const frozen = resource.files.find((item) => item.path === file.path);
          if (frozen) {
            if (frozen.url !== file.url || frozen.size !== file.size) throw new ImportConflictError("Frozen file manifest changed");
            await staging.read(task.id, frozen, task.expiresAt);
          } else resource.files.push(await downloads.freeze(staging, task.id, file, task.expiresAt));
          view.progress.completed++;
          view.progress.bytesRead += file.size;
          await store.save(task, { plan, view: summarize(view) });
        }
        resourceDigests(resource, task);
        if (await verify(resource, task)) {
          if (!resource.platform) await requireReusable(resource, task, store.sources, target);
        } else {
          if (resource.platform) throw new ImportConflictError("Platform Skill is missing on target; it cannot be uploaded as a private Skill");
          if (await store.sources.get(resource.kind, resource.id)) throw new ImportConflictError("Previously registered target dependency is unavailable; it cannot be revived");
        }
        const intent = await store.intent(resource.kind, resource.id);
        if (intent && (intent.sourceDigest !== resource.sourceDigest || intent.targetDigest !== resource.targetDigest
          || intent.connectionId !== task.connectionId || intent.sourceUserId !== task.request.sourceUserId)) {
          throw new ImportConflictError("A different durable import intent already owns this dependency ID");
        }
      } catch (error) {
        if (!(error instanceof ImportConflictError)) throw error;
        resource.error = error.message;
      }
      await store.save(task, { plan });
    }
    for (const item of view.agents.filter((item) => item.status === "pending")) {
      const agent = byAgent.get(item.id)!;
      const failed = dependencyKeys(agent).map((key) => resources.get(key)).find((resource) => !resource || resource.error);
      if (failed || dependencyKeys(agent).some((key) => !resources.get(key))) {
        block(item.id, failed?.error ?? "A required dependency could not be verified");
        continue;
      }
      const resource = resources.get(resourceKey("agent", item.id))!;
      resourceDigests(resource, task);
      const intent = await store.intent("agent", item.id);
      if (intent && (intent.sourceDigest !== resource.sourceDigest || intent.targetDigest !== resource.targetDigest
        || intent.connectionId !== task.connectionId || intent.sourceUserId !== task.request.sourceUserId)) {
        block(item.id, "A different durable import intent already owns this Agent ID"); continue;
      }
      item.status = "ready";
    }
    plan.eligibleAgentIds = view.agents.filter((item) => item.status === "ready").map((item) => item.id);
    plan.digest = planDigest(plan, task);
    view.status = "ready";
    view.progress = { ...view.progress, stage: "ready", completed: fileCount };
    await store.save(task, { plan, view: summarize(view) });
  };
}
