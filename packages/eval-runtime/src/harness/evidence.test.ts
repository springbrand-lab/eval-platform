import {
  DEFAULT_EVIDENCE_LIMITS, SP_PI_TRAJECTORY_FORMAT, sha256Hex, type EvidenceExportProgress, type EvidenceLimits,
} from "@eval-platform/eval-contracts";
import { describe, expect, it } from "vitest";

import { applyEvidenceLimits, createEvidenceStore, EvidenceIntegrityError } from "./evidence.js";
import { createMemoryEvidenceBlobs, exportedEvidence, testClock } from "./evidence-test-support.js";

const NOW = "2026-10-15T00:00:00.000Z";

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe("evidence limits", () => {
  const limits: EvidenceLimits = { maxFileBytes: 10, maxTotalBytes: 15, maxFiles: 2, excludedSegments: ["node_modules"] };

  it("keeps a stable path-ordered prefix and reports everything it leaves out", () => {
    expect(applyEvidenceLimits([
      { path: "/z.txt", size: 1, mediaType: "text/plain" },
      { path: "/node_modules/a/index.js", size: 1, mediaType: "text/javascript" },
      { path: "/big.bin", size: 11, mediaType: "application/octet-stream" },
      { path: "/a.txt", size: 8, mediaType: "text/plain" },
      { path: "/b.txt", size: 8, mediaType: "text/plain" },
    ], limits)).toEqual({
      artifacts: [
        { path: "/a.txt", size: 8, mediaType: "text/plain" },
        { path: "/z.txt", size: 1, mediaType: "text/plain" },
      ],
      omitted: [
        { path: "/b.txt", reason: "limit" },
        { path: "/big.bin", reason: "too-large" },
        { path: "/node_modules/a/index.js", reason: "excluded" },
      ],
    });
  });
});

