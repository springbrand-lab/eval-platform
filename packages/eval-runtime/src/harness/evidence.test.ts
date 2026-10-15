import { DEFAULT_EVIDENCE_LIMITS, sha256Hex, type EvidenceLimits } from "@eval-platform/eval-contracts";
import { describe, expect, it } from "vitest";

import { applyEvidenceLimits, createEvidenceStore, EvidenceIntegrityError } from "./evidence.js";
import { createMemoryEvidenceBlobs, exportedEvidence } from "./evidence-test-support.js";

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
    const ref = await store.save({ evidence: exportedEvidence({ samplingId: "s-1", files }), limits: DEFAULT_EVIDENCE_LIMITS });

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
      trajectory: { format: "eval-trajectory/v1", events: 1, complete: true },
      omitted: [],
    });
    expect(await sha256Hex(opened.manifestBytes)).toBe(ref.manifestSha256);
    await expect(text(await opened.readBlob(opened.manifest.artifacts[0]!.sha256))).resolves.toBe("<h1>Hi</h1>");
    const trajectory = await text(await opened.readBlob(opened.manifest.trajectory.sha256));
    expect(trajectory.trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ seq: 1, type: "user-message" }),
    ]);

    // The same export at the same moment is the same bundle.
    await expect(store.save({ evidence: exportedEvidence({ samplingId: "s-1", files }), limits: DEFAULT_EVIDENCE_LIMITS }))
      .resolves.toEqual(ref);
  });

  it("refuses a reference whose manifest or blobs do not match", async () => {
    const blobs = createMemoryEvidenceBlobs();
    const store = createEvidenceStore(blobs, () => NOW);
    const ref = await store.save({ evidence: exportedEvidence({ samplingId: "s-2" }), limits: DEFAULT_EVIDENCE_LIMITS });

    await expect(store.open({ ...ref, manifestSha256: "0".repeat(64) })).rejects.toBeInstanceOf(EvidenceIntegrityError);
    await expect(store.open({ ...ref, evidenceId: `sha256:${"1".repeat(64)}` })).rejects.toThrow(/not found/u);
    await expect(store.open({ ...ref, evidenceId: "not-a-hash" })).rejects.toThrow(/Invalid evidence ID/u);
    const opened = await store.open(ref);
    await expect(opened.readBlob("2".repeat(64))).rejects.toThrow(/missing blob/u);
  });

  it("rejects a file larger than the per-file limit", async () => {
    const store = createEvidenceStore(createMemoryEvidenceBlobs(), () => NOW);
    await expect(store.save({
      evidence: exportedEvidence({ samplingId: "s-3", files: { "/a.txt": "0123456789" } }),
      limits: { ...DEFAULT_EVIDENCE_LIMITS, maxFileBytes: 4 },
    })).rejects.toThrow(/too large/u);
  });
});
