import { sha256Hex, type JsonValue } from "@eval-platform/eval-contracts";

import type { EvidenceBlobStore } from "./evidence.js";
import type { ExportedEvidence } from "./model.js";

/** Test-only blob store; not exported from the package. */
export function createMemoryEvidenceBlobs(): EvidenceBlobStore & {
  readonly blobs: Map<string, Uint8Array>;
  readonly manifests: Map<string, Uint8Array>;
} {
  const blobs = new Map<string, Uint8Array>();
  const manifests = new Map<string, Uint8Array>();
  return {
    blobs,
    manifests,
    async putBlob(content, maxBytes) {
      const bytes = new Uint8Array(await new Response(content).arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new Error("Evidence blob is too large");
      const sha256 = await sha256Hex(bytes);
      if (!blobs.has(sha256)) blobs.set(sha256, bytes);
      return { sha256, size: bytes.byteLength };
    },
    async readBlob(sha256) {
      const bytes = blobs.get(sha256);
      return bytes === undefined ? undefined : new Response(new Uint8Array(bytes)).body!;
    },
    async putManifest(evidenceHex, bytes) {
      if (!manifests.has(evidenceHex)) manifests.set(evidenceHex, bytes);
    },
    async readManifest(evidenceHex) {
      return manifests.get(evidenceHex);
    },
  };
}

export function exportedEvidence(input: {
  readonly samplingId: string;
  readonly chatId?: string;
  readonly files?: Readonly<Record<string, string>>;
  /** Raw records keyed by their position (seq = index + 1); one event by default. */
  readonly events?: readonly JsonValue[];
}): ExportedEvidence {
  const files = input.files ?? { "/index.html": "<h1>Hello</h1>" };
  const events = input.events ?? [{ ingestSeq: 1, event: { type: "turn.admitted", payload: { prompt: "Build" } } }];
  const encoder = new TextEncoder();
  return {
    source: { framework: "sp", samplingId: input.samplingId, agentRef: { chatId: input.chatId ?? "chat-1" } },
    artifacts: Object.entries(files).map(([path, content]) => ({
      path, size: encoder.encode(content).byteLength, mediaType: "text/html",
    })),
    omitted: [],
    subjectInputs: [],
    async readFile(path) {
      const content = files[path];
      if (content === undefined) throw new Error(`No exported file ${path}`);
      return new Response(content).body!;
    },
    async* readTrajectory(afterSeq) {
      for (const [index, record] of events.entries()) if (index + 1 > afterSeq) yield { seq: index + 1, record };
    },
    trajectoryFormat: "sp-trajectory/v1",
    trajectoryComplete: true,
  };
}

/** A test clock; `tickMs` advances it on every read, so a value that must stay stable has to be persisted. */
export function testClock(start = "2026-10-15T00:00:00.000Z", tickMs = 0) {
  let time = Date.parse(start);
  return {
    now: (): string => {
      const current = new Date(time).toISOString();
      time += tickMs;
      return current;
    },
    advance: (milliseconds: number): void => { time += milliseconds; },
  };
}
