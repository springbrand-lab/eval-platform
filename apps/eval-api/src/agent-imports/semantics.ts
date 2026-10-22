import { equalJson } from "@eval-platform/eval-contracts";
import { ImportConflictError } from "./errors.js";
import { digest, type FrozenFile, type ImportPlan, type ImportTask, type PlannedResource, type SourceAgent } from "./model.js";
import type { AgentImportStore } from "./store.js";
import type { DefinitionEvidence } from "./definition-evidence.js";
import { dependencies } from "./selection-facts.js";

export function agentSourceDigest(source: SourceAgent, dependencies: readonly DefinitionEvidence[]): string {
  return digest({ version: 1, source, dependencies });
}

/** SP exports its canonical defaults. Assert their presence; never normalize, drop or refill source fields here. */
export function requireCanonicalSourceSetting(setting: Readonly<Record<string, unknown>>): void {
  if (!Object.hasOwn(setting, "presetId") || setting.presetId !== null && typeof setting.presetId !== "string"
    || ["referenceFileIds", "connectorIds", "extensionIds"].some((field) => !Object.hasOwn(setting, field) || !Array.isArray(setting[field]))) {
    throw new ImportConflictError("Source Agent setting is not canonical; update the source export and preview again");
  }
}

export function dependencyKeys(agent: SourceAgent): string[] {
  const { skills, references } = dependencies(agent);
  return [...skills.map((id) => `skill:${id}`), ...references.map((id) => `reference:${id}`)];
}
export function manifest(files: readonly FrozenFile[]) {
  return files.map(({ path, size, sha256 }) => ({ path, size, sha256 })).sort((a, b) => a.path.localeCompare(b.path, "en"));
}
export function sameFiles(expected: readonly FrozenFile[], actual: readonly FrozenFile[]): boolean {
  return equalJson(manifest(expected), manifest(actual));
}
export function resourceDigests(resource: PlannedResource, task: ImportTask): void {
  if (resource.kind === "skill") {
    const source = resource.source as Extract<PlannedResource["source"], { kind: "platform" | "user" }>;
    resource.sourceDigest = digest({ version: 1, id: source.id, name: source.name, kind: source.kind,
      contentHash: source.contentHash, files: manifest(resource.files) });
    resource.targetDigest = digest({ version: 1, id: source.id, name: source.name, kind: source.kind, files: manifest(resource.files) });
  } else if (resource.kind === "reference") {
    const source = resource.source as Extract<PlannedResource["source"], { status: "active" | "disabled" }>;
    resource.sourceDigest = resource.targetDigest = digest({ version: 1, id: source.id, name: source.name,
      mediaType: source.mediaType, size: source.size, status: source.status, files: manifest(resource.files) });
  } else {
    resource.sourceDigest = agentSourceDigest(resource.source as SourceAgent, resource.prepared!.dependencies);
    resource.targetDigest = digest({ version: 1, prepared: resource.prepared });
  }
  resource.importKey = `eval-import-v2-${digest({
    version: 2, task: task.id, owner: task.ownerUserId, connection: task.connectionId, sourceUserId: task.request.sourceUserId,
    kind: resource.kind, id: resource.id, source: resource.sourceDigest, target: resource.targetDigest,
  })}`;
}
export function planDigest(plan: ImportPlan, task: ImportTask): string {
  return digest({ version: plan.version, snapshot: plan.snapshot, resources: plan.resources,
    eligibleAgentIds: plan.eligibleAgentIds, owner: task.ownerUserId, connection: task.connectionId,
    user: task.request.sourceUserId, purpose: task.request.purpose });
}
/** Only known resource outcomes can admit a new overwrite; transactional admission also checks owning tasks. */
export async function requireReplaceableIntent(resource: PlannedResource, store: Pick<AgentImportStore, "intent">): Promise<void> {
  const current = await store.intent(resource.kind, resource.id);
  if (current && current.importKey !== resource.importKey && (!["completed", "planned", "conflict", "confirmed"].includes(current.status)
    || current.status === "confirmed" && !current.receipt)) {
    throw new ImportConflictError("An unfinished import must be reconciled before this resource can be overwritten");
  }
}
