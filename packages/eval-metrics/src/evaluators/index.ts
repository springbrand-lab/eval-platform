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
  OutputFieldKind,
  OutputFieldShape,
  OutputObservation,
  OutputScalar,
  OutputValue,
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

const KINDS: readonly OutputFieldKind[] = ["number", "integer", "boolean", "enum"];
export const EMPTY_SHAPE: OutputFieldShape = { kinds: [], values: [], nullable: false };

function isOutputScalar(value: JsonValue | undefined): value is OutputScalar {
  return ["string", "number", "boolean"].includes(typeof value);
}

/** Union of two kind lists in canonical order; `number` absorbs `integer`. */
function mergeKinds(left: readonly OutputFieldKind[], right: readonly OutputFieldKind[]): readonly OutputFieldKind[] {
  const kinds = new Set([...left, ...right]);
  if (kinds.has("number")) kinds.delete("integer");
  return KINDS.filter((kind) => kinds.has(kind));
}

/** Union of two shapes; values keep first-declared order. */
export function mergeShapes(left: OutputFieldShape, right: OutputFieldShape): OutputFieldShape {
  return {
    kinds: mergeKinds(left.kinds, right.kinds),
    values: [...new Set([...left.values, ...right.values])],
    nullable: left.nullable || right.nullable,
  };
}

/**
 * Instances a Schema location admits: any value of `types` (`number` includes `integer`) or one of `values`
 * (booleans and null are always listed as values). Undefined declares nothing: the identity of both combinations.
 */
interface Allowed {
  readonly types: ReadonlySet<string>;
  readonly values: readonly OutputValue[];
}

function admits(allowed: Allowed, value: OutputValue): boolean {
  if (allowed.values.includes(value)) return true;
  return typeof value === "number" ? allowed.types.has(Number.isInteger(value) ? "integer" : "number") : typeof value === "string" && allowed.types.has("string");
}

function intersect(left: Allowed | undefined, right: Allowed | undefined): Allowed | undefined {
  if (!left || !right) return left ?? right;
  return {
    types: new Set([...left.types].filter((type) => right.types.has(type))),
    values: [...new Set([...left.values.filter((value) => admits(right, value)), ...right.values.filter((value) => admits(left, value))])],
  };
}

function union(left: Allowed | undefined, right: Allowed | undefined): Allowed | undefined {
  if (!left || !right) return left ?? right;
  return { types: new Set([...left.types, ...right.types]), values: [...new Set([...left.values, ...right.values])] };
}

/** What one Schema node itself declares: its `enum`/`const` and `type` both hold. */
function nodeAllowed(node: JsonRecord): Allowed | undefined {
  const listed = Object.hasOwn(node, "const") || Array.isArray(node.enum)
    ? { types: new Set<string>(), values: [...Object.hasOwn(node, "const") ? [node.const] : [], ...list(node.enum)].filter((value) => value === null || isOutputScalar(value)) }
    : undefined;
  if (node.type === undefined) return listed;
  const types = (Array.isArray(node.type) ? node.type : [node.type]).filter((type) => typeof type === "string");
  const typed: Allowed = {
    types: new Set(types.flatMap((type) => type === "number" ? ["number", "integer"] : type === "boolean" || type === "null" ? [] : [type])),
    values: types.flatMap((type): OutputValue[] => type === "boolean" ? [true, false] : type === "null" ? [null] : []),
  };
  return intersect(listed, typed);
}

function toShape(allowed: Allowed | undefined): OutputFieldShape {
  if (!allowed) return EMPTY_SHAPE;
  const values = allowed.values.filter(isOutputScalar);
  const numbers = values.filter((value) => typeof value === "number");
  const numeric = allowed.types.has("number") || numbers.some((value) => !Number.isInteger(value)) ? "number"
    : allowed.types.has("integer") || numbers.length > 0 ? "integer" : undefined;
  const kinds = KINDS.filter((kind) => kind === numeric
    || (kind === "boolean" && values.some((value) => typeof value === "boolean"))
    || (kind === "enum" && values.some((value) => typeof value !== "boolean")));
  return { kinds, values, nullable: allowed.values.includes(null) };
}

