import type { EvaluationRecord } from "@eval-platform/eval-contracts";
import { isSucceededEvaluation, type EvaluationOutputReader } from "../evaluators/index.js";
import type { NumericSchemaType } from "../evaluators/model.js";
import type { NumericMissingReason, NumericObservationSummary, NumericOutputSummary } from "./model.js";
import { coverage, summarizeNumbers } from "./statistics.js";

interface FieldValues {
  readonly schemaType: NumericSchemaType;
  readonly values: number[];
  readonly contributors: Set<string>;
}

/** Why each evaluation cannot contribute any number; undefined for a succeeded, valid output. */
function missingReason(record: EvaluationRecord, reader: EvaluationOutputReader): NumericMissingReason | undefined {
  if (!isSucceededEvaluation(record)) return "not-succeeded";
  const { status } = reader.read(record).validation;
  return status === "invalid" ? "invalid-output" : status === "unavailable" ? "unavailable-output" : undefined;
}

function collectFields(reader: EvaluationOutputReader, evaluations: readonly EvaluationRecord[]): Map<string, FieldValues> {
  const fields = new Map<string, FieldValues>();
  for (const [pointer, schemaType] of reader.declaredFields) fields.set(pointer, { schemaType, values: [], contributors: new Set() });
  for (const record of evaluations) {
    for (const observation of reader.read(record).numericObservations) {
      const field = fields.get(observation.jsonPointer) ?? { schemaType: observation.schemaType, values: [], contributors: new Set() };
      field.values.push(observation.value);
      field.contributors.add(record.evaluationId);
      fields.set(observation.jsonPointer, field);
    }
  }
  return fields;
}

/** Per-field numeric statistics recomputed from the raw observations of the given evaluations. */
export function summarizeNumericOutputs(reader: EvaluationOutputReader, evaluations: readonly EvaluationRecord[]): NumericOutputSummary {
  const validation = { valid: 0, invalid: 0, unavailable: 0 };
  for (const record of evaluations) validation[reader.read(record).validation.status] += 1;
  if (reader.schema === null) return { schema: null, coverage: "unavailable", evaluations: evaluations.length, validation, fields: [] };
  const reasons = evaluations.map((record) => missingReason(record, reader));
  const usable = reasons.filter((reason) => reason === undefined).length;
  const complete = usable > 0 && usable === evaluations.length;
  const fields = collectFields(reader, evaluations);
  const pointers = [...reader.declaredFields.keys(), ...[...fields.keys()].filter((pointer) => !reader.declaredFields.has(pointer)).sort()];
  return {
    schema: reader.schema, coverage: coverage(complete, usable > 0), evaluations: evaluations.length, validation,
    fields: pointers.map((jsonPointer): NumericObservationSummary => {
      const field = fields.get(jsonPointer)!;
      const missing = new Map<NumericMissingReason, number>();
      evaluations.forEach((record, index) => {
        if (field.contributors.has(record.evaluationId)) return;
        const reason = reasons[index] ?? "absent";
        missing.set(reason, (missing.get(reason) ?? 0) + 1);
      });
      return {
        jsonPointer, schemaType: field.schemaType,
        observationCount: field.values.length,
        contributingEvaluationCount: field.contributors.size,
        missingEvaluationCount: evaluations.length - field.contributors.size,
        summary: summarizeNumbers(field.values),
        coverage: coverage(complete, field.values.length > 0),
        diagnostics: [...missing].map(([reason, count]) => ({ reason, evaluations: count })),
      };
    }),
  };
}
