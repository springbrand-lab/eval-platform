import { describe, expect, it } from "vitest";
import type { DatasetDocument } from "./model.js";
import { parseDatasetDocument, parsePromptDatasetUpload, serializeDatasetDocument } from "./serialization.js";
import { DatasetInputError } from "./store.js";

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
      initialSession: { bundleId: "401c23cf-d812-43f4-8404-d76e22cb0a66", sessionId: "2d1f19f1-7ab0-4037-8322-a149171e8351" },
      initialMaterials: [
        { bundleId: "f558ce88-fd69-4b57-8918-8938ab711cdf", materialId: "01b65fa2-88f6-4c99-8bb6-245fea0588af" },
        { bundleId: "0b5e8c3a-7d2f-4e1a-9c6b-3f8d2a1e5c47", materialId: "6e4d2c1b-9a8f-4e7d-8c6b-5a4f3e2d1c0b" },
      ],
      evalInitialMaterials: [
        { bundleId: "0b5e8c3a-7d2f-4e1a-9c6b-3f8d2a1e5c47", materialId: "6e4d2c1b-9a8f-4e7d-8c6b-5a4f3e2d1c0b" },
        { bundleId: "f558ce88-fd69-4b57-8918-8938ab711cdf", materialId: "01b65fa2-88f6-4c99-8bb6-245fea0588af" },
      ],
      metadata: JSON.parse('{"__proto__":{"label":"important"}}'),
    },
    {
      dataId: crypto.randomUUID(),
      userPrompt: "继续实现",
      json: null,
      initialSession: { bundleId: "401c23cf-d812-43f4-8404-d76e22cb0a66", sessionId: "c08a9f0c-3f01-4f50-88c2-052caae6e17a" },
    },
  ],
};

describe("Dataset serialization", () => {
  it.each(["json", "jsonl"] as const)("parses Data-only prompt upload in %s", (format) => {
    const row = { name: "First", description: "Case one", userPrompt: "  build it  ",
      evalPrompt: "  review it  ", requirements: ["accessible"] };
    const content = format === "json" ? JSON.stringify([row]) : `${JSON.stringify(row)}\n`;
    expect(parsePromptDatasetUpload({ name: " Tasks ", description: " Cases ", format, content }))
      .toEqual({ dataset: { name: "Tasks", description: "Cases" }, data: [row] });
  });

  it("rejects incomplete prompt metadata, resource refs, IDs and duplicate JSONL keys", () => {
    const row = { name: "First", description: "Case", userPrompt: "build", evalPrompt: "judge" };
    const input = { name: "Tasks", description: "Cases", format: "jsonl" as const };
    expect(() => parsePromptDatasetUpload({ ...input, content: JSON.stringify({ ...row, evalPrompt: "" }) })).toThrow();
    expect(() => parsePromptDatasetUpload({ ...input, content: JSON.stringify({ ...row, description: " " }) })).toThrow();
    expect(() => parsePromptDatasetUpload({ ...input, description: " ", content: JSON.stringify(row) })).toThrow();
    expect(() => parsePromptDatasetUpload({ ...input, content: JSON.stringify({ ...row, dataId: crypto.randomUUID() }) })).toThrow();
    expect(() => parsePromptDatasetUpload({ ...input, content: JSON.stringify({ ...row,
      initialMaterials: [{ bundleId: "d59795de-8a4d-4383-8e52-5b589b2bb0c1", materialId: "97912524-f347-43ab-8302-e4b51be6391c" }] }) })).toThrow();
    expect(() => parsePromptDatasetUpload({ ...input, content: '{"name":"first","name":"second"}' }))
      .toThrow(/Duplicate JSON field/u);
    expect(() => parsePromptDatasetUpload({ ...input, format: "json", content: JSON.stringify(row) })).toThrow();
  });
  it.each(["json", "yaml"] as const)("round-trips every input block through %s", (format) => {
    const source = serializeDatasetDocument(document, format);
    expect(parseDatasetDocument(source, format)).toEqual(document);
  });

  it.each(["json", "yaml"] as const)("round-trips documents without assigning IDs through %s", (format) => {
    const withoutIds = {
      dataset: { name: "tasks" },
      data: [{ userPrompt: "完成首页", initialSession: { bundleId: "401c23cf-d812-43f4-8404-d76e22cb0a66", sessionId: "a2047fbe-4917-4658-81ca-68f82ebe6071" } }],
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
    '{"userPrompt":"task","initialSession":{"bundleId":"781791f5-4cc0-46d0-8ef3-bc9b19e578a3","sessionId":"e0996a37-c13d-44c3-8060-74939d43fa37","sessionId":"352f7829-a238-4b00-8cc1-2b0c2613c756"}}',
    '{"userPrompt":"task","initialMaterials":[{"bundleId":"e0996a37-c13d-44c3-8060-74939d43fa37","bundleId":"352f7829-a238-4b00-8cc1-2b0c2613c756","materialId":"a1f13b3b-c20a-496e-88c2-12be9c56c706"}]}',
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
    expect(() => parseDatasetDocument("{}", "toml" as "json")).toThrow(DatasetInputError);
    expect(() => serializeDatasetDocument(document, "toml" as "json")).toThrow(DatasetInputError);
    expect(() => parseDatasetDocument([] as unknown as string, "json")).toThrow("must be a string");
    const stored = () => serializeDatasetDocument({ dataset: { name: "tasks" }, data: [{ userPrompt: "task", json: Infinity }] }, "json");
    expect(stored).toThrow();
    expect(stored).not.toThrow(DatasetInputError);
  });
});
