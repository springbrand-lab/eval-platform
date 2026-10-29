import { createHash } from "node:crypto";
import { MetricsEntityNotFoundError } from "@eval-platform/eval-metrics";
import { EVAL_EVIDENCE_TRAJECTORY_PAGE_MAX } from "@springbrand/eval-harness";
import { describe, expect, it, vi } from "vitest";
import { nativeAssistantMessage, nativeTransfer } from "../sp/native-test-fixture.js";
import { detail } from "./metrics-fixture.js";
import { MANAGEMENT_TRAJECTORY_PATH } from "./trajectory.js";
import { MANAGEMENT_TOKEN, OWNER, RESULT_TOKEN, WEB_TOKEN, project, run, setupManagement } from "./test-fixture.js";

const subject = { projectId: project.projectId, samplingId: "sampling-1", role: "subject" };
const evaluator = { ...subject, role: "evaluator", evaluationId: "evaluation-1" };
const address = (query: Record<string, string>) => `${MANAGEMENT_TRAJECTORY_PATH}?${new URLSearchParams(query)}`;
const get = (app: ReturnType<typeof setupManagement>, query: Record<string, string>, token = MANAGEMENT_TOKEN) =>
  app.request(address(query), { headers: { Authorization: `Bearer ${token}` } });
const page = (chatId: string, ingestSeq: number | readonly number[], throughSeq: number, nextAfterSeq: number | null) => ({
  format: "sp-pi-trajectory/v1", cursor: { throughSeq },
  records: (typeof ingestSeq === "number" ? [ingestSeq] : ingestSeq).map((seq) =>
    nativeAssistantMessage(seq, chatId, "submission-1", [{ type: "text", text: `private ${chatId} entry ${seq}` }])),
  nextAfterSeq,
});

function completeFile(body: string) {
  const lines = body.split("\n");
  expect(lines.at(-1)).toBe("");
  const manifest = JSON.parse(lines.at(-2)!) as {
    type: string; format: string; projectId: string; samplingId: string; runScope: string; runId?: string;
    role: string; evaluationId?: string; chatId: string; throughSeq: number; recordCount: number;
    recordsSha256: string; complete: boolean;
  };
  const recordLines = lines.slice(0, -2).map((line) => `${line}\n`);
  expect(manifest.type).toBe("manifest");
  expect(manifest.format).toBe("sp-pi-trajectory/v1");
  expect(manifest.complete).toBe(true);
  expect(manifest.recordCount).toBe(recordLines.length);
  expect(manifest.recordsSha256).toBe(createHash("sha256").update(recordLines.join("")).digest("hex"));
  const records = recordLines.map((line) => JSON.parse(line) as { ingestSeq: number; record: unknown });
  expect(records.every((record) => Object.keys(record).join() === "ingestSeq,record")).toBe(true);
  expect(records.map(({ ingestSeq }) => ingestSeq)).toEqual([...records.map(({ ingestSeq }) => ingestSeq)]
    .sort((a, b) => a - b));
  expect(records.every(({ ingestSeq }) => ingestSeq <= manifest.throughSeq)).toBe(true);
  return { manifest, records, recordLines };
}

async function incompleteFile(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  await expect((async () => {
    for (;;) {
      const item = await reader.read();
      if (item.done) return;
      chunks.push(item.value);
    }
  })()).rejects.toThrow();
  const partial = Buffer.concat(chunks).toString("utf8");
  expect(partial).not.toContain("\"type\":\"manifest\"");
  return partial;
}

