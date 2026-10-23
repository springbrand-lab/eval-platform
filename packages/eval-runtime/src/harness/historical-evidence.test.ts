import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEvidenceStore, readArchivedFinalReply } from "./index.js";
import { createMemoryEvidenceBlobs } from "./evidence-test-support.js";

const jsonl = '{"ingestSeq":9,"event":{"eventId":"archived","type":"turn.finished","payload":{"output":{"role":"assistant","content":[{"type":"text","text":"legacy answer"}]}}}}\n';
const partHash = "6e4c2b37a3e0c5c7d9755dfe4c775e275fbdcd3390e1cfc779a251ea59c160c0";
const hex = "f2c6182f0d6c68ea7a614f599a847e4a2a0255b0f5ea9c8b3cce7ae4fb3d7d94";
const manifest = `{
  "schemaVersion": 1,
  "source": {
    "framework": "sp",
    "samplingId": "archived",
    "agentRef": {
      "chatId": "old-chat"
    },
    "exportedAt": "2026-01-01T00:00:00.000Z"
  },
  "artifacts": [],
  "subjectInputs": [],
  "trajectory": {
    "format": "sp-trajectory/v1",
    "parts": [
      {
        "sha256": "6e4c2b37a3e0c5c7d9755dfe4c775e275fbdcd3390e1cfc779a251ea59c160c0",
        "size": 163,
        "events": 1
      }
    ],
    "events": 1,
    "complete": true
  },
  "omitted": [],
  "evidenceId": "sha256:f2c6182f0d6c68ea7a614f599a847e4a2a0255b0f5ea9c8b3cce7ae4fb3d7d94"
}
`;
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

describe("immutable historical evidence", () => {
  it("opens archived manifest/JSONL bytes and hashes without invoking the exporter or rewriting them", async () => {
    const blobs = createMemoryEvidenceBlobs();
    const bytes = new TextEncoder().encode(manifest);
    blobs.manifests.set(hex, bytes);
    blobs.blobs.set(partHash, new TextEncoder().encode(jsonl));
    const ref = { evidenceId: `sha256:${hex}`, manifestSha256: "6976f3a0946b04c065a61eb57d1f92ab950e59c74a22705b9856e7a9f7db63dd",
      exportedAt: "2026-01-01T00:00:00.000Z" };
    const bundle = await createEvidenceStore(blobs).open(ref);
    const archived = await new Response(await bundle.readBlob(partHash)).text();
    expect(bundle.manifestBytes).toBe(bytes);
    expect(new TextDecoder().decode(bundle.manifestBytes)).toBe(manifest);
    expect(sha(bundle.manifestBytes)).toBe(ref.manifestSha256);
    expect(archived).toBe(jsonl);
    expect(sha(archived)).toBe(partHash);
    expect(readArchivedFinalReply(bundle.manifest.trajectory.format, [JSON.parse(archived)])).toBe("legacy answer");
    expect(blobs.manifests.size).toBe(1);
    expect(blobs.blobs.size).toBe(1);
  });
});
