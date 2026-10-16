import type { EvaluationOutputSchema } from "@eval-platform/eval-contracts";
import type { EvaluationScorePort } from "@eval-platform/eval-runtime";
import { createEvaluationOutputReader, isSucceededEvaluation, type EvaluationOutputReader } from "./index.js";
import { record as jsonRecord } from "../json.js";

/** The optional Langfuse score uses exactly the same validated document as Metrics reporting. */
export function createEvaluationScoreReader(): EvaluationScorePort["read"] {
  const readers = new WeakMap<EvaluationOutputSchema, EvaluationOutputReader>();
  return (schema, record) => {
    if (!isSucceededEvaluation(record)) return undefined;
    let reader = readers.get(schema);
    if (!reader) {
      reader = createEvaluationOutputReader(null, schema);
      readers.set(schema, reader);
    }
    const { view } = reader.read(record);
    const document = jsonRecord(view.rawJson);
    if (view.validation.status !== "valid" || !document) return undefined;
    const { score, reason } = document;
    if (typeof score !== "number") return undefined;
    return { score, ...(typeof reason === "string" ? { reason } : {}) };
  };
}
