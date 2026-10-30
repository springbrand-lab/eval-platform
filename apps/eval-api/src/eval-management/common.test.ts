import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { displayJson, jsonChunk, redactLiteral, text } from "./common.js";

const TEN_MIB = 10 * 1024 * 1024;
const REDACTED = "[REDACTED: sensitive source content]";

describe("bounded management tool text", () => {
  it("accepts metrics through 10 MiB, but rejects the next byte", () => {
    const exact = { payload: "x".repeat(TEN_MIB - Buffer.byteLength('{"payload":""}')) };
    expect(Buffer.byteLength(text(exact, TEN_MIB, TEN_MIB), "utf8")).toBe(TEN_MIB);
    expect(() => text({ payload: exact.payload + "x" }, TEN_MIB, TEN_MIB)).toThrow();
    expect(() => text({ payload: "x".repeat(32_000) })).toThrow();
  });

  it("bounds the complete sanitized JSON document separately from its small continuation pages", () => {
    const reason = "x".repeat(TEN_MIB - Buffer.byteLength('{"reason":""}'));
    expect(displayJson({ reason }).display?.totalBytes).toBe(TEN_MIB);
    expect(() => displayJson({ reason: `${reason}x` })).toThrow();
    const redacted = displayJson({ token: `${reason}x`, reason: "safe" });
    expect(redacted.sourceRedacted).toBe(true);
    expect(redacted.display?.totalBytes).toBeLessThan(200);
    expect(JSON.parse(redacted.bytes!.toString("utf8"))).toEqual({
      token: "[REDACTED: sensitive source content]", reason: "safe",
    });
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

describe("selected Evaluation explanation display", () => {
  it("retains the safe reason around a whole URL and its query token only in explicit Evaluation scope", () => {
    const raw = { score: 40,
      reason: "Because the answer missed a step at https://example.test/path?token=SYNTHETIC but recovered." };
    const expected = { score: 40, reason: `Because the answer missed a step at ${REDACTED} but recovered.` };
    expect(JSON.parse(displayJson(raw).bytes!.toString("utf8"))).toEqual({ score: 40, reason: REDACTED });
    expect(JSON.parse(displayJson(raw, []).bytes!.toString("utf8"))).toEqual({ score: 40, reason: REDACTED });
    const document = displayJson(raw, [], "evaluation_result");
    expect(JSON.parse(document.bytes!.toString("utf8"))).toEqual(expected);
    expect(document.sourceRedacted).toBe(true);
    expect(document.bytes!.toString("utf8")).not.toContain("SYNTHETIC");
    expect(document.display).toEqual({ totalBytes: document.bytes!.length,
      sha256: createHash("sha256").update(document.bytes!).digest("hex") });
    const page = jsonChunk(raw, 0, [], undefined, "evaluation_result");
    expect(page.sourceRedacted).toBe(true);
    expect(page.chunk).toMatchObject({ text: document.bytes!.toString("utf8"),
      totalBytes: document.bytes!.length, sha256: document.display!.sha256, nextOffset: null });
  });

  it("masks every mixed literal and exact private prompt, including nested explanations and repeated URLs", () => {
    const userPrompt = "The user's private synthetic prompt";
    const evalPrompt = "The evaluator's private synthetic prompt";
    const url = "https://example.test/path?token=SYNTHETIC";
    const raw = {
      score: 40,
      reason: `Because ${url} and ${userPrompt}; then TEST+HTTPS://else.test/file?token=SECOND and Bearer SYNTHETIC_CREDENTIAL changed the decision.`,
      checks: [{ explanation: `The reply quoted ${evalPrompt} and apiKey: SYNTHETIC_API_TOKEN and data:text/plain;base64,SYNTHETIC_ENCODED and mailto:private@example.test?subject=SYNTHETIC_MAIL and www.example.test/path?token=SYNTHETIC_WEB but scored 40.`,
        reason: "The answer is partially correct.", note: `Because ${url}` }],
      copied: `Because ${userPrompt}`, reasonDetails: `Because ${url}`,
      prompt: { reason: "An entire sensitive subtree stays hidden" },
    };
    const document = displayJson(raw, [userPrompt, evalPrompt], "evaluation_result");
    expect(JSON.parse(document.bytes!.toString("utf8"))).toEqual({
      score: 40,
      reason: `Because ${REDACTED} and ${REDACTED}; then ${REDACTED} and ${REDACTED} changed the decision.`,
      checks: [{ explanation: `The reply quoted ${REDACTED} and ${REDACTED} and ${REDACTED} and ${REDACTED} and ${REDACTED} but scored 40.`,
        reason: "The answer is partially correct.", note: REDACTED }],
      copied: REDACTED, reasonDetails: REDACTED, prompt: REDACTED,
    });
    expect(document.sourceRedacted).toBe(true);
    for (const secret of ["example.test", "else.test", "SYNTHETIC", userPrompt, evalPrompt]) {
      expect(document.bytes!.toString("utf8")).not.toContain(secret);
    }
    expect(redactLiteral("The answer is partially correct.").redacted).toBe(false);
  });

  it("keeps a safe nested reason unchanged, but never relaxes Schemas or unsafe source keys", () => {
    const safe = { checks: [{ reason: "The answer is partially correct.", explanation: "Evidence is missing." }] };
    const document = displayJson(safe, [], "evaluation_result");
    expect(JSON.parse(document.bytes!.toString("utf8"))).toEqual(safe);
    expect(document.sourceRedacted).toBe(false);
    const schema = { properties: { reason: { description: "See https://example.test/path?token=SYNTHETIC" } } };
    expect(JSON.parse(displayJson(schema).bytes!.toString("utf8"))).toEqual({
      properties: { reason: { description: REDACTED } },
    });
    const unsafe = { reason: "A safe reason.", checks: [{ "https://example.test/path?token=SYNTHETIC": 40 }] };
    expect(displayJson(unsafe, [], "evaluation_result")).toMatchObject({
      bytes: null, display: null, sourceRedacted: true,
    });
  });

  it("falls back to a whole-value marker when the entire unsafe literal cannot be delimited", () => {
    for (const reason of ["Because the malformed URL https:// lacks a target.",
      "Because www. example.test/path?token=SYNTHETIC lacks a contiguous host.",
      "Because mailto: SYNTHETIC_EMAIL lacks a contiguous address.",
      "Because data: SYNTHETIC_PAYLOAD lacks a contiguous body.",
      `Because AKIA${"A".repeat(16)}/www. SYNTHETIC_HOST could hide an incomplete address.`,
      "Because https://example.test/https:// SYNTHETIC_HOST could hide an incomplete URL.",
      "Because -----BEGIN RSA PRIVATE KEY-----\nSYNTHETIC_KEY_BODY\n-----END RSA PRIVATE KEY----- is private.",
      `Because ${"www.private.test ".repeat(1_100)}would require too many separate redactions.`]) {
      const document = displayJson({ score: 40, reason }, [], "evaluation_result");
      expect(JSON.parse(document.bytes!.toString("utf8"))).toEqual({ score: 40, reason: REDACTED });
      expect(document.sourceRedacted).toBe(true);
    }
  });

  it("never leaves the credential body behind when unsafe literal matches overlap", () => {
    for (const reason of ["Because apiKey: Bearer SYNTHETIC_CREDENTIAL was included.",
      "Because Bearer password: SYNTHETIC_CREDENTIAL was included.",
      "Because password: -----BEGIN RSA PRIVATE KEY-----\nSYNTHETIC_KEY_BODY\n-----END RSA PRIVATE KEY----- was included.",
      `Because AKIA${"A".repeat(16)}/SYNTHETIC_SUFFIX was included.`,
      `Because sk-${"A".repeat(8)}.SYNTHETIC_SUFFIX was included.`]) {
      const document = displayJson({ score: 40, reason }, [], "evaluation_result");
      expect(document.sourceRedacted).toBe(true);
      expect(document.bytes!.toString("utf8")).not.toContain("SYNTHETIC");
    }
    const overlapping = displayJson({ reason: "Because ababa was copied." }, ["aba"], "evaluation_result");
    expect(JSON.parse(overlapping.bytes!.toString("utf8"))).toEqual({
      reason: `Because ${REDACTED} was copied.`,
    });
  });
});
