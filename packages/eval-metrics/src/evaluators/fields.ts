import type { OutputFieldDefinition, OutputFieldKind, OutputObservation } from "./model.js";

const KINDS: readonly OutputFieldKind[] = ["number", "integer", "boolean", "enum"];

export function unionKinds(sources: readonly (readonly OutputFieldKind[])[]): readonly OutputFieldKind[] {
  const kinds = new Set(sources.flat());
  if (kinds.has("number")) kinds.delete("integer");
  return KINDS.filter((kind) => kinds.has(kind));
}

/** Display unions preserve declaration order and cannot change an observation's statistical eligibility. */
export function mergeFieldDefinitions(left: OutputFieldDefinition | undefined, right: OutputFieldDefinition): OutputFieldDefinition {
  if (left === undefined) return right;
  return {
    ...left,
    kinds: unionKinds([left.kinds, right.kinds]),
    values: [...new Set([...left.values, ...right.values])],
    nullable: left.nullable || right.nullable,
  };
}

/** Null-only definitions remain available until the complete scope determines which fields are displayed. */
export function selectOutputFields(sources: readonly ReadonlyMap<string, OutputFieldDefinition>[]): ReadonlyMap<string, OutputFieldDefinition> {
  const fields = new Map<string, OutputFieldDefinition>();
  for (const source of sources) {
    for (const [pointer, field] of source) fields.set(pointer, mergeFieldDefinitions(fields.get(pointer), field));
  }
  return new Map([...fields].filter(([, field]) => field.kinds.length > 0));
}

/** Complete facts from a single succeeded, valid output, before field selection for any reporting scope. */
export interface OutputFacts {
  readonly fields: ReadonlyMap<string, OutputFieldDefinition>;
  readonly observations: readonly OutputObservation[];
}
