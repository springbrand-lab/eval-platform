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
const nativeConversation = { format: "pi-trajectory/v1", resource: { agentId: "root", sessionId: subject.chatId },
  projection: { kind: "safe", policyId: "fixture", policyVersion: 1 },
  submissionId: "submission-1", record: { type: "conversation", value: { id: 1 } } };
const subjectScope = { resource: { agentId: "root", sessionId: subject.chatId }, submissionId: "submission-1" };

describe("SP evidence export, persistence and import", () => {
  it("preserves original inputs and complete raw paged events through bounded parts", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-evidence-roundtrip-"));
    try {
      const events = Array.from({ length: 8 }, (_, index) => ({ ingestSeq: index + 1,
        event: { format: "pi-trajectory/v1", resource: { agentId: "root", sessionId: subject.chatId }, submissionId: "submission-1",
          projection: { kind: "safe", policyId: "fixture", policyVersion: 1 },
          record: { type: "entry", value: { id: index + 2, conversationId: 1, kind: "unknown.public.entry",
            futureField: { fields: [true, null, index] }, data: { content: "x".repeat(70) } } } } }));
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
          return Response.json({ format: "pi-trajectory/v1", scope: subjectScope, cursor: { throughSeq: 8 },
            ...(cursors.length === 1 ? { events: events.slice(0, 4), nextAfterSeq: 4 } : { events: events.slice(4), nextAfterSeq: null }) });
        },
      });
      const store = createEvidenceStore(await openLocalEvidenceBlobs(root));
      const exported = await harness.exportEvidence({ handle: subject, submissionId: "submission-1", limits, initialMaterials: materials });
      const evidence = await store.open(await store.resume({ evidence: exported, limits }));
      expect(cursors).toEqual(["0", "4"]);
      expect(evidence.manifest.trajectory.events).toBe(8);
      expect(evidence.manifest.trajectory.format).toBe("pi-trajectory/v1");
      expect(evidence.manifest.trajectory.scope).toEqual(subjectScope);
      expect(evidence.manifest.trajectory.cursor).toEqual({ throughSeq: 8 });
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
    { events: [{ ingestSeq: 1, event: nativeConversation }], nextAfterSeq: 0 },
    { events: [{ ingestSeq: 2, event: nativeConversation }, { ingestSeq: 1, event: nativeConversation }], nextAfterSeq: null },
    { events: [{ ingestSeq: 1, event: nativeConversation }], nextAfterSeq: 2 },
    { events: [], nextAfterSeq: 2 },
    { format: "future-trajectory/v2", events: [], nextAfterSeq: null },
    { events: [{ ingestSeq: 1, event: { type: "turn.finished" } }], nextAfterSeq: null },
  ])("rejects a trajectory page that cannot preserve source order: %j", async (page) => {
    const harness = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async (input) => Response.json(new URL(String(input instanceof Request ? input.url : input)).pathname.endsWith("/artifacts") ? { artifacts: [] }
        : { format: "pi-trajectory/v1", scope: subjectScope, cursor: { throughSeq: 3 }, ...page }) });
    await expect((async () => {
      const exported = await harness.exportEvidence({ handle: subject, submissionId: "submission-1", limits });
      for await (const _event of exported.readTrajectory(0)) { /* Consume the entire source. */ }
    })())
      .rejects.toMatchObject({ name: "SpHarnessError", retryable: false });
  });

  it("reads the Evaluator's Submission-correlated native final reply across trajectory pages", async () => {
    const record = (ingestSeq: number, type: string, value: object) => ({ ingestSeq,
      event: { format: "pi-trajectory/v1", resource: { agentId: "root", sessionId: evaluator.chatId },
        projection: { kind: "safe", policyId: "fixture", policyVersion: 1 },
        submissionId: "evaluation-submission", record: { type, value } } });
    const entry = (seq: number, kind: string, fields: object) => record(seq, "entry", { id: seq + 1, conversationId: 1, kind, ...fields });
    const pages = [
      { format: "pi-trajectory/v1", events: [
        record(1, "conversation", { id: 1 }),
        entry(2, "pi.user", { model: [{ role: "user", content: "Judge", timestamp: 0 }] }),
        entry(3, "springbrand.trajectory", { data: { type: "request", requestId: "r", taskId: 10, cutoff: 3, attempt: 1,
          purpose: "generation", method: "streamSimple", inputs: [], dispatched: true, startedAt: 1,
          model: { provider: "openrouter", modelId: "model", api: "openai-completions" } } }),
      ], nextAfterSeq: 3 },
      { format: "pi-trajectory/v1", events: [
        entry(4, "pi.assistant", { byTaskId: 10, model: [{ role: "assistant", provider: "openrouter", model: "model", api: "openai-completions",
          stopReason: "stop", timestamp: 1, content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "final" }, { type: "text", text: "```json\n{}\n```" }],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }] }),
        entry(5, "springbrand.trajectory", { data: { type: "request_end", requestId: "r", taskId: 10, endedAt: 2, result: { type: "entry", entryId: 5 } } }),
        entry(6, "springbrand.trajectory", { data: { type: "host_turn", submissionId: "evaluation-submission", phase: "terminal",
          status: "completed", childRegistrationClosed: true, recordedAt: 3 } }),
      ], nextAfterSeq: null },
    ];
    const urls: URL[] = [];
    const harness = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        urls.push(url);
        return Response.json({ ...pages[url.searchParams.get("afterSeq") === "0" ? 0 : 1],
          scope: { resource: { agentId: "root", sessionId: evaluator.chatId }, submissionId: "evaluation-submission" },
          cursor: { throughSeq: 6 },
        });
      } });
    const reply = { handle: evaluator, submissionId: "evaluation-submission" };
    await expect(harness.readFinalReply(reply)).resolves.toBe("final\n```json\n{}\n```");
    expect(urls.every((url) => url.pathname.endsWith(`/chats/${evaluator.chatId}/evidence/trajectory`)
      && url.searchParams.get("submissionId") === "evaluation-submission")).toBe(true);
    expect(urls[1]?.searchParams.get("throughSeq")).toBe("6");
    const empty = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async () => Response.json({ format: "pi-trajectory/v1", events: [], nextAfterSeq: null,
        scope: { resource: { agentId: "root", sessionId: evaluator.chatId }, submissionId: "evaluation-submission" },
        cursor: { throughSeq: 0 },
      }) });
    await expect(empty.readFinalReply(reply)).resolves.toBeUndefined();
  });
});
