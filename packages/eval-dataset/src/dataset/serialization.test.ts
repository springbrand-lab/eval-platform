import { describe, expect, it } from "vitest";
import type { DatasetDocument } from "./model.js";
import { parseDatasetDocument, serializeDatasetDocument } from "./serialization.js";

const document: DatasetDocument = {
  dataset: { datasetId: crypto.randomUUID(), name: "网页任务", description: "内部数据" },
  data: [
    {
      dataId: crypto.randomUUID(),
      userPrompt: "  完成首页\n保留已有样式。  ",
      evalPrompt: "  检查首页的功能和体验。  ",
      json: { task: "create homepage", enabled: true, count: 3 },
      requirements: ["responsive", "accessible"],
      expectedOutput: { files: ["src/index.ts"] },
      initialSession: { bundleId: "sessions-bundle", sessionId: "homepage-session" },
      initialMaterials: { bundleId: "project-files", materialId: "homepage-files" },
      metadata: JSON.parse('{"__proto__":{"label":"important"}}'),
    },
    {
      dataId: crypto.randomUUID(),
      userPrompt: "继续实现",
      json: null,
      initialSession: { bundleId: "sessions-bundle", sessionId: "tool-history-session" },
    },
  ],
};

describe("Dataset serialization", () => {
  it.each(["json", "yaml"] as const)("round-trips every input block through %s", (format) => {
    const source = serializeDatasetDocument(document, format);
    expect(parseDatasetDocument(source, format)).toEqual(document);
  });

  it.each(["json", "yaml"] as const)("round-trips documents without assigning IDs through %s", (format) => {
    const withoutIds = {
      dataset: { name: "tasks" },
      data: [{ userPrompt: "完成首页", initialSession: { bundleId: "sessions-bundle", sessionId: "session-seed" } }],
    };
    expect(parseDatasetDocument(serializeDatasetDocument(withoutIds, format), format)).toEqual(withoutIds);
  });

  it("rejects malformed JSON and structurally invalid documents", () => {
    expect(() => parseDatasetDocument("{", "json")).toThrow();
    expect(() => parseDatasetDocument("[]", "json")).toThrow();
    expect(() => parseDatasetDocument('{"dataset":[],"data":[]}', "json")).toThrow();
    expect(() => parseDatasetDocument('{"dataset":{"name":"tasks"},"data":[{"userPrompt":"task","initialSession":false}]}', "json"))
      .toThrow();
    expect(() => parseDatasetDocument('{"dataset":{"name":"tasks"},"data":[{"json":"task"}]}', "json"))
      .toThrow();
  });

  describe.each(["json", "yaml"] as const)("%s numeric integrity", (format) => {
    it.each([
      "9007199254740993",
      "9007199254740992",
      "-9007199254740993",
      "9007199254740993.0",
      "9.007199254740993e15",
      "1e309",
    ])("rejects unsafe numeric literals before import: %s", (literal) => {
      const source = format === "json"
        ? `{"dataset":{"name":"tasks"},"data":[{"userPrompt":"task","externalDataId":${literal}}]}`
        : `dataset: { name: tasks }\ndata: [{ userPrompt: task, externalDataId: ${literal} }]`;
      expect(() => parseDatasetDocument(source, format)).toThrow();
    });

    it("preserves safe boundaries, fractional numbers and string-encoded large IDs", () => {
      const input = {
        dataset: { name: "tasks" },
        data: [{
          userPrompt: "task",
          maximum: Number.MAX_SAFE_INTEGER,
          minimum: Number.MIN_SAFE_INTEGER,
          fraction: 0.125,
          tiny: 1e-7,
          externalDataId: "9007199254740993",
          expectedOutput: { ids: ["9007199254740992", "9007199254740993"] },
        }],
      };
      expect(parseDatasetDocument(serializeDatasetDocument(input, format), format)).toEqual(input);
    });

    it("rejects serialization of already-unsafe integer values", () => {
      expect(() => serializeDatasetDocument({
        dataset: { name: "tasks" },
        data: [{ userPrompt: "task", expectedOutput: { id: Number.MAX_SAFE_INTEGER + 1 } }],
      }, format)).toThrow();
    });
  });

  it.each(["0x20000000000001", "0o400000000000000001"])(
    "rejects unsafe YAML integers in non-decimal notation: %s",
    (literal) => expect(() => parseDatasetDocument(
      `dataset: { name: tasks }\ndata: [{ userPrompt: task, externalDataId: ${literal} }]`,
      "yaml",
    )).toThrow(),
  );

  it.each([
    '{"userPrompt":"first","userPrompt":"second"}',
    '{"userPrompt":"task","externalDataId":"first","externalDataId":"second"}',
    '{"userPrompt":"task","initialSession":{"bundleId":"sessions","sessionId":"first","sessionId":"second"}}',
    '{"userPrompt":"task","initialMaterials":{"bundleId":"first","bundleId":"second","materialId":"files"}}',
    '{"userPrompt":"task","expectedOutput":[{"id":1,"id":2}]}',
    '{"userPrompt":"first","user\\u0050rompt":"second"}',
    '{"userPrompt":"task","__proto__":{"first":true},"__proto__":{"second":true}}',
    '{"userPrompt":"task","constructor":1,"constructor":2}',
    '{"userPrompt":"task","":1,"":2}',
  ])("rejects duplicate decoded JSON fields in any object: %s", (data) => {
    expect(() => parseDatasetDocument(`{"dataset":{"name":"tasks"},"data":[${data}]}`, "json"))
      .toThrow(/Duplicate JSON field/);
  });

  it("allows identical field names in separate JSON objects and duplicate-looking string contents", () => {
    const input = {
      dataset: { name: "tasks" },
      data: [
        {
          userPrompt: "first",
          left: { id: 1 },
          right: { id: 2 },
          referenceText: '{"userPrompt":"first","userPrompt":"second"}',
          text: "\ud800",
        },
        { userPrompt: "second", left: { id: 3 } },
      ],
    };
    expect(parseDatasetDocument(JSON.stringify(input), "json")).toEqual(input);
  });

  it.each([
    '{/*comment*/"dataset":{"name":"tasks"},"data":[]}',
    '{"dataset":{"name":"tasks"},"data":[],}',
    '{"dataset":{"name":"tasks"},"data":[{"userPrompt":"task"},]}',
    '{"dataset":{"name":"tasks"},"data":[]} {"other":true}',
    '\ufeff{"dataset":{"name":"tasks"},"data":[]}',
  ])("continues to reject JSONC extensions and invalid JSON: %s", (source) => {
    expect(() => parseDatasetDocument(source, "json")).toThrow();
  });

  it.each([
    "dataset:\n  name: first\n  name: second\ndata: []",
    "dataset: { name: !custom tasks }\ndata: []",
    "dataset: { name: tasks }\ndata: []\n---\ndataset: { name: other }\ndata: []",
    "dataset: { name: tasks }\ndata: [{ userPrompt: task, json: .nan }]",
    "dataset: { name: tasks }\ndata: [{ userPrompt: task, json: .inf }]",
    "dataset: { name: tasks }\ndata: [{ userPrompt: task, json: { 1: task } }]",
    "dataset: { name: tasks }\ndata: [{ userPrompt: task, json: &shared [task] }, { userPrompt: task, json: *shared }]",
    "dataset: { name: tasks }\ndata: [{ userPrompt: task, json: &cycle [*cycle] }]",
  ])("rejects unsafe or lossy YAML: %s", (source) => {
    expect(() => parseDatasetDocument(source, "yaml")).toThrow();
  });

  it("rejects implicit formats and invalid serialization inputs", () => {
    expect(() => parseDatasetDocument("{}", "toml" as "json")).toThrow("Unsupported dataset format");
    expect(() => serializeDatasetDocument(document, "toml" as "json")).toThrow("Unsupported dataset format");
    expect(() => parseDatasetDocument([] as unknown as string, "json")).toThrow("must be a string");
    expect(() => serializeDatasetDocument({ dataset: { name: "tasks" }, data: [{ userPrompt: "task", json: Infinity }] }, "json"))
      .toThrow();
  });
});
