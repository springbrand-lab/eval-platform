import { describe, expect, it } from "vitest";
import * as entry from "./index.js";

describe("@eval-platform/eval-contracts", () => {
  it("keeps the public entry importable", () => {
    expect(entry).toBeDefined();
  });
});
