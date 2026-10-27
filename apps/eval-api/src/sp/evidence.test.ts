import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvidenceExportProgress } from "@eval-platform/eval-contracts";
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
      const exported = await harness.exportEvidence({ handle: subject, submissionId: "submission-1", limits, initialMaterials: materials });
      const evidence = await store.open(await store.resume({ evidence: exported, limits }));
      expect(cursors).toEqual(["0", "4"]);
      expect(evidence.manifest.trajectory.events).toBe(8);
      // SP without a cursor: the export is unbounded and keeps the default format.
      expect(evidence.manifest.trajectory.format).toBe("sp-trajectory/v1");
      expect(exported).not.toHaveProperty("trajectoryCursor");
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

  it("stores exactly the pinned range across an interrupted export and refuses a changed pin", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-evidence-pinned-"));
    try {
      // Events 7 and 8 arrive after SP pinned the export at 6; they never enter the bundle.
      const events = Array.from({ length: 8 }, (_, index) => ({ ingestSeq: index + 1,
        event: { type: "unknown.public.event", payload: { content: "x".repeat(70), index } } }));
      const queries: Record<string, string>[] = [];
      let failSecondPage = true;
      const harness = createSpHarness({
        origin: "https://sp.test", serviceToken: "service",
        fetch: async (input, init) => {
          const url = new URL(new Request(input, init).url);
          if (url.pathname.endsWith("/artifacts")) return Response.json({ artifacts: [] });
          queries.push(Object.fromEntries(url.searchParams));
          const afterSeq = Number(url.searchParams.get("afterSeq"));
          const throughSeq = Number(url.searchParams.get("throughSeq") ?? 6);
          if (afterSeq > 0 && failSecondPage) {
            failSecondPage = false;
            return Response.json({ code: "EVIDENCE_NOT_READY", errMsg: "not ready" }, { status: 409 });
          }
          const page = events.filter((entry) => entry.ingestSeq > afterSeq && entry.ingestSeq <= throughSeq).slice(0, 5);
          const last = page.at(-1)?.ingestSeq;
          return Response.json({ events: page, nextAfterSeq: last === undefined || last === throughSeq ? null : last,
            format: "sp-trajectory/v1", cursor: { throughSeq } });
        },
      });
      const store = createEvidenceStore(await openLocalEvidenceBlobs(root));
      let progress: EvidenceExportProgress | undefined;
      const onProgress = async (next: EvidenceExportProgress) => { progress = structuredClone(next); };

      const first = await harness.exportEvidence({ handle: subject, submissionId: "submission-1", limits });
      expect(first.trajectoryCursor).toEqual({ throughSeq: 6 });
      await expect(store.resume({ evidence: first, limits, onProgress })).rejects.toMatchObject({ retryable: true, status: 409 });
      expect(progress!.trajectory).toMatchObject({ format: "sp-trajectory/v1", cursor: { throughSeq: 6 } });
      expect(progress!.trajectory.afterSeq).toBeGreaterThan(0);

      // The next pass hands the saved pin back, as Runtime does; the Harness never pins again.
      const { format, cursor } = progress!.trajectory;
      queries.length = 0;
      const resumed = await harness.exportEvidence({ handle: subject, submissionId: "submission-1", limits,
        trajectory: { ...(format === undefined ? {} : { format }), ...(cursor === undefined ? {} : { cursor }) } });
      const evidence = await store.open(await store.resume({ evidence: resumed, limits, progress: progress!, onProgress }));
      expect(queries.length).toBeGreaterThan(0);
      expect(queries.every((query) => query.throughSeq === "6")).toBe(true);
      expect(evidence.manifest.trajectory).toMatchObject({ format: "sp-trajectory/v1", events: 6 });
      const lines = (await Promise.all(evidence.manifest.trajectory.parts.map(async (part) =>
        new Response(await evidence.readBlob(part.sha256)).text()))).join("").trimEnd().split("\n").map((line) => JSON.parse(line));
      expect(lines).toEqual(events.slice(0, 6));

      // A pin that differs from the saved progress is never concatenated with it.
      const moved = await harness.exportEvidence({ handle: subject, submissionId: "submission-1", limits, trajectory: { format: "sp-trajectory/v1", cursor: { throughSeq: 8 } } });
      await expect(store.resume({ evidence: moved, limits, progress: progress! }))
        .rejects.toMatchObject({ name: "EvidenceIntegrityError", retryable: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { events: [{ ingestSeq: 1, event: {} }], nextAfterSeq: 0 },
    { events: [{ ingestSeq: 2, event: {} }, { ingestSeq: 1, event: {} }], nextAfterSeq: null },
  ])("rejects a trajectory page that cannot preserve source order: %j", async (page) => {
    const harness = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async (input) => Response.json(new URL(String(input instanceof Request ? input.url : input)).pathname.endsWith("/artifacts") ? { artifacts: [] } : page) });
    const exported = await harness.exportEvidence({ handle: subject, submissionId: "submission-1", limits });
    await expect((async () => { for await (const _event of exported.readTrajectory(0)) { /* Consume the entire source. */ } })())
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
    const urls: URL[] = [];
    const harness = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        urls.push(url);
        return Response.json(pages[url.searchParams.get("afterSeq") === "0" ? 0 : 1]);
      } });
    const reply = { handle: evaluator, submissionId: "evaluation-submission" };
    await expect(harness.readFinalReply(reply)).resolves.toBe("final\n```json\n{}\n```");
    expect(urls.every((url) => url.pathname.endsWith(`/chats/${evaluator.chatId}/evidence/trajectory`)
      && url.searchParams.get("submissionId") === "evaluation-submission")).toBe(true);
    const empty = createSpHarness({ origin: "https://sp.test", serviceToken: "service",
      fetch: async () => Response.json({ events: [], nextAfterSeq: null }) });
    await expect(empty.readFinalReply(reply)).resolves.toBeUndefined();
  });
});
