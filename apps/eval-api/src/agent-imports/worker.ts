import type { AgentConfigService } from "../agent-configs.js";
import type { Fetch } from "../sp/http.js";
import type { ImportStaging } from "./bytes.js";
import { ImportConflictError, ImportDependencyError, ImportLeaseLostError, ImportOutcomeUnknownError, importConflict } from "./errors.js";
import { resourceKey, summarize, type ImportResult, type ImportTask, type PlannedResource } from "./model.js";
import { createImportPlanner } from "./planner.js";
import { dependencyKeys, planDigest, requireCanonicalSourceSetting } from "./semantics.js";
import { plannedResourcesForAgent } from "./selection-facts.js";
import type { AgentImportSource } from "./source.js";
import type { AgentImportStore } from "./store.js";
import { checkReceipt, type AgentImportTarget } from "./target.js";
import { createImportVerification } from "./verification.js";

export function createAgentImportWorker(input: {
  source: AgentImportSource; target: AgentImportTarget; agents: AgentConfigService;
  store: AgentImportStore; staging: ImportStaging; fetch?: Fetch;
}) {
  const { store, target, agents, staging } = input;
  const preview = createImportPlanner(input);
  async function apply(task: ImportTask): Promise<void> {
    await target.requireEnabled();
    const plan = task.plan;
    if (!task.applyKey || !plan || plan.digest !== planDigest(plan, task)) throw new ImportConflictError("Import plan is missing or changed");
    const view = structuredClone(task.view);
    view.status = "importing";
    delete view.error;
    const eligible = new Set(plan.eligibleAgentIds);
    const needed = new Set(plan.snapshot.agents.filter((agent) => eligible.has(agent.id)).flatMap((agent) =>
      [resourceKey("agent", agent.id), ...dependencyKeys(agent)]));
    const resources = plan.resources.filter((item) => needed.has(resourceKey(item.kind, item.id)));
    const results = new Map<string, { unknown: boolean; message: string } | null>();
    const verify = createImportVerification({ target, staging, heartbeat: () => store.heartbeat(task), ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
    view.progress = { ...view.progress, stage: "dependencies", completed: 0, total: resources.length };
    await store.save(task, { view: summarize(view) });
    async function receipt(resource: PlannedResource): Promise<ImportResult | null> {
      const intent = await store.intent(resource.kind, resource.id);
      if (!intent || intent.ownerUserId !== task.ownerUserId || intent.importKey !== resource.importKey
        || intent.sourceDigest !== resource.sourceDigest || intent.targetDigest !== resource.targetDigest
        || intent.connectionId !== task.connectionId || intent.sourceUserId !== task.request.sourceUserId) {
        throw new ImportConflictError("No matching persisted write-ahead intent");
      }
      const result = await target.receipt(resource.kind, resource.importKey);
      if (result) checkReceipt(result, resource.kind, resource.id, resource.importKey, intent.receipt);
      else if (intent.receipt) throw new ImportOutcomeUnknownError();
      return result;
    }
    async function confirmed(resource: PlannedResource, result: ImportResult): Promise<void> {
      checkReceipt(result, resource.kind, resource.id, resource.importKey);
      await store.markIntent(task, resource, "confirmed", result.receipt);
    }
    async function failure(resource: PlannedResource, error: unknown): Promise<void> {
      if (error instanceof ImportLeaseLostError) throw error;
      const unknown = !importConflict(error);
      const message = unknown ? "Import outcome requires target receipt or local finalization reconciliation"
        : error instanceof ImportConflictError ? error.message : "Target rejected this resource import";
      results.set(resourceKey(resource.kind, resource.id), { unknown, message });
      if (!resource.platform) {
        const intent = await store.intent(resource.kind, resource.id);
        await store.markIntent(task, resource, intent?.receipt ? "confirmed" : unknown ? "outcome_unknown" : "conflict",
          intent?.receipt ?? undefined, message);
      }
    }
    // Check each complete root and its frozen facts before ANY Skill, Reference, attachment or Agent write.
    // A conflicting root cannot cause its otherwise-unused dependencies to be published on the target.
    for (const resource of resources.filter((item) => item.kind === "agent")) {
      await store.heartbeat(task);
      try {
        if (!resource.prepared) throw new ImportConflictError("Agent has no frozen target configuration");
        requireCanonicalSourceSetting(resource.prepared.config.setting);
        const source = plan.snapshot.agents.find((agent) => agent.id === resource.id);
        if (!source) throw new ImportConflictError("Agent is missing from the frozen source snapshot");
        await target.validateSelections(resource.prepared.config.setting, resource.prepared.dependencies, plannedResourcesForAgent(plan.snapshot, source));
      } catch (error) {
        if (!(error instanceof ImportConflictError)) throw error; // dependency outage pauses the plan before remote writes
        await failure(resource, error);
      }
    }
    const neededDependencies = new Set(plan.snapshot.agents.filter((agent) =>
      eligible.has(agent.id) && !results.has(resourceKey("agent", agent.id))).flatMap(dependencyKeys));
    for (const resource of resources.filter((item) => item.kind !== "agent" && neededDependencies.has(resourceKey(item.kind, item.id)))
      .sort((a, b) => a.kind === b.kind ? 0 : a.kind === "skill" ? -1 : 1)) {
      await store.heartbeat(task);
      view.progress.stage = resource.kind === "skill" ? "skills" : "references";
      try {
        if (resource.error) throw new ImportConflictError(resource.error);
        if (resource.platform) {
          if (!await verify(resource, task)) throw new ImportConflictError("Platform Skill is missing on target");
          await store.complete(task, resource, null);
        } else {
          let result = await receipt(resource);
          if (!result) {
            if (plan.version !== 2) throw new ImportOutcomeUnknownError();
            const current = resource.kind === "skill" ? await target.skill(resource.id) : await target.reference(resource.id);
            if (!current && await store.sources.get(resource.kind, resource.id)) throw new ImportConflictError("A registered dependency was removed; import cannot revive it");
            if (Date.parse(task.expiresAt) <= Date.now()) throw new ImportConflictError("Preview expired before this resource was imported");
            await store.markIntent(task, resource, "submitting");
            if (resource.kind === "skill") {
              result = await target.importSkill(resource.id, await staging.zip(task.id, resource.files, task.expiresAt), resource.importKey);
            } else {
              const source = resource.source;
              if (!("mediaType" in source)) throw new ImportConflictError("Invalid Reference plan");
              const intent = await store.intent(resource.kind, resource.id);
              let attachment = intent?.attachment;
              if (!attachment) {
                attachment = await target.uploadReference(resource.id, source.name, source.mediaType,
                  await staging.read(task.id, resource.files[0]!, task.expiresAt), resource.importKey);
                await store.saveAttachment(task, resource, attachment); // freezes the exact target attachment before POST
              }
              result = await target.importReference(resource.id, attachment, resource.importKey);
            }
          }
          await confirmed(resource, result);
          if (!await verify(resource, task)) throw new ImportConflictError("Imported dependency is no longer available");
          await store.complete(task, resource, result.receipt);
        }
        results.set(resourceKey(resource.kind, resource.id), null);
      } catch (error) { await failure(resource, error); }
      view.progress.completed++;
      await store.save(task, { view: summarize(view) });
    }
    for (const item of view.agents.filter((item) => eligible.has(item.id))) {
      await store.heartbeat(task);
      const resource = resources.find((resource) => resource.kind === "agent" && resource.id === item.id)!;
      const source = plan.snapshot.agents.find((agent) => agent.id === item.id)!;
      const dependencyError = results.get(resourceKey("agent", item.id))
        ?? dependencyKeys(source).map((key) => results.get(key)).find((value) => value);
      view.progress.stage = "agents";
      if (dependencyError) {
        item.status = dependencyError.unknown ? "outcome_unknown" : "conflict";
        item.message = dependencyError.message;
      } else {
        try {
          if (!resource.prepared) throw new ImportConflictError("Agent has no frozen target configuration");
          const recovered = await receipt(resource);
          if (!recovered) {
            if (plan.version !== 2) throw new ImportOutcomeUnknownError();
            if (Date.parse(task.expiresAt) <= Date.now()) throw new ImportConflictError("Preview expired before Agent import");
            const existing = await target.agent(resource.id);
            if (!existing && await store.sources.get("agent", resource.id)) throw new ImportConflictError("A registered Agent was removed; import cannot revive it");
            item.overwrite = !!existing;
            await store.markIntent(task, resource, "submitting");
          }
          // AgentConfigService verifies the current target even when this is a historical receipt result.
          const result = await agents.import(resource.prepared, resource.importKey,
            (result) => confirmed(resource, result), recovered ?? undefined);
          await store.complete(task, resource, result.receipt);
          item.status = (item.overwrite ?? resource.overwrite) ? "overwritten" : "created";
          delete item.message;
        } catch (error) {
          await failure(resource, error);
          const result = results.get(resourceKey("agent", resource.id))!;
          item.status = result.unknown ? "outcome_unknown" : "conflict";
          item.message = result.message;
        }
      }
      view.progress.completed++;
      await store.save(task, { view: summarize(view) });
    }
    if (view.agents.some((item) => item.status === "outcome_unknown")) throw new ImportOutcomeUnknownError();
    view.status = view.agents.some((item) => ["conflict", "failed"].includes(item.status))
      ? "completed_with_errors" : "completed";
    view.progress.stage = "finished";
    await store.save(task, { view: summarize(view) });
  }
  return {
    async run(taskId: string, options: { final?: boolean } = {}): Promise<void> {
      const task = await store.claim(taskId, crypto.randomUUID());
      if (!task) return;
      try {
        if (task.connectionId !== input.source.connectionId || task.ownerUserId !== target.ownerUserId) throw new ImportConflictError("Task source or target changed");
        await staging.prune();
        if (task.view.status === "checking") await preview(task);
        else await apply(task);
      } catch (error) {
        if (error instanceof ImportLeaseLostError) throw error;
        const conflict = importConflict(error);
        const uncertain = !!task.applyKey && !conflict;
        const terminal = conflict || options.final === true;
        const view = { ...task.view,
          status: uncertain ? terminal ? "outcome_unknown" as const : "importing" as const
            : terminal ? "failed" as const : "checking" as const,
          progress: uncertain ? { ...task.view.progress, stage: "receipts" } : task.view.progress,
          error: error instanceof ImportConflictError ? error.message : uncertain
            ? terminal ? "Automatic import recovery is exhausted; the same task requires manual receipt or local finalization reconciliation"
              : "Import receipt or local finalization reconciliation is pending; background recovery will continue with the same task"
            : "Agent import dependency or local persistence is unavailable; retry the same task",
        };
        if (view.status === "failed") view.agents = view.agents.map((item) => ["pending", "ready"].includes(item.status)
          ? { ...item, status: "failed" as const, message: view.error } : item);
        await store.save(task, { view: summarize(view) });
        if (!terminal || uncertain || error instanceof ImportDependencyError) throw error;
      } finally { await store.release(task); }
    },
  };
}
