import { describe, expect, it } from "vitest";
import {
  EVAL_INITIAL_FILE_MAX_BYTES,
  EVAL_INITIALIZATION_MAX_BYTES,
  EVAL_MATERIAL_MAX_FILES,
  EVAL_SESSION_CONTENT_MAX_CHARS,
} from "@springbrand/eval-harness";
import { BUNDLE_ERROR_DETAILS } from "../limits.js";
import { validateMaterialFiles, validateSessionContent } from "./bundle-content.js";

const userEntry = (id: string) => JSON.stringify({ id, message: { role: "user", content: "Hi", timestamp: 1 }, createdAt: 1 });
const file = (path: string, bytes: number) => ({
  path, mediaType: "application/octet-stream", contentBase64: Buffer.alloc(bytes).toString("base64"),
});
const failure = (reason: "invalid" | "too-large", ...details: readonly { path: string; errMsg?: unknown }[]) => ({
  name: "BundleFileError",
  reason,
  details: details.map(({ path, errMsg = expect.any(String) }) => ({ path, errMsg })),
});

describe("Material content", () => {
  it("names each invalid file by its label and the list by its own label", () => {
    expect(() => validateMaterialFiles([])).toThrow(expect.objectContaining(failure("invalid", { path: "files" })));
    expect(() => validateMaterialFiles([
      { path: "/a.txt", mediaType: "text/plain", contentBase64: "not base64" },
      { path: "/../b.txt", mediaType: "text/plain", contentBase64: "SGk=" },
    ])).toThrow(expect.objectContaining(failure("invalid",
      { path: "files.0", errMsg: expect.stringMatching(/^contentBase64: /u) },
      { path: "files.1", errMsg: "path: Invalid initial material path" },
    )));
    const labels = { files: "docs", file: (index: number) => `docs/${index}` };
    expect(() => validateMaterialFiles([file("/a", 1), file("/../b", 1)], labels))
      .toThrow(expect.objectContaining(failure("invalid", { path: "docs/1", errMsg: "path: Invalid initial material path" })));
    expect(() => validateMaterialFiles([file("/a", 1), file("/b", 1), file("/a", 1)], labels))
      .toThrow(expect.objectContaining(failure("invalid", { path: "docs/2", errMsg: "path: Duplicate material path" })));
  });

  it("bounds each material file and the material in total, reporting the decoded total", () => {
    const big = EVAL_INITIAL_FILE_MAX_BYTES + 1;
    expect(() => validateMaterialFiles([file("/small.bin", 1), file("/big.bin", big)]))
      .toThrow(expect.objectContaining(failure("too-large", { path: "files.1" })));
    expect(() => validateMaterialFiles([file("/big.bin", big), file("/../bad", 1)]))
      .toThrow(expect.objectContaining(failure("too-large", { path: "files.0" })));
    expect(() => validateMaterialFiles(Array.from({ length: EVAL_MATERIAL_MAX_FILES + 1 }, (_, index) => file(`/${index}.bin`, 1))))
      .toThrow(expect.objectContaining(failure("too-large", { path: "files" })));
    const full = EVAL_INITIALIZATION_MAX_BYTES / EVAL_INITIAL_FILE_MAX_BYTES;
    const files = Array.from({ length: full }, (_, index) => file(`/${index}.bin`, EVAL_INITIAL_FILE_MAX_BYTES));
    expect(validateMaterialFiles(files).byteSize).toBe(EVAL_INITIALIZATION_MAX_BYTES);
    expect(() => validateMaterialFiles([...files, file("/extra.bin", 1)]))
      .toThrow(expect.objectContaining(failure("too-large", { path: "files" })));
  });
});

describe("Session content", () => {
  it("accepts SP canonical JSON and JSONL unchanged", () => {
    const jsonl = { format: "jsonl", content: `${userEntry("m1")}\r\n\n${userEntry("m2")}\n` } as const;
    expect(validateSessionContent(jsonl)).toEqual(jsonl);
  });

  it("reports strict JSON failures per JSONL line before SP structure", () => {
    expect(() => validateSessionContent({ format: "jsonl", content: `${userEntry("m1")}\n\n{"a":1,"a":2}\nnot-json` }, "s.jsonl"))
      .toThrow(expect.objectContaining(failure("invalid",
        { path: "s.jsonl:3", errMsg: expect.stringMatching(/Duplicate JSON field "a"/u) },
        { path: "s.jsonl:4", errMsg: expect.stringMatching(/^Invalid JSON at offset/u) },
      )));
    expect(() => validateSessionContent({ format: "json", content: `{"entries":[],"entries":[]}` }))
      .toThrow(expect.objectContaining(failure("invalid", { path: "content" })));
    const lines = Array.from({ length: BUNDLE_ERROR_DETAILS + 5 }, () => "x").join("\n");
    expect(() => validateSessionContent({ format: "jsonl", content: lines }))
      .toThrow(expect.objectContaining({ details: Array.from({ length: BUNDLE_ERROR_DETAILS }, () => expect.anything()) }));
  });

  it("rejects syntactically valid Session content that SP cannot import, with SP's reason", () => {
    for (const [context, errMsg] of [
      [{ format: "json", content: "{}" }, expect.stringContaining("Invalid canonical context: entries:")],
      [{ format: "json", content: JSON.stringify({ entries: [{ id: "m1", message: {
        role: "assistant", content: [], timestamp: 1, api: "openai-completions", provider: "openai", model: "test", stopReason: "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      }, createdAt: 1 }] }) },
        "Invalid canonical context: entries.0.message.role: Canonical history must begin with a user message"],
      [{ format: "jsonl", content: [userEntry("m1"), userEntry("m1")].join("\n") }, "Invalid canonical context: entries.1.id: Duplicate canonical message ID"],
      [{ format: "jsonl", content: `${userEntry("m1")}\n${" ".repeat(EVAL_SESSION_CONTENT_MAX_CHARS)}` }, "Initial context is too large"],
      [{ format: "jsonl", content: "" }, expect.stringMatching(/^content: /u)],
      [{ format: "yaml", content: "a: 1" }, expect.stringMatching(/^format: /u)],
    ] as const) {
      expect(() => validateSessionContent(context)).toThrow(expect.objectContaining(failure("invalid", { path: "content", errMsg })));
    }
  });
});