describe("evidence store", () => {
  it("stores content once per hash and opens the same manifest by reference", async () => {
    const blobs = createMemoryEvidenceBlobs();
    const store = createEvidenceStore(blobs, () => NOW);
    const files = { "/index.html": "<h1>Hi</h1>", "/copy.html": "<h1>Hi</h1>" };
    const ref = await store.resume({ evidence: exportedEvidence({ samplingId: "s-1", files }), limits: DEFAULT_EVIDENCE_LIMITS });

    expect(ref).toEqual({ evidenceId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u), manifestSha256: expect.any(String), exportedAt: NOW });
    // Two identical files plus the trajectory.
    expect(blobs.blobs.size).toBe(2);
    const opened = await store.open(ref);
    expect(opened.manifest).toMatchObject({
      schemaVersion: 2,
      evidenceId: ref.evidenceId,
      source: { framework: "sp", samplingId: "s-1", exportedAt: NOW },
      artifacts: [
        { path: "/index.html", size: 11, mediaType: "text/html", sha256: await sha256Hex("<h1>Hi</h1>") },
        { path: "/copy.html", size: 11, mediaType: "text/html", sha256: await sha256Hex("<h1>Hi</h1>") },
      ],
      subjectInputs: [],
      trajectory: { format: SP_PI_TRAJECTORY_FORMAT, records: 1, complete: true },
      omitted: [],
    });
    expect(await sha256Hex(opened.manifestBytes)).toBe(ref.manifestSha256);
    await expect(text(await opened.readBlob(opened.manifest.artifacts[0]!.sha256))).resolves.toBe("<h1>Hi</h1>");
    const trajectory = await text(await opened.readBlob(opened.manifest.trajectory.parts[0]!.sha256));
    expect(trajectory.trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([
      { ingestSeq: 1, record: { format: "pi-trajectory/v1", projection: { kind: "safe" }, kind: "event",
        event: { type: "agent_start" } } },
    ]);

    // The same export at the same moment is the same bundle.
    await expect(store.resume({ evidence: exportedEvidence({ samplingId: "s-1", files }), limits: DEFAULT_EVIDENCE_LIMITS }))
      .resolves.toEqual(ref);
  });

  it("refuses a reference whose manifest or blobs do not match", async () => {
    const blobs = createMemoryEvidenceBlobs();
    const store = createEvidenceStore(blobs, () => NOW);
    const ref = await store.resume({ evidence: exportedEvidence({ samplingId: "s-2" }), limits: DEFAULT_EVIDENCE_LIMITS });

    await expect(store.open({ ...ref, manifestSha256: "0".repeat(64) })).rejects.toBeInstanceOf(EvidenceIntegrityError);
    await expect(store.open({ ...ref, evidenceId: `sha256:${"1".repeat(64)}` })).rejects.toThrow(/not found/u);
    await expect(store.open({ ...ref, evidenceId: "not-a-hash" })).rejects.toThrow(/Invalid evidence ID/u);
    const opened = await store.open(ref);
    await expect(opened.readBlob("2".repeat(64))).rejects.toThrow(/missing blob/u);
  });

  it("freezes a verified empty native trajectory without manufacturing an event line", async () => {
    const store = createEvidenceStore(createMemoryEvidenceBlobs(), () => NOW);
    const opened = await store.open(await store.resume({
      evidence: exportedEvidence({ samplingId: "empty", files: {}, events: [] }),
      limits: DEFAULT_EVIDENCE_LIMITS,
    }));
    expect(opened.manifest.trajectory).toEqual({
      format: SP_PI_TRAJECTORY_FORMAT, parts: [], records: 0, complete: true,
    });
  });

  it("rejects a file larger than the per-file limit", async () => {
    const store = createEvidenceStore(createMemoryEvidenceBlobs(), () => NOW);
    await expect(store.resume({
      evidence: exportedEvidence({ samplingId: "s-3", files: { "/a.txt": "0123456789" } }),
      limits: { ...DEFAULT_EVIDENCE_LIMITS, maxFileBytes: 4 },
    })).rejects.toThrow(/too large/u);
  });

  it("splits raw native trajectory on whole record boundaries and keeps original input bytes", async () => {
    const blobs = createMemoryEvidenceBlobs();
    const store = createEvidenceStore(blobs, () => NOW);
    const events = Array.from({ length: 5 }, (_, index) => ({ ingestSeq: index + 1,
      record: { format: "pi-trajectory/v1", projection: { kind: "safe" }, kind: "message",
        message: { role: "user", content: `原始-${index}`, timestamp: index } } }));
    const maxFileBytes = new TextEncoder().encode(`${JSON.stringify(events[0])}\n`).byteLength * 2;
    const evidence = {
      ...exportedEvidence({ samplingId: "split", files: {}, events }),
      subjectInputs: [{ bundleId: "bundle", materialId: "material", path: "/brief.txt", mediaType: "text/plain", size: 8,
        read: async () => new Response("original").body! }],
    };
    const opened = await store.open(await store.resume({ evidence, limits: { ...DEFAULT_EVIDENCE_LIMITS, maxFileBytes } }));
    expect(opened.manifest.trajectory.parts.map((part) => part.records)).toEqual([2, 2, 1]);
    const saved: unknown[] = [];
    for (const part of opened.manifest.trajectory.parts) {
      expect(part.size).toBeLessThanOrEqual(maxFileBytes);
      saved.push(...(await text(await opened.readBlob(part.sha256))).trimEnd().split("\n").map((line) => JSON.parse(line)));
    }
    expect(saved).toEqual(events);
    expect(await text(await opened.readBlob(opened.manifest.subjectInputs[0]!.sha256))).toBe("original");
  });

  it("fails explicitly on a single oversized native record, before storing any part", async () => {
    const blobs = createMemoryEvidenceBlobs();
    const evidence = exportedEvidence({ samplingId: "large", files: {}, events: [
      { ingestSeq: 1, record: { format: "pi-trajectory/v1", projection: { kind: "safe" }, kind: "event",
        event: { type: "agent_start" } } },
      { ingestSeq: 2, record: { format: "pi-trajectory/v1", projection: { kind: "safe" }, kind: "message",
        message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "x".repeat(100) }] } } },
    ] });
    const store = createEvidenceStore(blobs, () => NOW);
    const failure = () => store.resume({ evidence, limits: { ...DEFAULT_EVIDENCE_LIMITS, maxFileBytes: 150 } });
    await expect(failure()).rejects.toThrow(/Trajectory record 2 is \d+ bytes, above the 150-byte evidence file limit/u);
    await expect(failure()).rejects.toMatchObject({ retryable: false });
    expect(blobs.blobs.size).toBe(0);
    expect(blobs.manifests.size).toBe(0);
  });

  it("refuses incomplete native history and an over-budget complete history without omitting records", async () => {
    const blobs = createMemoryEvidenceBlobs();
    const store = createEvidenceStore(blobs, () => NOW);
    const raw = exportedEvidence({ samplingId: "bounded", files: {}, events: [
      { ingestSeq: 1, record: { format: "pi-trajectory/v1", projection: { kind: "safe" }, kind: "event",
        event: { type: "agent_start", note: "x".repeat(40) } } },
      { ingestSeq: 2, record: { format: "pi-trajectory/v1", projection: { kind: "safe" }, kind: "event",
        event: { type: "agent_end", note: "x".repeat(40) } } },
    ] });
    await expect(store.resume({ evidence: { ...raw, trajectoryComplete: false,
      trajectoryIncompleteReason: "source still delivering" }, limits: DEFAULT_EVIDENCE_LIMITS }))
      .rejects.toThrow(/Cannot export an incomplete native trajectory/u);
    expect(blobs.blobs.size).toBe(0);
    const maxFileBytes = new TextEncoder().encode(`${JSON.stringify({
      ingestSeq: 1, record: { format: "pi-trajectory/v1", projection: { kind: "safe" }, kind: "event",
        event: { type: "agent_start", note: "x".repeat(40) } },
    })}\n`).byteLength;
    await expect(store.resume({ evidence: raw, limits: {
      ...DEFAULT_EVIDENCE_LIMITS, maxFileBytes, maxTotalBytes: maxFileBytes,
    } })).rejects.toThrow(/Complete native trajectory exceeds the evidence limit/u);
    expect(blobs.blobs.size).toBe(1);
    expect(blobs.manifests.size).toBe(0);
  });
});

