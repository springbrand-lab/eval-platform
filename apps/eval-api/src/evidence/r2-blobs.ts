import { createHash, createHmac } from "node:crypto";
import type { EvidenceBlobStore } from "@eval-platform/eval-runtime/harness";
import type { Fetch } from "../sp/http.js";

const SHA256 = /^[0-9a-f]{64}$/u;
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
/** One request moves a whole blob (up to SP's per-file evidence limit) in either direction. */
const REQUEST_TIMEOUT_MS = 5 * 60_000;

export interface R2EvidenceConfig {
  /** The account's S3 endpoint origin, such as `https://<account>.r2.cloudflarestorage.com`. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** R2 refused or failed a request; 5xx and 429 may succeed when repeated. */
export class R2EvidenceError extends Error {
  readonly retryable: boolean;

  constructor(readonly status: number, operation: string) {
    super(`R2 evidence ${operation} returned ${status}`);
    this.name = "R2EvidenceError";
    this.retryable = status === 429 || status >= 500;
  }
}

/**
 * Evidence in an Eval-only R2 bucket through its S3 API: `evidence/blobs/<sha256>` and
 * `evidence/<evidence hex>/manifest.json`. Each blob is hashed before upload, so its key and
 * the signed payload hash are the same digest, and an existing blob is never uploaded again.
 */
export function createR2EvidenceBlobs(config: R2EvidenceConfig, fetch: Fetch = globalThis.fetch,
  now: () => Date = () => new Date()): EvidenceBlobStore {
  const endpoint = new URL(config.endpoint);

  async function send(method: "GET" | "HEAD" | "PUT", key: string, init: {
    readonly body?: Uint8Array;
    readonly payloadSha256?: string;
    readonly headers?: Readonly<Record<string, string>>;
  } = {}): Promise<Response> {
    const url = new URL(`/${config.bucket}/${key}`, endpoint);
    const headers = signV4({
      method, url, config, date: now(),
      payloadSha256: init.payloadSha256 ?? EMPTY_SHA256,
      headers: init.headers ?? {},
    });
    return fetch(url, {
      method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(init.body === undefined ? {} : { body: new Uint8Array(init.body) }),
    });
  }

  async function exists(key: string): Promise<boolean> {
    const response = await send("HEAD", key);
    if (response.status === 404) return false;
    if (!response.ok) throw new R2EvidenceError(response.status, "HEAD");
    return true;
  }

  async function read(key: string): Promise<Response | undefined> {
    const response = await send("GET", key);
    if (response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new R2EvidenceError(response.status, "GET");
    }
    return response;
  }

  async function write(key: string, body: Uint8Array, payloadSha256: string, headers: Record<string, string>): Promise<void> {
    const response = await send("PUT", key, { body, payloadSha256, headers });
    await response.body?.cancel();
    // 412: a conditional write found the object already there, which is the outcome we want.
    if (!response.ok && response.status !== 412) throw new R2EvidenceError(response.status, "PUT");
  }

  return {
    async putBlob(content, maxBytes) {
      const bytes = await readLimited(content, maxBytes);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const key = `evidence/blobs/${sha256}`;
      if (!await exists(key)) {
        await write(key, bytes, sha256, { "content-type": "application/octet-stream", "if-none-match": "*" });
      }
      return { sha256, size: bytes.byteLength };
    },

    async readBlob(sha256) {
      if (!SHA256.test(sha256)) return undefined;
      return (await read(`evidence/blobs/${sha256}`))?.body ?? undefined;
    },

    async putManifest(evidenceHex, bytes) {
      if (!SHA256.test(evidenceHex)) throw new TypeError("Invalid evidence ID");
      await write(`evidence/${evidenceHex}/manifest.json`, bytes, createHash("sha256").update(bytes).digest("hex"),
        { "content-type": "application/json", "if-none-match": "*" });
    },

    async readManifest(evidenceHex) {
      if (!SHA256.test(evidenceHex)) return undefined;
      const response = await read(`evidence/${evidenceHex}/manifest.json`);
      return response === undefined ? undefined : new Uint8Array(await response.arrayBuffer());
    },
  };
}

async function readLimited(content: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of content) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error("Evidence blob is too large");
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** AWS Signature Version 4 for one S3 request; R2 uses the region `auto`. */
export function signV4(input: {
  readonly region?: string;
  readonly method: string;
  readonly url: URL;
  readonly config: Pick<R2EvidenceConfig, "accessKeyId" | "secretAccessKey">;
  readonly date: Date;
  readonly payloadSha256: string;
  readonly headers: Readonly<Record<string, string>>;
}): Record<string, string> {
  const amzDate = input.date.toISOString().replace(/[:-]|\.\d{3}/gu, "");
  const day = amzDate.slice(0, 8);
  const region = input.region ?? "auto";
  const scope = `${day}/${region}/s3/aws4_request`;
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(input.headers).map(([name, value]) => [name.toLowerCase(), value.trim()])),
    host: input.url.host,
    "x-amz-content-sha256": input.payloadSha256,
    "x-amz-date": amzDate,
  };
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const canonicalQuery = [...input.url.searchParams]
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonicalRequest = [
    input.method,
    input.url.pathname.split("/").map((segment) => encodeRfc3986(decodeURIComponent(segment))).join("/"),
    canonicalQuery,
    names.map((name) => `${name}:${headers[name]}\n`).join(""),
    signedHeaders,
    input.payloadSha256,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  let key: Buffer = createHmac("sha256", `AWS4${input.config.secretAccessKey}`).update(day).digest();
  for (const part of [region, "s3", "aws4_request"]) key = createHmac("sha256", key).update(part).digest();
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  const { host: _host, ...sent } = headers;
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
