import type { JsonValue } from "@eval-platform/eval-contracts";
import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { jsonPointer, pointerToken, record, text, type JsonRecord } from "../json.js";
import { mergeFieldDefinitions, unionKinds, type OutputFacts } from "./fields.js";
import type { OutputFieldDefinition, OutputFieldKind, OutputObservation, OutputScalar, OutputValue } from "./model.js";
import { SchemaValidationTrace, type SchemaVisit, type ValidationContext, type ValidationRun } from "./validation.js";

type Path = readonly string[];
type NumericKind = "number" | "integer";
type Target = PlanNode | boolean;

/** A positive statistical declaration, not an approximation of the values a Schema validates. */
interface Declaration {
  readonly numeric: NumericKind | null;
  readonly values: readonly OutputValue[];
}

interface PlanNode {
  readonly path: Path;
  readonly baseId: string;
  readonly schema: JsonRecord;
  readonly declaration: Declaration;
  readonly properties: ReadonlyMap<string, Target>;
  readonly patterns: readonly { readonly pattern: RegExp; readonly target: Target }[];
  readonly additional: Target | undefined;
  readonly prefix: readonly Target[];
  readonly items: Target | undefined;
  readonly all: readonly Target[];
  readonly alternatives: readonly (readonly Target[])[];
  readonly condition: { readonly predicate: Target; readonly then: Target; readonly else: Target } | null;
  readonly negative: Target | undefined;
}

interface Scope {
  readonly anchors: ReadonlyMap<string, PlanNode>;
  readonly document: JsonValue | undefined;
  readonly instance?: string;
  readonly run?: ValidationRun;
  readonly visit?: SchemaVisit | undefined;
  readonly caller?: SchemaVisit | undefined;
}

interface Location {
  readonly node: PlanNode;
  readonly scope: Scope;
}

/** Guards constrain their own instance; they declare no fields when traversing into children. */
type Rule = boolean
  | { readonly op: "schema"; readonly at: Location }
  | { readonly op: "guard"; readonly at: Location; readonly expected: boolean }
  | { readonly op: "all" | "any"; readonly items: readonly Rule[] };

interface BoundDeclaration {
  readonly declaration: Declaration;
  readonly constraints: Rule;
}

interface ReferenceNeeds {
  readonly references: boolean;
  readonly dynamic: ReadonlySet<string>;
}

const DEFAULT_SCHEMA_ID = "urn:eval-platform:evaluation-output-schema";
const all = (items: readonly Rule[]): Rule => ({ op: "all", items });
const any = (items: readonly Rule[]): Rule => ({ op: "any", items });
const schemaRule = (node: PlanNode, scope: Scope): Rule => ({ op: "schema", at: { node, scope } });
const list = (value: JsonValue | undefined): readonly JsonValue[] => Array.isArray(value) ? value : [];
const scalar = (value: JsonValue | undefined): value is OutputScalar => ["number", "boolean", "string"].includes(typeof value);
const typesOf = (schema: JsonRecord): readonly JsonValue[] | undefined => schema.type === undefined ? undefined
  : Array.isArray(schema.type) ? schema.type : [schema.type];

function declarationOf(schema: JsonRecord): Declaration {
  const types = typesOf(schema) ?? [];
  const values = [
    ...Object.hasOwn(schema, "const") ? [schema.const!] : [], ...list(schema.enum),
    ...types.includes("boolean") ? [true, false] : [], ...types.includes("null") ? [null] : [],
  ].filter((value): value is OutputValue => value === null || scalar(value));
  return {
    numeric: types.includes("number") ? "number" : types.includes("integer") ? "integer" : null,
    values: [...new Set(values)],
  };
}

function locations(rule: Rule): readonly Location[] {
  if (typeof rule === "boolean" || rule.op === "guard") return [];
  return rule.op === "schema" ? [rule.at] : rule.items.flatMap(locations);
}

