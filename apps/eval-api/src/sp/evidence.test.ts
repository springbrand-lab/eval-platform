import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SP_PI_TRAJECTORY_FORMAT, type NativeTrajectoryEntry } from "@eval-platform/eval-contracts";
import { createEvidenceStore, type AgentHandle } from "@eval-platform/eval-runtime/harness";
import { evalEvidencePath } from "@springbrand/eval-harness";
import { describe, expect, it } from "vitest";
import { openLocalEvidenceBlobs } from "../evidence/local-blobs.js";
import { createSpHarness, MAX_TRAJECTORY_PAGE_BYTES } from "./harness.js";
import { finalReplyText } from "./harness-wire.js";
import { nativeAssistantMessage, nativeFixture, nativeFixtureRecords } from "./native-test-fixture.js";

const subject: AgentHandle = {
  ownerUserId: "11111111-1111-4111-8111-111111111111", chatId: "22222222-2222-4222-8222-222222222222",
  samplingId: "sampling", role: "subject", framework: "sp",
};
const evaluator: AgentHandle = { ...subject, chatId: "33333333-3333-4333-8333-333333333333", role: "evaluator", evaluationId: "evaluation" };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const limits = { maxFileBytes: 1_200, maxTotalBytes: 15_000, maxFiles: 20, excludedSegments: [] };
const native = (seq: number, chatId = subject.chatId, submissionId = "submission-1") => nativeFixture(seq, chatId, submissionId);
const asContext = (entry: NativeTrajectoryEntry): NativeTrajectoryEntry => ({
  ...entry, record: { ...entry.record, submissionId: null, origin: "context" },
});
const page = (records: readonly unknown[], throughSeq: number, nextAfterSeq: number | null) => ({
  format: SP_PI_TRAJECTORY_FORMAT, cursor: { throughSeq }, records, nextAfterSeq,
});
const read = async (items: AsyncIterable<unknown>) => { const result = []; for await (const item of items) result.push(item); return result; };

