import { equalJson } from "@eval-platform/eval-contracts";
import { ImportConflictError } from "./errors.js";
import { digest, type FrozenFile, type ImportPlan, type ImportTask, type PlannedResource, type SourceAgent } from "./model.js";
import type { AgentImportTarget } from "./target.js";
import { checkReceipt } from "./target.js";
import type { ResourceSourceStore } from "../db/agent-import-sources.js";
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
  resource.importKey = `eval-import-v1-${digest({
    version: 1, owner: task.ownerUserId, connection: task.connectionId, sourceUserId: task.request.sourceUserId,
    kind: resource.kind, id: resource.id, source: resource.sourceDigest, target: resource.targetDigest,
  })}`;
}
export function planDigest(plan: ImportPlan, task: ImportTask): string {
  return digest({ version: plan.version, snapshot: plan.snapshot, resources: plan.resources,
    eligibleAgentIds: plan.eligibleAgentIds, owner: task.ownerUserId, connection: task.connectionId,
    user: task.request.sourceUserId, purpose: task.request.purpose });
}
/** Equality is necessary, never sufficient: provenance and its still-valid SP receipt are both required. */
export async function requireReusable(resource: PlannedResource, task: ImportTask, sources: ResourceSourceStore, target: AgentImportTarget): Promise<void> {
  const source = await sources.get(resource.kind, resource.id);
  if (!source || source.origin !== "dev_import" || source.connectionId !== task.connectionId
    || source.sourceUserId !== task.request.sourceUserId || source.sourceDigest !== resource.sourceDigest
    || source.targetDigest !== resource.targetDigest || !source.receipt) {
    throw new ImportConflictError("Existing resource has no matching proven import, or its source content changed");
  }
  const result = await target.receipt(resource.kind, source.receipt.importKey);
  if (!result) throw new ImportConflictError("Existing resource import receipt is unavailable");
  checkReceipt(result, resource.kind, resource.id, source.receipt.importKey, source.receipt);
  resource.importKey = source.receipt.importKey;
}
