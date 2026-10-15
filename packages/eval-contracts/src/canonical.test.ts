import { describe, expect, it } from "vitest";
import { canonicalJsonBytes, createId, equalJson, sha256Hex } from "./canonical.js";

describe("canonical JSON and identity helpers", () => {
  it("orders object keys recursively, keeps array order and drops undefined fields", () => {
    const text = new TextDecoder().decode(canonicalJsonBytes({ b: 1, a: [{ d: 1, c: 2 }, 3], u: undefined }));
    expect(text).toBe('{"a":[{"c":2,"d":1},3],"b":1}');
    expect(equalJson({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1, c: undefined })).toBe(true);
    expect(equalJson([1, 2], [2, 1])).toBe(false);
    expect(() => canonicalJsonBytes(undefined)).toThrow(TypeError);
  });

  it("hashes text and bytes identically and creates distinct UUIDs", async () => {
    const expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(await sha256Hex("abc")).toBe(expected);
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(expected);
    const [first, second] = [createId(), createId()];
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(first).not.toBe(second);
  });
});