/** Each declaration keeps the conjunctions surrounding its own alternative. No range is merged to infer eligibility. */
function bindDeclarations(rule: Rule, constraints: readonly Rule[] = []): readonly BoundDeclaration[] {
  if (typeof rule === "boolean" || rule.op === "guard") return [];
  if (rule.op === "schema") {
    const declaration = rule.at.node.declaration;
    return declaration.numeric === null && declaration.values.length === 0 ? [] : [{ declaration, constraints: all([...constraints, rule]) }];
  }
  return rule.items.flatMap((item, index) => bindDeclarations(item, rule.op === "any" ? constraints
    : [...constraints, ...rule.items.filter((_, other) => index !== other)]));
}

function numericLiterals(schema: JsonRecord): readonly number[] | undefined {
  const choices = Object.hasOwn(schema, "const") ? [schema.const!].filter((value) => !Array.isArray(schema.enum) || schema.enum.includes(value))
    : Array.isArray(schema.enum) ? schema.enum : undefined;
  return choices?.filter((value): value is number => typeof value === "number");
}

/** These two projections choose a numeric display kind only. Observation admission always executes the bound constraints. */
function numericTypes(rule: Rule): number {
  if (typeof rule === "boolean") return rule ? 3 : 0;
  if (rule.op === "guard" && !rule.expected) return 3;
  if (rule.op === "schema" || rule.op === "guard") {
    const schema = rule.at.node.schema;
    const types = typesOf(schema);
    const mask = types === undefined || types.includes("number") ? 3 : types.includes("integer") ? 1 : 0;
    const choices = numericLiterals(schema);
    return choices === undefined ? mask : mask & choices.reduce((mask, value) => mask | (Number.isInteger(value) ? 1 : 2), 0);
  }
  return rule.items.reduce((mask, item) => rule.op === "all" ? mask & numericTypes(item) : mask | numericTypes(item), rule.op === "all" ? 3 : 0);
}

function numericChoices(rule: Rule): readonly number[] | undefined {
  if (typeof rule === "boolean") return rule ? undefined : [];
  if (rule.op === "guard" && !rule.expected) return undefined;
  if (rule.op === "schema" || rule.op === "guard") {
    if (numericTypes(rule) === 0) return [];
    return numericLiterals(rule.at.node.schema);
  }
  const choices = rule.items.map(numericChoices);
  if (rule.op === "any") return choices.some((values) => values === undefined) ? undefined : [...new Set(choices.flatMap((values) => values!))];
  const bounded = choices.filter((values) => values !== undefined);
  return bounded.length === 0 ? undefined : bounded[0]!.filter((value) => bounded.every((values) => values.includes(value)));
}

const finiteNumericKind = (values: readonly OutputValue[]): NumericKind | undefined => {
  const numbers = values.filter((value) => typeof value === "number");
  return numbers.length === 0 ? undefined : numbers.some((value) => !Number.isInteger(value)) ? "number" : "integer";
};

/** Keep physical locations even for schemas reached through a reference into an otherwise opaque keyword. */
function indexLocations(value: JsonValue, path: Path, indexed: Map<JsonRecord, Path>): void {
  if (Array.isArray(value)) value.forEach((item, index) => indexLocations(item, [...path, String(index)], indexed));
  else {
    const object = record(value);
    if (!object) return;
    indexed.set(object, path);
    for (const [key, item] of Object.entries(object)) indexLocations(item, [...path, key], indexed);
  }
}

/** Compiled once per Metrics facts snapshot. Registered Ajv validators and their root context serve every plan operation. */
export class CompiledOutputPlan {
  readonly fields: ReadonlyMap<string, OutputFieldDefinition>;
  readonly #ajv = new Ajv2020({ strict: false, allErrors: true, logger: false, inlineRefs: false });
  readonly #validate: ValidateFunction;
  readonly #trace: SchemaValidationTrace;
  readonly #id: string;
  readonly #root: PlanNode;
  readonly #paths = new Map<JsonRecord, Path>();
  readonly #nodes = new Map<JsonRecord, PlanNode>();
  readonly #validators = new Map<PlanNode, ValidateFunction>();
  readonly #references = new Map<string, Target>();
  readonly #needs = new Map<PlanNode, ReferenceNeeds>();

