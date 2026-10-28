import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SP_PI_TRAJECTORY_FORMAT, type JsonValue, type NativeTrajectoryEntry } from "@eval-platform/eval-contracts";
import { createEvidenceStore, type AgentHandle } from "@eval-platform/eval-runtime/harness";
import { evalEvidencePath } from "@springbrand/eval-harness";
import { describe, expect, it } from "vitest";
import { openLocalEvidenceBlobs } from "../evidence/local-blobs.js";
import { createSpHarness, MAX_TRAJECTORY_PAGE_BYTES } from "./harness.js";

const subject: AgentHandle = {
  ownerUserId: "11111111-1111-4111-8111-111111111111", chatId: "22222222-2222-4222-8222-222222222222",
  samplingId: "sampling", role: "subject", framework: "sp",
};
const evaluator: AgentHandle = { ...subject, chatId: "33333333-3333-4333-8333-333333333333", role: "evaluator", evaluationId: "evaluation" };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const limits = { maxFileBytes: 500, maxTotalBytes: 10_000, maxFiles: 20, excludedSegments: [] };
const native = (seq: number, kind: string, body: Record<string, JsonValue>,
  chatId = subject.chatId, submissionId = "submission-1"): NativeTrajectoryEntry => ({
  ingestSeq: seq, record: { format: "pi-trajectory/v1", projection: { kind: "safe" }, kind,
    chatId, submissionId, ...body },
});
const page = (records: readonly NativeTrajectoryEntry[], throughSeq: number, nextAfterSeq: number | null) => ({
  format: SP_PI_TRAJECTORY_FORMAT, cursor: { throughSeq }, records, nextAfterSeq,
});
const read = async (items: AsyncIterable<unknown>) => { const result = []; for await (const item of items) result.push(item); return result; };

describe("SP Pi-native evidence export, persistence and import", () => {
  it("preserves Subject inputs and complete native JSONL through bounded parts, service auth and a frozen high-water mark", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-native-evidence-roundtrip-"));
    try {
      const records = Array.from({ length: 8 }, (_, index) => native(index + 1, "message",
        { message: { role: "assistant", timestamp: index, stopReason: "stop",
          content: [{ type: "text", text: "native-原始" }] } }));
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
    ["wrong wire", { ...page([native(1, "event", { event: { type: "agent_start" } })], 1, null), format: "sp-trajectory/v1" }],
    ["legacy event in native envelope", { ...page([], 1, null), records: [{ ingestSeq: 1, record: { type: "turn.finished" } }] }],
    ["unsafe projection", { ...page([], 1, null),
      records: [{ ingestSeq: 1, record: { format: "pi-trajectory/v1", projection: { kind: "full" }, kind: "message" } }] }],
    ["backward cursor", page([native(1, "event", { event: { type: "agent_start" } })], 1, 0)],
    ["out-of-order records", page([native(2, "event", { event: { type: "agent_start" } }),
      native(1, "event", { event: { type: "agent_end" } })], 2, null)],
    ["incomplete final page", page([native(1, "event", { event: { type: "agent_start" } })], 2, null)],
    ["different Chat", page([native(1, "event", { event: { type: "agent_start" } }, evaluator.chatId)], 1, null)],
  ])("rejects %s without mislabelling event JSON as Pi history", async (_name, invalid) => {
    const harness = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async (input) => Response.json(new URL(String(input instanceof Request ? input.url : input)).pathname.endsWith("/artifacts")
        ? { artifacts: [] } : invalid) });
    const exported = await harness.exportEvidence({ handle: subject, submissionId: "submission-1", limits });
    await expect(read(exported.readTrajectory(0))).rejects.toMatchObject({ name: "SpHarnessError", retryable: false });
  });

  it("rejects changed throughSeq and pages beyond the frozen mark, including a replayed cursor", async () => {
    const first = native(1, "event", { event: { type: "turn_start", turnId: "turn" } });
    const second = native(2, "event", { event: { type: "agent_end" } });
    for (const last of [page([second], 3, null), page([native(3, "event", { event: { type: "agent_end" } })], 2, null)]) {
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
    const piMessage = (seq: number, submissionId: string, content: JsonValue, role = "assistant") => native(seq, "message",
      { message: { role, timestamp: seq, stopReason: "stop", content } }, evaluator.chatId, submissionId);
    const records = [
      piMessage(1, "earlier-submission", [{ type: "text", text: "old" }]),
      native(2, "event", { event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "fake" }] } } },
        evaluator.chatId, "evaluation-submission"),
      piMessage(3, "evaluation-submission", [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "final" },
        { type: "text", text: "```json\n{}\n```" }]),
      piMessage(4, "evaluation-submission", [{ type: "thinking", thinking: "no text" }]),
    ];
    const urls: URL[] = [];
    const harness = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        urls.push(url);
        return Response.json(url.searchParams.get("afterSeq") === "0"
          ? page(records.slice(0, 2), 4, 2) : page(records.slice(2), 4, null));
      } });
    const reply = { handle: evaluator, submissionId: "evaluation-submission" };
    await expect(harness.readFinalReply(reply)).resolves.toBe("final\n```json\n{}\n```");
    expect(urls.map((url) => [url.pathname, url.searchParams.get("submissionId"), url.searchParams.get("throughSeq")]))
      .toEqual([
        [`/internal/v1/eval-harness/users/${evaluator.ownerUserId}/chats/${evaluator.chatId}/evidence/trajectory`,
          "evaluation-submission", null],
        [`/internal/v1/eval-harness/users/${evaluator.ownerUserId}/chats/${evaluator.chatId}/evidence/trajectory`,
          "evaluation-submission", "4"],
      ]);
    const empty = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async () => Response.json(page([piMessage(1, "earlier-submission", [{ type: "text", text: "old" }])], 1, null)) });
    await expect(empty.readFinalReply(reply)).resolves.toBeUndefined();
    const omitted = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async () => Response.json(page([
        piMessage(1, "evaluation-submission", [{ type: "text", text: "[CONTENT OMITTED]" }]),
      ], 1, null)) });
    await expect(omitted.readFinalReply(reply)).resolves.toBeUndefined();
  });

  it("bounds a JSON page by bytes and rejects an oversized individual record instead of truncating it", async () => {
    const oversized = native(1, "message", { message: { role: "assistant", timestamp: 1,
      stopReason: "stop", content: [{ type: "text", text: "x".repeat(1_000) }] } });
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
});
