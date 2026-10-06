import { describe, expect, it } from "vitest";
import * as entry from "./index.js";

describe("@eval-platform/eval-cli", () => {
  it("keeps the application entry importable", () => {
    expect(entry).toBeDefined();
  });
});
