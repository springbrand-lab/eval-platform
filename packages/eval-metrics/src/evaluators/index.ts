import type { EvaluationRecord } from "@eval-platform/eval-contracts";
import { summarizeNumbers } from "../aggregation/statistics.js";
import type { NumericMissingReason, NumericObservationSummary, NumericOutputSummary, NumericSchemaType } from "./model.js";
import { isSucceededEvaluation, type EvaluationOutputReader } from "./schema.js";

export { createEvaluationOutputReader, type EvaluationOutputReader } from "./schema.js";

interface FieldValues {
  readonly schemaType: NumericSchemaType;
  readonly values: number[];
  readonly contributors: Set<string>;
}

/** Per-field numeric statistics recomputed from the raw observations of the given evaluations. */
export function summarizeNumericOutputs(reader: EvaluationOutputReader, evaluations: readonly EvaluationRecord[]): NumericOutputSummary {
  const read = evaluations.map((record) => ({ record, view: reader.read(record) }));
  const validation = { valid: 0, invalid: 0, unavailable: 0 };
  for (const { view } of read) validation[view.validation.status] += 1;
  if (reader.schema === null) return { schema: null, coverage: "unavailable", evaluations: evaluations.length, validation, fields: [] };
  const reasons = read.map(({ record, view }): NumericMissingReason | undefined => {
    if (!isSucceededEvaluation(record)) return "not-succeeded";
    if (view.validation.status === "invalid") return "invalid-output";
    return view.validation.status === "unavailable" ? "unavailable-output" : undefined;
  });
  const usable = reasons.filter((reason) => reason === undefined).length;
  const fields = new Map<string, FieldValues>();
  for (const [pointer, schemaType] of reader.declaredFields) fields.set(pointer, { schemaType, values: [], contributors: new Set() });
  for (const { record, view } of read) {
    for (const observation of view.numericObservations) {
      const field = fields.get(observation.jsonPointer) ?? { schemaType: observation.schemaType, values: [], contributors: new Set() };
      field.values.push(observation.value);
      field.contributors.add(record.evaluationId);
      fields.set(observation.jsonPointer, field);
    }
  }
  const pointers = [
    ...reader.declaredFields.keys(),
    ...[...fields.keys()].filter((pointer) => !reader.declaredFields.has(pointer)).sort(),
  ];
  return {
    schema: reader.schema,
    coverage: usable === 0 ? "unavailable" : usable === evaluations.length ? "complete" : "partial",
    evaluations: evaluations.length,
    validation,
    fields: pointers.map((jsonPointer): NumericObservationSummary => {
      const field = fields.get(jsonPointer)!;
      const missing = new Map<NumericMissingReason, number>();
      read.forEach(({ record }, index) => {
        if (field.contributors.has(record.evaluationId)) return;
        const reason = reasons[index] ?? "absent";
        missing.set(reason, (missing.get(reason) ?? 0) + 1);
      });
      const complete = evaluations.length > 0 && usable === evaluations.length;
      return {
        jsonPointer, schemaType: field.schemaType,
        observationCount: field.values.length,
        contributingEvaluationCount: field.contributors.size,
        missingEvaluationCount: evaluations.length - field.contributors.size,
        summary: summarizeNumbers(field.values),
        coverage: complete ? "complete" : field.values.length > 0 ? "partial" : "unavailable",
        diagnostics: [...missing].map(([reason, count]) => ({ reason, evaluations: count })),
      };
    }),
  };
}
