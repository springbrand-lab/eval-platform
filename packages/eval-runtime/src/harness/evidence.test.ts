import {
  DEFAULT_EVIDENCE_LIMITS, SP_PI_TRAJECTORY_FORMAT, sha256Hex, type EvidenceExportProgress, type EvidenceLimits,
} from "@eval-platform/eval-contracts";
import { describe, expect, it } from "vitest";

import { applyEvidenceLimits, createEvidenceStore, EvidenceIntegrityError } from "./evidence.js";
import { createMemoryEvidenceBlobs, exportedEvidence, publicAssistantRecord, publicNativeRecords, testClock } from "./evidence-test-support.js";

const NOW = "2026-10-15T00:00:00.000Z";
const SCOPE = { chatId: "chat-1", submissionId: "submission-1" };
const rows = (seqs: readonly number[]) => publicNativeRecords(seqs, SCOPE);
const bytes = (record: unknown) => new TextEncoder().encode(`${JSON.stringify(record)}\n`).byteLength;
const firstFive = rows([1, 2, 3, 4, 5]);
const twoRecordFileBytes = Math.max(bytes(firstFive[0]) + bytes(firstFive[1]),
  bytes(firstFive[2]) + bytes(firstFive[3]));

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
    expect(trajectory.trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual(rows([1]));

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
    const progress: EvidenceExportProgress[] = [];
    const opened = await store.open(await store.resume({
      evidence: exportedEvidence({ samplingId: "empty", files: {}, events: [] }),
      limits: DEFAULT_EVIDENCE_LIMITS,
      onProgress: async (next) => { progress.push(next); },
    }));
    expect(opened.manifest.trajectory).toEqual({
      format: SP_PI_TRAJECTORY_FORMAT, parts: [], records: 0, complete: true,
    });
    expect(progress.at(-1)?.trajectory).toEqual({
      format: SP_PI_TRAJECTORY_FORMAT, throughSeq: 0, cursor: { throughSeq: 0 },
      afterSeq: 0, parts: [], done: true,
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
    const events = rows([1, 2, 3, 4, 5]);
    const maxFileBytes = twoRecordFileBytes;
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
      ...rows([1]), publicAssistantRecord(2, SCOPE, "x".repeat(100)),
    ] });
    const store = createEvidenceStore(blobs, () => NOW);
    const failure = () => store.resume({ evidence, limits: { ...DEFAULT_EVIDENCE_LIMITS, maxFileBytes: 400 } });
    await expect(failure()).rejects.toThrow(/Trajectory record 2 is \d+ bytes, above the 400-byte evidence file limit/u);
    await expect(failure()).rejects.toMatchObject({ retryable: false });
    expect(blobs.blobs.size).toBe(0);
    expect(blobs.manifests.size).toBe(0);
  });

  it("refuses incomplete native history and an over-budget complete history without omitting records", async () => {
    const blobs = createMemoryEvidenceBlobs();
    const store = createEvidenceStore(blobs, () => NOW);
    const raw = exportedEvidence({ samplingId: "bounded", files: {}, events: rows([1, 2]) });
    await expect(store.resume({ evidence: { ...raw, trajectoryComplete: false,
      trajectoryIncompleteReason: "source still delivering" }, limits: DEFAULT_EVIDENCE_LIMITS }))
      .rejects.toThrow(/Cannot export an incomplete native trajectory/u);
    expect(blobs.blobs.size).toBe(0);
    const maxFileBytes = bytes(firstFive[1]);
    await expect(store.resume({ evidence: raw, limits: {
      ...DEFAULT_EVIDENCE_LIMITS, maxFileBytes, maxTotalBytes: maxFileBytes,
    } })).rejects.toThrow(/Complete native trajectory exceeds the evidence limit/u);
    expect(blobs.blobs.size).toBe(1);
    expect(blobs.manifests.size).toBe(0);
  });
});

