import { describe, expect, it } from "vitest";
import { redactLiteral } from "./common.js";

describe("source literal redaction", () => {
  it("does not scan each suffix of a long benign string for a URL", () => {
    const plain = "a".repeat(64_000);
    expect(redactLiteral(plain)).toEqual({ value: plain, redacted: false });
    expect(redactLiteral("1".repeat(64_000) + "://")).toMatchObject({ redacted: false });
  });

  it("redacts URL schemes and credentials without exposing their value", () => {
    for (const value of ["https://private.example/path", "TEST+HTTPS://private.example",
      "Bearer secret1234567890", "apiKey: secret1234567890"]) {
      expect(redactLiteral(value)).toEqual({
        value: "[REDACTED: sensitive source content]", redacted: true,
      });
    }
    expect(redactLiteral("public", "url")).toMatchObject({ redacted: true });
  });
});
