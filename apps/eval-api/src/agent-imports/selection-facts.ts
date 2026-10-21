import { ImportConflictError } from "./errors.js";
import { plannedImportResourcesSchema, skillId, uuid, type PlannedImportResources, type SourceAgent, type SourceSnapshot } from "./model.js";

export function dependencies(agent: { readonly setting: Readonly<Record<string, unknown>> }): { skills: string[]; references: string[] } {
  function ids(field: string, kind: "skill" | "reference") {
    const values = agent.setting[field] ?? [];
    if (!Array.isArray(values) || values.length > 256) throw new ImportConflictError(`Unsupported ${field}`);
    const ids = values.map((value) => (kind === "skill" ? skillId : uuid).parse(value));
    if (new Set(ids).size !== ids.length) throw new ImportConflictError(`Duplicate ${field}`);
    return ids;
  }
  return { skills: ids("skillIds", "skill"), references: ids("referenceFileIds", "reference") };
}

/** Transport scope/identity only. SP owns eligibility, names, aggregate sizes and existing-resource facts. */
export function requirePlannedResources(setting: Record<string, unknown>, resources: PlannedImportResources): PlannedImportResources {
  const parsed = plannedImportResourcesSchema.safeParse(resources);
  if (!parsed.success) throw new ImportConflictError("Planned resource facts are invalid");
  const selected = dependencies({ setting });
  for (const kind of ["skills", "references"] as const) {
    const ids = parsed.data[kind].map((resource) => resource.id);
    if (new Set(ids).size !== ids.length || ids.some((id) => !selected[kind].includes(id))) {
      throw new ImportConflictError("Planned resource facts must be unique selected dependencies");
    }
  }
  return parsed.data;
}

/** Missing-dependency facts come only from the durable source snapshot and only for this Agent's selections. */
export function plannedResourcesForAgent(snapshot: SourceSnapshot, agent: SourceAgent): PlannedImportResources {
  const selected = dependencies(agent);
  const skills = selected.skills.flatMap((id) => {
    const skill = snapshot.skills.find((skill) => skill.id === id);
    if (!skill) throw new ImportConflictError("Export is missing a selected Skill");
    return skill.kind === "user" ? [{ id: skill.id, name: skill.name }] : [];
  });
  const references = selected.references.map((id) => {
    const reference = snapshot.references.find((reference) => reference.id === id);
    if (!reference || reference.status !== "active") throw new ImportConflictError("Selected Reference is missing or disabled");
    return { id: reference.id, size: reference.size };
  });
  return requirePlannedResources(agent.setting, { skills, references });
}
