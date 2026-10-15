import { parseStrictJson } from "@eval-platform/eval-dataset";

export function methodNotAllowed(methods: string): Response {
  return new Response(null, { status: 405, headers: { Allow: methods } });
}

export function onlyFields(body: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(body).some((key) => !fields.includes(key)) || fields.some((field) => !(field in body))) {
    throw new TypeError(`Expected fields: ${fields.join(", ")}`);
  }
}

export async function readJsonObject(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  if (!request.body) throw new TypeError("JSON body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RangeError("Request body is too large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(body); }
  catch (error) {
    if (error instanceof TypeError) throw new SyntaxError("Request body must be valid UTF-8");
    throw error;
  }
  const parsed: unknown = parseStrictJson(source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("JSON object is required");
  }
  return parsed as Record<string, unknown>;
}
