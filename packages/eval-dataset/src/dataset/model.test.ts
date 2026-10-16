import { describe, expect, it } from "vitest";
import {
  dataInputSchema,
  datasetDocumentSchema,
  datasetInputSchema,
  datasetSnapshotSchema,
  initialMaterialsRefSchema,
  initialSessionRefSchema,
} from "./model.js";

describe("Dataset inputs", () => {
  it("keeps JSON, Session references and material references independent", () => {
    const input = {
      userPrompt: "Build the homepage",
      json: { task: "build homepage", requirements: ["responsive", true, null, 3] },
      initialSession: { bundleId: "401c23cf-d812-43f4-8404-d76e22cb0a66", sessionId: "a2047fbe-4917-4658-81ca-68f82ebe6071" },
      initialMaterials: [{ bundleId: "b80ca540-c5c3-47c5-854f-bf083d4afdb0", materialId: "01b65fa2-88f6-4c99-8bb6-245fea0588af" }],
      metadata: { source: "internal", labels: ["web"] },
    };
    const parsed = dataInputSchema.parse(input);
    expect(parsed).toEqual(input);
    input.json.requirements.push("changed");
    input.initialSession.sessionId = "changed";
    expect(parsed.json).toEqual({ task: "build homepage", requirements: ["responsive", true, null, 3] });
    expect(parsed.initialSession).toEqual({ bundleId: "401c23cf-d812-43f4-8404-d76e22cb0a66", sessionId: "a2047fbe-4917-4658-81ca-68f82ebe6071" });
  });

  it("preserves the external Bundle and concrete material identity", () => {
    expect(dataInputSchema.parse({
      userPrompt: "Build the homepage",
      json: null,
      initialMaterials: [{
        bundleId: "b80ca540-c5c3-47c5-854f-bf083d4afdb0",
        materialId: "01b65fa2-88f6-4c99-8bb6-245fea0588af",
      }],
    })).toEqual({
      userPrompt: "Build the homepage",
      json: null,
      initialMaterials: [{
        bundleId: "b80ca540-c5c3-47c5-854f-bf083d4afdb0",
        materialId: "01b65fa2-88f6-4c99-8bb6-245fea0588af",
      }],
    });
  });

  it.each([null, false, 3, "task", ["task", 2], { task: "build" }])(
    "accepts an additional JSON business value: %j",
    (json) => expect(dataInputSchema.parse({ userPrompt: "task", json }).json).toEqual(json),
  );

  it.each([
    undefined,
    NaN,
    Infinity,
    1n,
    new Date(),
    new Map([["key", "value"]]),
    new Uint8Array([1]),
    () => "task",
    { missing: undefined },
    [undefined],
    { toJSON: () => "converted" },
  ])("rejects non-JSON business values: %s", (json) => {
    expect(dataInputSchema.safeParse({ userPrompt: "task", json }).success).toBe(false);
  });

  it("rejects cycles and sparse arrays without recursive validation overflow", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(dataInputSchema.safeParse({ userPrompt: "task", json: cyclic }).success).toBe(false);
    expect(dataInputSchema.safeParse({ userPrompt: "task", json: new Array(2) }).success).toBe(false);
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1, 1e100, -1e100])(
    "rejects unsafe integers at every nesting level: %s",
    (value) => {
      expect(dataInputSchema.safeParse({ userPrompt: "task", externalDataId: value }).success).toBe(false);
      expect(dataInputSchema.safeParse({ userPrompt: "task", expectedOutput: { records: [{ id: value }] } }).success)
        .toBe(false);
    },
  );

  it.each([Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 0, 0.1, 3.25, 1e-7])(
    "preserves safe integers and finite fractional numbers: %s",
    (value) => expect(dataInputSchema.parse({ userPrompt: "task", value }).value).toBe(value),
  );

  it("preserves all JSON keys without prototype pollution or silent stripping", () => {
    const json: unknown = JSON.parse('{"__proto__":{"enabled":true},"constructor":"task"}');
    const parsed = dataInputSchema.parse({ userPrompt: "task", json, metadata: json });
    expect(parsed.json).toEqual(json);
    expect(parsed.metadata).toEqual(json);
    expect(Object.prototype).not.toHaveProperty("enabled");
    expect(dataInputSchema.safeParse({
      userPrompt: "task",
      json: JSON.parse('{"__proto__":{"unsupported":null}}', (key, value: unknown) => (
        key === "unsupported" ? Infinity : value
      )),
    }).success).toBe(false);
  });

  it.each([
    {},
    [],
    { name: " " },
    { name: "tasks", ownerUserId: "user" },
    { name: "tasks", version: 1 },
    { name: "tasks", datasetId: crypto.randomUUID() },
  ])("rejects invalid or foreign Dataset fields: %j", (input) => {
    expect(datasetInputSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    [],
    {},
    { dataId: crypto.randomUUID(), userPrompt: "task" },
    { userPrompt: "task", initialMaterials: [{ bundleId: " " }] },
  ])("rejects invalid Data input: %j", (input) => {
    expect(dataInputSchema.safeParse(input).success).toBe(false);
  });
});

