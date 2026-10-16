import { expect, it } from "vitest";
import { buildSchemaContent, initialSchemaFields } from "./schema-builder";

it("creates typed scoring fields without changing their meaning", () => {
  const fields = initialSchemaFields();
  fields.push({ ...fields[1]!, id: 3, key: "passed", title: "是否通过", type: "boolean", required: false });
  const result = buildSchemaContent(fields);
  expect(result.error).toBeUndefined();
  expect(JSON.parse(result.content)).toMatchObject({
    type: "object", required: ["score", "reason"], additionalProperties: false,
    properties: { score: { type: "number", minimum: 0, maximum: 10 }, reason: { type: "string" }, passed: { type: "boolean" } },
  });
});

it("rejects missing or duplicate keys and invalid numeric ranges", () => {
  const [field] = initialSchemaFields();
  expect(buildSchemaContent([]).error).toBeDefined();
  expect(buildSchemaContent([{ ...field!, key: " " }]).error).toBeDefined();
  expect(buildSchemaContent([field!, { ...field!, id: 2 }]).error).toContain("重复");
  expect(buildSchemaContent([{ ...field!, minimum: "20", maximum: "10" }]).error).toContain("下限");
  expect(buildSchemaContent([{ ...field!, maximum: "9007199254740993" }]).error).toContain("有限数值");
  expect(buildSchemaContent([{ ...field!, maximum: "1e400" }]).error).toContain("有限数值");
});
