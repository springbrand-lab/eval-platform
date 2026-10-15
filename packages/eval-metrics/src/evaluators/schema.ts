import type {
  EvaluationOutputSchema,
  EvaluationOutputSchemaRef,
  EvaluationRecord,
  JsonValue,
} from "@eval-platform/eval-contracts";
import { parseStrictJson } from "@eval-platform/eval-dataset";
import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import type {
  EvaluationOutputView,
  EvaluationValidation,
  EvaluationValidationError,
  NumericObservation,
  NumericSchemaType,
} from "./model.js";

type JsonObject = Readonly<Record<string, JsonValue>>;
type Path = readonly string[];

const DEFAULT_SCHEMA_ID = "urn:eval-platform:evaluation-output-schema";
const COMBINATORS = ["anyOf", "oneOf"] as const;
const MAX_FIELD_DEPTH = 64;

function object(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function list(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? value : [];
}

/** RFC 6901 JSON Pointer of the given reference tokens. */
function jsonPointer(tokens: Path): string {
  return tokens.map((token) => `/${token.replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
}

function numericType(type: JsonValue | undefined): NumericSchemaType | undefined {
  const types = Array.isArray(type) ? type : [type];
  return types.includes("number") ? "number" : types.includes("integer") ? "integer" : undefined;
}

function mergeType(left: NumericSchemaType | undefined, right: NumericSchemaType): NumericSchemaType {
  return left === "number" || right === "number" ? "number" : "integer";
}

function pattern(source: string): RegExp | undefined {
  try {
    return new RegExp(source, "u");
  } catch {
    return undefined;
  }
}

/** First number JSON cannot carry exactly: non-finite or an integer outside the safe range. */
function unsafeNumber(value: JsonValue, path: Path): string | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)) ? undefined : jsonPointer(path);
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = unsafeNumber(item, [...path, String(index)]);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const [key, item] of Object.entries(object(value) ?? {})) {
    const found = unsafeNumber(item, [...path, key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The Project Schema compiled once, with sub-schema validators for branch selection. */
class CompiledSchema {
  readonly validate: ValidateFunction;
  readonly #ajv = new Ajv2020({ strict: false, allErrors: true, logger: false });
  readonly #id: string;
  readonly #branches = new Map<string, ValidateFunction | null>();

  constructor(readonly root: JsonObject) {
    const id = typeof root.$id === "string" && /^[a-z][a-z0-9+.-]*:/i.test(root.$id) ? root.$id.split("#")[0]! : DEFAULT_SCHEMA_ID;
    this.#ajv.addSchema({ ...root, $id: id });
    this.validate = this.#ajv.getSchema(id)!;
    this.#id = id;
  }

  node(path: Path): JsonValue | undefined {
    let current: JsonValue | undefined = this.root;
    for (const token of path) {
      current = Array.isArray(current) ? current[Number(token)] : object(current)?.[token];
      if (current === undefined) return undefined;
    }
    return current;
  }

  /** Whether the value satisfies the sub-schema at `path`, resolved in the context of the root. */
  matches(path: Path, value: JsonValue): boolean {
    const key = jsonPointer(path);
    let validate = this.#branches.get(key);
    if (validate === undefined) {
      const fragment = path.map((token) => `/${encodeURIComponent(token.replaceAll("~", "~0").replaceAll("/", "~1"))}`).join("");
      try {
        validate = this.#ajv.compile({ $ref: `${this.#id}#${fragment}` });
      } catch {
        validate = null;
      }
      this.#branches.set(key, validate);
    }
    return validate?.(value) === true;
  }

  /** Target path of a `$ref` into this document; undefined for anchors and remote references. */
  resolveRef(ref: string): Path | undefined {
    const hash = ref.indexOf("#");
    const base = hash < 0 ? ref : ref.slice(0, hash);
    if (base !== "" && base !== this.#id) return undefined;
    let fragment: string;
    try {
      fragment = decodeURIComponent(hash < 0 ? "" : ref.slice(hash + 1));
    } catch {
      return undefined;
    }
    if (fragment === "") return [];
    if (!fragment.startsWith("/")) return undefined;
    return fragment.slice(1).split("/").map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  }
}

/** Numeric fields the Schema can declare, by field pointer; recursive references stop at the cycle. */
function declaredFields(schema: CompiledSchema): ReadonlyMap<string, NumericSchemaType> {
  const fields = new Map<string, NumericSchemaType>();
  const walk = (path: Path, field: Path, active: ReadonlySet<string>): void => {
    const node = object(schema.node(path));
    const key = jsonPointer(path);
    if (!node || active.has(key) || field.length > MAX_FIELD_DEPTH) return;
    const next = new Set(active).add(key);
    const at = (...tokens: string[]): Path => [...path, ...tokens];
    const target = typeof node.$ref === "string" ? schema.resolveRef(node.$ref) : undefined;
    if (target) walk(target, field, next);
    for (const keyword of ["allOf", ...COMBINATORS]) list(node[keyword]).forEach((_, index) => walk(at(keyword, String(index)), field, next));
    for (const keyword of ["then", "else"]) if (node[keyword] !== undefined) walk(at(keyword), field, next);
    const type = numericType(node.type);
    if (type) fields.set(jsonPointer(field), mergeType(fields.get(jsonPointer(field)), type));
    for (const name of Object.keys(object(node.properties) ?? {})) walk(at("properties", name), [...field, name], next);
    list(node.prefixItems).forEach((_, index) => walk(at("prefixItems", String(index)), [...field, "*"], next));
    if (node.items !== undefined) walk(at("items"), [...field, "*"], next);
  };
  walk([], [], new Set());
  return fields;
}

/** Numbers in a valid output whose applicable Schema node declares number or integer. */
function extractNumbers(schema: CompiledSchema, document: JsonValue): readonly NumericObservation[] {
  const found = new Map<string, NumericObservation>();
  const visited = new Set<string>();
  const visit = (path: Path, value: JsonValue, instance: Path, field: Path): void => {
    const node = object(schema.node(path));
    const key = JSON.stringify([path, instance]);
    if (!node || visited.has(key)) return;
    visited.add(key);
    const at = (...tokens: string[]): Path => [...path, ...tokens];
    const target = typeof node.$ref === "string" ? schema.resolveRef(node.$ref) : undefined;
    if (target) visit(target, value, instance, field);
    list(node.allOf).forEach((_, index) => visit(at("allOf", String(index)), value, instance, field));
    for (const keyword of COMBINATORS) {
      list(node[keyword]).forEach((_, index) => {
        if (schema.matches(at(keyword, String(index)), value)) visit(at(keyword, String(index)), value, instance, field);
      });
    }
    if (node.if !== undefined) {
      const branch = schema.matches(at("if"), value) ? "then" : "else";
      if (node[branch] !== undefined) visit(at(branch), value, instance, field);
    }
    const type = numericType(node.type);
    if (type && typeof value === "number") {
      const instancePointer = jsonPointer(instance);
      const schemaType = mergeType(found.get(instancePointer)?.schemaType, type);
      found.set(instancePointer, { jsonPointer: jsonPointer(field), instancePointer, schemaType, value });
    }
    if (Array.isArray(value)) {
      const prefix = list(node.prefixItems).length;
      value.forEach((item: JsonValue, index: number) => {
        const itemPath = index < prefix ? at("prefixItems", String(index)) : node.items === undefined ? undefined : at("items");
        if (itemPath) visit(itemPath, item, [...instance, String(index)], [...field, "*"]);
      });
      return;
    }
    const properties = object(node.properties) ?? {};
    const patterns = Object.keys(object(node.patternProperties) ?? {});
    for (const [name, item] of Object.entries(object(value) ?? {})) {
      let matched = Object.hasOwn(properties, name);
      if (matched) visit(at("properties", name), item, [...instance, name], [...field, name]);
      for (const source of patterns) {
        if (!pattern(source)?.test(name)) continue;
        matched = true;
        visit(at("patternProperties", source), item, [...instance, name], [...field, name]);
      }
      if (!matched && node.additionalProperties !== undefined) {
        visit(at("additionalProperties"), item, [...instance, name], [...field, name]);
      }
    }
  };
  visit([], document, [], []);
  return [...found.values()];
}

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

/** Only a succeeded Evaluator with a succeeded output can contribute numbers. */
export function isSucceededEvaluation(record: EvaluationRecord): boolean {
  return record.status.status === "succeeded" && record.output?.status === "succeeded";
}

export interface EvaluationOutputReader {
  readonly schema: EvaluationOutputSchemaRef | null;
  /** Numeric fields the Schema declares, in Schema order. */
  readonly declaredFields: ReadonlyMap<string, NumericSchemaType>;
  read(record: EvaluationRecord): EvaluationOutputView;
}

export function createEvaluationOutputReader(
  schemaRef: EvaluationOutputSchemaRef | null,
  schema: EvaluationOutputSchema | null,
): EvaluationOutputReader {
  let compiled: CompiledSchema | undefined;
  let compileError: string | undefined;
  if (schema !== null) {
    try {
      compiled = new CompiledSchema(schema);
    } catch (error) {
      compileError = error instanceof Error ? error.message : String(error);
    }
  }
  const views = new Map<string, EvaluationOutputView>();
  const readOutput = (record: EvaluationRecord): EvaluationOutputView => {
    const output = record.output;
    const structured = output?.structuredOutput;
    const view = (
      rawJson: JsonValue | null,
      result: EvaluationValidation,
      numericObservations: readonly NumericObservation[] = [],
    ): EvaluationOutputView => ({
      evaluationId: record.evaluationId, samplingId: record.samplingId,
      outputStatus: output?.status ?? null, outputError: output?.error ?? null,
      path: structured?.path ?? null, contentHash: structured?.contentHash ?? null, content: structured?.content ?? null,
      rawJson, validation: result, numericObservations,
      artifacts: output?.artifacts ?? [], evidenceRefs: output?.evidenceRefs ?? [], trajectory: output?.trajectory ?? null,
    });
    if (!output) return view(null, validation("unavailable", "no-output"));
    if (!structured) return view(null, validation("unavailable", "no-structured-output"));
    let document: JsonValue;
    try {
      document = parseStrictJson(structured.content) as JsonValue;
    } catch (error) {
      return view(null, validation("invalid", "invalid-json", [documentError("json", error instanceof Error ? error.message : String(error))]));
    }
    const unsafe = unsafeNumber(document, []);
    if (unsafe !== undefined) {
      return view(null, validation("invalid", "unsafe-number", [
        documentError("number", "Number is not finite or exceeds the safe-integer range", unsafe),
      ]));
    }
    if (!compiled) {
      return view(document, compileError === undefined
        ? validation("unavailable", "no-schema")
        : validation("unavailable", "invalid-schema", [documentError("schema", compileError)]));
    }
    if (!compiled.validate(document)) {
      return view(document, validation("invalid", "schema-mismatch", (compiled.validate.errors ?? []).map(schemaError)));
    }
    return view(document, validation("valid", "valid"), isSucceededEvaluation(record) ? extractNumbers(compiled, document) : []);
  };
  return {
    schema: schemaRef,
    declaredFields: compiled ? declaredFields(compiled) : new Map(),
    read(record) {
      const cached = views.get(record.evaluationId);
      if (cached) return cached;
      const view = readOutput(record);
      views.set(record.evaluationId, view);
      return view;
    },
  };
}
