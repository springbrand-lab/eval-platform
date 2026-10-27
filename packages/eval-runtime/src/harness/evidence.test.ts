import {
  DEFAULT_EVIDENCE_LIMITS, sha256Hex, type EvidenceExportProgress, type EvidenceLimits,
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
      schemaVersion: 1,
      evidenceId: ref.evidenceId,
      source: { framework: "sp", samplingId: "s-1", exportedAt: NOW },
      artifacts: [
        { path: "/index.html", size: 11, mediaType: "text/html", sha256: await sha256Hex("<h1>Hi</h1>") },
        { path: "/copy.html", size: 11, mediaType: "text/html", sha256: await sha256Hex("<h1>Hi</h1>") },
      ],
      subjectInputs: [],
      trajectory: { format: "sp-trajectory/v1", events: 1, complete: true },
      omitted: [],
    });
    expect(await sha256Hex(opened.manifestBytes)).toBe(ref.manifestSha256);
    await expect(text(await opened.readBlob(opened.manifest.artifacts[0]!.sha256))).resolves.toBe("<h1>Hi</h1>");
    const trajectory = await text(await opened.readBlob(opened.manifest.trajectory.parts[0]!.sha256));
    expect(trajectory.trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([
      { ingestSeq: 1, event: { type: "turn.admitted", payload: { prompt: "Build" } } },
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

  it("rejects a file larger than the per-file limit", async () => {
    const store = createEvidenceStore(createMemoryEvidenceBlobs(), () => NOW);
    await expect(store.resume({
      evidence: exportedEvidence({ samplingId: "s-3", files: { "/a.txt": "0123456789" } }),
      limits: { ...DEFAULT_EVIDENCE_LIMITS, maxFileBytes: 4 },
    })).rejects.toThrow(/too large/u);
  });

  it("splits raw trajectory on event boundaries and keeps original input bytes", async () => {
    const blobs = createMemoryEvidenceBlobs();
    const store = createEvidenceStore(blobs, () => NOW);
    const events = Array.from({ length: 5 }, (_, index) => ({ ingestSeq: index + 1, event: { unknown: `原始-${index}`, payload: null } }));
    const maxFileBytes = new TextEncoder().encode(`${JSON.stringify(events[0])}\n`).byteLength * 2;
    const evidence = {
      ...exportedEvidence({ samplingId: "split", files: {}, events }),
      subjectInputs: [{ bundleId: "bundle", materialId: "material", path: "/brief.txt", mediaType: "text/plain", size: 8,
        read: async () => new Response("original").body! }],
    };
    const opened = await store.open(await store.resume({ evidence, limits: { ...DEFAULT_EVIDENCE_LIMITS, maxFileBytes } }));
    expect(opened.manifest.trajectory.parts.map((part) => part.events)).toEqual([2, 2, 1]);
    const saved: unknown[] = [];
    for (const part of opened.manifest.trajectory.parts) {
      expect(part.size).toBeLessThanOrEqual(maxFileBytes);
      saved.push(...(await text(await opened.readBlob(part.sha256))).trimEnd().split("\n").map((line) => JSON.parse(line)));
    }
    expect(saved).toEqual(events);
    expect(await text(await opened.readBlob(opened.manifest.subjectInputs[0]!.sha256))).toBe("original");
  });

  it("fails the export on a trajectory event larger than one file, before storing any part", async () => {
    const blobs = createMemoryEvidenceBlobs();
    const evidence = exportedEvidence({ samplingId: "large", files: {}, events: [{ small: 1 }, { full: "x".repeat(100) }] });
    const store = createEvidenceStore(blobs, () => NOW);
    const failure = store.resume({ evidence, limits: { ...DEFAULT_EVIDENCE_LIMITS, maxFileBytes: 50 } });
    await expect(failure).rejects.toThrow(/Trajectory event 2 is \d+ bytes, above the 50-byte evidence file limit/u);
    await expect(failure).rejects.toMatchObject({ retryable: false });
    expect(blobs.blobs.size).toBe(0);
    expect(blobs.manifests.size).toBe(0);
  });
});

describe("resumable evidence export", () => {
  const events = Array.from({ length: 5 }, (_, index) => ({ ingestSeq: index + 1, event: { type: "raw", index } }));
  const limits = { ...DEFAULT_EVIDENCE_LIMITS, maxFileBytes: new TextEncoder().encode(`${JSON.stringify(events[0])}\n`).byteLength * 2 };
  const files = { "/a.txt": "first", "/b.txt": "second", "/c.txt": "third" };

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
      async* readTrajectory(afterSeq: number) {
        cursors.push(afterSeq);
        for await (const event of base.readTrajectory(afterSeq)) {
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
    expect(afterFiles.trajectory).toEqual({ afterSeq: 0, parts: [], format: "sp-trajectory/v1" });

    reads.length = 0;
    await expect(store.resume({ evidence, limits, progress: afterFiles, onProgress })).rejects.toThrow(/page unavailable/u);
    expect(reads).toEqual(["/b.txt"]);
    const afterPage = saved.at(-1)!;
    expect(afterPage.trajectory).toMatchObject({ afterSeq: 2, parts: [{ events: 2 }] });
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
    const pinned = (cursor?: { throughSeq: number }, format = "sp-trajectory/v1") => ({
      ...exportedEvidence({ samplingId: "pinned", files, events }),
      trajectoryFormat: format,
      ...(cursor === undefined ? {} : { trajectoryCursor: cursor }),
    });

    it("saves the source's format and cursor with new progress and writes the actual format to the manifest", async () => {
      const blobs = createMemoryEvidenceBlobs();
      const saved: EvidenceExportProgress[] = [];
      const ref = await createEvidenceStore(blobs, () => NOW).resume({
        evidence: pinned({ throughSeq: 5 }, "sp-trajectory/v2"), limits,
        onProgress: async (progress) => { saved.push(structuredClone(progress)); },
      });
      expect(saved[0]!.trajectory).toEqual({ afterSeq: 0, parts: [], format: "sp-trajectory/v2", cursor: { throughSeq: 5 } });
      expect(saved.every((progress) => progress.trajectory.cursor?.throughSeq === 5
        && progress.trajectory.format === "sp-trajectory/v2")).toBe(true);
      expect(saved.at(-1)!.trajectory).toMatchObject({ afterSeq: 5, done: true });
      expect((await createEvidenceStore(blobs).open(ref)).manifest.trajectory.format).toBe("sp-trajectory/v2");
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
          async* readTrajectory(afterSeq: number) { reads.push(`trajectory:${afterSeq}`); yield* base.readTrajectory(afterSeq); },
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
      expect(persisted[0]!.trajectory).toEqual({ afterSeq: 0, parts: [], format: "sp-trajectory/v1", cursor: { throughSeq: 6 } });
      expect(persisted.every((progress) => progress.trajectory.cursor?.throughSeq === 6)).toBe(true);
      expect(ref).toEqual(await createEvidenceStore(createMemoryEvidenceBlobs(), () => NOW).resume({ evidence: pinned({ throughSeq: 6 }), limits }));
    });

    it("saves the format without a cursor when the source pins none", async () => {
      const saved: EvidenceExportProgress[] = [];
      await createEvidenceStore(createMemoryEvidenceBlobs(), () => NOW).resume({
        evidence: pinned(), limits, onProgress: async (progress) => { saved.push(structuredClone(progress)); },
      });
      expect(saved[0]!.trajectory).toEqual({ afterSeq: 0, parts: [], format: "sp-trajectory/v1" });
    });

    it("resumes with the saved pin and finalizes the same bundle", async () => {
      const store = createEvidenceStore(createMemoryEvidenceBlobs(), () => NOW);
      let failAfter: number | undefined = 3;
      const base = pinned({ throughSeq: 5 });
      const flaky = {
        ...base,
        async* readTrajectory(afterSeq: number) {
          for await (const event of base.readTrajectory(afterSeq)) {
            if (failAfter !== undefined && event.seq > failAfter) {
              failAfter = undefined;
              throw new Error("page unavailable");
            }
            yield event;
          }
        },
      };
      let progress: EvidenceExportProgress | undefined;
      const onProgress = async (next: EvidenceExportProgress) => { progress = structuredClone(next); };
      await expect(store.resume({ evidence: flaky, limits, onProgress })).rejects.toThrow(/page unavailable/u);
      expect(progress!.trajectory).toMatchObject({ afterSeq: 2, cursor: { throughSeq: 5 }, format: "sp-trajectory/v1" });
      const ref = await store.resume({ evidence: flaky, limits, progress: progress!, onProgress });
      expect(progress!.trajectory).toMatchObject({ afterSeq: 5, done: true, cursor: { throughSeq: 5 } });
      expect(ref).toEqual(await createEvidenceStore(createMemoryEvidenceBlobs(), () => NOW).resume({ evidence: pinned({ throughSeq: 5 }), limits }));
    });

    it.each([
      { name: "a different cursor", evidence: () => pinned({ throughSeq: 6 }) },
      { name: "no cursor", evidence: () => pinned() },
      { name: "a different format", evidence: () => pinned({ throughSeq: 5 }, "pi-trajectory/v1") },
    ])("rejects a resumed export whose source returns $name", async ({ evidence }) => {
      const blobs = createMemoryEvidenceBlobs();
      const progress: EvidenceExportProgress = {
        exportedAt: NOW, artifacts: [], subjectInputs: [], omitted: [],
        trajectory: { afterSeq: 2, parts: [], format: "sp-trajectory/v1", cursor: { throughSeq: 5 } },
      };
      const failure = createEvidenceStore(blobs, () => NOW).resume({ evidence: { ...evidence(), artifacts: [] }, limits, progress });
      await expect(failure).rejects.toBeInstanceOf(EvidenceIntegrityError);
      await expect(failure).rejects.toThrow(/trajectory pin/u);
      expect(blobs.blobs.size + blobs.manifests.size).toBe(0);
    });

    it("rejects a cursor appearing on progress saved without one", async () => {
      const progress: EvidenceExportProgress = {
        exportedAt: NOW, artifacts: [], subjectInputs: [], omitted: [], trajectory: { afterSeq: 0, parts: [] },
      };
      await expect(createEvidenceStore(createMemoryEvidenceBlobs(), () => NOW)
        .resume({ evidence: { ...pinned({ throughSeq: 5 }), artifacts: [] }, limits, progress })).rejects.toBeInstanceOf(EvidenceIntegrityError);
    });

    it("continues legacy progress without a cursor and never relabels it", async () => {
      const blobs = createMemoryEvidenceBlobs();
      const store = createEvidenceStore(blobs, () => NOW);
      const base = exportedEvidence({ samplingId: "legacy", files: {}, events });
      const first = await store.resume({ evidence: base, limits });
      const firstPart = (await store.open(first)).manifest.trajectory.parts[0]!;
      const legacy: EvidenceExportProgress = {
        exportedAt: NOW, artifacts: [], subjectInputs: [], omitted: [],
        trajectory: { afterSeq: 2, parts: [firstPart] },
      };
      const cursors: number[] = [];
      const saved: EvidenceExportProgress[] = [];
      const ref = await store.resume({
        evidence: { ...base, async* readTrajectory(afterSeq: number) { cursors.push(afterSeq); yield* base.readTrajectory(afterSeq); } },
        limits, progress: legacy, onProgress: async (progress) => { saved.push(structuredClone(progress)); },
      });
      expect(cursors).toEqual([2]);
      expect(saved.every((progress) => !("cursor" in progress.trajectory) && !("format" in progress.trajectory))).toBe(true);
      expect(ref).toEqual(first);
      expect((await store.open(ref)).manifest.trajectory.format).toBe("sp-trajectory/v1");
    });
  });

  it("refuses saved progress whose stored bytes no longer match the listing", async () => {
    const store = createEvidenceStore(createMemoryEvidenceBlobs(), () => NOW);
    const evidence = exportedEvidence({ samplingId: "changed", files: { "/a.txt": "first" } });
    await expect(store.resume({ evidence, limits, progress: {
      exportedAt: NOW, artifacts: [{ path: "/a.txt", size: 99, mediaType: "text/html" }], subjectInputs: [], omitted: [],
      trajectory: { afterSeq: 0, parts: [] },
    } })).rejects.toBeInstanceOf(EvidenceIntegrityError);
  });
});
