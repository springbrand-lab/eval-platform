import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_EVIDENCE_LIMITS, SP_PI_TRAJECTORY_FORMAT, type EvidenceExportProgress } from "@eval-platform/eval-contracts";
import { createEvidenceStore, type ExportedEvidence } from "@eval-platform/eval-runtime/harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeFixture } from "../sp/native-test-fixture.js";
import { openLocalEvidenceBlobs } from "./local-blobs.js";
import { createR2EvidenceBlobs, signV4 } from "./r2-blobs.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const stream = (text: string) => new Response(text).body!;
const text = async (body: ReadableStream<Uint8Array> | undefined) => body === undefined ? undefined : new Response(body).text();
const nativePage = (afterSeq: number) => {
  const line = `${JSON.stringify(nativeFixture(3, "c-1"))}\n`;
  return { throughSeq: 3, nextAfterSeq: null,
    records: afterSeq < 3 ? [{ seq: 3, byteLength: Buffer.byteLength(line), readJsonl: async () => stream(line) }] : [] };
};

describe("local evidence blobs", () => {
  it("stores each content once under its hash and keeps the first manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-evidence-"));
    directories.push(root);
    const blobs = await openLocalEvidenceBlobs(root);

    await expect(blobs.putBlob(stream("hello"), 10)).resolves.toEqual({ sha256: sha("hello"), size: 5 });
    await expect(blobs.putBlob(stream("hello"), 10)).resolves.toEqual({ sha256: sha("hello"), size: 5 });
    await expect(text(await blobs.readBlob(sha("hello")))).resolves.toBe("hello");
    await expect(blobs.readBlob(sha("missing"))).resolves.toBeUndefined();
    await expect(blobs.readBlob("../../etc/passwd")).resolves.toBeUndefined();
    await expect(blobs.putBlob(stream("too long"), 3)).rejects.toThrow(/too large/u);
    expect(await readdir(join(root, "evidence", "blobs"))).toEqual([sha("hello")]);
    expect(await readdir(join(root, "evidence", "tmp"))).toEqual([]);

    const id = "a".repeat(64);
    await blobs.putManifest(id, new TextEncoder().encode("first"));
    await blobs.putManifest(id, new TextEncoder().encode("second"));
    expect(new TextDecoder().decode(await blobs.readManifest(id))).toBe("first");
    await expect(blobs.readManifest("b".repeat(64))).resolves.toBeUndefined();
  });

  it("backs a complete evidence store", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-evidence-"));
    directories.push(root);
    const store = createEvidenceStore(await openLocalEvidenceBlobs(root), () => "2026-10-15T00:00:00.000Z");
    const ref = await store.resume({
      limits: DEFAULT_EVIDENCE_LIMITS,
      evidence: {
        source: { framework: "sp", samplingId: "s-1", agentRef: { chatId: "c-1" } },
        artifacts: [{ path: "/index.html", size: 2, mediaType: "text/html" }],
        subjectInputs: [],
        omitted: [{ path: "/node_modules/a.js", reason: "excluded" }],
        readFile: async () => stream("hi"),
        async* readTrajectory(afterSeq) {
          yield nativePage(afterSeq);
        },
        trajectoryComplete: true,
        trajectoryFormat: SP_PI_TRAJECTORY_FORMAT,
      },
    });
    const opened = await store.open(ref);
    expect(opened.manifest.omitted).toEqual([{ path: "/node_modules/a.js", reason: "excluded" }]);
    await expect(text(await opened.readBlob(sha("hi")))).resolves.toBe("hi");
  });
});

