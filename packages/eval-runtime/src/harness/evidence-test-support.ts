import { sha256Hex } from "@eval-platform/eval-contracts";

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
}): ExportedEvidence {
  const files = input.files ?? { "/index.html": "<h1>Hello</h1>" };
  const encoder = new TextEncoder();
  return {
    source: { framework: "sp", samplingId: input.samplingId, agentRef: { chatId: input.chatId ?? "chat-1" } },
    artifacts: Object.entries(files).map(([path, content]) => ({
      path, size: encoder.encode(content).byteLength, mediaType: "text/html",
    })),
    omitted: [],
    async readFile(path) {
      const content = files[path];
      if (content === undefined) throw new Error(`No exported file ${path}`);
      return new Response(content).body!;
    },
    trajectory: (async function* () {
      yield { seq: 1, at: "2026-10-15T00:00:00.000Z", type: "user-message" as const, content: { text: "Build" }, raw: {} };
    })(),
    trajectoryComplete: true,
  };
}
