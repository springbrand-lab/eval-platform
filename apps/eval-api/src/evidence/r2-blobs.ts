import { createHash, createHmac } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
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
 * `evidence/<evidence hex>/manifest.json`. A temporary, bounded local spool provides the digest
 * for both the content-addressed key and SigV4 before streaming the file to R2. Neither the
 * source nor a whole evidence part is retained in JS memory, and every spool is deleted.
 */
export function createR2EvidenceBlobs(config: R2EvidenceConfig, fetch: Fetch = globalThis.fetch,
  now: () => Date = () => new Date()): EvidenceBlobStore {
  const endpoint = new URL(config.endpoint);

  async function send(method: "GET" | "HEAD" | "PUT", key: string, init: {
    readonly body?: Uint8Array | ReadableStream<Uint8Array>;
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
      ...(init.body === undefined ? {} : init.body instanceof ReadableStream
        ? { body: init.body, duplex: "half" } as RequestInit
        : { body: new Uint8Array(init.body) }),
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

  async function write(key: string, body: Uint8Array | ReadableStream<Uint8Array>,
    payloadSha256: string, headers: Record<string, string>): Promise<void> {
    const response = await send("PUT", key, { body, payloadSha256, headers });
    await response.body?.cancel();
    // 412: a conditional write found the object already there, which is the outcome we want.
    if (!response.ok && response.status !== 412) throw new R2EvidenceError(response.status, "PUT");
  }

  return {
    async putBlob(content, maxBytes) {
      const temporary = await mkdtemp(join(tmpdir(), "eval-evidence-r2-"));
      const file = join(temporary, "part");
      let size = 0;
      const hash = createHash("sha256");
      try {
        await pipeline(Readable.fromWeb(content as never), async function* (chunks: AsyncIterable<Uint8Array>) {
          for await (const chunk of chunks) {
            size += chunk.byteLength;
            if (size > maxBytes) throw new Error("Evidence blob is too large");
            hash.update(chunk);
            yield chunk;
          }
        }, createWriteStream(file, { flags: "wx", mode: 0o600 }));
        const sha256 = hash.digest("hex");
        const key = `evidence/blobs/${sha256}`;
        if (!await exists(key)) {
          const body = createReadStream(file);
          try {
            await write(key, Readable.toWeb(body) as ReadableStream<Uint8Array>, sha256, {
              "content-type": "application/octet-stream", "content-length": String(size), "if-none-match": "*",
            });
          } finally {
            body.destroy();
          }
        }
        return { sha256, size };
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
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
