import { validateHeaderValue } from "node:http";

/** Untrusted resource bytes never execute in Eval's origin, including direct navigation. */
export function fileResponse(file: {
  readonly body: BodyInit | null;
  readonly contentType: string;
  readonly contentLength: string | null;
}): Response {
  const headers = new Headers({
    "Content-Disposition": "attachment",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  });
  try {
    headers.set("Content-Type", file.contentType || "application/octet-stream");
    // Fetch accepts some control characters that Node refuses to send on the actual HTTP connection.
    validateHeaderValue("Content-Type", headers.get("Content-Type")!);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    headers.set("Content-Type", "application/octet-stream");
  }
  if (file.contentLength !== null) headers.set("Content-Length", file.contentLength);
  return new Response(file.body, { status: 200, headers });
}
