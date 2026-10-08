import { describe, expect, it } from "vitest";
import * as entry from "./index.js";

describe("@eval-platform/eval-dataset", () => {
  it("keeps the public entry importable", () => {
    expect(entry.createDatasetService).toBeTypeOf("function");
    expect(entry.parseDatasetDocument).toBeTypeOf("function");
    expect(entry.initialSessionRefSchema).toBeDefined();
    expect(entry.initialMaterialsRefSchema).toBeDefined();
    expect(entry).not.toHaveProperty("initialContextSchema");
    expect(entry).not.toHaveProperty("initialMaterialsSpecSchema");
  });
});
