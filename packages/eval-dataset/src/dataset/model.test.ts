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
      initialSession: { bundleId: "sessions-bundle", sessionId: "session-seed" },
      initialMaterials: { bundleId: "project-assets", materialId: "homepage-files" },
      metadata: { source: "internal", labels: ["web"] },
    };
    const parsed = dataInputSchema.parse(input);
    expect(parsed).toEqual(input);
    input.json.requirements.push("changed");
    input.initialSession.sessionId = "changed";
    expect(parsed.json).toEqual({ task: "build homepage", requirements: ["responsive", true, null, 3] });
    expect(parsed.initialSession).toEqual({ bundleId: "sessions-bundle", sessionId: "session-seed" });
  });

  it("preserves the external Bundle and concrete material identity", () => {
    expect(dataInputSchema.parse({
      userPrompt: "Build the homepage",
      json: null,
      initialMaterials: {
        bundleId: "project-assets",
        materialId: "homepage-files",
      },
    })).toEqual({
      userPrompt: "Build the homepage",
      json: null,
      initialMaterials: {
        bundleId: "project-assets",
        materialId: "homepage-files",
      },
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
    { userPrompt: "task", initialMaterials: { kind: "file-bundle", bundleId: " " } },
    { userPrompt: "task", initialMaterials: { kind: "generated", generatorId: "fixture", parameters: [] } },
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
    const reference = { bundleId: "sessions-bundle", sessionId: "session-seed" };
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
    { bundleId: "sessions-bundle" },
    { sessionId: "session-seed" },
    { sessionId: "" },
    { sessionId: " " },
    { sessionId: 123 },
    { bundleId: "", sessionId: "session-seed" },
    { bundleId: "sessions-bundle", sessionId: "" },
    { bundleId: "sessions-bundle", sessionId: " session-seed " },
    { bundleId: " sessions-bundle ", sessionId: "session-seed" },
    { bundleId: "sessions-bundle", sessionId: "session-seed", version: 1 },
    { bundleId: "sessions-bundle", sessionId: "session-seed", content: "inline history" },
    { bundleId: "sessions-bundle", sessionId: "session-seed", entries: [{ role: "user", content: "task" }] },
    { submissionId: "source-chat" },
    { messages: [{ role: "user", content: "task" }] },
    { conversations: [{ role: "user", content: "task" }] },
    [{ role: "user", content: "task" }],
  ])("rejects inline Session bodies and invalid references: %j", (initialSession) => {
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
    { bundleId: "project-assets" },
    { materialId: "homepage-files" },
    { bundleId: "", materialId: "homepage-files" },
    { bundleId: "project-assets", materialId: " " },
    { bundleId: "project-assets", materialId: 123 },
    { bundleId: "project-assets", materialId: " homepage-files " },
    { bundleId: " project-assets ", materialId: "homepage-files" },
    { bundleId: "project-assets", materialId: "homepage-files", files: ["inline content"] },
    { kind: "generated", generatorId: "fixture", parameters: {} },
  ])("rejects incomplete, transformed or inline material references: %j", (initialMaterials) => {
    expect(initialMaterialsRefSchema.safeParse(initialMaterials).success).toBe(false);
    expect(dataInputSchema.safeParse({ userPrompt: "task", initialMaterials }).success).toBe(false);
  });
});

describe("Dataset documents", () => {
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