describe("SP Pi-native evidence export, persistence and import", () => {
  it("preserves Subject inputs and complete native JSONL through bounded parts, service auth and a frozen high-water mark", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-native-evidence-roundtrip-"));
    try {
      const records = [
        asContext(native(1)),
        ...nativeFixtureRecords([2, 3], subject.chatId, "earlier-submission"),
        ...nativeFixtureRecords([4, 5, 6, 7, 8], subject.chatId, "submission-1"),
      ];
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
      expect(trajectory.map((file) => new TextDecoder().decode(file.bytes)).join(""))
        .toBe(records.map((record) => `${JSON.stringify(record)}\n`).join(""));
      expect(trajectory.map((file) => hash(file.bytes))).toEqual(evidence.manifest.trajectory.parts.map((part) => part.sha256));
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
    ["wrong wire", { ...page([native(1)], 1, null), format: "sp-trajectory/v1" }],
    ["legacy event in native envelope", { ...page([], 1, null), records: [{ ingestSeq: 1, record: { type: "turn.finished" } }] }],
    ["unsafe projection", page([{ ...native(1), record: { ...native(1).record,
      projection: { kind: "full", policyId: "test", policyVersion: 1 } } }], 1, null)],
    ["missing safe projection", page([{ ...native(1), record: { ...native(1).record, projection: undefined } }], 1, null)],
    ["backward cursor", page([native(1)], 1, 0)],
    ["out-of-order records", page([native(2), native(1)], 2, null)],
    ["duplicate inner sequence", page([{ ...native(1), record: { ...native(1).record, ingestSeq: 1 } }], 1, null)],
    ["different Chat", page([native(1, evaluator.chatId)], 1, null)],
    ["foreign parent Chat", page([{ ...native(1), record: { ...native(1).record,
      parent: { resource: { agentId: "agent-1", sessionId: evaluator.chatId }, submissionId: "earlier-submission" } } }], 1, null)],
  ])("rejects %s without mislabelling event JSON as Pi history", async (_name, invalid) => {
    const harness = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async (input) => Response.json(new URL(String(input instanceof Request ? input.url : input)).pathname.endsWith("/artifacts")
        ? { artifacts: [] } : invalid) });
    const exported = await harness.exportEvidence({ handle: subject, submissionId: "submission-1", limits });
    await expect(read(exported.readTrajectory(0))).rejects.toMatchObject({ name: "SpHarnessError", retryable: false });
  });

  it("rejects a page with a foreign Chat before yielding even its safe Context prefix", async () => {
    const harness = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async (input) => Response.json(new URL(String(input instanceof Request ? input.url : input)).pathname.endsWith("/artifacts")
        ? { artifacts: [] } : page([asContext(native(1)), native(2, evaluator.chatId)], 2, null)) });
    const exported = await harness.exportEvidence({ handle: subject, submissionId: "submission-1", limits });
    const iterator = exported.readTrajectory(0)[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({
      retryable: false, message: expect.stringContaining("outside the requested Chat"),
    });
  });

  it("accepts a directly parented child, earlier same-Chat Submissions and a sparse frozen end", async () => {
    const earlierChild = native(7, subject.chatId, "earlier-child");
    Object.assign(earlierChild.record, { parent: {
      resource: { agentId: "agent-1", sessionId: subject.chatId }, submissionId: "earlier-submission",
    } });
    const child = native(8, subject.chatId, "child-submission");
    Object.assign(child.record, { parent: {
      resource: { agentId: "agent-1", sessionId: subject.chatId }, submissionId: "submission-1",
    } });
    const records = [native(3), native(5, subject.chatId, "earlier-submission"), earlierChild, child];
    const harness = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async (input) => Response.json(new URL(String(input instanceof Request ? input.url : input)).pathname.endsWith("/artifacts")
        ? { artifacts: [] } : page(records, 9, null)) });
    const exported = await harness.exportEvidence({ handle: subject, submissionId: "submission-1", limits });
    expect(await read(exported.readTrajectory(0))).toEqual(records.map((record) => ({
      seq: record.ingestSeq, throughSeq: 9, record,
    })));
  });

  it("rejects changed throughSeq and pages beyond the frozen mark, including a replayed cursor", async () => {
    const first = native(1);
    const second = native(2);
    for (const last of [page([second], 3, null), page([native(3)], 2, null)]) {
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
    const submissionId = "evaluation-submission";
    const current = nativeAssistantMessage(14, evaluator.chatId, submissionId, [
      { type: "thinking", thinking: "hidden" }, { type: "text", text: "final" }, { type: "text", text: "```json\n{}\n```" },
    ]);
    const context = asContext(nativeAssistantMessage(2, evaluator.chatId, submissionId, [{ type: "text", text: "initial Context" }]));
    const earlier = nativeAssistantMessage(5, evaluator.chatId, "earlier-submission", [{ type: "text", text: "earlier reply" }]);
    const records = [
      context,
      earlier,
      native(6, evaluator.chatId, submissionId),
      current,
      native(16, evaluator.chatId, submissionId),
      nativeAssistantMessage(18, evaluator.chatId, "later-submission", [{ type: "text", text: "later reply" }]),
    ];
    const urls: URL[] = [];
    const harness = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        urls.push(url);
        return Response.json(url.searchParams.get("afterSeq") === "0"
          ? page(records.slice(0, 4), 18, 14) : page(records.slice(4), 18, null));
      } });
    const reply = { handle: evaluator, submissionId };
    await expect(harness.readFinalReply(reply)).resolves.toBe("final\n```json\n{}\n```");
    expect(urls.map((url) => [url.pathname, url.searchParams.get("submissionId"), url.searchParams.get("throughSeq")]))
      .toEqual([
        [`/internal/v1/eval-harness/users/${evaluator.ownerUserId}/chats/${evaluator.chatId}/evidence/trajectory`,
          submissionId, null],
        [`/internal/v1/eval-harness/users/${evaluator.ownerUserId}/chats/${evaluator.chatId}/evidence/trajectory`,
          submissionId, "18"],
      ]);
    expect(finalReplyText(native(14, evaluator.chatId, "earlier-submission").record, submissionId)).toBeUndefined();
    const empty = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async () => Response.json(page([native(16, evaluator.chatId, submissionId)], 17, null)) });
    await expect(empty.readFinalReply(reply)).resolves.toBeUndefined();
    const omitted = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async () => Response.json(page([
        current, nativeAssistantMessage(17, evaluator.chatId, submissionId, [{ type: "text", text: "[CONTENT OMITTED]" }]),
      ], 17, null)) });
    await expect(omitted.readFinalReply(reply)).resolves.toBeUndefined();
    const thinkingOnly = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async () => Response.json(page([
        current, nativeAssistantMessage(17, evaluator.chatId, submissionId, [{ type: "thinking", thinking: "private" }]),
      ], 17, null)) });
    await expect(thinkingOnly.readFinalReply(reply)).resolves.toBeUndefined();
    const child = nativeAssistantMessage(17, evaluator.chatId, "child-submission", [{ type: "text", text: "child reply" }]);
    Object.assign(child.record, { parent: {
      resource: { agentId: "agent-1", sessionId: evaluator.chatId }, submissionId,
    } });
    const scoped = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async () => Response.json(page([current, child], 17, null)) });
    await expect(scoped.readFinalReply(reply)).resolves.toBe("final\n```json\n{}\n```");
    const historyOnly = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async () => Response.json(page([context, earlier], 5, null)) });
    await expect(historyOnly.readFinalReply(reply)).resolves.toBeUndefined();
    const foreignChat = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async () => Response.json(page([native(14, subject.chatId, submissionId)], 14, null)) });
    await expect(foreignChat.readFinalReply(reply)).rejects.toMatchObject({ retryable: false,
      message: expect.stringContaining("outside the requested Chat") });
  });

  it("bounds a JSON page by bytes and rejects an oversized individual record instead of truncating it", async () => {
    const oversized = nativeAssistantMessage(1, subject.chatId, "submission-1", [{ type: "text", text: "x".repeat(2_000) }]);
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

  it("fails explicitly for a safe record over the 4 MB JSON page limit (streaming consumer pending SP public wire)", async () => {
    const record = nativeAssistantMessage(1, subject.chatId, "submission-1",
      [{ type: "text", text: "x".repeat(MAX_TRAJECTORY_PAGE_BYTES) }]);
    const harness = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async (input) => Response.json(new URL(String(input instanceof Request ? input.url : input)).pathname.endsWith("/artifacts")
        ? { artifacts: [] } : page([record], 1, null)) });
    const exported = await harness.exportEvidence({ handle: subject, submissionId: "submission-1", limits });
    await expect(read(exported.readTrajectory(0))).rejects.toMatchObject({
      retryable: false,
      message: `Eval SP evidence trajectory page exceeded the ${MAX_TRAJECTORY_PAGE_BYTES}-byte response limit`,
    });
  });
});
