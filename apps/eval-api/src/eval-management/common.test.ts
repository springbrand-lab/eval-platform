import { describe, expect, it } from "vitest";
import { redactLiteral, text } from "./common.js";

const TEN_MIB = 10 * 1024 * 1024;

describe("bounded management tool text", () => {
  it("accepts metrics through 10 MiB, but rejects the next byte", () => {
    const exact = { payload: "x".repeat(TEN_MIB - Buffer.byteLength('{"payload":""}')) };
    expect(Buffer.byteLength(text(exact, TEN_MIB, TEN_MIB), "utf8")).toBe(TEN_MIB);
    expect(() => text({ payload: exact.payload + "x" }, TEN_MIB, TEN_MIB)).toThrow();
    expect(() => text({ payload: "x".repeat(32_000) })).toThrow();
  });
});

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
