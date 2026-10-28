import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SP_PI_TRAJECTORY_FORMAT, type NativeTrajectoryEntry } from "@eval-platform/eval-contracts";
import { createEvidenceStore, type AgentHandle, type ExportedTrajectoryPage } from "@eval-platform/eval-runtime/harness";
import { EVAL_EVIDENCE_FILE_MAX_BYTES, evalEvidencePath } from "@springbrand/eval-harness";
import { describe, expect, it } from "vitest";
import { openLocalEvidenceBlobs } from "../evidence/local-blobs.js";
import { createSpHarness, MAX_TRAJECTORY_PAGE_BYTES } from "./harness.js";
import { finalReplyText } from "./harness-wire.js";
import {
  nativeAssistantMessage, nativeFixture, nativeFixtureRecords, nativeTransfer, nativeTransferResponse,
  streamedAssistantTransfer,
} from "./native-test-fixture.js";

const subject: AgentHandle = {
  ownerUserId: "11111111-1111-4111-8111-111111111111", chatId: "22222222-2222-4222-8222-222222222222",
  samplingId: "sampling", role: "subject", framework: "sp",
};
const evaluator: AgentHandle = { ...subject, chatId: "33333333-3333-4333-8333-333333333333", role: "evaluator", evaluationId: "evaluation" };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const limits = { maxFileBytes: 1_200, maxTotalBytes: 15_000, maxFiles: 20, excludedSegments: [] };
const native = (seq: number, chatId = subject.chatId, submissionId = "submission-1") => nativeFixture(seq, chatId, submissionId);
const asContext = (entry: NativeTrajectoryEntry): NativeTrajectoryEntry => ({
  ...entry, record: { ...entry.record, submissionId: null, origin: "context" },
});
const page = (records: readonly unknown[], throughSeq: number, nextAfterSeq: number | null) => ({
  format: SP_PI_TRAJECTORY_FORMAT, cursor: { throughSeq }, records, nextAfterSeq,
});
const read = async (items: AsyncIterable<ExportedTrajectoryPage>) => {
  const records = [];
  for await (const page of items) {
    for (const row of page.records) {
      records.push({ seq: row.seq, throughSeq: page.throughSeq,
        record: JSON.parse(await new Response(await row.readJsonl()).text()) as unknown });
    }
  }
  return records;
};