describe("Current user prompt and extension fields", () => {
  it("accepts a standalone prompt without Session, materials or a JSON container", () => {
    expect(dataInputSchema.parse({ userPrompt: "Start a new project" }))
      .toEqual({ userPrompt: "Start a new project" });
  });

  it("preserves the prompt exactly and retains arbitrary business fields", () => {
    const input = {
      userPrompt: "  Continue the project\nKeep the current layout.  ",
      evalPrompt: "  Check the resulting page against the requirements.  ",
      requirements: ["responsive", "accessible"],
      expectedOutput: { files: ["src/index.ts"] },
      referenceText: "design notes",
      customFlag: false,
      priority: 3,
      optionalValue: null,
      metadata: ["custom", 123],
      externalDataId: 123,
    };
    expect(dataInputSchema.parse(input)).toEqual(input);
  });

  it.each(["", " \n\t", null, 123, ["judge"]])("rejects invalid evaluation prompts: %j", (evalPrompt) => {
    expect(dataInputSchema.safeParse({ userPrompt: "task", evalPrompt }).success).toBe(false);
  });

  it("keeps evaluator materials separate from Subject materials", () => {
    const data = dataInputSchema.parse({ userPrompt: "Build", evalPrompt: "Judge",
      initialMaterials: [{ bundleId: "335ce16b-3fe4-4346-8c3a-f2a4efce2ef0", materialId: "57c8ddb0-90f6-45c0-85c9-19758bfb53af" }],
      evalInitialMaterials: [{ bundleId: "b49b3f03-2a47-4314-8c98-03ac96738979", materialId: "56230a91-7786-4fe6-8eb0-83b53fac7bcd" }] });
    expect(data.evalInitialMaterials).toEqual([{ bundleId: "b49b3f03-2a47-4314-8c98-03ac96738979", materialId: "56230a91-7786-4fe6-8eb0-83b53fac7bcd" }]);
    expect(data.initialMaterials).toEqual([{ bundleId: "335ce16b-3fe4-4346-8c3a-f2a4efce2ef0", materialId: "57c8ddb0-90f6-45c0-85c9-19758bfb53af" }]);
    expect(dataInputSchema.safeParse({ userPrompt: "Build",
      evalInitialMaterials: [{ bundleId: "b49b3f03-2a47-4314-8c98-03ac96738979" }] }).success).toBe(false);
  });

  it("preserves extension keys that object-schema parsers commonly strip", () => {
    const input: unknown = JSON.parse('{"userPrompt":"task","__proto__":{"label":"custom"},"constructor":"custom"}');
    expect(dataInputSchema.parse(input)).toEqual(input);
    expect(Object.prototype).not.toHaveProperty("label");
  });

  it.each(["source-sample-42", 42, { source: "external", id: 42 }, ["first", "second"]])(
    "preserves sampleId as an arbitrary JSON business field: %j",
    (sampleId) => expect(dataInputSchema.parse({ userPrompt: "task", sampleId }))
      .toEqual({ userPrompt: "task", sampleId }),
  );

  it.each([
    {},
    { json: "task" },
    { userPrompt: "" },
    { userPrompt: " \n\t" },
    { userPrompt: null },
    { userPrompt: 123 },
    { userPrompt: ["task"] },
    { userPrompt: { content: "task" } },
  ])("rejects absent, blank or non-string user prompts: %j", (input) => {
    expect(dataInputSchema.safeParse(input).success).toBe(false);
  });
});

