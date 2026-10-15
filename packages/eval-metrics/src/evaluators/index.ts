import type {
  EvaluationOutputSchema,
  EvaluationOutputSchemaRef,
  EvaluationRecord,
  JsonValue,
} from "@eval-platform/eval-contracts";
import { parseStrictJson } from "@eval-platform/eval-dataset";
import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { record, type JsonRecord } from "../json.js";
import type {
  EvaluationOutputView,
  EvaluationValidation,
  EvaluationValidationError,
  NumericObservation,
  NumericSchemaType,
} from "./model.js";

type Path = readonly string[];

const DEFAULT_SCHEMA_ID = "urn:eval-platform:evaluation-output-schema";

function list(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? value : [];
}

/** RFC 6901 reference token: `~` → `~0`, `/` → `~1`. */
function pointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

function jsonPointer(tokens: Path): string {
  return tokens.map((token) => `/${pointerToken(token)}`).join("");
}

function numericType(type: JsonValue | undefined): NumericSchemaType | undefined {
  const types = Array.isArray(type) ? type : [type];
  return types.includes("number") ? "number" : types.includes("integer") ? "integer" : undefined;
}

function mergeType(left: NumericSchemaType | undefined, right: NumericSchemaType): NumericSchemaType {
  return left === "number" || right === "number" ? "number" : "integer";
}

/** First number JSON cannot carry exactly: non-finite or an integer outside the safe range. */
function unsafeNumber(value: JsonValue, path: Path): string | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)) ? undefined : jsonPointer(path);
  }
  const entries: [string, JsonValue][] = Array.isArray(value)
    ? value.map((item: JsonValue, index: number) => [String(index), item])
    : Object.entries(record(value) ?? {});
  for (const [key, item] of entries) {
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
  readonly #branches = new Map<string, ValidateFunction>();

  constructor(readonly root: JsonRecord) {
    const id = typeof root.$id === "string" && /^[a-z][a-z0-9+.-]*:/i.test(root.$id) ? root.$id.split("#")[0]! : DEFAULT_SCHEMA_ID;
    this.#ajv.addSchema({ ...root, $id: id });
    this.validate = this.#ajv.getSchema(id)!;
    this.#id = id;
  }

  node(path: Path): JsonRecord | undefined {
    let current: JsonValue | undefined = this.root;
    for (const token of path) current = Array.isArray(current) ? current[Number(token)] : record(current)?.[token];
    return record(current);
  }

  /** Whether the value satisfies the sub-schema at `path`, resolved in the context of the root. */
  matches(path: Path, value: JsonValue): boolean {
    const fragment = path.map((token) => `/${encodeURIComponent(pointerToken(token))}`).join("");
    let validate = this.#branches.get(fragment);
    if (!validate) {
      validate = this.#ajv.compile({ $ref: `${this.#id}#${fragment}` });
      this.#branches.set(fragment, validate);
    }
    return validate(value) === true;
  }

  /** Target path of a JSON Pointer `$ref` into this document; undefined for anchors and other documents. */
  #resolveRef(ref: string): Path | undefined {
    const hash = ref.indexOf("#");
    const base = hash < 0 ? ref : ref.slice(0, hash);
    if (base !== "" && base !== this.#id) return undefined;
    const fragment = hash < 0 ? "" : decodeURIComponent(ref.slice(hash + 1));
    if (fragment === "") return [];
    if (!fragment.startsWith("/")) return undefined;
    return fragment.slice(1).split("/").map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  }

  /**
   * Sub-schemas applying to the same instance as the node at `path`. With a value only the
   * `anyOf`/`oneOf`/`if` branches that value satisfies; without one every branch.
   */
  applied(path: Path, node: JsonRecord, value?: JsonValue): readonly Path[] {
    const at = (...tokens: string[]): Path => [...path, ...tokens];
    const target = typeof node.$ref === "string" ? this.#resolveRef(node.$ref) : undefined;
    const branches = (keyword: string) => list(node[keyword]).map((_, index) => at(keyword, String(index)));
    const selected = (keyword: string) => branches(keyword).filter((branch) => value === undefined || this.matches(branch, value));
    const conditional = node.if === undefined ? [] : value === undefined ? ["then", "else"] : [this.matches(at("if"), value) ? "then" : "else"];
    return [
      ...target ? [target] : [], ...branches("allOf"), ...selected("anyOf"), ...selected("oneOf"),
      ...conditional.filter((keyword) => node[keyword] !== undefined).map((keyword) => at(keyword)),
    ];
  }
}

