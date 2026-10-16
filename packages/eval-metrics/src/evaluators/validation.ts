import type { JsonValue } from "@eval-platform/eval-contracts";
import { _, type CodeKeywordDefinition, type Name, type SchemaObjCxt, type ValidateFunction } from "ajv";
import type Ajv2020 from "ajv/dist/2020.js";
import { record, type JsonRecord } from "../json.js";

export type ValidationContext = NonNullable<Parameters<ValidateFunction>[1]>;

interface ReferenceSite {
  readonly schema: JsonRecord;
  readonly keyword: string;
  readonly frame: number;
}

/** One invocation, not one schema/path pair: the same reference can run under different bindings. */
export interface SchemaVisit {
  readonly schema: JsonRecord;
  readonly data: JsonValue;
  readonly index: number;
  readonly frame: number;
  readonly reference: boolean;
  readonly baseId: string;
  readonly sources: readonly ReferenceSite[];
  context: ValidationContext;
  end: number;
  valid: boolean;
}

export interface ValidationRun {
  readonly valid: boolean;
  readonly visits: readonly SchemaVisit[];
  find(schema: JsonRecord, parent: SchemaVisit, instance: string): SchemaVisit | undefined;
  reference(schema: JsonRecord, keyword: string, caller: SchemaVisit, instance: string): SchemaVisit | undefined;
}

type VisitIndex = Map<JsonRecord, Map<string, SchemaVisit[]>>;
const instanceKey = (frame: number, instance: string) => frame + ":" + instance;

/** Only Schema positions receive annotations; const/enum/default/example JSON values stay untouched. */
function annotate(schema: JsonValue, keywords: readonly string[]): void {
  const node = record(schema);
  if (!node) return;
  mark(node, keywords, true);
  for (const keyword of ["$defs", "definitions", "properties", "patternProperties", "dependentSchemas"]) {
    for (const child of Object.values(record(node[keyword]) ?? {})) annotate(child, keywords);
  }
  for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    const children = node[keyword];
    if (Array.isArray(children)) children.forEach((child) => annotate(child, keywords));
  }
  for (const keyword of ["additionalProperties", "unevaluatedProperties", "propertyNames", "items", "unevaluatedItems", "contains", "not", "if", "then", "else"]) {
    const child = node[keyword];
    if (child !== undefined) annotate(child, keywords);
  }
  for (const child of Object.values(record(node.dependencies) ?? {})) if (!Array.isArray(child)) annotate(child, keywords);
}

function mark(object: JsonRecord, keywords: readonly string[], enumerable: boolean): void {
  for (const keyword of keywords) Object.defineProperty(object, keyword, { value: true, enumerable, configurable: true });
}

/** Public Ajv keyword hooks record execution without substituting another validator or changing literal JSON. */
export class SchemaValidationTrace {
  readonly #typeValidators = new Map<string, ValidateFunction>();
  readonly #validTypes = new WeakMap<SchemaVisit, boolean>();
  #visits: SchemaVisit[] | undefined;
  #indexed: VisitIndex | undefined;
  #references: VisitIndex | undefined;
  #frames: number[] = [];
  #pending: ReferenceSite[] = [];