describe("resumable evidence export", () => {
  const events = Array.from({ length: 5 }, (_, index) => ({ ingestSeq: index + 1,
    record: { format: "pi-trajectory/v1", projection: { kind: "safe" }, kind: "event",
      event: { type: "agent_start", index } } }));
  const limits = { ...DEFAULT_EVIDENCE_LIMITS, maxFileBytes: new TextEncoder().encode(`${JSON.stringify(events[0])}\n`).byteLength * 2 };
  const files = { "/a.txt": "first", "/b.txt": "second", "/c.txt": "third" };

  it("persists the first page's watermark even if delivery fails before any part can be written", async () => {
    const records = [1, 2].map((seq) => ({ ingestSeq: seq,
      record: { format: "pi-trajectory/v1", projection: { kind: "safe" }, kind: "event",
        event: { type: "agent_start", seq } } }));
    const base = exportedEvidence({ samplingId: "first-page", files: {}, events: records });
    const reads: { afterSeq: number; throughSeq: number | undefined }[] = [];
    let fail = true;
    const evidence = { ...base, async* readTrajectory(afterSeq: number, throughSeq?: number) {
      reads.push({ afterSeq, throughSeq });
      for await (const entry of base.readTrajectory(afterSeq, throughSeq)) {
        if (entry.seq === 2 && fail) { fail = false; throw new Error("first page disconnected"); }
        yield entry;
      }
    } };
    const blobs = createMemoryEvidenceBlobs();
    const store = createEvidenceStore(blobs, () => NOW);
    let progress: EvidenceExportProgress | undefined;
    const onProgress = async (next: EvidenceExportProgress) => { progress = next; };
    await expect(store.resume({ evidence, limits: DEFAULT_EVIDENCE_LIMITS, onProgress }))
      .rejects.toThrow(/first page disconnected/u);
    expect(progress?.trajectory).toEqual({
      format: SP_PI_TRAJECTORY_FORMAT, throughSeq: 2, afterSeq: 0, parts: [],
    });
    expect(blobs.blobs.size).toBe(0);
    records.push({ ingestSeq: 3, record: { format: "pi-trajectory/v1", projection: { kind: "safe" },
      kind: "event", event: { type: "agent_start", seq: 3 } } });
    const opened = await store.open(await store.resume({
      evidence, limits: DEFAULT_EVIDENCE_LIMITS, progress: progress!, onProgress,
    }));
    expect(reads).toEqual([{ afterSeq: 0, throughSeq: undefined }, { afterSeq: 0, throughSeq: 2 }]);
    expect(opened.manifest.trajectory.records).toBe(2);
    expect((await text(await opened.readBlob(opened.manifest.trajectory.parts[0]!.sha256)))
      .trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual(records.slice(0, 2));
  });

  it("persists each completed step and stores only what the saved progress lacks", async () => {
    const blobs = createMemoryEvidenceBlobs();
    const store = createEvidenceStore(blobs, testClock(NOW, 1_000).now);
    const reads: string[] = [];
    const cursors: number[] = [];
    let failB = true;
    let failAfter: number | undefined = 3;
    const base = exportedEvidence({ samplingId: "resume", files, events });
    const evidence = {
      ...base,
      async readFile(path: string) {
        reads.push(path);
        if (path === "/b.txt" && failB) {
          failB = false;
          throw new Error("file unavailable");
        }
        return base.readFile(path);
      },
      async* readTrajectory(afterSeq: number, throughSeq?: number) {
        cursors.push(afterSeq);
        for await (const event of base.readTrajectory(afterSeq, throughSeq)) {
          if (failAfter !== undefined && event.seq > failAfter) {
            failAfter = undefined;
            throw new Error("page unavailable");
          }
          yield event;
        }
      },
    };
    const saved: EvidenceExportProgress[] = [];
    const onProgress = async (progress: EvidenceExportProgress) => { saved.push(structuredClone(progress)); };

    await expect(store.resume({ evidence, limits, onProgress })).rejects.toThrow(/file unavailable/u);
    const afterFiles = saved.at(-1)!;
    expect(afterFiles.artifacts.map((artifact) => artifact.sha256 !== undefined)).toEqual([true, false, true]);
    expect(afterFiles.trajectory).toEqual({ format: SP_PI_TRAJECTORY_FORMAT, afterSeq: 0, parts: [] });

    reads.length = 0;
    await expect(store.resume({ evidence, limits, progress: afterFiles, onProgress })).rejects.toThrow(/page unavailable/u);
    expect(reads).toEqual(["/b.txt"]);
    const afterPage = saved.at(-1)!;
    expect(afterPage.trajectory).toMatchObject({ throughSeq: 5, afterSeq: 2, parts: [{ records: 2 }] });
    expect(afterPage.trajectory.done).toBeUndefined();

    reads.length = 0;
    const ref = await store.resume({ evidence, limits, progress: afterPage, onProgress });
    expect(reads).toEqual([]);
    expect(cursors).toEqual([0, 2]);
    expect(saved.at(-1)!.trajectory).toMatchObject({ afterSeq: 5, done: true });

    // The same bundle as one uninterrupted export at the same moment.
    const uninterrupted = await createEvidenceStore(createMemoryEvidenceBlobs(), () => afterFiles.exportedAt)
      .resume({ evidence: exportedEvidence({ samplingId: "resume", files, events }), limits });
    expect(ref).toEqual(uninterrupted);
    expect(ref.exportedAt).toBe(afterFiles.exportedAt);
  });

  it("finalizes the same manifest when a written manifest's response was lost", async () => {
    const blobs = createMemoryEvidenceBlobs();
    const putManifest = blobs.putManifest.bind(blobs);
    let lose = true;
    blobs.putManifest = async (hex, bytes) => {
      await putManifest(hex, bytes);
      if (lose) {
        lose = false;
        throw new Error("response lost");
      }
    };
    const store = createEvidenceStore(blobs, testClock(NOW, 1_000).now);
    let progress: EvidenceExportProgress | undefined;
    const evidence = exportedEvidence({ samplingId: "lost", files, events });
    await expect(store.resume({ evidence, limits, onProgress: async (next) => { progress = next; } })).rejects.toThrow(/response lost/u);
    const ref = await store.resume({ evidence, limits, progress: progress!, onProgress: async (next) => { progress = next; } });
    expect([...blobs.manifests.keys()]).toEqual([ref.evidenceId.slice("sha256:".length)]);
  });

  it("refuses saved progress whose stored bytes no longer match the listing", async () => {
    const store = createEvidenceStore(createMemoryEvidenceBlobs(), () => NOW);
    const evidence = exportedEvidence({ samplingId: "changed", files: { "/a.txt": "first" } });
    await expect(store.resume({ evidence, limits, progress: {
      exportedAt: NOW, artifacts: [{ path: "/a.txt", size: 99, mediaType: "text/html" }], subjectInputs: [], omitted: [],
      trajectory: { format: SP_PI_TRAJECTORY_FORMAT, afterSeq: 0, parts: [] },
    } })).rejects.toBeInstanceOf(EvidenceIntegrityError);
  });

  it("keeps version 1 manifest bytes/ref immutable and rejects event-only progress before any new writes", async () => {
    const blobs = createMemoryEvidenceBlobs();
    const store = createEvidenceStore(blobs, () => NOW);
    const oldBytes = new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1, evidenceId: `sha256:${"a".repeat(64)}`,
      trajectory: { format: "sp-trajectory/v1" },
    }));
    const ref = { evidenceId: `sha256:${"a".repeat(64)}`, manifestSha256: await sha256Hex(oldBytes), exportedAt: NOW };
    await blobs.putManifest("a".repeat(64), oldBytes);
    await expect(store.open(ref)).rejects.toThrow(/unsupported manifest schema version 1/u);
    expect(await blobs.readManifest("a".repeat(64))).toEqual(oldBytes);
    const oldProgress = { exportedAt: NOW, artifacts: [], subjectInputs: [], omitted: [],
      trajectory: { afterSeq: 1, parts: [{ sha256: "b".repeat(64), size: 8, events: 1 }] } } as unknown as EvidenceExportProgress;
    await expect(store.resume({ evidence: exportedEvidence({ samplingId: "old", files: {} }), limits, progress: oldProgress }))
      .rejects.toThrow(/Cannot resume non-native/u);
    expect(blobs.blobs.size).toBe(0);
    expect(blobs.manifests.size).toBe(1);
  });
});
