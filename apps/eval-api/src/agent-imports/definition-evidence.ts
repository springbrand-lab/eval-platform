import { z } from "zod";
import { ImportConflictError } from "./errors.js";

// Codec for SP's public HTTP evidence seam, not a local capability definition/version generator.
export const DEFINITION_PROBE_LIMIT = 500;
const resourceId = z.string().min(1).max(255).refine((id) => id === id.trim());
export const definitionResourceSchema = z.strictObject({
  kind: z.enum(["action", "connector", "extension"]), id: resourceId,
});
export const definitionEvidenceSchema = definitionResourceSchema.extend({
  fingerprint: z.string().length(64).regex(/^[0-9a-f]{64}$/u),
});
export type DefinitionResource = z.infer<typeof definitionResourceSchema>;
export type DefinitionEvidence = z.infer<typeof definitionEvidenceSchema>;
const key = ({ kind, id }: DefinitionResource) => `${kind}:${id}`;
function ordered<T extends DefinitionResource>(values: readonly T[]): T[] {
  return [...values].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

/** Only direct public Action/Component selections require definition evidence; Toolkits are not Components. */
export function selectedDefinitions(setting: Readonly<Record<string, unknown>>): DefinitionResource[] {
  const result: DefinitionResource[] = [];
  for (const [field, kind] of [["actionIds", "action"], ["connectorIds", "connector"], ["extensionIds", "extension"]] as const) {
    const parsed = z.array(resourceId).max(256).safeParse(setting[field] ?? []);
    if (!parsed.success) throw new ImportConflictError(`Unsupported ${field}`);
    result.push(...parsed.data.map((id) => ({ kind, id })));
  }
  return ordered(result);
}

/** Exact per-Agent coverage. Never adopt a target-only proof or choose one of two competing source versions. */
export function requireDefinitionEvidence(setting: Readonly<Record<string, unknown>>, evidence: readonly DefinitionEvidence[]): DefinitionEvidence[] {
  const selected = selectedDefinitions(setting);
  const parsed = z.array(definitionEvidenceSchema).max(DEFINITION_PROBE_LIMIT).safeParse(evidence);
  if (!parsed.success) throw new ImportConflictError("Capability definition evidence is invalid");
  const selectedKeys = new Set(selected.map(key));
  const evidenceKeys = new Set(parsed.data.map(key));
  if (selectedKeys.size !== selected.length || evidenceKeys.size !== parsed.data.length
    || selected.length !== parsed.data.length || parsed.data.some((item) => !selectedKeys.has(key(item)))) {
    throw new ImportConflictError("Selected capabilities need exactly one matching source definition proof per kind and ID");
  }
  return ordered(parsed.data);
}

/** Select each Agent's frozen proofs from the source's selected-root union. Missing proof blocks only that Agent. */
export function sourceDefinitionEvidence(setting: Readonly<Record<string, unknown>>, union: readonly DefinitionEvidence[]): DefinitionEvidence[] {
  const selected = new Set(selectedDefinitions(setting).map(key));
  return requireDefinitionEvidence(setting, union.filter((item) => selected.has(key(item))));
}

/** A source may not expand its authorized snapshot with proofs outside the requested roots. */
export function requireDefinitionScope(agents: readonly { setting: Record<string, unknown> }[], evidence: readonly DefinitionEvidence[]): void {
  const selected = new Set(agents.flatMap((agent) => selectedDefinitions(agent.setting)).map(key));
  if (evidence.some((item) => !selected.has(key(item)))) throw new ImportConflictError("Export dependency evidence exceeds the selected Agent scope");
}
