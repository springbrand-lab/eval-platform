import type { EvaluationRecord } from "@eval-platform/eval-contracts";
import { isSucceededEvaluation, type EvaluationOutputReader } from "../evaluators/index.js";
import { selectOutputFields } from "../evaluators/fields.js";
import type { OutputFieldDefinition, OutputScalar } from "../evaluators/model.js";
import type { EvaluationOutputSummary, OutputFieldSummary, OutputMissingReason } from "./model.js";
import { coverage, summarizeNumbers } from "./statistics.js";

interface FieldValues {
  readonly definition: OutputFieldDefinition;
  observations: number;
  nulls: number;
  readonly numbers: number[];
  readonly entries: ReadonlyMap<OutputScalar, { count: number; readonly evaluations: Set<string> }>;
  readonly contributors: Set<string>;
}

/** Why each evaluation cannot contribute any value; undefined for a succeeded, valid output. */
function missingReason(record: EvaluationRecord, reader: EvaluationOutputReader): OutputMissingReason | undefined {
  if (!isSucceededEvaluation(record)) return "not-succeeded";
  const { status } = reader.read(record).view.validation;
  return status === "invalid" ? "invalid-output" : status === "unavailable" ? "unavailable-output" : undefined;
}

/** Merge presentation definitions for the scope; observation eligibility was already decided by the plan. */
function collectFields(reader: EvaluationOutputReader, evaluations: readonly EvaluationRecord[]): ReadonlyMap<string, FieldValues> {
  const definitions = selectOutputFields([reader.fields, ...evaluations.map((record) => reader.read(record).facts.fields)]);
  const fields = new Map([...definitions].map(([pointer, definition]): [string, FieldValues] => [pointer, {
    definition, observations: 0, nulls: 0, numbers: [], contributors: new Set(),
    entries: new Map(definition.values.map((value) => [value, { count: 0, evaluations: new Set<string>() }])),
  }]));
  for (const record of evaluations) {
    for (const { jsonPointer, kinds, value } of reader.read(record).facts.observations) {
      const field = fields.get(jsonPointer);
      if (!field) continue;
      field.observations += 1;
      field.contributors.add(record.evaluationId);
      if (value === null) {
        field.nulls += 1;
        continue;
      }
      if (typeof value === "number" && (kinds.includes("number") || kinds.includes("integer"))) field.numbers.push(value);
      const entry = kinds.includes("boolean") || kinds.includes("enum") ? field.entries.get(value) : undefined;
      if (entry) {
        entry.count += 1;
        entry.evaluations.add(record.evaluationId);
      }
    }
  }
  return fields;
}

/** Per-field statistics and distributions recomputed from the raw observations of the given evaluations. */
export function summarizeOutputFields(reader: EvaluationOutputReader, evaluations: readonly EvaluationRecord[]): EvaluationOutputSummary {
  const validation = { valid: 0, invalid: 0, unavailable: 0 };
  for (const record of evaluations) validation[reader.read(record).view.validation.status] += 1;
  if (reader.schema === null) return { schema: null, coverage: "unavailable", evaluations: evaluations.length, validation, fields: [] };
  const reasons = evaluations.map((record) => missingReason(record, reader));
  const usable = reasons.filter((reason) => reason === undefined).length;
  const complete = usable > 0 && usable === evaluations.length;
  const fields = collectFields(reader, evaluations);
  return {
    schema: reader.schema, coverage: coverage(complete, usable > 0), evaluations: evaluations.length, validation,
    fields: [...fields].map(([jsonPointer, field]): OutputFieldSummary => {
      const missing = new Map<OutputMissingReason, number>();
      evaluations.forEach((record, index) => {
        if (field.contributors.has(record.evaluationId)) return;
        const reason = reasons[index] ?? "absent";
        missing.set(reason, (missing.get(reason) ?? 0) + 1);
      });
      return {
        jsonPointer, title: field.definition.title, description: field.definition.description, kinds: field.definition.kinds,
        observationCount: field.observations,
        contributingEvaluationCount: field.contributors.size,
        missingEvaluationCount: evaluations.length - field.contributors.size,
        numeric: field.definition.kinds.some((kind) => kind === "number" || kind === "integer") ? summarizeNumbers(field.numbers) : null,
        distribution: [...field.entries].map(([value, entry]) => ({
          value, count: entry.count, share: field.observations === 0 ? null : entry.count / field.observations, evaluations: entry.evaluations.size,
        })),
        ...field.definition.nullable ? { nullCount: field.nulls } : {},
        coverage: coverage(field.observations > 0 && field.contributors.size === evaluations.length, field.observations > 0),
        diagnostics: [...missing].map(([reason, count]) => ({ reason, evaluations: count })),
      };
    }),
  };
}