describe("InitialSessionRef", () => {
  it("keeps only the independent initialization resource identity", () => {
    const reference = { bundleId: "401c23cf-d812-43f4-8404-d76e22cb0a66", sessionId: "a2047fbe-4917-4658-81ca-68f82ebe6071" };
    expect(initialSessionRefSchema.parse(reference)).toEqual(reference);
    expect(dataInputSchema.parse({ userPrompt: "Continue the project", initialSession: reference }))
      .toEqual({ userPrompt: "Continue the project", initialSession: reference });
  });

  it("allows task input without an initial Session", () => {
    expect(dataInputSchema.parse({ userPrompt: "Start a new project" }))
      .toEqual({ userPrompt: "Start a new project" });
  });

  it.each([
    null,
    123,
    true,
    {},
    [],
    "session-seed",
    { bundleId: "401c23cf-d812-43f4-8404-d76e22cb0a66" },
    { sessionId: "a2047fbe-4917-4658-81ca-68f82ebe6071" },
    { sessionId: "" },
    { sessionId: " " },
    { sessionId: 123 },
    { bundleId: "", sessionId: "a2047fbe-4917-4658-81ca-68f82ebe6071" },
    { bundleId: "401c23cf-d812-43f4-8404-d76e22cb0a66", sessionId: "" },
    { bundleId: "401c23cf-d812-43f4-8404-d76e22cb0a66", sessionId: " session-seed " },
    { bundleId: " sessions-bundle ", sessionId: "a2047fbe-4917-4658-81ca-68f82ebe6071" },
    { bundleId: "sessions-bundle", sessionId: "a2047fbe-4917-4658-81ca-68f82ebe6071" },
    { bundleId: "401c23cf-d812-43f4-8404-d76e22cb0a66", sessionId: "a2047fbe-4917-4658-81ca-68f82ebe6071", extra: 1 },
  ])("rejects invalid Session references: %j", (initialSession) => {
    expect(initialSessionRefSchema.safeParse(initialSession).success).toBe(false);
    expect(dataInputSchema.safeParse({ userPrompt: "task", initialSession }).success).toBe(false);
  });
});