/** Kinds a value counts as under a shape; empty for null and for values the shape does not aggregate. */
function valueKinds(shape: OutputFieldShape, value: OutputValue): readonly OutputFieldKind[] {
  if (value === null) return [];
  const listed = shape.values.includes(value);
  if (typeof value === "number") {
    return shape.kinds.filter((kind) => kind === "number" || kind === "integer" || (kind === "enum" && listed));
  }
  if (typeof value === "boolean") return listed ? ["boolean"] : [];
  return listed ? ["enum"] : [];
}

/** Schema locations combined conjunctively (`all`) or as alternatives (`any`). */
type Tree<T> = { readonly leaf: T } | { readonly op: "all" | "any"; readonly items: readonly Tree<T>[] };

interface SchemaNode {
  readonly path: Path;
  readonly node: JsonRecord;
}

const leaf = <T>(value: T): Tree<T> => ({ leaf: value });
const all = <T>(items: readonly Tree<T>[]): Tree<T> => ({ op: "all", items });
const any = <T>(items: readonly Tree<T>[]): Tree<T> => ({ op: "any", items });

function leaves<T>(tree: Tree<T>): readonly T[] {
  return "leaf" in tree ? [tree.leaf] : tree.items.flatMap(leaves);
}

function fold<T>(tree: Tree<T>, at: (value: T) => Allowed | undefined): Allowed | undefined {
  if ("leaf" in tree) return at(tree.leaf);
  const combine = tree.op === "all" ? intersect : union;
  return tree.items.reduce<Allowed | undefined>((result, item) => combine(result, fold(item, at)), undefined);
}

