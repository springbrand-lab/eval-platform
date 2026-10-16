/** Generates the opaque UUID used by newly persisted Eval entities. */
export function createId(): string {
  return crypto.randomUUID();
}

/** Serializes JSON with recursively sorted object keys while preserving array order. */
function canonicalJsonStringify(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : item,
  );
}

/** Encodes canonical JSON and rejects values that JSON cannot represent at the root. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  const serialized = canonicalJsonStringify(value);
  if (serialized === undefined) throw new TypeError("Value cannot be represented as JSON");
  return new TextEncoder().encode(serialized);
}

/** JSON persistence ignores object key order and omits undefined object fields. */
export function equalJson(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

/** Lowercase hexadecimal SHA-256 of UTF-8 text or raw bytes. */
export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
