import type { EvaluationOutputSchema, EvaluationOutputSchemaRef, EvaluationRecord, JsonValue } from "@eval-platform/eval-contracts";
import { parseStrictJson } from "@eval-platform/eval-dataset";
import type { ErrorObject } from "ajv";
import { unsafeNumber } from "../json.js";
import type { EvaluationOutputView, EvaluationValidation, EvaluationValidationError, OutputFieldDefinition } from "./model.js";
import { selectOutputFields, type OutputFacts } from "./fields.js";
import { CompiledOutputPlan } from "./plan.js";

function validation(
  status: EvaluationValidation["status"],
  reason: EvaluationValidation["reason"],
  errors: readonly EvaluationValidationError[] = [],
): EvaluationValidation {
  return { status, reason, errors };
}

function documentError(keyword: string, message: string, instancePath = ""): EvaluationValidationError {
  return { instancePath, schemaPath: null, keyword, message };
}

function schemaError(error: ErrorObject): EvaluationValidationError {
  return { instancePath: error.instancePath, schemaPath: error.schemaPath, keyword: error.keyword, message: error.message ?? error.keyword };
}

/** Only a succeeded Evaluator with a succeeded output can contribute observations. */
export function isSucceededEvaluation(record: EvaluationRecord): boolean {
  return record.status.status === "succeeded" && record.output?.status === "succeeded";
}

export interface EvaluationOutputReader {
  readonly schema: EvaluationOutputSchemaRef | null;
  /** The plan's named presentation definitions, including null-only definitions needed in a larger scope. */
  readonly fields: ReadonlyMap<string, OutputFieldDefinition>;
  /** One execution supplies both the detail view and all observation facts needed by any aggregation scope. */
  read(record: EvaluationRecord): EvaluationOutputRead;
}

const NOTHING: OutputFacts = { observations: [], fields: new Map() };

interface ContentCheck {
  readonly document: JsonValue | null;
  readonly validation: EvaluationValidation;
  readonly validated?: ReturnType<CompiledOutputPlan["validate"]>;
}

/** Strict JSON parse, safe-number check and Schema validation of one raw result text. */
function checkContent(compiled: CompiledOutputPlan | undefined, compileError: string | undefined, content: string): ContentCheck {
  let document: JsonValue;
  try {
    document = parseStrictJson(content) as JsonValue;
  } catch (error) {
    return { document: null, validation: validation("invalid", "invalid-json", [documentError("json", (error as SyntaxError).message)]) };
  }
  const unsafe = unsafeNumber(document, []);
  if (unsafe !== undefined) {
    return { document: null, validation: validation("invalid", "unsafe-number", [
      documentError("number", "Number is not finite or exceeds the safe-integer range", unsafe),
    ]) };
  }
  if (!compiled) {
    return { document, validation: compileError === undefined
      ? validation("unavailable", "no-schema")
      : validation("unavailable", "invalid-schema", [documentError("schema", compileError)]) };
  }
  const validated = compiled.validate(document);
  if (!validated.valid) {
    return { document, validation: validation("invalid", "schema-mismatch", (compiled.errors ?? []).map(schemaError)) };
  }
  return { document, validation: validation("valid", "valid"), validated };
}

/** Validates raw result text exactly as the detail view does; one compiled Schema per Schema object. */
export function createEvaluationResultValidator(): (schema: EvaluationOutputSchema, content: string) => EvaluationValidation {
  const plans = new WeakMap<EvaluationOutputSchema, { compiled?: CompiledOutputPlan; compileError?: string }>();
  return (schema, content) => {
    let plan = plans.get(schema);
    if (!plan) {
      try {
        plan = { compiled: new CompiledOutputPlan(schema) };
      } catch (error) {
        plan = { compileError: (error as Error).message };
      }
      plans.set(schema, plan);
    }
    return checkContent(plan.compiled, plan.compileError, content).validation;
  };
}

export interface EvaluationOutputRead {
  readonly view: EvaluationOutputView;
  readonly facts: OutputFacts;
}

export function createEvaluationOutputReader(
  schemaRef: EvaluationOutputSchemaRef | null,
  schema: EvaluationOutputSchema | null,
): EvaluationOutputReader {
  let compiled: CompiledOutputPlan | undefined;
  let compileError: string | undefined;
  if (schema !== null) {
    try {
      compiled = new CompiledOutputPlan(schema);
    } catch (error) {
      compileError = (error as Error).message;
    }
  }
  const fields = compiled?.fields ?? new Map<string, OutputFieldDefinition>();
  const reads = new Map<string, EvaluationOutputRead>();
  const readOutput = (record: EvaluationRecord): EvaluationOutputRead => {
    const output = record.output;
    const structured = output?.structuredOutput;
    const view = (rawJson: JsonValue | null, result: EvaluationValidation, facts = NOTHING): EvaluationOutputRead => {
      const displayed = selectOutputFields([fields, facts.fields]);
      return {
        view: {
          evaluationId: record.evaluationId, samplingId: record.samplingId,
          outputStatus: output?.status ?? null, outputError: output?.error ?? null,
          path: structured?.path ?? null, contentHash: structured?.contentHash ?? null, content: structured?.content ?? null,
          rawJson, validation: result, observations: facts.observations.filter((observation) => displayed.has(observation.jsonPointer)),
          artifacts: output?.artifacts ?? [], evidenceRefs: output?.evidenceRefs ?? [], trajectory: output?.trajectory ?? null,
        },
        facts,
      };
    };
    if (!output) return view(null, validation("unavailable", "no-output"));
    if (!structured) return view(null, validation("unavailable", "no-structured-output"));
    const checked = checkContent(compiled, compileError, structured.content);
    if (checked.validation.status !== "valid" || !compiled || !checked.validated) return view(checked.document, checked.validation);
    return view(checked.document, checked.validation, isSucceededEvaluation(record) ? compiled.observe(checked.document!, checked.validated) : NOTHING);
  };
  const cachedRead = (record: EvaluationRecord): EvaluationOutputRead => {
    let cached = reads.get(record.evaluationId);
    if (!cached) {
      cached = readOutput(record);
      reads.set(record.evaluationId, cached);
    }
    return cached;
  };
  return {
    schema: schemaRef,
    fields,
    read: cachedRead,
  };
}