/** Locations applying to the child `token` of an instance `tree` applies to; for arrays `*` stands for every item. */
function child(tree: Tree<SchemaNode>, token: string, array: boolean): Tree<Path> {
  if (!("leaf" in tree)) return { op: tree.op, items: tree.items.map((item) => child(item, token, array)) };
  const { path, node } = tree.leaf;
  if (array) {
    const prefix = list(node.prefixItems).map((_, index): Path => [...path, "prefixItems", String(index)]);
    const items: Path[] = node.items === undefined ? [] : [[...path, "items"]];
    if (token === "*") return any([...prefix, ...items].map(leaf));
    const index = Number(token);
    return index < prefix.length ? leaf(prefix[index]!) : all(items.map(leaf));
  }
  const named: Path[] = Object.hasOwn(record(node.properties) ?? {}, token) ? [[...path, "properties", token]] : [];
  const patterns = Object.keys(record(node.patternProperties) ?? {})
    .filter((source) => new RegExp(source, "u").test(token)).map((source): Path => [...path, "patternProperties", source]);
  const additional: Path[] = named.length + patterns.length === 0 && node.additionalProperties !== undefined ? [[...path, "additionalProperties"]] : [];
  return all([...named, ...patterns, ...additional].map(leaf));
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

interface Extraction {
  readonly observations: readonly OutputObservation[];
  readonly fields: ReadonlyMap<string, OutputFieldShape>;
}

/**
 * The Project Schema compiled once. A node, its `$ref` target and `allOf` members all hold; `anyOf`/`oneOf`
 * branches and `then`/`else` are alternatives, narrowed to those an instance satisfies when it is known.
 */
class CompiledSchema {
  readonly validate: ValidateFunction;
  readonly #root: JsonRecord;
  readonly #ajv = new Ajv2020({ strict: false, allErrors: true, logger: false });
  readonly #id: string;
  readonly #branches = new Map<string, ValidateFunction>();
  readonly #allowed = new Map<string, Allowed | undefined>();

  constructor(root: JsonRecord) {
    const id = typeof root.$id === "string" && /^[a-z][a-z0-9+.-]*:/i.test(root.$id) ? root.$id.split("#")[0]! : DEFAULT_SCHEMA_ID;
    this.#ajv.addSchema({ ...root, $id: id });
    this.validate = this.#ajv.getSchema(id)!;
    this.#root = root;
    this.#id = id;
  }

  /** Aggregated fields the Schema names, in declaration order; recursive references stop at the cycle. */
  declaredFields(): ReadonlyMap<string, OutputFieldShape> {
    const fields = new Map<string, OutputFieldShape>();
    const walk = (location: Tree<Path>, field: Path, active: ReadonlySet<string>): void => {
      const tree = this.#expand(location, undefined, active);
      const nodes = leaves(tree);
      const shape = this.#shape(location);
      if (shape.kinds.length > 0) fields.set(jsonPointer(field), shape);
      const next = new Set([...active, ...nodes.map(({ path }) => jsonPointer(path))]);
      for (const name of new Set(nodes.flatMap(({ node }) => Object.keys(record(node.properties) ?? {})))) {
        walk(child(tree, name, false), [...field, name], next);
      }
      if (nodes.some(({ node }) => node.items !== undefined || Array.isArray(node.prefixItems))) walk(child(tree, "*", true), [...field, "*"], next);
    };
    walk(leaf([]), [], new Set());
    return fields;
  }

  /** Aggregated scalars of a valid document and the shapes of the field locations they reached, in document order. */
  extract(document: JsonValue): Extraction {
    const observations: OutputObservation[] = [];
    const fields = new Map<string, OutputFieldShape>();
    const visit = (location: Tree<Path>, value: JsonValue, instance: Path, field: Path): void => {
      if (value !== null && !isOutputScalar(value)) {
        const tree = this.#expand(location, value);
        const array = Array.isArray(value);
        const entries: [string, JsonValue][] = array ? value.map((item: JsonValue, index: number) => [String(index), item]) : Object.entries(value);
        for (const [token, item] of entries) visit(child(tree, token, array), item, [...instance, token], [...field, array ? "*" : token]);
        return;
      }
      const shape = this.#shape(location);
      if (shape.kinds.length === 0) return;
      const pointer = jsonPointer(field);
      fields.set(pointer, mergeShapes(fields.get(pointer) ?? EMPTY_SHAPE, shape));
      const kinds = valueKinds(shape, value);
      if (kinds.length > 0 || (value === null && shape.nullable)) {
        observations.push({ jsonPointer: pointer, instancePointer: jsonPointer(instance), kinds, value });
      }
    };
    visit(leaf([]), document, [], []);
    return { observations, fields };
  }

  #node(path: Path): JsonRecord | undefined {
    let current: JsonValue | undefined = this.#root;
    for (const token of path) current = Array.isArray(current) ? current[Number(token)] : record(current)?.[token];
    return record(current);
  }

  /** Whether the value satisfies the sub-schema at `path`, resolved in the context of the root. */
  #matches(path: Path, value: JsonValue): boolean {
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
   * Nodes applying to the instance at `location`: each node first, then `$ref`, `allOf`, `anyOf`, `oneOf` and
   * `then`/`else` in that order. With a value only the alternatives it satisfies; `skip` and cycles apply nothing.
   */
  #expand(location: Tree<Path>, value?: JsonValue, skip: ReadonlySet<string> = new Set()): Tree<SchemaNode> {
    const visiting = new Set(skip);
    const visit = (path: Path): Tree<SchemaNode> => {
      const node = this.#node(path);
      const key = jsonPointer(path);
      if (!node || visiting.has(key)) return all([]);
      visiting.add(key);
      const at = (...tokens: string[]): Path => [...path, ...tokens];
      const target = typeof node.$ref === "string" ? this.#resolveRef(node.$ref) : undefined;
      const branches = (keyword: string) => list(node[keyword]).map((_, index) => at(keyword, String(index)));
      const alternatives = (paths: readonly Path[]) => any(paths.filter((branch) => value === undefined || this.#matches(branch, value)).map(visit));
      const conditional = node.if === undefined ? [] : value === undefined ? ["then", "else"] : [this.#matches(at("if"), value) ? "then" : "else"];
      const tree = all([
        leaf({ path, node }), ...target ? [visit(target)] : [], ...branches("allOf").map(visit),
        ...["anyOf", "oneOf"].filter((keyword) => Array.isArray(node[keyword])).map((keyword) => alternatives(branches(keyword))),
        any(conditional.filter((keyword) => node[keyword] !== undefined).map((keyword) => visit(at(keyword)))),
      ]);
      visiting.delete(key);
      return tree;
    };
    const map = (tree: Tree<Path>): Tree<SchemaNode> => "leaf" in tree ? visit(tree.leaf) : { op: tree.op, items: tree.items.map(map) };
    return map(location);
  }

  #allowedAt(path: Path): Allowed | undefined {
    const key = jsonPointer(path);
    if (!this.#allowed.has(key)) this.#allowed.set(key, fold(this.#expand(leaf(path)), ({ node }) => nodeAllowed(node)));
    return this.#allowed.get(key);
  }

  /** What the Schema lets the instance at `location` hold, whatever alternatives it took. */
  #shape(location: Tree<Path>): OutputFieldShape {
    return toShape(fold(location, (path) => this.#allowedAt(path)));
  }
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

/** Only a succeeded Evaluator with a succeeded output can contribute observations. */
export function isSucceededEvaluation(record: EvaluationRecord): boolean {
  return record.status.status === "succeeded" && record.output?.status === "succeeded";
}

export interface EvaluationOutputReader {
  readonly schema: EvaluationOutputSchemaRef | null;
  /** Aggregated fields the Schema names, in declaration order. */
  readonly declaredFields: ReadonlyMap<string, OutputFieldShape>;
  read(record: EvaluationRecord): EvaluationOutputView;
  /** Shapes of the aggregated field locations the record's output reached, in document order. */
  reachedFields(record: EvaluationRecord): ReadonlyMap<string, OutputFieldShape>;
}

const NOTHING: Extraction = { observations: [], fields: new Map() };

interface OutputRead {
  readonly view: EvaluationOutputView;
  readonly fields: Extraction["fields"];
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
  const reads = new Map<string, OutputRead>();
  const readOutput = (record: EvaluationRecord): OutputRead => {
    const output = record.output;
    const structured = output?.structuredOutput;
    const view = (rawJson: JsonValue | null, result: EvaluationValidation, extraction = NOTHING): OutputRead => ({
      view: {
        evaluationId: record.evaluationId, samplingId: record.samplingId,
        outputStatus: output?.status ?? null, outputError: output?.error ?? null,
        path: structured?.path ?? null, contentHash: structured?.contentHash ?? null, content: structured?.content ?? null,
        rawJson, validation: result, observations: extraction.observations,
        artifacts: output?.artifacts ?? [], evidenceRefs: output?.evidenceRefs ?? [], trajectory: output?.trajectory ?? null,
      },
      fields: extraction.fields,
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
    return view(document, validation("valid", "valid"), isSucceededEvaluation(record) ? compiled.extract(document) : NOTHING);
  };
  const cachedRead = (record: EvaluationRecord): OutputRead => {
    let cached = reads.get(record.evaluationId);
    if (!cached) {
      cached = readOutput(record);
      reads.set(record.evaluationId, cached);
    }
    return cached;
  };
  return {
    schema: schemaRef,
    declaredFields: compiled?.declaredFields() ?? new Map(),
    read: (record) => cachedRead(record).view,
    reachedFields: (record) => cachedRead(record).fields,
  };
}