  constructor(schema: JsonRecord) {
    this.#id = (typeof schema.$id === "string" ? this.#ajv.opts.uriResolver.resolve(DEFAULT_SCHEMA_ID, schema.$id) : DEFAULT_SCHEMA_ID).replace(/#$/, "");
    const root = structuredClone({ ...schema, $id: this.#id });
    indexLocations(root, [], this.#paths);
    this.#trace = new SchemaValidationTrace(this.#ajv, root, this.#paths.keys());
    this.#ajv.addSchema(root);
    this.#validate = this.#ajv.getSchema(this.#id)!;
    this.#root = this.#compile(root, [], this.#id) as PlanNode;
    this.#validators.set(this.#root, this.#validate);
    this.fields = this.#catalogue();
  }

  validate(document: JsonValue): ValidationRun {
    return this.#trace.validate(this.#validate, document);
  }

  get errors() { return this.#validate.errors; }

  /** Expand the plan against one valid output. Every scalar is emitted once, with only its matching declaration kinds. */
  observe(document: JsonValue, run: ValidationRun): OutputFacts {
    const fields = new Map<string, OutputFieldDefinition>();
    const observations: OutputObservation[] = [];
    const visit = (location: Rule, value: JsonValue, instance: Path, field: Path): void => {
      const rules = this.#expand(location, value);
      if (value !== null && !scalar(value)) {
        const array = Array.isArray(value);
        const entries: [string, JsonValue][] = array ? value.map((item: JsonValue, index) => [String(index), item]) : Object.entries(value);
        for (const [token, item] of entries) visit(this.#child(rules, token, array), item, [...instance, token], [...field, array ? "*" : token]);
        return;
      }
      const pointer = jsonPointer(field);
      const { definition, observed, kinds } = this.#inspect(rules, pointer, value);
      for (const source of [this.#inspect(this.#expand(location), pointer).definition, definition]) {
        if (source) fields.set(pointer, mergeFieldDefinitions(fields.get(pointer), source));
      }
      if (observed) observations.push({ jsonPointer: jsonPointer(field), instancePointer: jsonPointer(instance), value, kinds });
    };
    visit(schemaRule(this.#root, { anchors: new Map(), document, instance: "", run, visit: run.visits[0] }), document, [], []);
    return { fields, observations };
  }

  #compile(schema: JsonValue, path: Path, baseId: string): Target {
    if (typeof schema === "boolean") return schema;
    const object = record(schema)!;
    const existing = this.#nodes.get(object);
    if (existing) return existing;
    const at = (value: JsonValue, ...tokens: string[]) => {
      const id = record(value)?.$id;
      return this.#compile(value, [...path, ...tokens], typeof id === "string" ? this.#ajv.opts.uriResolver.resolve(baseId, id) : baseId);
    };
    const properties = new Map(Object.entries(record(object.properties) ?? {}).map(([key, value]) => [key, at(value, "properties", key)]));
    const patterns = Object.entries(record(object.patternProperties) ?? {}).map(([key, value]) => ({ pattern: new RegExp(key, "u"), target: at(value, "patternProperties", key) }));
    const prefix = list(object.prefixItems).map((value, index) => at(value, "prefixItems", String(index)));
    const node: PlanNode = {
      path, baseId, schema: object, declaration: declarationOf(object), properties, patterns, prefix,
      additional: object.additionalProperties === undefined ? undefined : at(object.additionalProperties, "additionalProperties"),
      items: object.items === undefined ? undefined : at(object.items, "items"),
      all: list(object.allOf).map((value, index) => at(value, "allOf", String(index))),
      alternatives: ["anyOf", "oneOf"].filter((keyword) => Array.isArray(object[keyword]))
        .map((keyword) => list(object[keyword]).map((value, index) => at(value, keyword, String(index)))),
      condition: object.if === undefined ? null : {
        predicate: at(object.if, "if"), then: object.then === undefined ? true : at(object.then, "then"),
        else: object.else === undefined ? true : at(object.else, "else"),
      },
      negative: object.not === undefined ? undefined : at(object.not, "not"),
    };
    this.#nodes.set(object, node);
    return node;
  }

  #validator(node: PlanNode): ValidateFunction {
    let validator = this.#validators.get(node);
    if (!validator) {
      const fragment = node.path.map((token) => "/" + encodeURIComponent(pointerToken(token))).join("");
      validator = this.#ajv.getSchema(this.#id + "#" + fragment)!;
      this.#validators.set(node, validator);
    }
    return validator;
  }

  #enter(node: PlanNode, scope: Scope): Location {
    if (scope.run) {
      const parent = scope.visit ?? scope.caller;
      const found = parent?.schema === node.schema && parent.context.instancePath === scope.instance ? parent
        : parent && scope.run.find(node.schema, parent, scope.instance!);
      return { node, scope: { ...scope, visit: found, caller: parent } };
    }
    const anchor = node.schema.$dynamicAnchor;
    return { node, scope: typeof anchor === "string" && !scope.anchors.has(anchor)
      ? { ...scope, anchors: new Map([...scope.anchors, [anchor, node]]) } : scope };
  }

  #key(at: Location): string {
    return JSON.stringify([at.node.path, [...at.scope.anchors].map(([name, node]) => [name, node.path])]);
  }

  #referenceNeeds(node: PlanNode): ReferenceNeeds {
    const existing = this.#needs.get(node);
    if (existing) return existing;
    const dynamic = new Set<string>();
    let references = false;
    const visited = new Set<PlanNode>();
    const pending: Target[] = [node];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (typeof current === "boolean" || visited.has(current)) continue;
      visited.add(current);
      const { schema, condition } = current;
      if (typeof schema.$dynamicRef === "string") {
        references = true;
        dynamic.add(decodeURIComponent(schema.$dynamicRef.slice(1)));
      }
      if (typeof schema.$ref === "string") {
        references = true;
        pending.push(this.#reference({ node: current, scope: { anchors: new Map(), document: undefined } }, schema.$ref, false));
      }
      pending.push(...current.all, ...current.alternatives.flat());
      if (condition) pending.push(condition.predicate, condition.then, condition.else);
      if (current.negative !== undefined) pending.push(current.negative);
    }
    const needs = { references, dynamic };
    this.#needs.set(node, needs);
    return needs;
  }

  #unbound(rule: Rule): ReadonlySet<string> {
    const unbound = new Set<string>();
    const visit = (item: Rule): void => {
      if (typeof item === "boolean") return;
      if (item.op !== "schema" && item.op !== "guard") { item.items.forEach(visit); return; }
      const { node, scope } = item.at;
      for (const name of this.#referenceNeeds(node).dynamic) {
        if (node.schema.$dynamicAnchor !== name && !scope.anchors.has(name) && !scope.visit?.context.dynamicAnchors[name]) unbound.add(name);
      }
    };
    visit(rule);
    return unbound;
  }

  #matches(at: Location, value: JsonValue, unbound = this.#unbound(schemaRule(at.node, at.scope))): boolean | undefined {
    if (at.scope.visit && at.scope.visit.data === value) return at.scope.visit.valid;
    // A dynamic binding belongs to an execution, not to the Schema document. Defer its display candidates until known.
    if (unbound.size > 0 && this.#referenceNeeds(at.node).references) return undefined;
    const context: ValidationContext = {
      instancePath: "", parentData: {}, parentDataProperty: "",
      rootData: (at.scope.document ?? value) as ValidationContext["rootData"],
      dynamicAnchors: { ...at.scope.visit?.context.dynamicAnchors ?? Object.fromEntries([...at.scope.anchors].map(([name, node]) => [name, this.#validator(node)])) },
    };
    return this.#validator(at.node)(value, context) === true;
  }

  #matchesRule(rule: Rule, value: JsonValue, unbound = this.#unbound(rule)): boolean | undefined {
    if (typeof rule === "boolean") return rule;
    if (rule.op === "schema") return this.#matches(rule.at, value, unbound);
    if (rule.op === "guard") {
      const matched = this.#matches(rule.at, value, unbound);
      return matched === undefined ? undefined : matched === rule.expected;
    }
    const results = rule.items.map((item) => this.#matchesRule(item, value, unbound));
    const decisive = rule.op === "any";
    return results.includes(decisive) ? decisive : results.includes(undefined) ? undefined : !decisive;
  }

  #reference(at: Location, reference: string, dynamic: boolean): Target {
    if (dynamic && reference.startsWith("#")) {
      const bound = at.scope.anchors.get(decodeURIComponent(reference.slice(1)));
      if (bound) return bound;
    }
    const uri = this.#ajv.opts.uriResolver.resolve(at.node.baseId, reference);
    let target = this.#references.get(uri);
    if (target === undefined) {
      const registered = this.#ajv.getSchema(uri);
      if (!registered) throw new Error("Unresolved output Schema reference: " + uri);
      const schema = registered.schema;
      target = typeof schema === "boolean" ? schema : this.#nodes.get(schema as JsonRecord)
        ?? this.#compile(schema as JsonRecord, this.#paths.get(schema as JsonRecord)!, registered.schemaEnv.baseId);
      this.#references.set(uri, target);
    }
    return target;
  }

  #expand(location: Rule, value?: JsonValue, skip: ReadonlySet<string> = new Set()): Rule {
    const visiting = new Set(skip);
    const visit = (target: Target, scope: Scope): Rule => {
      if (typeof target === "boolean") return target;
      const at = this.#enter(target, scope);
      const key = this.#key(at);
      if (visiting.has(key)) return true;
      visiting.add(key);
      const references = ["$dynamicRef", "$ref"].flatMap((keyword) => {
        if (typeof target.schema[keyword] !== "string") return [];
        const declared = keyword === "$ref" ? this.#reference(at, target.schema[keyword], false) : undefined;
        if (typeof declared === "boolean") return [declared];
        const caller = at.scope.visit ?? at.scope.caller;
        const actual = caller && at.scope.run?.reference(target.schema, keyword, caller, at.scope.instance!);
        if (actual) {
          const node = this.#nodes.get(actual.schema) ?? this.#compile(actual.schema, this.#paths.get(actual.schema)!, actual.baseId) as PlanNode;
          return [visit(node, { ...at.scope, visit: actual })];
        }
        return [visit(declared ?? this.#reference(at, target.schema[keyword], true), at.scope)];
      });
      const alternatives = target.alternatives.map((branches) => any(branches.filter((branch) => value === undefined
        || this.#matchesRule(typeof branch === "boolean" ? branch : schemaRule(branch, this.#enter(branch, at.scope).scope), value)).map((branch) => visit(branch, at.scope))));
      const condition: Rule[] = [];
      if (target.condition) {
        const { predicate, then, else: otherwise } = target.condition;
        const predicateAt = typeof predicate === "boolean" ? predicate : this.#enter(predicate, at.scope);
        const guard = (expected: boolean): Rule => typeof predicateAt === "boolean" ? predicateAt === expected : { op: "guard", at: predicateAt, expected };
        const matched = typeof predicateAt === "boolean" ? predicateAt : value === undefined ? undefined : this.#matches(predicateAt, value);
        const branches = value === undefined ? [true, false] : matched === undefined ? [] : [matched];
        condition.push(any(branches.map((matched) => all([guard(matched), visit(matched ? then : otherwise, at.scope)]))));
      }
      const rules = all([schemaRule(target, at.scope), ...references, ...target.all.map((item) => visit(item, at.scope)), ...alternatives, ...condition]);
      visiting.delete(key);
      return rules;
    };
    const map = (rule: Rule): Rule => {
      if (typeof rule === "boolean" || rule.op === "guard") return rule;
      if (rule.op === "schema") return visit(rule.at.node, rule.at.scope);
      return { op: rule.op, items: rule.items.filter((item) => rule.op !== "any" || value === undefined || this.#matchesRule(item, value)).map(map) };
    };
    return map(location);
  }

  #child(rule: Rule, token: string, array: boolean): Rule {
    if (typeof rule === "boolean") return rule;
    if (rule.op === "guard") return true;
    if (rule.op !== "schema") return { op: rule.op, items: rule.items.map((item) => this.#child(item, token, array)) };
    const { node, scope } = rule.at;
    const asRule = (target: Target): Rule => typeof target === "boolean" ? target : schemaRule(target,
      scope.run ? { ...scope, instance: (scope.instance ?? "") + "/" + pointerToken(token) } : scope);
    if (array) {
      const index = Number(token);
      if (typeof node.schema.maxItems === "number" && index >= node.schema.maxItems) return false;
      return asRule(index < node.prefix.length ? node.prefix[index]! : node.items ?? true);
    }
    const named = node.properties.get(token);
    const patterns = node.patterns.filter(({ pattern }) => pattern.test(token)).map(({ target }) => target);
    return all([...(named === undefined ? [] : [named]), ...patterns,
      ...named === undefined && patterns.length === 0 && node.additional !== undefined ? [node.additional] : [],
    ].map(asRule));
  }

  #numericKind(rule: Rule): NumericKind | undefined {
    const choices = numericChoices(rule);
    if (choices !== undefined) return finiteNumericKind(choices.filter((value) => this.#matchesRule(rule, value)));
    const mask = numericTypes(rule);
    return mask === 0 ? undefined : (mask & 2) !== 0 ? "number" : "integer";
  }

  #inspect(rule: Rule, pointer: string, value?: OutputValue): {
    readonly definition: OutputFieldDefinition | undefined; readonly kinds: readonly OutputFieldKind[]; readonly observed: boolean;
  } {
    const nodes = locations(rule).map(({ node }) => node.schema);
    const title = nodes.map((node) => text(node.title)).find((title) => title !== undefined) ?? (pointer || "$");
    const description = nodes.map((node) => text(node.description)).find((description) => description !== undefined) ?? null;
    let definition: OutputFieldDefinition | undefined;
    let observed = false;
    const observedKinds: (readonly OutputFieldKind[])[] = [];
    for (const { declaration, constraints } of bindDeclarations(rule)) {
      const values = declaration.values.filter((candidate) => this.#matchesRule(constraints, candidate));
      const numeric = declaration.numeric === null ? finiteNumericKind(values) : this.#numericKind(constraints);
      const kinds = unionKinds([
        numeric === undefined ? [] : [numeric], values.some((candidate) => typeof candidate === "boolean") ? ["boolean"] : [],
        values.some((candidate) => typeof candidate === "string" || typeof candidate === "number") ? ["enum"] : [],
      ]);
      if (kinds.length === 0 && !values.includes(null)) continue;
      definition = mergeFieldDefinitions(definition, { jsonPointer: pointer, title, description, kinds, values: values.filter(scalar), nullable: values.includes(null) });
      if (value === undefined || !this.#matchesRule(constraints, value)) continue;
      if (values.includes(value)) {
        observed = true;
        observedKinds.push(value === null ? [] : typeof value === "boolean" ? ["boolean"]
          : typeof value === "number" ? [numeric!, "enum"] : ["enum"]);
      }
      if (declaration.numeric !== null && typeof value === "number" && numeric !== undefined) {
        observed = true;
        observedKinds.push([numeric]);
      }
    }
    return { definition, observed, kinds: unionKinds(observedKinds) };
  }

  #catalogue(): ReadonlyMap<string, OutputFieldDefinition> {
    const fields = new Map<string, OutputFieldDefinition>();
    const walk = (location: Rule, field: Path, active: ReadonlySet<string>): void => {
      const rules = this.#expand(location, undefined, active);
      const at = locations(rules);
      const { definition } = this.#inspect(rules, jsonPointer(field));
      if (definition) fields.set(definition.jsonPointer, mergeFieldDefinitions(fields.get(definition.jsonPointer), definition));
      const next = new Set([...active, ...at.map((location) => this.#key(location))]);
      for (const name of new Set(at.flatMap(({ node }) => [...node.properties.keys()]))) walk(this.#child(rules, name, false), [...field, name], next);
      if (at.some(({ node }) => node.items !== undefined || node.prefix.length > 0)) {
        const prefix = at.reduce((length, { node }) => Math.max(length, node.prefix.length), 0);
        const items = any(Array.from({ length: prefix + 1 }, (_, index) => this.#child(rules, String(index), true)));
        walk(items, [...field, "*"], next);
      }
    };
    walk(schemaRule(this.#root, { anchors: new Map(), document: undefined }), [], new Set());
    return fields;
  }
}