describe("InitialMaterialsRef", () => {
  it.each([
    null,
    [],
    {},
    "homepage-files",
    { bundleId: "b80ca540-c5c3-47c5-854f-bf083d4afdb0" },
    { materialId: "01b65fa2-88f6-4c99-8bb6-245fea0588af" },
    { bundleId: "", materialId: "01b65fa2-88f6-4c99-8bb6-245fea0588af" },
    { bundleId: "b80ca540-c5c3-47c5-854f-bf083d4afdb0", materialId: " " },
    { bundleId: "b80ca540-c5c3-47c5-854f-bf083d4afdb0", materialId: 123 },
    { bundleId: "b80ca540-c5c3-47c5-854f-bf083d4afdb0", materialId: " homepage-files " },
    { bundleId: " project-assets ", materialId: "01b65fa2-88f6-4c99-8bb6-245fea0588af" },
    { bundleId: "b80ca540-c5c3-47c5-854f-bf083d4afdb0", materialId: "homepage-files" },
    { bundleId: "b80ca540-c5c3-47c5-854f-bf083d4afdb0", materialId: "01b65fa2-88f6-4c99-8bb6-245fea0588af", extra: 1 },
  ])("rejects invalid material references: %j", (reference) => {
    expect(initialMaterialsRefSchema.safeParse(reference).success).toBe(false);
    expect(dataInputSchema.safeParse({ userPrompt: "task", initialMaterials: [reference] }).success).toBe(false);
  });

  const first = { bundleId: "b80ca540-c5c3-47c5-854f-bf083d4afdb0", materialId: "01b65fa2-88f6-4c99-8bb6-245fea0588af" };
  const second = { bundleId: "a3b1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d", materialId: "c9d8e7f6-a5b4-4c3d-9e2f-1a0b9c8d7e6f" };

  it.each(["initialMaterials", "evalInitialMaterials"])("requires %s to be a non-empty list", (field) => {
    expect(dataInputSchema.safeParse({ userPrompt: "task", [field]: [] }).success).toBe(false);
    expect(dataInputSchema.safeParse({ userPrompt: "task", [field]: first }).success).toBe(false);
  });

  it.each(["initialMaterials", "evalInitialMaterials"])("rejects a Material listed twice in %s at its index", (field) => {
    const parsed = dataInputSchema.safeParse({ userPrompt: "task",
      [field]: [first, second, { bundleId: first.bundleId.toUpperCase(), materialId: first.materialId }] });
    expect(parsed.error?.issues).toEqual([expect.objectContaining({ path: [field, 2] })]);
  });

  it("keeps material order and accepts Materials of different Bundles in one field", () => {
    expect(dataInputSchema.parse({ userPrompt: "task", initialMaterials: [second, first] }).initialMaterials)
      .toEqual([second, first]);
  });

  it("accepts only a single Session reference", () => {
    const session = { bundleId: first.bundleId, sessionId: first.materialId };
    expect(dataInputSchema.safeParse({ userPrompt: "task", initialSession: [session] }).success).toBe(false);
  });
});

describe("Dataset documents", () => {
  it("canonicalizes platform UUIDs before duplicate detection without changing business IDs", () => {
    const datasetId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const dataId = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
    const bundleId = "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC";
    const sessionId = "DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD";
    const document = datasetDocumentSchema.parse({
      dataset: { datasetId, name: "tasks" },
      data: [{ dataId, userPrompt: "task", sampleId: "BUSINESS-ID", initialSession: { bundleId, sessionId } }],
    });
    expect(document.dataset.datasetId).toBe(datasetId.toLowerCase());
    expect(document.data[0]).toMatchObject({
      dataId: dataId.toLowerCase(), sampleId: "BUSINESS-ID",
      initialSession: { bundleId: bundleId.toLowerCase(), sessionId: sessionId.toLowerCase() },
    });
    expect(datasetSnapshotSchema.parse(document)).toEqual(document);

    const duplicate = datasetDocumentSchema.safeParse({
      dataset: { name: "tasks" },
      data: [{ dataId, userPrompt: "first" }, { dataId: dataId.toLowerCase(), userPrompt: "second" }],
    });
    expect(duplicate.success).toBe(false);
    if (!duplicate.success) {
      expect(duplicate.error.issues).toContainEqual(expect.objectContaining({ path: ["data", 1, "dataId"] }));
    }
  });

  it("leaves absent IDs absent until import admission", () => {
    expect(datasetDocumentSchema.parse({ dataset: { name: "tasks" }, data: [{ userPrompt: "task" }] }))
      .toEqual({ dataset: { name: "tasks" }, data: [{ userPrompt: "task" }] });
    expect(datasetSnapshotSchema.safeParse({ dataset: { name: "tasks" }, data: [{ userPrompt: "task" }] }).success)
      .toBe(false);
  });

  it("rejects duplicate Data identities with a field-specific issue", () => {
    const dataId = crypto.randomUUID();
    const result = datasetDocumentSchema.safeParse({
      dataset: { name: "tasks" },
      data: [{ dataId, userPrompt: "first" }, { dataId, userPrompt: "second" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ["data", 1, "dataId"] }));
    }
  });
});