describe("read-only trusted complete SAFE Pi trajectory file", () => {
  it("requires the management Bearer before leasing an owner, rejecting unknown/duplicate query fields", async () => {
    const disabled = setupManagement(false);
    expect((await get(disabled, subject)).status).toBe(404);
    expect(disabled.ownerServices).not.toHaveBeenCalled();
    const app = setupManagement();
    for (const token of [RESULT_TOKEN, WEB_TOKEN, "bad"]) expect((await get(app, subject, token)).status).toBe(401);
    expect(app.ownerServices).not.toHaveBeenCalled();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await app.request(address(subject), { method, headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` } });
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET");
    }
    expect(app.ownerServices).not.toHaveBeenCalled();
    for (const path of [
      `${address(subject)}&url=https%3A%2F%2Fother.test`,
      `${address(subject)}&projectId=other-project`,
      address({ ...subject, role: "evaluator" }),
      address({ ...subject, evaluationId: "evaluation-1" }),
      address({ ...subject, role: "not-a-role" }),
    ]) {
      const response = await app.request(path, { headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` } });
      expect(response.status).not.toBe(200);
    }
    expect(app.observation.trajectory).not.toHaveBeenCalled();
  });

  it("streams multi-record native pages, a last partial page and one verified frozen manifest", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    app.observation.trajectory.mockResolvedValueOnce(page("subject-chat", [1, 4, 5], 9, 5))
      .mockResolvedValueOnce(page("subject-chat", [6, 9], 9, null));
    const response = await get(app, subject);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-length")).toBeNull();
    const body = await response.text();
    const { manifest, records } = completeFile(body);
    expect(manifest).toEqual({
      type: "manifest", format: "sp-pi-trajectory/v1", projectId: project.projectId, samplingId: "sampling-1",
      runScope: "project_current", role: "subject", chatId: "subject-chat", throughSeq: 9, recordCount: 5,
      recordsSha256: expect.stringMatching(/^[0-9a-f]{64}$/u), complete: true,
    });
    expect(records.map(({ ingestSeq }) => ingestSeq)).toEqual([1, 4, 5, 6, 9]);
    expect(JSON.stringify(records)).toContain("private subject-chat entry 4");
    expect(app.observation.trajectory).toHaveBeenCalledTimes(2);
    expect(app.observation.trajectory).toHaveBeenNthCalledWith(1,
      { ownerUserId: OWNER, chatId: "subject-chat" }, { afterSeq: 0, limit: EVAL_EVIDENCE_TRAJECTORY_PAGE_MAX },
      expect.any(AbortSignal));
    expect(app.observation.trajectory).toHaveBeenNthCalledWith(2,
      { ownerUserId: OWNER, chatId: "subject-chat" },
      { afterSeq: 5, throughSeq: 9, limit: EVAL_EVIDENCE_TRAJECTORY_PAGE_MAX }, expect.any(AbortSignal));
    expect(app.services.projectRuns.readRun).not.toHaveBeenCalled();
    expect(app.services.metrics.getSamplingDetail).toHaveBeenCalledTimes(2);
    expect(app.observation.trajectoryRecord).not.toHaveBeenCalled();
    expect(body).not.toContain(MANAGEMENT_TOKEN);
    expect(body).not.toContain("fixed-session");
  });

  it("handles an empty frozen Chat with a complete zero-record manifest", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    app.observation.trajectory.mockResolvedValueOnce({
      format: "sp-pi-trajectory/v1", cursor: { throughSeq: 0 }, records: [], nextAfterSeq: null,
    });
    const { manifest, records } = completeFile(await (await get(app, subject)).text());
    expect(records).toHaveLength(0);
    expect(manifest.throughSeq).toBe(0);
    expect(manifest.recordsSha256).toBe(createHash("sha256").digest("hex"));
    expect(app.observation.trajectory).toHaveBeenCalledTimes(1);
  });

  it("scopes Evaluator to the matching current Evaluation and exact Run, never the Subject Chat", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    app.observation.trajectory.mockResolvedValueOnce(page("evaluator-chat", 4, 4, null));
    const { manifest, records } = completeFile(await (await get(app, { ...evaluator, runId: run.runId })).text());
    expect(manifest).toMatchObject({ role: "evaluator", evaluationId: "evaluation-1",
      runScope: "exact_run", runId: run.runId, chatId: "evaluator-chat", throughSeq: 4 });
    expect(records[0]!.record).toMatchObject({ resource: { sessionId: "evaluator-chat" } });
    expect(app.services.projectRuns.readRun).toHaveBeenCalledTimes(2);
    expect(app.services.metrics.getSamplingDetail).toHaveBeenCalledWith({
      projectId: project.projectId, samplingId: "sampling-1", runIds: [run.runId],
    });
    expect(app.services.observations.evaluator).toHaveBeenCalledWith(project.projectId, "evaluation-1");
    expect(app.services.observations.subject).not.toHaveBeenCalled();
    expect(app.observation.trajectory).toHaveBeenCalledTimes(1);
  });

  it("rejects nonmembers/foreign or replaced current facts, observation mismatches and not-started Chats before SP", async () => {
    const app = setupManagement();
    for (const query of [
      { ...subject, runId: "other-run" }, { ...subject, runId: run.runId, samplingId: "other-sampling" },
      { ...evaluator, runId: run.runId, evaluationId: "other-evaluation" },
      { ...subject, runId: run.runId, projectId: "other-project" },
    ]) expect((await get(app, query)).status).not.toBe(200);
    expect(app.services.metrics.getSamplingDetail).not.toHaveBeenCalled();
    app.services.metrics.getSamplingDetail.mockRejectedValueOnce(new MetricsEntityNotFoundError("sampling", "sampling-1"));
    expect((await get(app, subject)).status).toBe(404);
    app.services.metrics.getSamplingDetail.mockResolvedValueOnce({
      ...detail, project: { ...detail.project, ownerUserId: "other-owner" },
    });
    expect((await get(app, subject)).status).not.toBe(200);
    app.services.metrics.getSamplingDetail.mockResolvedValueOnce(detail);
    app.services.observations.subject.mockResolvedValueOnce({ role: "subject", projectId: project.projectId,
      samplingId: "sampling-1", ownerUserId: OWNER, chatId: "foreign-chat", state: "available" });
    expect((await get(app, subject)).status).not.toBe(200);
    app.services.metrics.getSamplingDetail.mockResolvedValueOnce({
      ...detail, sampling: { ...detail.sampling, subjectChatId: undefined },
      subject: { ...detail.subject, chatId: null },
    });
    app.services.observations.subject.mockResolvedValueOnce({ role: "subject", projectId: project.projectId,
      samplingId: "sampling-1", ownerUserId: OWNER, chatId: undefined, state: "not-started" });
    expect((await get(app, subject)).status).toBe(404);
    app.services.metrics.getSamplingDetail.mockResolvedValueOnce({ ...detail,
      evaluations: [{ ...detail.evaluations[0]!,
        record: { ...detail.evaluations[0]!.record, samplingId: "other-sampling" } }],
    });
    expect((await get(app, evaluator)).status).toBe(404);
    expect(app.observation.trajectory).not.toHaveBeenCalled();
    expect(app.observation.trajectoryRecord).not.toHaveBeenCalled();
  });

  it("streams an original referenced SAFE record exactly once (not repeated per 4-KiB chunk)", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    const native = nativeAssistantMessage(4, "evaluator-chat", "submission-1",
      [{ type: "text", text: "trusted SAFE model/tool body 汉🌎".repeat(550) }]);
    const transfer = nativeTransfer(native, 4);
    // The reference must keep its original JSON whitespace instead of rebuilding it from the parsed record.
    const bytes = Buffer.from(Buffer.from(transfer.bytes).toString("utf8").replace('{"format":', '{ "format":'));
    const reference = { ...transfer.reference, reference: { ...transfer.reference.reference,
      byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"),
    } };
    app.observation.trajectory.mockResolvedValueOnce({
      format: "sp-pi-trajectory/v1", cursor: { throughSeq: 4 }, records: [reference], nextAfterSeq: null,
    });
    const dispose = vi.fn(async () => {});
    app.observation.trajectoryRecord.mockResolvedValueOnce({
      byteLength: bytes.byteLength, sha256: reference.reference.sha256,
      async *bytes() {
        for (let at = 0; at < bytes.byteLength; at += 257) yield bytes.subarray(at, at + 257);
      }, dispose,
    });
    const body = await (await get(app, { ...evaluator, runId: run.runId })).text();
    const { manifest, records, recordLines } = completeFile(body);
    expect(records).toEqual([{ ingestSeq: 4, record: native.record }]);
    expect(recordLines[0]).toBe(`{"ingestSeq":4,"record":${Buffer.from(bytes).toString("utf8")}}\n`);
    expect(manifest).toMatchObject({ role: "evaluator", throughSeq: 4, recordCount: 1, complete: true });
    expect(app.observation.trajectoryRecord).toHaveBeenCalledExactlyOnceWith(
      { ownerUserId: OWNER, chatId: "evaluator-chat" }, reference, expect.any(AbortSignal));
    expect(app.observation.trajectory).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid public pages before any bytes, and a changed cutoff without a success manifest", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    app.observation.trajectory.mockResolvedValueOnce({ format: "sp-pi-trajectory/v1", cursor: { throughSeq: 5 },
      records: [nativeAssistantMessage(4, "foreign-chat", "submission-1", [{ type: "text", text: "foreign" }])],
      nextAfterSeq: null });
    const foreign = await get(app, subject);
    expect(foreign.status).not.toBe(200);
    expect(await foreign.text()).not.toContain("foreign");
    expect(app.observation.trajectoryRecord).not.toHaveBeenCalled();
    const { reference: foreignRef } = nativeTransfer(nativeAssistantMessage(4, "foreign-chat", "submission-1",
      [{ type: "text", text: "foreign body" }]), 4);
    app.observation.trajectory.mockResolvedValueOnce({ format: "sp-pi-trajectory/v1",
      cursor: { throughSeq: 4 }, records: [foreignRef], nextAfterSeq: null });
    expect((await get(app, subject)).status).not.toBe(200);
    expect(app.observation.trajectoryRecord).not.toHaveBeenCalled();
    app.observation.trajectory.mockResolvedValueOnce(page("subject-chat", 4, 5, 4))
      .mockResolvedValueOnce(page("subject-chat", 5, 6, null));
    const partial = await incompleteFile(await get(app, subject));
    expect(partial).toContain("private subject-chat entry 4");
    expect(partial).not.toContain("entry 5");
  });

  it("rejects duplicate/out-of-order rows and invalid next cursors within or across pages, without a terminal manifest", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    for (const invalid of [
      page("subject-chat", [4, 4], 9, 4),
      page("subject-chat", [6, 5], 9, 5),
      page("subject-chat", [4, 5], 9, 4),
      page("subject-chat", [4, 10], 9, null),
    ]) {
      app.observation.trajectory.mockResolvedValueOnce(invalid);
      expect((await get(app, subject)).status).not.toBe(200);
    }
    app.observation.trajectory.mockResolvedValueOnce(page("subject-chat", [4, 6], 9, 6))
      .mockResolvedValueOnce(page("subject-chat", [6, 9], 9, null));
    const partial = await incompleteFile(await get(app, subject));
    expect(partial).toContain("entry 4");
    expect(partial).not.toContain("entry 9");
    expect(app.observation.trajectoryRecord).not.toHaveBeenCalled();
  });

  it("omits the manifest if the next frozen page is missing after multiple records were sent", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    app.observation.trajectory.mockResolvedValueOnce(page("subject-chat", [1, 3, 5], 9, 5))
      .mockRejectedValueOnce(new Error("SP page unavailable"));
    const partial = await incompleteFile(await get(app, subject));
    expect(partial).toContain("entry 5");
    expect(app.observation.trajectory).toHaveBeenCalledTimes(2);
  });

  it("never sends even a JSONL prefix for an unverified reference", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    const { reference } = nativeTransfer(nativeAssistantMessage(4, "subject-chat", "submission-1",
      [{ type: "text", text: "private rejected body" }]), 4);
    app.observation.trajectory.mockResolvedValueOnce({
      format: "sp-pi-trajectory/v1", cursor: { throughSeq: 4 }, records: [reference], nextAfterSeq: null,
    });
    app.observation.trajectoryRecord.mockRejectedValueOnce(new Error("source is corrupt"));
    expect(await incompleteFile(await get(app, subject))).toBe("");
  });

  it("withholds the terminal manifest if current ownership changes before completion", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValueOnce(detail)
      .mockRejectedValueOnce(new MetricsEntityNotFoundError("sampling", "sampling-1"));
    app.observation.trajectory.mockResolvedValueOnce(page("subject-chat", 4, 4, null));
    const partial = await incompleteFile(await get(app, subject));
    expect(partial).toContain("private subject-chat entry 4");
    expect(partial).not.toContain("\"type\":\"manifest\"");
    expect(app.services.metrics.getSamplingDetail).toHaveBeenCalledTimes(2);
  });

  it("cancels an in-flight file, disposing a per-record spool without fetching subsequent pages", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    const { reference, bytes } = nativeTransfer(nativeAssistantMessage(4, "subject-chat", "submission-1",
      [{ type: "text", text: "long private response".repeat(350) }]), 5);
    app.observation.trajectory.mockResolvedValueOnce({
      format: "sp-pi-trajectory/v1", cursor: { throughSeq: 5 }, records: [reference], nextAfterSeq: 4,
    });
    const dispose = vi.fn(async () => {});
    app.observation.trajectoryRecord.mockResolvedValueOnce({
      byteLength: bytes.byteLength, sha256: reference.reference.sha256,
      async *bytes() { yield bytes; }, dispose,
    });
    const response = await get(app, subject);
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new TextEncoder().encode('{"ingestSeq":4,"record":'));
    await reader.cancel();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(app.observation.trajectory).toHaveBeenCalledTimes(1);
    expect(app.services.metrics.getSamplingDetail).toHaveBeenCalledTimes(1);
  });
});