  constructor(ajv: Ajv2020, root: JsonRecord, objects: Iterable<JsonRecord>) {
    // Keep presentation annotations visible when Ajv would otherwise collapse a transparent reference alias.
    for (const keyword of ["title", "description"]) {
      ajv.removeKeyword(keyword);
      ajv.addKeyword({ keyword, schemaType: "string", errors: false, validate: () => true });
    }
    for (const [keyword, before] of [["$dynamicRef", "$recursiveAnchor"], ["$ref", "const"]] as const) {
      const definition = ajv.getKeyword(keyword) as CodeKeywordDefinition;
      ajv.removeKeyword(keyword);
      ajv.addKeyword({ ...definition, before, code: (cxt) => {
        const uri = keyword === "$ref" ? ajv.opts.uriResolver.resolve(cxt.it.baseId, cxt.schema as string) : undefined;
        let scalarTarget: boolean | undefined;
        const enter = cxt.gen.scopeValue("func", { ref: () => {
          if (!this.#visits) return undefined;
          if (uri !== undefined) scalarTarget ??= typeof ajv.getSchema(uri)?.schema === "boolean";
          if (scalarTarget) return undefined;
          const site: ReferenceSite = { schema: cxt.parentSchema as JsonRecord, keyword, frame: this.#frames.at(-1)! };
          this.#pending.push(site);
          return site;
        } });
        const leave = cxt.gen.scopeValue("func", { ref: (site: ReferenceSite | undefined) => {
          if (site) this.#pending = this.#pending.filter((pending) => pending !== site);
        } });
        const token = cxt.gen.const("metricReference", _`${enter}()`);
        definition.code(cxt);
        cxt.gen.code(_`${leave}(${token})`);
      } });
    }
    const locations = [...objects];
    const keys = new Set(locations.flatMap((object) => Object.keys(object)));
    let prefix = "x-eval-metrics-trace";
    while (["-start", "-context", "-end"].some((suffix) => keys.has(prefix + suffix))) prefix += "-";
    const [start, context, end] = [prefix + "-start", prefix + "-context", prefix + "-end"];
    const generated = new WeakMap<SchemaObjCxt, { readonly token: Name; readonly errors: Name }>();
    ajv.addKeyword({
      keyword: start!, schemaType: "boolean", before: "$dynamicAnchor", trackErrors: true,
      code: (cxt) => {
        const schema = cxt.parentSchema as JsonRecord;
        const reference = cxt.it.schema === cxt.it.schemaEnv.schema;
        const key = JSON.stringify(schema.type);
        let type = this.#typeValidators.get(key);
        if (schema.type !== undefined && !type) {
          type = ajv.compile({ type: schema.type });
          this.#typeValidators.set(key, type);
        }
        const checkType = type;
        const capture = cxt.gen.scopeValue("func", { ref: (data: JsonValue) => {
          if (!this.#visits) return undefined;
          const index = this.#visits.length;
          const frame = reference ? index : this.#frames.at(-1)!;
          if (reference) this.#frames.push(frame);
          const visit: SchemaVisit = {
            schema, data, index, frame, reference, baseId: cxt.it.baseId, sources: reference ? this.#pending.splice(0) : [], context: {} as ValidationContext,
            end: index, valid: false,
          };
          this.#validTypes.set(visit, checkType === undefined || checkType(data) === true);
          this.#visits.push(visit);
          return visit;
        } });
        generated.set(cxt.it, { token: cxt.gen.const("metricVisit", _`${capture}(${cxt.data})`), errors: cxt.errsCount! });
      },
    });
    ajv.addKeyword({
      keyword: context!, schemaType: "boolean", before: "$dynamicAnchor", errors: false,
      validate: (_flag: unknown, _data: unknown, _schema: unknown, at?: ValidationContext) => {
        const visit = this.#visits?.at(-1);
        if (visit) {
          visit.context = { ...at!, dynamicAnchors: { ...at!.dynamicAnchors } };
          let instances = this.#indexed!.get(visit.schema);
          if (!instances) this.#indexed!.set(visit.schema, instances = new Map());
          const key = instanceKey(visit.frame, at!.instancePath);
          const entries = instances.get(key);
          if (entries) entries.push(visit);
          else instances.set(key, [visit]);
          for (const source of visit.sources) {
            let calls = this.#references!.get(source.schema);
            if (!calls) this.#references!.set(source.schema, calls = new Map());
            const callKey = source.keyword + ":" + instanceKey(source.frame, at!.instancePath);
            const targets = calls.get(callKey);
            if (targets) targets.push(visit);
            else calls.set(callKey, [visit]);
          }
        }
        return true;
      },
    });
    ajv.addKeyword({
      keyword: end!, schemaType: "boolean", post: true, trackErrors: true,
      code: (cxt) => {
        const entry = generated.get(cxt.it)!;
        const finish = cxt.gen.scopeValue("func", { ref: (visit: SchemaVisit | undefined, valid: boolean) => {
          if (!visit) return;
          visit.valid = this.#validTypes.get(visit)! && valid;
          visit.end = this.#visits!.length;
          if (visit.reference) this.#frames.pop();
        } });
        cxt.gen.code(_`${finish}(${entry.token}, ${entry.errors} === ${cxt.errsCount})`);
      },
    });
    const keywords = [start!, context!, end!];
    // An opaque object can also be a referenced Schema. Non-enumerable hooks preserve its literal JSON role.
    for (const object of locations) mark(object, keywords, false);
    // Force hooks at structural Schema positions, including otherwise transparent $ref-only wrappers.
    annotate(root, keywords);
  }

  validate(validator: ValidateFunction, document: JsonValue): ValidationRun {
    this.#visits = [];
    const indexed: VisitIndex = new Map();
    this.#indexed = indexed;
    const references: VisitIndex = new Map();
    this.#references = references;
    this.#frames = [];
    this.#pending = [];
    try {
      const valid = validator(document) === true;
      return {
        valid, visits: this.#visits,
        find: (schema, parent, instance) => indexed.get(schema)?.get(instanceKey(parent.frame, instance))
          ?.find((visit) => visit.index > parent.index && visit.index < parent.end),
        reference: (schema, keyword, caller, instance) => references.get(schema)?.get(keyword + ":" + instanceKey(caller.frame, instance))
          ?.find((visit) => visit.index > caller.index && visit.index < caller.end),
      };
    } finally {
      this.#visits = undefined;
      this.#indexed = undefined;
      this.#references = undefined;
      this.#frames = [];
      this.#pending = [];
    }
  }
}