/** Numeric fields the Schema can declare, by field pointer; recursive references stop at the cycle. */
function declaredFields(schema: CompiledSchema): ReadonlyMap<string, NumericSchemaType> {
  const fields = new Map<string, NumericSchemaType>();
  const walk = (path: Path, field: Path, active: ReadonlySet<string>): void => {
    const node = schema.node(path);
    const key = jsonPointer(path);
    if (!node || active.has(key)) return;
    const next = new Set(active).add(key);
    for (const applied of schema.applied(path, node)) walk(applied, field, next);
    const type = numericType(node.type);
    if (type) fields.set(jsonPointer(field), mergeType(fields.get(jsonPointer(field)), type));
    for (const name of Object.keys(record(node.properties) ?? {})) walk([...path, "properties", name], [...field, name], next);
    list(node.prefixItems).forEach((_, index) => walk([...path, "prefixItems", String(index)], [...field, "*"], next));
    if (node.items !== undefined) walk([...path, "items"], [...field, "*"], next);
  };
  walk([], [], new Set());
  return fields;
}

/** Child instances of `value` with the sub-schemas that apply to each and their instance tokens. */
function children(path: Path, node: JsonRecord, value: JsonValue): readonly (readonly [Path, string, JsonValue])[] {
  if (Array.isArray(value)) {
    const prefix = list(node.prefixItems).length;
    return value.flatMap((item: JsonValue, index: number) => {
      const itemPath = index < prefix ? [...path, "prefixItems", String(index)] : node.items === undefined ? undefined : [...path, "items"];
      return itemPath ? [[itemPath, String(index), item] as const] : [];
    });
  }
  const properties = record(node.properties) ?? {};
  const patterns = Object.keys(record(node.patternProperties) ?? {});
  return Object.entries(record(value) ?? {}).flatMap(([name, item]) => {
    const paths = [
      ...Object.hasOwn(properties, name) ? [[...path, "properties", name]] : [],
      ...patterns.filter((source) => new RegExp(source, "u").test(name)).map((source) => [...path, "patternProperties", source]),
    ];
    if (paths.length === 0 && node.additionalProperties !== undefined) paths.push([...path, "additionalProperties"]);
    return paths.map((childPath) => [childPath, name, item] as const);
  });
}

/** Numbers in a valid output whose applicable Schema node declares number or integer. */
function extractNumbers(schema: CompiledSchema, document: JsonValue): readonly NumericObservation[] {
  const found = new Map<string, NumericObservation>();
  const visited = new Set<string>();
  const visit = (path: Path, value: JsonValue, instance: Path, field: Path): void => {
    const node = schema.node(path);
    const key = JSON.stringify([path, instance]);
    if (!node || visited.has(key)) return;
    visited.add(key);
    for (const applied of schema.applied(path, node, value)) visit(applied, value, instance, field);
    const type = numericType(node.type);
    if (type && typeof value === "number") {
      const instancePointer = jsonPointer(instance);
      const schemaType = mergeType(found.get(instancePointer)?.schemaType, type);
      found.set(instancePointer, { jsonPointer: jsonPointer(field), instancePointer, schemaType, value });
    }
    for (const [childPath, token, item] of children(path, node, value)) {
      visit(childPath, item, [...instance, token], [...field, Array.isArray(value) ? "*" : token]);
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
      compileError = (error as Error).message;
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
      return view(null, validation("invalid", "invalid-json", [documentError("json", (error as SyntaxError).message)]));
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