describe("R2 evidence blobs", () => {
  it("spools and SigV4-streams a 30+ MiB part to its content key without a full-body Uint8Array", async () => {
    const body = new TextEncoder().encode("汉🌎é".repeat(4_096));
    const repetitions = 900;
    const expected = createHash("sha256");
    for (let index = 0; index < repetitions; index++) expected.update(body);
    const digest = expected.digest("hex");
    const byteLength = repetitions * body.byteLength;
    expect(byteLength).toBeGreaterThan(30 * 1024 * 1024);
    let read = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(new URL(request.url).pathname).toBe(`/eval-evidence/evidence/blobs/${digest}`);
      if (request.method === "HEAD") return new Response(null, { status: 404 });
      expect(request.method).toBe("PUT");
      expect(request.headers.get("content-length")).toBe(String(byteLength));
      expect(request.headers.get("x-amz-content-sha256")).toBe(digest);
      const received = createHash("sha256");
      for await (const chunk of request.body!) {
        read += chunk.byteLength;
        expect(chunk.byteLength).toBeLessThan(1024 * 1024);
        received.update(chunk);
      }
      expect(received.digest("hex")).toBe(digest);
      return new Response(null, { status: 200 });
    });
    const blobs = createR2EvidenceBlobs({
      endpoint: "https://account.r2.cloudflarestorage.com", bucket: "eval-evidence",
      accessKeyId: "key-id", secretAccessKey: "secret",
    }, fetch);
    const parts = (function* () {
      for (let index = 0; index < repetitions; index++) {
        for (let offset = 0; offset < body.byteLength; offset += 257) yield body.subarray(offset, offset + 257);
      }
    })();
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = parts.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
    });
    await expect(blobs.putBlob(source, 95_000_000)).resolves.toEqual({ sha256: digest, size: byteLength });
    expect(read).toBe(byteLength);
    expect(fetch).toHaveBeenCalledTimes(2);
  }, 45_000);

  it("signs requests with AWS Signature Version 4", () => {
    // AWS S3 documentation example: GET Object with a Range header.
    const headers = signV4({
      region: "us-east-1",
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      config: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
      date: new Date("2013-05-24T00:00:00Z"),
      payloadSha256: sha(""),
      headers: { Range: "bytes=0-9" },
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
      + "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, "
      + "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(headers).not.toHaveProperty("host");
  });

  it("uploads a blob only when its hash key is absent and reads manifests by evidence ID", async () => {
    const objects = new Map<string, Uint8Array>();
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const key = new URL(request.url).pathname;
      expect(request.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=key-id\/\d{8}\/auto\/s3\/aws4_request/u);
      if (request.method === "PUT") {
        const body = new Uint8Array(await request.arrayBuffer());
        expect(request.headers.get("x-amz-content-sha256")).toBe(createHash("sha256").update(body).digest("hex"));
        if (objects.has(key)) return new Response(null, { status: 412 });
        objects.set(key, body);
        return new Response(null, { status: 200 });
      }
      const body = objects.get(key);
      if (!body) return new Response(null, { status: 404 });
      return new Response(request.method === "HEAD" ? null : new Uint8Array(body));
    });
    const blobs = createR2EvidenceBlobs({
      endpoint: "https://account.r2.cloudflarestorage.com", bucket: "eval-evidence",
      accessKeyId: "key-id", secretAccessKey: "secret",
    }, fetch);

    await expect(blobs.putBlob(stream("hello"), 10)).resolves.toEqual({ sha256: sha("hello"), size: 5 });
    await blobs.putBlob(stream("hello"), 10);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
    expect([...objects.keys()]).toEqual([`/eval-evidence/evidence/blobs/${sha("hello")}`]);
    await expect(text(await blobs.readBlob(sha("hello")))).resolves.toBe("hello");
    await expect(blobs.readBlob(sha("missing"))).resolves.toBeUndefined();
    await expect(blobs.putBlob(stream("too long"), 3)).rejects.toThrow(/too large/u);

    const id = "c".repeat(64);
    await blobs.putManifest(id, new TextEncoder().encode("first"));
    await blobs.putManifest(id, new TextEncoder().encode("second"));
    expect(new TextDecoder().decode(await blobs.readManifest(id))).toBe("first");
    await expect(blobs.readManifest("d".repeat(64))).resolves.toBeUndefined();
  });

  it("resumes an export on R2 without re-reading stored files and keeps one manifest after a lost response", async () => {
    const objects = new Map<string, Uint8Array>();
    let loseManifestResponse = true;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const key = new URL(request.url).pathname;
      if (request.method === "PUT") {
        if (objects.has(key)) return new Response(null, { status: 412 });
        objects.set(key, new Uint8Array(await request.arrayBuffer()));
        if (key.endsWith("/manifest.json") && loseManifestResponse) {
          loseManifestResponse = false;
          throw new TypeError("fetch failed");
        }
        return new Response(null, { status: 200 });
      }
      const body = objects.get(key);
      if (!body) return new Response(null, { status: 404 });
      return new Response(request.method === "HEAD" ? null : new Uint8Array(body));
    });
    let tick = 0;
    const store = createEvidenceStore(createR2EvidenceBlobs({
      endpoint: "https://account.r2.cloudflarestorage.com", bucket: "eval-evidence", accessKeyId: "key-id", secretAccessKey: "secret",
    }, fetch), () => new Date(Date.UTC(2026, 9, 15, 0, 0, tick++)).toISOString());
    const reads: string[] = [];
    const evidence: ExportedEvidence = {
      source: { framework: "sp", samplingId: "s-r2", agentRef: { chatId: "c-1" } },
      artifacts: [{ path: "/a.txt", size: 1, mediaType: "text/plain" }, { path: "/b.txt", size: 1, mediaType: "text/plain" }],
      subjectInputs: [],
      omitted: [],
      async readFile(path) {
        reads.push(path);
        return stream(path === "/a.txt" ? "a" : "b");
      },
      async* readTrajectory(afterSeq) {
        yield nativePage(afterSeq);
      },
      trajectoryComplete: true,
      trajectoryFormat: SP_PI_TRAJECTORY_FORMAT,
    };
    let progress: EvidenceExportProgress | undefined;
    const onProgress = async (next: EvidenceExportProgress) => { progress = next; };

    await expect(store.resume({ evidence, limits: DEFAULT_EVIDENCE_LIMITS, onProgress })).rejects.toThrow(/fetch failed/u);
    expect(progress?.trajectory.done).toBe(true);
    reads.length = 0;
    const ref = await store.resume({ evidence, limits: DEFAULT_EVIDENCE_LIMITS, progress: progress!, onProgress });
    expect(reads).toEqual([]);
    expect([...objects.keys()].filter((key) => key.endsWith("/manifest.json")))
      .toEqual([`/eval-evidence/evidence/${ref.evidenceId.slice("sha256:".length)}/manifest.json`]);
    expect((await store.open(ref)).manifest.artifacts.map((artifact) => artifact.sha256)).toEqual([sha("a"), sha("b")]);
  });

  it("reports a transient R2 failure as retryable", async () => {
    const blobs = createR2EvidenceBlobs({
      endpoint: "https://account.r2.cloudflarestorage.com", bucket: "b", accessKeyId: "k", secretAccessKey: "s",
    }, async () => new Response(null, { status: 503 }));
    await expect(blobs.putBlob(stream("x"), 10)).rejects.toMatchObject({ name: "R2EvidenceError", retryable: true, status: 503 });
  });
});
