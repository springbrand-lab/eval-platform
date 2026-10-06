import { describe, expect, it } from "vitest";
import * as entry from "./index.js";

describe("@eval-platform/eval-metrics", () => {
  it("keeps the public entry importable", () => {
    expect(entry).toBeDefined();
  });
});