describe("SP Pi-native evidence export, persistence and import", () => {
  it("hydrates an authenticated 5+ MiB SAFE Pi reference before unchanged JSONL, manifest and scoped final reply", async () => {
    const submissionId = "11111111-1111-4111-8111-111111111111";
    const context = asContext(native(1));
    const earlier = nativeAssistantMessage(2, subject.chatId, "earlier-submission",
      [{ type: "text", text: "汉🌎é".repeat(650_000) }]);
    const current = nativeAssistantMessage(3, subject.chatId, submissionId, [{ type: "text", text: "current answer" }]);
    const { reference, bytes } = nativeTransfer(earlier, 3);
    expect(bytes.byteLength).toBeGreaterThan(5 * 1024 * 1024);
    const requests: URL[] = [];
    const imported: { path: string; bytes: Uint8Array }[] = [];
    const harness = createSpHarness({
      origin: "https://sp.test", serviceToken: "service",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        expect(request.headers.get("X-Eval-Service-Token")).toBe("service");
        const url = new URL(request.url);
        requests.push(url);
        if (request.method === "PUT") {
          const uploaded = new Uint8Array(await request.arrayBuffer());
          const relative = url.searchParams.get("path")!;
          expect(request.headers.get("X-Eval-Content-Sha256")).toBe(hash(uploaded));
          imported.push({ path: relative, bytes: uploaded });
          return Response.json({ path: evalEvidencePath(relative), size: uploaded.byteLength, sha256: hash(uploaded) });
        }
        if (url.pathname.endsWith("/artifacts")) return Response.json({ artifacts: [] });
        if (url.pathname.endsWith(`/trajectory/records/${reference.ingestSeq}`)) {
          expect(url.searchParams.get("submissionId")).toBe(submissionId);
          expect(url.searchParams.get("throughSeq")).toBe("3");
          expect(url.searchParams.get("identity")).toBe(reference.reference.identity);
          expect(url.searchParams.get("byteLength")).toBe(String(bytes.byteLength));
          expect(url.searchParams.get("sha256")).toBe(reference.reference.sha256);
          return nativeTransferResponse(reference, bytes);
        }
        expect(url.pathname.endsWith("/evidence/trajectory")).toBe(true);
        expect(url.searchParams.get("submissionId")).toBe(submissionId);
        const after = url.searchParams.get("afterSeq");
        expect(url.searchParams.get("throughSeq")).toBe(after === "0" ? null : "3");
        return Response.json(after === "0" ? page([context, reference], 3, 2)
          : after === "1" ? page([reference, current], 3, null)
            : page([current], 3, null));
      },
    });
    const root = await mkdtemp(join(tmpdir(), "eval-large-native-reference-"));
    const largeLimits = { ...limits, maxFileBytes: 9_000_000, maxTotalBytes: 18_000_000 };
    try {
      const store = createEvidenceStore(await openLocalEvidenceBlobs(root));
      const exported = await harness.exportEvidence({ handle: subject, submissionId, limits: largeLimits });
      const evidence = await store.open(await store.resume({ evidence: exported, limits: largeLimits }));
      expect(evidence.manifest).toMatchObject({
        schemaVersion: 2,
        trajectory: { format: SP_PI_TRAJECTORY_FORMAT, records: 3, complete: true },
      });
      expect(evidence.manifest.trajectory.parts).toHaveLength(1);
      const part = evidence.manifest.trajectory.parts[0]!;
      expect(part.size).toBeLessThan(EVAL_EVIDENCE_FILE_MAX_BYTES);
      const stored = await evidence.readBlob(part.sha256);
      expect(stored).toBeDefined();
      const jsonl = new TextDecoder().decode(await new Response(stored!).arrayBuffer());
      expect(jsonl).toBe([context, earlier, current].map((entry) => `${JSON.stringify(entry)}\n`).join(""));
      expect(part).toMatchObject({ sha256: hash(new TextEncoder().encode(jsonl)), records: 3 });
      expect(await read(exported.readTrajectory(1, 3))).toEqual([
        { seq: 2, throughSeq: 3, record: earlier },
        { seq: 3, throughSeq: 3, record: current },
      ]);
      expect(await harness.readFinalReply({ handle: subject, submissionId })).toBe("current answer");
      await harness.importEvidence({ handle: evaluator, idempotencyKey: "evidence", evidence, root: "/evidence" });
      expect(imported.map(({ path }) => path)).toEqual(["/trajectory/events-000001.jsonl", "/manifest.json"]);
      expect(new TextDecoder().decode(imported[0]!.bytes)).toBe(jsonl);
      expect(imported[1]!.bytes).toEqual(evidence.manifestBytes);
      expect(requests.filter((item) => item.pathname.endsWith(`/trajectory/records/${reference.ingestSeq}`)).length)
        .toBeGreaterThanOrEqual(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("streams a 30+ MiB immutable SAFE Pi JSONL record from the authenticated GET into one evidence blob without a whole-body object", async () => {
    const submissionId = "11111111-1111-4111-8111-111111111111";
    const { reference, recordLength, fileSha256, response } = streamedAssistantTransfer(subject.chatId, submissionId);
    expect(recordLength).toBeGreaterThan(30 * 1024 * 1024);
    let frozen: number | undefined;
    let readRequests = 0;
    const harness = createSpHarness({
      origin: "https://sp.test", serviceToken: "service",
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        if (url.pathname.endsWith("/artifacts")) return Response.json({ artifacts: [] });
        if (url.pathname.endsWith("/evidence/trajectory")) return Response.json(page([reference], 14, null));
        expect(url.pathname.endsWith("/trajectory/records/14")).toBe(true);
        expect(url.searchParams.get("submissionId")).toBe(submissionId);
        expect(frozen).toBe(14);
        readRequests++;
        return response();
      },
    });
    const root = await mkdtemp(join(tmpdir(), "eval-30m-native-evidence-"));
    try {
      const store = createEvidenceStore(await openLocalEvidenceBlobs(root));
      const exported = await harness.exportEvidence({ handle: subject, submissionId,
        limits: { ...limits, maxFileBytes: EVAL_EVIDENCE_FILE_MAX_BYTES, maxTotalBytes: 100_000_000 } });
      const bundle = await store.open(await store.resume({
        evidence: exported, limits: { ...limits, maxFileBytes: EVAL_EVIDENCE_FILE_MAX_BYTES, maxTotalBytes: 100_000_000 },
        onProgress: async (progress) => { frozen = progress.trajectory.throughSeq; },
      }));
      const [part] = bundle.manifest.trajectory.parts;
      expect(part).toMatchObject({ sha256: fileSha256, size: recordLength + Buffer.byteLength('{"ingestSeq":14,"record":}\n'), records: 1 });
      const received = createHash("sha256");
      let size = 0;
      for await (const chunk of await bundle.readBlob(part!.sha256)) { size += chunk.byteLength; received.update(chunk); }
      expect(size).toBe(part!.size);
      expect(received.digest("hex")).toBe(part!.sha256);
      expect(readRequests).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it("replays a failed large-record GET against EvidenceStore's persisted high-water mark", async () => {
    const submissionId = "11111111-1111-4111-8111-111111111111";
    const context = asContext(native(1));
    const large = nativeAssistantMessage(2, subject.chatId, "earlier-submission",
      [{ type: "text", text: "🌎汉".repeat(800_000) }]);
    const { reference, bytes } = nativeTransfer(large, 2);
    expect(bytes.byteLength).toBeGreaterThan(5 * 1024 * 1024);
    const cursors: (string | null)[] = [];
    let transfers = 0;
    const harness = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        expect(request.headers.get("X-Eval-Service-Token")).toBe("service");
        const url = new URL(request.url);
        if (url.pathname.endsWith("/artifacts")) return Response.json({ artifacts: [] });
        if (url.pathname.endsWith(`/trajectory/records/${reference.ingestSeq}`)) {
          expect(url.searchParams.get("throughSeq")).toBe("2");
          expect(url.searchParams.get("submissionId")).toBe(submissionId);
          transfers++;
          return transfers === 1
            ? Response.json({ code: "EVIDENCE_NOT_READY", errMsg: "Retry later" },
              { status: 409, headers: { "Retry-After": "5" } })
            : nativeTransferResponse(reference, bytes);
        }
        cursors.push(url.searchParams.get("throughSeq"));
        return Response.json(page([context, reference], 2, null));
      } });
    const root = await mkdtemp(join(tmpdir(), "eval-large-native-replay-"));
    const largeLimits = { ...limits, maxFileBytes: 9_000_000, maxTotalBytes: 18_000_000 };
    try {
      const store = createEvidenceStore(await openLocalEvidenceBlobs(root));
      const exported = await harness.exportEvidence({ handle: subject, submissionId, limits: largeLimits });
      let saved: Parameters<typeof store.resume>[0]["progress"];
      const onProgress = async (value: NonNullable<typeof saved>) => { saved = value; };
      await expect(store.resume({ evidence: exported, limits: largeLimits, onProgress }))
        .rejects.toMatchObject({ name: "SpHarnessError", status: 409, retryable: true });
      expect(saved?.trajectory).toMatchObject({ throughSeq: 2, afterSeq: 0, parts: [] });
      expect(saved?.trajectory.done).not.toBe(true);
      if (!saved) throw new Error("EvidenceStore did not persist the frozen trajectory cutoff");
      const evidence = await store.open(await store.resume({ evidence: exported, limits: largeLimits,
        progress: saved, onProgress }));
      expect(evidence.manifest.trajectory).toMatchObject({ records: 2, complete: true });
      expect(cursors).toEqual([null, "2"]); // Retry does not adopt a new Chat head.
      expect(transfers).toBe(2);
      const stored = await evidence.readBlob(evidence.manifest.trajectory.parts[0]!.sha256);
      expect(new TextDecoder().decode(await new Response(stored!).arrayBuffer()))
        .toBe(`${JSON.stringify(context)}\n${JSON.stringify(large)}\n`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("preserves Subject inputs and complete native JSONL through bounded parts, service auth and a frozen high-water mark", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-native-evidence-roundtrip-"));
    try {
      const records = [
        asContext(native(1)),
        ...nativeFixtureRecords([2, 3], subject.chatId, "earlier-submission"),
        ...nativeFixtureRecords([4, 5, 6, 7, 8], subject.chatId, "submission-1"),
      ];
      const imported: { path: string; bytes: Uint8Array }[] = [];
      const cursors: { after: string | null; through: string | null; token: string | null }[] = [];
      const materials = [{ bundleId: "bundle-1", materialId: "material-1" }, { bundleId: "bundle-2", materialId: "material-2" }];
      const harness = createSpHarness({
        origin: "https://sp.test", serviceToken: "service",
        resolveInitialMaterials: async (_owner, ref) => [{ path: "/same.txt", mediaType: "text/plain",
          contentBase64: Buffer.from(`original ${ref.materialId}`).toString("base64") }],
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          if (request.method === "PUT") {
            const bytes = new Uint8Array(await request.arrayBuffer());
            const path = url.searchParams.get("path")!;
            imported.push({ path, bytes });
            expect(request.headers.get("X-Eval-Content-Sha256")).toBe(hash(bytes));
            return Response.json({ path: evalEvidencePath(path), size: bytes.byteLength, sha256: hash(bytes) });
          }
          expect(request.headers.get("X-Eval-Service-Token")).toBe("service");
          if (url.pathname.endsWith("/artifacts")) return Response.json({ artifacts: [{ path: "/site.html", size: 4, mediaType: "text/html" }] });
          if (url.pathname.endsWith("/files")) return new Response("site");
          cursors.push({ after: url.searchParams.get("afterSeq"), through: url.searchParams.get("throughSeq"),
            token: url.searchParams.get("submissionId") });
          return Response.json(cursors.length === 1 ? page(records.slice(0, 4), 8, 4) : page(records.slice(4), 8, null));
        },
      });
      const store = createEvidenceStore(await openLocalEvidenceBlobs(root));
      const exported = await harness.exportEvidence({ handle: subject, submissionId: "submission-1", limits, initialMaterials: materials });
      const evidence = await store.open(await store.resume({ evidence: exported, limits }));
      expect(cursors).toEqual([{ after: "0", through: null, token: "submission-1" },
        { after: "4", through: "8", token: "submission-1" }]);
      expect(evidence.manifest.schemaVersion).toBe(2);
      expect(evidence.manifest.trajectory).toMatchObject({ format: SP_PI_TRAJECTORY_FORMAT, records: 8, complete: true });
      expect(evidence.manifest.trajectory.parts.length).toBeGreaterThan(1);
      await harness.importEvidence({ handle: evaluator, idempotencyKey: "evidence", evidence, root: "/evidence" });
      expect(imported.at(-1)?.path).toBe("/manifest.json");
      const trajectory = imported.filter((file) => file.path.startsWith("/trajectory/")).sort((a, b) => a.path.localeCompare(b.path));
      expect(trajectory.every((file) => file.bytes.byteLength <= limits.maxFileBytes)).toBe(true);
      expect(trajectory.flatMap((file) => new TextDecoder().decode(file.bytes).trimEnd().split("\n").map((line) => JSON.parse(line)))).toEqual(records);
      expect(trajectory.map((file) => new TextDecoder().decode(file.bytes)).join(""))
        .toBe(records.map((record) => `${JSON.stringify(record)}\n`).join(""));
      expect(trajectory.map((file) => hash(file.bytes))).toEqual(evidence.manifest.trajectory.parts.map((part) => part.sha256));
      for (const ref of materials) {
        const file = imported.find((item) => item.path === `/subject-inputs/${ref.bundleId}/${ref.materialId}/same.txt`);
        expect(new TextDecoder().decode(file!.bytes)).toBe(`original ${ref.materialId}`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["legacy page", { events: [{ ingestSeq: 1, event: { type: "turn.finished" } }], nextAfterSeq: null }],
    ["wrong wire", { ...page([native(1)], 1, null), format: "sp-trajectory/v1" }],
    ["legacy event in native envelope", { ...page([], 1, null), records: [{ ingestSeq: 1, record: { type: "turn.finished" } }] }],
    ["unsafe projection", page([{ ...native(1), record: { ...native(1).record,
      projection: { kind: "full", policyId: "test", policyVersion: 1 } } }], 1, null)],
    ["missing safe projection", page([{ ...native(1), record: { ...native(1).record, projection: undefined } }], 1, null)],
    ["forged local metric projection", page([{ ...native(1), metricProjection: { supported: true, facts: [] } }], 1, null)],
    ["backward cursor", page([native(1)], 1, 0)],
    ["out-of-order records", page([native(2), native(1)], 2, null)],
    ["duplicate inner sequence", page([{ ...native(1), record: { ...native(1).record, ingestSeq: 1 } }], 1, null)],
    ["different Chat", page([native(1, evaluator.chatId)], 1, null)],
    ["foreign parent Chat", page([{ ...native(1), record: { ...native(1).record,
      parent: { resource: { agentId: "agent-1", sessionId: evaluator.chatId }, submissionId: "earlier-submission" } } }], 1, null)],
  ])("rejects %s without mislabelling event JSON as Pi history", async (_name, invalid) => {
    const harness = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async (input) => Response.json(new URL(String(input instanceof Request ? input.url : input)).pathname.endsWith("/artifacts")
        ? { artifacts: [] } : invalid) });
    const exported = await harness.exportEvidence({ handle: subject, submissionId: "submission-1", limits });
    await expect(read(exported.readTrajectory(0))).rejects.toMatchObject({ name: "SpHarnessError", retryable: false });
  });

  it("rejects a page with a foreign Chat before yielding even its safe Context prefix", async () => {
    const harness = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async (input) => Response.json(new URL(String(input instanceof Request ? input.url : input)).pathname.endsWith("/artifacts")
        ? { artifacts: [] } : page([asContext(native(1)), native(2, evaluator.chatId)], 2, null)) });
    const exported = await harness.exportEvidence({ handle: subject, submissionId: "submission-1", limits });
    const iterator = exported.readTrajectory(0)[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({
      retryable: false, message: expect.stringContaining("outside the requested Chat"),
    });
  });

  it("rejects a foreign reference before yielding any earlier same-Chat Context or fetching bytes", async () => {
    const { reference } = nativeTransfer(native(2), 2);
    const foreign = { ...reference, reference: { ...reference.reference,
      identity: JSON.stringify(["agent-1", evaluator.chatId, "entry", 2]) } };
    let transfers = 0;
    const harness = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async (input) => {
        const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
        if (path.endsWith("/artifacts")) return Response.json({ artifacts: [] });
        if (path.includes("/trajectory/records/")) transfers++;
        return Response.json(page([asContext(native(1)), foreign], 2, null));
      } });
    const exported = await harness.exportEvidence({ handle: subject, submissionId: "submission-1", limits });
    await expect(exported.readTrajectory(0)[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      retryable: false, message: expect.stringContaining("outside the requested Chat"),
    });
    expect(transfers).toBe(0);
  });

  it.each(["corrupt-hash", "truncated", "overlong", "invalid-utf8",
    "wrong-header", "foreign-record", "foreign-parent", "partial"] as const)(
    "never marks a %s SAFE Pi record transfer complete or publishes a partial evidence manifest", async (failure) => {
      const original = nativeAssistantMessage(2, subject.chatId, "earlier-submission", [{ type: "text", text: "current answer" }]);
      const { reference: originalRef, bytes: originalBytes } = nativeTransfer(original, 2);
      let reference = originalRef;
      let bytes = originalBytes;
      if (failure === "invalid-utf8") {
        bytes = new Uint8Array(originalBytes);
        bytes[20] = 0xff;
        reference = { ...reference, reference: { ...reference.reference, sha256: hash(bytes) } };
      }
      if (failure === "foreign-record") {
        const foreign = nativeAssistantMessage(2, evaluator.chatId, "earlier-submission", [{ type: "text", text: "current answer" }]);
        const foreignTransfer = nativeTransfer(foreign, 2);
        bytes = foreignTransfer.bytes;
        reference = { ...reference, reference: { ...reference.reference,
          byteLength: bytes.byteLength, sha256: foreignTransfer.reference.reference.sha256 } };
      }
      if (failure === "foreign-parent") {
        const foreign = { ...original, record: { ...original.record, parent: {
          resource: { agentId: "foreign-agent", sessionId: evaluator.chatId }, submissionId: "earlier-submission",
        } } };
        const foreignTransfer = nativeTransfer(foreign, 2);
        bytes = foreignTransfer.bytes;
        reference = { ...reference, reference: { ...reference.reference,
          byteLength: bytes.byteLength, sha256: foreignTransfer.reference.reference.sha256 } };
      }
      let calls = 0;
      const harness = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
        fetch: async (input) => {
          const url = new URL(String(input instanceof Request ? input.url : input));
          if (url.pathname.endsWith("/artifacts")) return Response.json({ artifacts: [] });
          if (!url.pathname.includes("/trajectory/records/")) return Response.json(page([reference], 2, null));
          calls++;
          if (failure === "wrong-header") {
            return nativeTransferResponse(reference, bytes, { "X-Eval-Content-Sha256": "0".repeat(64) });
          }
          if (failure === "partial") {
            let sent = false;
            const stream = new ReadableStream<Uint8Array>({
              pull(controller) {
                if (sent) return controller.error(new Error("source disconnected"));
                controller.enqueue(bytes.subarray(0, 13));
                sent = true;
              },
            });
            return new Response(stream, { headers: nativeTransferResponse(reference, bytes).headers });
          }
          if (failure === "truncated") return nativeTransferResponse(reference, bytes.subarray(0, -1));
          if (failure === "overlong") {
            const extra = new Uint8Array(bytes.byteLength + 1);
            extra.set(bytes);
            extra[bytes.byteLength] = 0x20;
            return nativeTransferResponse(reference, extra);
          }
          if (failure === "corrupt-hash") {
            return nativeTransferResponse(reference, new TextEncoder().encode(
              new TextDecoder().decode(bytes).replace("current answer", "changed answer")));
          }
          return nativeTransferResponse(reference, bytes);
        } });
      const root = await mkdtemp(join(tmpdir(), `eval-unsafe-native-${failure}-`));
      try {
        const exported = await harness.exportEvidence({ handle: subject, submissionId: "submission-1", limits });
        const store = createEvidenceStore(await openLocalEvidenceBlobs(root));
        let saved: Parameters<typeof store.resume>[0]["progress"];
        await expect(store.resume({ evidence: exported, limits, onProgress: async (value) => { saved = value; } }))
          .rejects.toMatchObject({ name: "SpHarnessError", retryable: failure === "partial" || failure === "truncated" });
        expect(saved?.trajectory.done).not.toBe(true);
        expect(calls).toBe(1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects a reference too large for one unchanged evidence file before requesting its body", async () => {
    const { reference } = nativeTransfer(native(2), 2);
    const oversized = { ...reference, reference: { ...reference.reference, byteLength: EVAL_EVIDENCE_FILE_MAX_BYTES } };
    let transfers = 0;
    const harness = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async (input) => {
        const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
        if (path.endsWith("/artifacts")) return Response.json({ artifacts: [] });
        if (path.includes("/trajectory/records/")) transfers++;
        return Response.json(page([oversized], 2, null));
      } });
    const exported = await harness.exportEvidence({ handle: subject, submissionId: "submission-1", limits });
    await expect(read(exported.readTrajectory(0))).rejects.toMatchObject({ retryable: false });
    expect(transfers).toBe(0);
  });

  it.each([
    "Content-Type", "Content-Length", "X-Eval-Content-Sha256",
    "X-Eval-Trajectory-Identity", "X-Eval-Trajectory-Ingest-Seq", "X-Eval-Trajectory-Through-Seq",
  ])("refuses a native record response with an invalid %s header before treating it as evidence", async (header) => {
    const { reference, bytes } = nativeTransfer(native(2), 2);
    const harness = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async (input) => {
        const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
        return path.endsWith("/artifacts") ? Response.json({ artifacts: [] })
          : path.includes("/trajectory/records/")
            ? nativeTransferResponse(reference, bytes, { [header]: "incorrect" })
            : Response.json(page([reference], 2, null));
      } });
    const exported = await harness.exportEvidence({ handle: subject, submissionId: "submission-1", limits });
    await expect(read(exported.readTrajectory(0))).rejects.toMatchObject({
      retryable: false, message: expect.stringContaining("differs from its reference"),
    });
  });

  it.each([
    ["EVIDENCE_NOT_READY", true],
    ["REQUEST_CONFLICT", false],
  ] as const)("preserves SP's %s retry semantics for one authenticated record GET", async (code, retryable) => {
    const { reference } = nativeTransfer(native(2), 2);
    const harness = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async (input) => {
        const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
        return path.endsWith("/artifacts") ? Response.json({ artifacts: [] })
          : path.includes("/trajectory/records/")
            ? Response.json({ code, errMsg: "Cannot read native record", requestId: "sp-request-1" }, {
              status: 409, headers: { "Retry-After": "5", "X-Request-ID": "sp-request-1" },
            })
            : Response.json(page([reference], 2, null));
      } });
    const exported = await harness.exportEvidence({ handle: subject, submissionId: "submission-1", limits });
    await expect(read(exported.readTrajectory(0))).rejects.toMatchObject({
      retryable, status: 409, requestId: "sp-request-1",
    });
  });

  it("accepts a directly parented child, earlier same-Chat Submissions and a sparse frozen end", async () => {
    const earlierChild = native(7, subject.chatId, "earlier-child");
    Object.assign(earlierChild.record, { parent: {
      resource: { agentId: "agent-1", sessionId: subject.chatId }, submissionId: "earlier-submission",
    } });
    const child = native(8, subject.chatId, "child-submission");
    Object.assign(child.record, { parent: {
      resource: { agentId: "agent-1", sessionId: subject.chatId }, submissionId: "submission-1",
    } });
    const records = [native(3), native(5, subject.chatId, "earlier-submission"), earlierChild, child];
    const harness = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async (input) => Response.json(new URL(String(input instanceof Request ? input.url : input)).pathname.endsWith("/artifacts")
        ? { artifacts: [] } : page(records, 9, null)) });
    const exported = await harness.exportEvidence({ handle: subject, submissionId: "submission-1", limits });
    expect(await read(exported.readTrajectory(0))).toEqual(records.map((record) => ({
      seq: record.ingestSeq, throughSeq: 9, record,
    })));
  });

  it("rejects changed throughSeq and pages beyond the frozen mark, including a replayed cursor", async () => {
    const first = native(1);
    const second = native(2);
    for (const last of [page([second], 3, null), page([native(3)], 2, null)]) {
      const harness = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
        fetch: async (input) => {
          const url = new URL(String(input instanceof Request ? input.url : input));
          return Response.json(url.pathname.endsWith("/artifacts") ? { artifacts: [] }
            : url.searchParams.get("afterSeq") === "0" ? page([first], 2, 1) : last);
        } });
      const exported = await harness.exportEvidence({ handle: subject, submissionId: "submission-1", limits });
      await expect(read(exported.readTrajectory(0))).rejects.toMatchObject({ retryable: false });
    }
  });

  it("reads only the selected Submission's last native Pi assistant text, not an event or another Submission", async () => {
    const submissionId = "evaluation-submission";
    const current = nativeAssistantMessage(14, evaluator.chatId, submissionId, [
      { type: "thinking", thinking: "hidden" }, { type: "text", text: "final" }, { type: "text", text: "```json\n{}\n```" },
    ]);
    const context = asContext(nativeAssistantMessage(2, evaluator.chatId, submissionId, [{ type: "text", text: "initial Context" }]));
    const earlier = nativeAssistantMessage(5, evaluator.chatId, "earlier-submission", [{ type: "text", text: "earlier reply" }]);
    const records = [
      context,
      earlier,
      native(6, evaluator.chatId, submissionId),
      current,
      native(16, evaluator.chatId, submissionId),
      nativeAssistantMessage(18, evaluator.chatId, "later-submission", [{ type: "text", text: "later reply" }]),
    ];
    const urls: URL[] = [];
    const harness = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        urls.push(url);
        return Response.json(url.searchParams.get("afterSeq") === "0"
          ? page(records.slice(0, 4), 18, 14) : page(records.slice(4), 18, null));
      } });
    const reply = { handle: evaluator, submissionId };
    await expect(harness.readFinalReply(reply)).resolves.toBe("final\n```json\n{}\n```");
    expect(urls.map((url) => [url.pathname, url.searchParams.get("submissionId"), url.searchParams.get("throughSeq")]))
      .toEqual([
        [`/internal/v1/eval-harness/users/${evaluator.ownerUserId}/chats/${evaluator.chatId}/evidence/trajectory`,
          submissionId, null],
        [`/internal/v1/eval-harness/users/${evaluator.ownerUserId}/chats/${evaluator.chatId}/evidence/trajectory`,
          submissionId, "18"],
      ]);
    expect(finalReplyText(native(14, evaluator.chatId, "earlier-submission").record, submissionId)).toBeUndefined();
    const empty = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async () => Response.json(page([native(16, evaluator.chatId, submissionId)], 17, null)) });
    await expect(empty.readFinalReply(reply)).resolves.toBeUndefined();
    const omitted = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async () => Response.json(page([
        current, nativeAssistantMessage(17, evaluator.chatId, submissionId, [{ type: "text", text: "[CONTENT OMITTED]" }]),
      ], 17, null)) });
    await expect(omitted.readFinalReply(reply)).resolves.toBeUndefined();
    const thinkingOnly = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async () => Response.json(page([
        current, nativeAssistantMessage(17, evaluator.chatId, submissionId, [{ type: "thinking", thinking: "private" }]),
      ], 17, null)) });
    await expect(thinkingOnly.readFinalReply(reply)).resolves.toBeUndefined();
    const child = nativeAssistantMessage(17, evaluator.chatId, "child-submission", [{ type: "text", text: "child reply" }]);
    Object.assign(child.record, { parent: {
      resource: { agentId: "agent-1", sessionId: evaluator.chatId }, submissionId,
    } });
    const scoped = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async () => Response.json(page([current, child], 17, null)) });
    await expect(scoped.readFinalReply(reply)).resolves.toBe("final\n```json\n{}\n```");
    const historyOnly = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async () => Response.json(page([context, earlier], 5, null)) });
    await expect(historyOnly.readFinalReply(reply)).resolves.toBeUndefined();
    const foreignChat = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async () => Response.json(page([native(14, subject.chatId, submissionId)], 14, null)) });
    await expect(foreignChat.readFinalReply(reply)).rejects.toMatchObject({ retryable: false,
      message: expect.stringContaining("outside the requested Chat") });
  });

  it("does not substitute an earlier Evaluator reply when the last selected assistant is a large streamed native record", async () => {
    const submissionId = "11111111-1111-4111-8111-111111111111";
    const earlier = nativeAssistantMessage(13, evaluator.chatId, submissionId, [{ type: "text", text: "earlier" }]);
    const last = nativeAssistantMessage(14, evaluator.chatId, submissionId, [
      { type: "text", text: "汉🌎é".repeat(650_000) },
    ]);
    const { reference, bytes } = nativeTransfer(last, 14);
    expect(bytes.byteLength).toBeGreaterThan(5 * 1024 * 1024);
    const harness = createSpHarness({
      origin: "https://sp.test", serviceToken: "service",
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        return url.pathname.includes("/trajectory/records/")
          ? nativeTransferResponse(reference, bytes) : Response.json(page([earlier, reference], 14, null));
      },
    });
    await expect(harness.readFinalReply({ handle: evaluator, submissionId })).resolves.toBeUndefined();
  }, 30_000);

  it("bounds a JSON page by bytes and rejects an oversized individual record instead of truncating it", async () => {
    const oversized = nativeAssistantMessage(1, subject.chatId, "submission-1", [{ type: "text", text: "x".repeat(2_000) }]);
    const harness = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async (input) => Response.json(new URL(String(input instanceof Request ? input.url : input)).pathname.endsWith("/artifacts")
        ? { artifacts: [] } : page([oversized], 1, null)) });
    const evidence = await harness.exportEvidence({ handle: subject, submissionId: "submission-1", limits });
    const root = await mkdtemp(join(tmpdir(), "eval-native-record-limit-"));
    try {
      const store = createEvidenceStore(await openLocalEvidenceBlobs(root));
      await expect(store.resume({ evidence, limits: { ...limits, maxFileBytes: 500 } }))
        .rejects.toThrow(/Trajectory record 1 is \d+ bytes, above the 500-byte evidence file limit/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    const bounded = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      maxResponseBytes: 256, fetch: async () => Response.json(page([oversized], 1, null)) });
    await expect(bounded.readFinalReply({ handle: evaluator, submissionId: "submission-1" }))
      .rejects.toMatchObject({ retryable: false, message: "Eval SP evidence trajectory page exceeded the 256-byte response limit" });
    expect(MAX_TRAJECTORY_PAGE_BYTES).toBeLessThan(95_000_000);
  });

  it("refuses an oversized inline JSON page even when a separate record-reference transfer exists", async () => {
    const record = nativeAssistantMessage(1, subject.chatId, "submission-1",
      [{ type: "text", text: "x".repeat(MAX_TRAJECTORY_PAGE_BYTES) }]);
    const harness = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async (input) => Response.json(new URL(String(input instanceof Request ? input.url : input)).pathname.endsWith("/artifacts")
        ? { artifacts: [] } : page([record], 1, null)) });
    const exported = await harness.exportEvidence({ handle: subject, submissionId: "submission-1", limits });
    await expect(read(exported.readTrajectory(0))).rejects.toMatchObject({
      retryable: false,
      message: `Eval SP evidence trajectory page exceeded the ${MAX_TRAJECTORY_PAGE_BYTES}-byte response limit`,
    });
  });
});
