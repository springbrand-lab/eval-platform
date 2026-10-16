import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvidenceStore, type AgentHandle } from "@eval-platform/eval-runtime/harness";
import { evalEvidencePath } from "@springbrand/eval-harness";
import { describe, expect, it } from "vitest";
import { openLocalEvidenceBlobs } from "../evidence/local-blobs.js";
import { createSpHarness } from "./harness.js";

const subject: AgentHandle = {
  ownerUserId: "11111111-1111-4111-8111-111111111111", chatId: "22222222-2222-4222-8222-222222222222",
  samplingId: "sampling", role: "subject", framework: "sp",
};
const evaluator: AgentHandle = { ...subject, chatId: "33333333-3333-4333-8333-333333333333", role: "evaluator", evaluationId: "evaluation" };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const limits = { maxFileBytes: 500, maxTotalBytes: 10_000, maxFiles: 10, excludedSegments: [] };

describe("SP evidence export, persistence and import", () => {
  it("preserves original inputs and complete raw paged events through bounded parts", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-evidence-roundtrip-"));
    try {
      const events = Array.from({ length: 8 }, (_, index) => ({ ingestSeq: index + 1,
        event: { type: "unknown.public.event", extra: { fields: [true, null, index] }, payload: { content: "x".repeat(70) } } }));
      const imported: { path: string; bytes: Uint8Array }[] = [];
      const cursors: string[] = [];
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
          if (url.pathname.endsWith("/artifacts")) return Response.json({ artifacts: [{ path: "/site.html", size: 4, mediaType: "text/html" }] });
          if (url.pathname.endsWith("/files")) return new Response("site");
          cursors.push(url.searchParams.get("afterSeq")!);
          return Response.json(cursors.length === 1 ? { events: events.slice(0, 4), nextAfterSeq: 4 } : { events: events.slice(4), nextAfterSeq: null });
        },
      });
      const store = createEvidenceStore(await openLocalEvidenceBlobs(root));
      const exported = await harness.exportEvidence({ handle: subject, limits, initialMaterials: materials });
      const evidence = await store.open(await store.save({ evidence: exported, limits }));
      expect(cursors).toEqual(["0", "4"]);
      expect(evidence.manifest.trajectory.events).toBe(8);
      expect(evidence.manifest.trajectory.parts.length).toBeGreaterThan(1);
      await harness.importEvidence({ handle: evaluator, idempotencyKey: "evidence", evidence, root: "/evidence" });
      expect(imported.at(-1)?.path).toBe("/manifest.json");
      const trajectory = imported.filter((file) => file.path.startsWith("/trajectory/")).sort((a, b) => a.path.localeCompare(b.path));
      expect(trajectory.every((file) => file.bytes.byteLength <= limits.maxFileBytes)).toBe(true);
      expect(trajectory.flatMap((file) => new TextDecoder().decode(file.bytes).trimEnd().split("\n").map((line) => JSON.parse(line)))).toEqual(events);
      for (const ref of materials) {
        const file = imported.find((item) => item.path === `/subject-inputs/${ref.bundleId}/${ref.materialId}/same.txt`);
        expect(new TextDecoder().decode(file!.bytes)).toBe(`original ${ref.materialId}`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { events: [{ ingestSeq: 1, event: {} }], nextAfterSeq: 0 },
    { events: [{ ingestSeq: 2, event: {} }, { ingestSeq: 1, event: {} }], nextAfterSeq: null },
  ])("rejects a trajectory page that cannot preserve source order: %j", async (page) => {
    const harness = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async (input) => Response.json(String(input instanceof Request ? input.url : input).endsWith("/artifacts") ? { artifacts: [] } : page) });
    const exported = await harness.exportEvidence({ handle: subject, limits });
    await expect((async () => { for await (const _event of exported.trajectory) { /* Consume the entire source. */ } })())
      .rejects.toMatchObject({ name: "SpHarnessError", retryable: false });
  });

  it("reads the Evaluator's last finished reply across trajectory pages", async () => {
    const turn = (ingestSeq: number, content: unknown[]) => ({ ingestSeq,
      event: { type: "turn.finished", payload: { outcome: "completed", output: { role: "assistant", content } } } });
    const pages = [
      { events: [turn(1, [{ type: "text", text: "first answer" }]), { ingestSeq: 2, event: { type: "tool.started", payload: {} } }], nextAfterSeq: 2 },
      { events: [turn(3, [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "final" }, { type: "text", text: "```json\n{}\n```" }]),
        turn(4, [{ type: "thinking", thinking: "no text" }])], nextAfterSeq: null },
    ];
    const paths: string[] = [];
    const harness = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        paths.push(url.pathname);
        return Response.json(pages[url.searchParams.get("afterSeq") === "0" ? 0 : 1]);
      } });
    await expect(harness.readFinalReply({ handle: evaluator })).resolves.toBe("final\n```json\n{}\n```");
    expect(paths.every((path) => path.endsWith(`/chats/${evaluator.chatId}/evidence/trajectory`))).toBe(true);
    const empty = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async () => Response.json({ events: [], nextAfterSeq: null }) });
    await expect(empty.readFinalReply({ handle: evaluator })).resolves.toBeUndefined();
  });
});