describe("resumable evidence export", () => {
  const events = rows([1, 2, 3, 4, 5]);
  const limits = { ...DEFAULT_EVIDENCE_LIMITS, maxFileBytes: twoRecordFileBytes };
  const files = { "/a.txt": "first", "/b.txt": "second", "/c.txt": "third" };

  it("persists the first page's watermark even if delivery fails before any part can be written", async () => {
    const records = rows([1, 2]);
    const base = exportedEvidence({ samplingId: "first-page", files: {}, events: records });
    const reads: { afterSeq: number; throughSeq: number | undefined }[] = [];
    let fail = true;
    const evidence = { ...base, async* readTrajectory(afterSeq: number, throughSeq?: number) {
      reads.push({ afterSeq, throughSeq });
      for await (const page of base.readTrajectory(afterSeq, throughSeq)) {
        if (fail) {
          fail = false;
          yield { ...page, records: page.records.slice(0, 1), nextAfterSeq: page.records[0]!.seq };
          throw new Error("first page disconnected");
        }
        yield page;
      }
    } };
    const blobs = createMemoryEvidenceBlobs();
    const store = createEvidenceStore(blobs, () => NOW);
    let progress: EvidenceExportProgress | undefined;
    const onProgress = async (next: EvidenceExportProgress) => { progress = next; };
    await expect(store.resume({ evidence, limits: DEFAULT_EVIDENCE_LIMITS, onProgress }))
      .rejects.toThrow(/first page disconnected/u);
    expect(progress?.trajectory).toEqual({
      format: SP_PI_TRAJECTORY_FORMAT, throughSeq: 2, cursor: { throughSeq: 2 }, afterSeq: 0, parts: [],
    });
    expect(blobs.blobs.size).toBe(0);
    records.push(...rows([3]));
    const opened = await store.open(await store.resume({
      evidence, limits: DEFAULT_EVIDENCE_LIMITS, progress: progress!, onProgress,
    }));
    expect(reads).toEqual([{ afterSeq: 0, throughSeq: undefined }, { afterSeq: 0, throughSeq: 2 }]);
    expect(opened.manifest.trajectory.records).toBe(2);
    expect((await text(await opened.readBlob(opened.manifest.trajectory.parts[0]!.sha256)))
      .trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual(records.slice(0, 2));
  });

  it("never commits a short native line or a missing terminal page as complete evidence", async () => {
    const base = exportedEvidence({ samplingId: "incomplete", files: {}, events: rows([1, 2]) });
    for (const broken of ["short-line", "missing-terminal"] as const) {
      const blobs = createMemoryEvidenceBlobs();
      const store = createEvidenceStore(blobs, () => NOW);
      let progress: EvidenceExportProgress | undefined;
      const evidence = { ...base, async* readTrajectory(afterSeq: number, throughSeq?: number) {
        for await (const page of base.readTrajectory(afterSeq, throughSeq)) {
          if (broken === "short-line") {
            yield { ...page, records: page.records.map((record, index) => index === 0
              ? { ...record, readJsonl: async () => new Response("short").body! } : record) };
          } else {
            yield { ...page, records: page.records.slice(0, 1), nextAfterSeq: 1 };
          }
        }
      } };
      await expect(store.resume({ evidence, limits: DEFAULT_EVIDENCE_LIMITS,
        onProgress: async (next) => { progress = next; } })).rejects.toBeInstanceOf(EvidenceIntegrityError);
      expect(progress?.trajectory).toEqual({ format: SP_PI_TRAJECTORY_FORMAT, throughSeq: 2,
        cursor: { throughSeq: 2 }, afterSeq: 0, parts: [] });
      expect(blobs.blobs.size).toBe(0);
      expect(blobs.manifests.size).toBe(0);
      const resumed = await store.open(await store.resume({ evidence: base, limits: DEFAULT_EVIDENCE_LIMITS,
        progress: progress!, onProgress: async (next) => { progress = next; } }));
      expect(resumed.manifest.trajectory.records).toBe(2);
      expect(progress?.trajectory).toMatchObject({ afterSeq: 2, done: true });
    }
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
        for await (const page of base.readTrajectory(afterSeq, throughSeq)) {
          if (failAfter !== undefined && page.records.some((record) => record.seq > failAfter!)) {
            const records = page.records.filter((record) => record.seq <= failAfter!);
            failAfter = undefined;
            yield { ...page, records, nextAfterSeq: records.at(-1)!.seq };
            throw new Error("page unavailable");
          }
          yield page;
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

  describe("trajectory pin", () => {
    const pinned = (cursor?: { throughSeq: number }, format: string = SP_PI_TRAJECTORY_FORMAT) => ({
      ...exportedEvidence({ samplingId: "pinned", files, events }),
      trajectoryFormat: format,
      ...(cursor === undefined ? {} : { trajectoryCursor: cursor }),
    });

    it("saves the source's native format and cursor with new progress before any file read", async () => {
      const blobs = createMemoryEvidenceBlobs();
      const saved: EvidenceExportProgress[] = [];
      const ref = await createEvidenceStore(blobs, () => NOW).resume({
        evidence: pinned({ throughSeq: 5 }), limits,
        onProgress: async (progress) => { saved.push(structuredClone(progress)); },
      });
      expect(saved[0]!.trajectory).toEqual({ afterSeq: 0, parts: [], format: SP_PI_TRAJECTORY_FORMAT,
        throughSeq: 5, cursor: { throughSeq: 5 } });
      expect(saved.every((progress) => progress.trajectory.cursor?.throughSeq === 5
        && progress.trajectory.format === SP_PI_TRAJECTORY_FORMAT)).toBe(true);
      expect(saved.at(-1)!.trajectory).toMatchObject({ afterSeq: 5, done: true });
      expect((await createEvidenceStore(blobs).open(ref)).manifest.trajectory.format).toBe(SP_PI_TRAJECTORY_FORMAT);
    });

    it("stores and reads nothing before a new pin is persisted, so a failed first persist re-pins harmlessly", async () => {
      const blobs = createMemoryEvidenceBlobs();
      const store = createEvidenceStore(blobs, () => NOW);
      const reads: string[] = [];
      const observed = (cursor: { throughSeq: number }) => {
        const base = pinned(cursor);
        return {
          ...base,
          async readFile(path: string) { reads.push(path); return base.readFile(path); },
          async* readTrajectory(afterSeq: number, throughSeq?: number) {
            reads.push(`trajectory:${afterSeq}`);
            yield* base.readTrajectory(afterSeq, throughSeq);
          },
        };
      };
      const persisted: EvidenceExportProgress[] = [];
      await expect(store.resume({
        evidence: observed({ throughSeq: 5 }), limits,
        onProgress: async () => { throw new Error("progress write failed"); },
      })).rejects.toThrow(/progress write failed/u);
      expect(reads).toEqual([]);
      expect(blobs.blobs.size + blobs.manifests.size).toBe(0);

      // No progress survived, so the next pass is a new export pinned by the source again.
      const ref = await store.resume({
        evidence: observed({ throughSeq: 6 }), limits,
        onProgress: async (progress) => { persisted.push(structuredClone(progress)); },
      });
      expect(persisted[0]!.trajectory).toEqual({ afterSeq: 0, parts: [],
        format: SP_PI_TRAJECTORY_FORMAT, throughSeq: 6, cursor: { throughSeq: 6 } });
      expect(persisted.every((progress) => progress.trajectory.cursor?.throughSeq === 6)).toBe(true);
      expect(ref).toEqual(await createEvidenceStore(createMemoryEvidenceBlobs(), () => NOW).resume({ evidence: pinned({ throughSeq: 6 }), limits }));
    });

    it("saves the format without a cursor until the source's first native page freezes it", async () => {
      const saved: EvidenceExportProgress[] = [];
      await createEvidenceStore(createMemoryEvidenceBlobs(), () => NOW).resume({
        evidence: pinned(), limits, onProgress: async (progress) => { saved.push(structuredClone(progress)); },
      });
      expect(saved[0]!.trajectory).toEqual({ afterSeq: 0, parts: [], format: SP_PI_TRAJECTORY_FORMAT });
      expect(saved.at(-1)!.trajectory).toMatchObject({ throughSeq: 5, cursor: { throughSeq: 5 }, done: true });
    });

    it("resumes with the saved pin and finalizes the same bundle", async () => {
      const store = createEvidenceStore(createMemoryEvidenceBlobs(), () => NOW);
      let failAfter: number | undefined = 3;
      const base = pinned({ throughSeq: 5 });
      const flaky = {
        ...base,
        async* readTrajectory(afterSeq: number, throughSeq?: number) {
          for await (const page of base.readTrajectory(afterSeq, throughSeq)) {
            if (failAfter !== undefined && page.records.some((record) => record.seq > failAfter!)) {
              const records = page.records.filter((record) => record.seq <= failAfter!);
              failAfter = undefined;
              yield { ...page, records, nextAfterSeq: records.at(-1)!.seq };
              throw new Error("page unavailable");
            }
            yield page;
          }
        },
      };
      let progress: EvidenceExportProgress | undefined;
      const onProgress = async (next: EvidenceExportProgress) => { progress = structuredClone(next); };
      await expect(store.resume({ evidence: flaky, limits, onProgress })).rejects.toThrow(/page unavailable/u);
      expect(progress!.trajectory).toMatchObject({ afterSeq: 2, cursor: { throughSeq: 5 },
        format: SP_PI_TRAJECTORY_FORMAT });
      const ref = await store.resume({ evidence: flaky, limits, progress: progress!, onProgress });
      expect(progress!.trajectory).toMatchObject({ afterSeq: 5, done: true, cursor: { throughSeq: 5 } });
      expect(ref).toEqual(await createEvidenceStore(createMemoryEvidenceBlobs(), () => NOW).resume({ evidence: pinned({ throughSeq: 5 }), limits }));
    });

    it.each([
      { name: "a different cursor", evidence: () => pinned({ throughSeq: 6 }) },
      { name: "a different format", evidence: () => pinned({ throughSeq: 5 }, "pi-trajectory/v1") },
    ])("rejects a resumed export whose source returns $name", async ({ evidence }) => {
      const blobs = createMemoryEvidenceBlobs();
      const progress: EvidenceExportProgress = {
        exportedAt: NOW, artifacts: [], subjectInputs: [], omitted: [],
        trajectory: { afterSeq: 2, parts: [], format: SP_PI_TRAJECTORY_FORMAT,
          throughSeq: 5, cursor: { throughSeq: 5 } },
      };
      const failure = createEvidenceStore(blobs, () => NOW).resume({ evidence: { ...evidence(), artifacts: [] }, limits, progress });
      await expect(failure).rejects.toBeInstanceOf(EvidenceIntegrityError);
      expect(blobs.blobs.size + blobs.manifests.size).toBe(0);
    });

    it("uses the saved cutoff even when a lazy native source announces no cursor ahead of its pages", async () => {
      const base = pinned();
      const progress: EvidenceExportProgress = {
        exportedAt: NOW, artifacts: [], subjectInputs: [], omitted: [],
        trajectory: { format: SP_PI_TRAJECTORY_FORMAT, throughSeq: 4, cursor: { throughSeq: 4 },
          afterSeq: 0, parts: [] },
      };
      const requested: (number | undefined)[] = [];
      const evidence = { ...base, async* readTrajectory(afterSeq: number, throughSeq?: number) {
        requested.push(throughSeq);
        yield* base.readTrajectory(afterSeq, throughSeq);
      } };
      const store = createEvidenceStore(createMemoryEvidenceBlobs(), () => NOW);
      const ref = await store.resume({ evidence, limits, progress });
      expect(requested).toEqual([4]);
      expect((await store.open(ref)).manifest.trajectory.records).toBe(4);
    });

    it("rejects a cursor appearing on progress saved without one", async () => {
      const progress: EvidenceExportProgress = {
        exportedAt: NOW, artifacts: [], subjectInputs: [], omitted: [],
        trajectory: { format: SP_PI_TRAJECTORY_FORMAT, afterSeq: 0, parts: [] },
      };
      await expect(createEvidenceStore(createMemoryEvidenceBlobs(), () => NOW)
        .resume({ evidence: { ...pinned({ throughSeq: 5 }), artifacts: [] }, limits, progress })).rejects.toBeInstanceOf(EvidenceIntegrityError);
    });

    it("never relabels an old event-only progress or appends Pi parts to it", async () => {
      const blobs = createMemoryEvidenceBlobs();
      const store = createEvidenceStore(blobs, () => NOW);
      const legacy: EvidenceExportProgress = {
        exportedAt: NOW, artifacts: [], subjectInputs: [], omitted: [],
        trajectory: { afterSeq: 2, parts: [{ sha256: "a".repeat(64), size: 10, events: 2 }] },
      } as unknown as EvidenceExportProgress;
      await expect(store.resume({ evidence: pinned(), limits, progress: legacy }))
        .rejects.toThrow(/Cannot resume non-native/u);
      expect(blobs.blobs.size + blobs.manifests.size).toBe(0);
    });
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
