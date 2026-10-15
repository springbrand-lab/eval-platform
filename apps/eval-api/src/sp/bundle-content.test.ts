import { describe, expect, it } from "vitest";
import { BUNDLE_ERROR_DETAILS } from "../limits.js";
import { validateMaterialFiles, validateSessionContent } from "./bundle-content.js";

const userEntry = (id: string) => JSON.stringify({ id, message: { role: "user", content: "Hi" }, createdAt: 1 });
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
    ])).toThrow(expect.objectContaining(failure("invalid", { path: "files.0", errMsg: expect.stringMatching(/^contentBase64: /u) })));
    expect(() => validateMaterialFiles([file("/a", 1), file("/../b", 1), file("/a", 1)], {
      files: "docs", file: (index) => `docs/${index}`,
    })).toThrow(expect.objectContaining(failure("invalid",
      { path: "docs/1", errMsg: "Invalid initial material path" },
      { path: "docs/2", errMsg: "Duplicate material file path /a" },
    )));
  });

  it("bounds each material file and the material in total", () => {
    expect(() => validateMaterialFiles([file("/big.bin", 5_000_001)]))
      .toThrow(expect.objectContaining(failure("too-large", { path: "files.0" })));
    expect(() => validateMaterialFiles(Array.from({ length: 5 }, (_, index) => file(`/${index}.bin`, 4_000_001))))
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
      [{ format: "json", content: "{}" }, "Initial context must contain canonical entries"],
      [{ format: "json", content: JSON.stringify({ entries: [{ id: "m1", message: { role: "assistant" }, createdAt: 1 }] }) },
        "Initial context must begin with a user message"],
      [{ format: "jsonl", content: [userEntry("m1"), userEntry("m1")].join("\n") }, "Invalid or duplicate canonical context entry"],
      [{ format: "jsonl", content: `${userEntry("m1")}\n${" ".repeat(2_000_000)}` }, "Initial context is too large"],
      [{ format: "jsonl", content: "" }, expect.stringMatching(/^content: /u)],
      [{ format: "yaml", content: "a: 1" }, expect.stringMatching(/^format: /u)],
    ] as const) {
      expect(() => validateSessionContent(context)).toThrow(expect.objectContaining(failure("invalid", { path: "content", errMsg })));
    }
  });
});
