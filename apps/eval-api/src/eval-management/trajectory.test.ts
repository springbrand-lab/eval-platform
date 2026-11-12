import { createHash } from "node:crypto";
import { MetricsEntityNotFoundError } from "@eval-platform/eval-metrics";
import { EVAL_EVIDENCE_FILE_MAX_BYTES, EVAL_EVIDENCE_TRAJECTORY_PAGE_MAX } from "@springbrand/eval-harness";
import { describe, expect, it, vi } from "vitest";
import { nativeAssistantMessage, nativeTransfer, nativeTransferResponse } from "../sp/native-test-fixture.js";
import { createSpObservationClient, type SpObservationClient } from "../sp/observation.js";
import { detail } from "./metrics-fixture.js";
import { MANAGEMENT_TRAJECTORY_PATH } from "./trajectory.js";
import {
  MANAGEMENT_TOKEN, OWNER, RESULT_TOKEN, WEB_TOKEN, project, run, setupManagement as setupManagementFixture,
} from "./test-fixture.js";

const subject = { projectId: project.projectId, samplingId: "sampling-1", role: "subject" };
const evaluator = { ...subject, role: "evaluator", evaluationId: "evaluation-1" };
const address = (query: Record<string, string>) => `${MANAGEMENT_TRAJECTORY_PATH}?${new URLSearchParams(query)}`;
const get = (app: ReturnType<typeof setupManagement>, query: Record<string, string>, token = MANAGEMENT_TOKEN) =>
  app.request(address(query), { headers: { Authorization: `Bearer ${token}` } });
const withPublicSp = (app: ReturnType<typeof setupManagement>, fetch: typeof globalThis.fetch) => {
  // The production binding is readonly; this fixture intentionally substitutes a local mock transport.
  Object.assign(app.runtime, { observation: createSpObservationClient({
    agentOrigin: "https://agent.test", apiOrigin: "https://api.test", trustedOrigin: "https://web.test",
    sessionToken: "fixed-session", fetch,
  }) });
};
const page = (chatId: string, ingestSeq: number | readonly number[], throughSeq: number, nextAfterSeq: number | null) => ({
  format: "sp-pi-trajectory/v1", cursor: { throughSeq },
  records: (typeof ingestSeq === "number" ? [ingestSeq] : ingestSeq).map((seq) =>
    nativeAssistantMessage(seq, chatId, "submission-1", [{ type: "text", text: `private ${chatId} entry ${seq}` }])),
  nextAfterSeq,
});

function setupManagement(configured = true) {
  const app = setupManagementFixture(configured);
  // Page fixtures enter as HTTP payloads. Never replace the owned observation/page parser.
  const pages = vi.fn(async (request: Request): Promise<unknown> => {
    const chatId = decodeURIComponent(new URL(request.url).pathname.split("/")[3]!);
    return page(chatId, 4, 4, null);
  });
  const observation = createSpObservationClient({
    agentOrigin: "https://agent.test", apiOrigin: "https://api.test", trustedOrigin: "https://web.test",
    sessionToken: "fixed-session",
    fetch: async (source, init) => Response.json({ success: true, msg: await pages(new Request(source, init)) }),
  });
  // The private verified-file seam can independently fail or be cancelled after parsing a page.
  const trajectoryRecord = vi.fn<SpObservationClient["trajectoryRecord"]>(async () => {
    throw new Error("Unexpected raw Pi record-byte read");
  });
  const observed = { ...observation, trajectoryRecord };
  Object.assign(app.runtime, { observation: observed });
  return { ...app, observation: observed, pages };
}

/** Real raw Pi JSON with a reusable 64 KiB text chunk: compute hashes without materializing a giant record. */
function virtualReference(ingestSeq: number, throughSeq: number, repetitions: number) {
  const marker = "__RAW_BODY__";
  const native = nativeAssistantMessage(ingestSeq, "subject-chat", "submission-1", [{ type: "text", text: marker }]);
  const original = JSON.stringify(native.record);
  const at = original.indexOf(marker);
  if (at < 0 || original.indexOf(marker, at + marker.length) !== -1) throw new Error("Missing unique test marker");
  const before = Buffer.from(original.slice(0, at));
  const after = Buffer.from(original.slice(at + marker.length));
  const chunk = Buffer.alloc(64 * 1024, "a");
  const sha = createHash("sha256").update(before);
  for (let index = 0; index < repetitions; index++) sha.update(chunk);
  sha.update(after);
  const { reference: base } = nativeTransfer(native, throughSeq);
  const reference = { ...base, reference: { ...base.reference,
    byteLength: before.byteLength + repetitions * chunk.byteLength + after.byteLength,
    sha256: sha.digest("hex"),
  } };
  return { reference, async *bytes() {
    yield before;
    for (let index = 0; index < repetitions; index++) yield chunk;
    yield after;
  } };
}

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

describe("read-only trusted complete raw Pi trajectory file", () => {
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
    expect(app.pages).not.toHaveBeenCalled();
  });

  it("streams multi-record native pages, a last partial page and one verified frozen manifest", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    app.pages.mockResolvedValueOnce(page("subject-chat", [1, 4, 5], 9, 5))
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
    expect(app.pages.mock.calls.map(([request]) => request.url)).toEqual([
      `https://api.test/api/chats/subject-chat/trajectory?afterSeq=0&limit=${EVAL_EVIDENCE_TRAJECTORY_PAGE_MAX}`,
      `https://api.test/api/chats/subject-chat/trajectory?afterSeq=5&limit=${EVAL_EVIDENCE_TRAJECTORY_PAGE_MAX}&throughSeq=9`,
    ]);
    expect(app.services.projectRuns.readRun).not.toHaveBeenCalled();
    expect(app.services.metrics.getSamplingDetail).toHaveBeenCalledTimes(2);
    expect(app.observation.trajectoryRecord).not.toHaveBeenCalled();
    expect(body).not.toContain(MANAGEMENT_TOKEN);
    expect(body).not.toContain("fixed-session");
  });

  it("downloads the whole Chat from public SP pages and a verified owner-session record GET, then frames one NDJSON manifest", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    const context = nativeAssistantMessage(1, "subject-chat", "earlier-submission",
      [{ type: "text", text: "imported context" }]);
    const imported = { ...context, record: { ...context.record, submissionId: null, origin: "context" as const } };
    const earlier = nativeAssistantMessage(4, "subject-chat", "earlier-submission",
      [{ type: "text", text: "汉🌎é".repeat(2_000) }]);
    const current = nativeAssistantMessage(9, "subject-chat", "current-submission",
      [{ type: "text", text: "current response" }]);
    const transfer = nativeTransfer(earlier, 9);
    const original = Buffer.from(JSON.stringify(earlier.record).replace('{"format":', '{ "format":'));
    const reference = { ...transfer.reference, reference: { ...transfer.reference.reference,
      byteLength: original.byteLength, sha256: createHash("sha256").update(original).digest("hex"),
    } };
    const calls: URL[] = [];
    const fetch = vi.fn(async (source: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(source, init);
      const url = new URL(request.url);
      calls.push(url);
      expect(request.headers.get("Authorization")).toBe("Bearer fixed-session");
      expect(request.headers.get("Origin")).toBe("https://web.test");
      if (url.pathname.endsWith("/trajectory")) {
        expect(request.redirect).toBe("manual");
        expect(url.searchParams.get("limit")).toBe(String(EVAL_EVIDENCE_TRAJECTORY_PAGE_MAX));
        return Response.json({ success: true, msg: url.searchParams.get("afterSeq") === "0"
          ? { format: "sp-pi-trajectory/v1", cursor: { throughSeq: 9 },
            records: [imported, reference], nextAfterSeq: 4 }
          : { format: "sp-pi-trajectory/v1", cursor: { throughSeq: 9 },
            records: [current], nextAfterSeq: null } });
      }
      expect(request.redirect).toBe("error");
      expect(url.pathname).toBe("/api/chats/subject-chat/trajectory/records/4");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        throughSeq: "9", identity: reference.reference.identity,
        byteLength: String(original.byteLength), sha256: reference.reference.sha256,
      });
      return nativeTransferResponse(reference, original);
    });
    withPublicSp(app, fetch);
    const response = await get(app, subject);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    const { manifest, records, recordLines } = completeFile(await response.text());
    expect(records.map(({ ingestSeq }) => ingestSeq)).toEqual([1, 4, 9]);
    expect(records[0]!.record).toMatchObject({ submissionId: null, origin: "context" });
    expect(records[1]!.record).toEqual(earlier.record);
    expect(recordLines[1]).toBe(`{"ingestSeq":4,"record":${original.toString("utf8")}}\n`);
    expect(manifest).toMatchObject({ throughSeq: 9, chatId: "subject-chat", recordCount: 3, complete: true });
    expect(calls.map(({ pathname, searchParams }) => [
      pathname, searchParams.get("afterSeq"), searchParams.get("throughSeq"),
    ])).toEqual([
      ["/api/chats/subject-chat/trajectory", "0", null],
      ["/api/chats/subject-chat/trajectory/records/4", null, "9"],
      ["/api/chats/subject-chat/trajectory", "4", "9"],
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("accepts a continuation at the frozen cutoff followed by an empty EOF page", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    const native = nativeAssistantMessage(4, "subject-chat", "submission-1", [{ type: "text", text: "complete raw record" }]);
    const transfer = nativeTransfer(native, 4);
    const fetch = vi.fn(async (source: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(source, init).url);
      if (url.pathname.endsWith("/records/4")) return nativeTransferResponse(transfer.reference, transfer.bytes);
      const first = url.searchParams.get("afterSeq") === "0";
      return Response.json({ success: true, msg: {
        format: "sp-pi-trajectory/v1", cursor: { throughSeq: 4 },
        records: first ? [transfer.reference] : [], nextAfterSeq: first ? 4 : null,
      } });
    });
    withPublicSp(app, fetch);
    const response = await get(app, subject);
    expect(response.status).toBe(200);
    const { manifest, records } = completeFile(await response.text());
    expect(records).toEqual([native]);
    expect(manifest).toMatchObject({ throughSeq: 4, recordCount: 1, complete: true });
    expect(fetch.mock.calls.map(([source, init]) => {
      const url = new URL(new Request(source, init).url);
      return [url.pathname, url.searchParams.get("afterSeq"), url.searchParams.get("throughSeq")];
    })).toEqual([
      ["/api/chats/subject-chat/trajectory", "0", null],
      ["/api/chats/subject-chat/trajectory/records/4", null, "4"],
      ["/api/chats/subject-chat/trajectory", "4", "4"],
    ]);
  });

  it.each(["empty continuation", "replayed continuation", "changed cutoff"] as const)(
    "never certifies an %s after a real cutoff-equality page", async (failure) => {
      const app = setupManagement();
      app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
      const native = nativeAssistantMessage(4, "subject-chat", "submission-1", [{ type: "text", text: "verified prefix" }]);
      const { reference, bytes } = nativeTransfer(native, 4);
      const requests: URL[] = [];
      const fetch = vi.fn(async (source: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(new Request(source, init).url);
        requests.push(url);
        if (url.pathname.endsWith("/records/4")) return nativeTransferResponse(reference, bytes);
        const first = url.searchParams.get("afterSeq") === "0";
        return Response.json({ success: true, msg: {
          format: "sp-pi-trajectory/v1",
          cursor: { throughSeq: !first && failure === "changed cutoff" ? 5 : 4 },
          records: first || failure === "replayed continuation" ? [reference] : [],
          nextAfterSeq: first || failure !== "changed cutoff" ? 4 : null,
        } });
      });
      withPublicSp(app, fetch);
      const response = await get(app, subject);
      expect(response.status).toBe(200);
      expect(await incompleteFile(response)).toBe(`${JSON.stringify(native)}\n`);
      expect(requests.filter(({ pathname }) => pathname.endsWith("/trajectory"))
        .map(({ searchParams }) => [searchParams.get("afterSeq"), searchParams.get("throughSeq")]))
        .toEqual([["0", null], ["4", "4"]]);
      expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("handles an empty frozen Chat with a complete zero-record manifest", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    app.pages.mockResolvedValueOnce({
      format: "sp-pi-trajectory/v1", cursor: { throughSeq: 0 }, records: [], nextAfterSeq: null,
    });
    const { manifest, records } = completeFile(await (await get(app, subject)).text());
    expect(records).toHaveLength(0);
    expect(manifest.throughSeq).toBe(0);
    expect(manifest.recordsSha256).toBe(createHash("sha256").digest("hex"));
    expect(app.pages).toHaveBeenCalledTimes(1);
  });

  it("returns an HTTP error, not a 200 record prefix, if the first public SP page fails", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    const fetch = vi.fn(async () => new Response(null, { status: 503 }));
    withPublicSp(app, fetch);
    const response = await get(app, subject);
    expect(response.status).not.toBe(200);
    expect(response.headers.get("content-type")).not.toBe("application/x-ndjson; charset=utf-8");
    expect(await response.text()).not.toContain('"type":"manifest"');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a declared oversized first SP JSON page before responding with an attachment", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ success: true, msg: page("subject-chat", 4, 4, null) }), {
      headers: { "Content-Type": "application/json", "Content-Length": "4000001" },
    }));
    withPublicSp(app, fetch);
    expect((await get(app, subject)).status).not.toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an SP JSON page mislabelled text/plain before returning a 200 trajectory", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ success: true, msg: page("subject-chat", 4, 4, null) }), {
      headers: { "Content-Type": "text/plain" },
    }));
    withPublicSp(app, fetch);
    expect((await get(app, subject)).status).not.toBe(200);
  });

  it("withholds the success manifest if a later public SP JSON page has the wrong Content-Type", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    const fetch = vi.fn(async (source: RequestInfo | URL, init?: RequestInit) => {
      const after = new URL(new Request(source, init).url).searchParams.get("afterSeq");
      return new Response(JSON.stringify({ success: true, msg: after === "0"
        ? page("subject-chat", 4, 9, 4) : page("subject-chat", 9, 9, null) }), {
        headers: { "Content-Type": after === "0" ? "application/json" : "text/plain" },
      });
    });
    withPublicSp(app, fetch);
    const response = await get(app, subject);
    expect(response.status).toBe(200);
    const partial = await incompleteFile(response);
    expect(partial).toContain("private subject-chat entry 4");
    expect(partial).not.toContain("entry 9");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("scopes Evaluator to the matching current Evaluation and exact Run, never the Subject Chat", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    app.pages.mockResolvedValueOnce(page("evaluator-chat", 4, 4, null));
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
    expect(app.pages).toHaveBeenCalledTimes(1);
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
    expect(app.pages).not.toHaveBeenCalled();
    expect(app.observation.trajectoryRecord).not.toHaveBeenCalled();
  });

  it("streams an original referenced raw record exactly once (not repeated per 4-KiB chunk)", async () => {
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
    app.pages.mockResolvedValueOnce({
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
    expect(app.pages).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("never certifies a reference with literal JSON whitespace newlines as one complete NDJSON record", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    const native = nativeAssistantMessage(4, "subject-chat", "submission-1",
      [{ type: "text", text: "a literal escaped \\n is fine, but JSON formatting is not" }]);
    const bytes = Buffer.from(JSON.stringify(native.record).replace(',"record":', ',\n"record":'));
    const { reference: base } = nativeTransfer(native, 4);
    const reference = { ...base, reference: { ...base.reference,
      byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"),
    } };
    const fetch = vi.fn(async (source: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(source, init).url);
      return url.pathname.endsWith("/trajectory")
        ? Response.json({ success: true, msg: {
          format: "sp-pi-trajectory/v1", cursor: { throughSeq: 4 }, records: [reference], nextAfterSeq: null,
        } })
        : nativeTransferResponse(reference, bytes);
    });
    withPublicSp(app, fetch);
    const response = await get(app, subject);
    expect(response.status).toBe(200);
    const partial = await incompleteFile(response);
    expect(partial).toBe("");
    expect(partial).not.toContain('"type":"manifest"');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("streams a raw record larger than the public JSON page ceiling through one owner-session reference", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    const native = nativeAssistantMessage(4, "subject-chat", "submission-1",
      [{ type: "text", text: "汉🌎".repeat(610_000) }]);
    const { reference, bytes } = nativeTransfer(native, 4);
    expect(bytes.byteLength).toBeGreaterThan(4_000_000);
    expect(bytes.byteLength).toBeLessThan(EVAL_EVIDENCE_FILE_MAX_BYTES);
    const fetch = vi.fn(async (source: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(source, init);
      const url = new URL(request.url);
      return url.pathname.endsWith("/trajectory")
        ? Response.json({ success: true, msg: {
          format: "sp-pi-trajectory/v1", cursor: { throughSeq: 4 }, records: [reference], nextAfterSeq: null,
        } })
        : nativeTransferResponse(reference, bytes);
    });
    withPublicSp(app, fetch);
    const response = await get(app, subject);
    expect(response.status).toBe(200);
    const { manifest, records, recordLines } = completeFile(await response.text());
    expect(manifest.recordCount).toBe(1);
    expect(records[0]).toEqual(native);
    expect(Buffer.byteLength(recordLines[0]!)).toBeGreaterThan(4_000_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  }, 30_000);

  it("rejects a reference that cannot fit one SP evidence file without fetching its bytes", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    const { reference: base } = nativeTransfer(nativeAssistantMessage(4, "subject-chat", "submission-1",
      [{ type: "text", text: "do not fetch" }]), 4);
    // No 95 MB buffer is allocated: the published reference schema checks the framed file size.
    const overLimit = { ...base, reference: { ...base.reference, byteLength: EVAL_EVIDENCE_FILE_MAX_BYTES } };
    app.pages.mockResolvedValueOnce({
      format: "sp-pi-trajectory/v1", cursor: { throughSeq: 4 }, records: [overLimit], nextAfterSeq: null,
    });
    const response = await get(app, subject);
    expect(response.status).not.toBe(200);
    expect(app.observation.trajectoryRecord).not.toHaveBeenCalled();
  });

  it.each([
    ["unexpected MIME", { "Content-Type": "text/plain" }],
    ["compressed bytes", { "Content-Encoding": "gzip" }],
    ["false Content-Length", { "Content-Length": "1" }],
  ])("rejects an SP reference with %s before releasing any HTTP record prefix", async (_reason, headers) => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    const { reference, bytes } = nativeTransfer(nativeAssistantMessage(4, "subject-chat", "submission-1",
      [{ type: "text", text: "private record" }]), 4);
    const fetch = vi.fn(async (source: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(source, init).url);
      return url.pathname.endsWith("/trajectory")
        ? Response.json({ success: true, msg: {
          format: "sp-pi-trajectory/v1", cursor: { throughSeq: 4 }, records: [reference], nextAfterSeq: null,
        } })
        : nativeTransferResponse(reference, bytes, headers);
    });
    withPublicSp(app, fetch);
    const response = await get(app, subject);
    expect(response.status).toBe(200); // the first page succeeded before the record GET failed
    expect(await incompleteFile(response)).toBe("");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid public pages before any bytes, and a changed cutoff without a success manifest", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    app.pages.mockResolvedValueOnce({ format: "sp-pi-trajectory/v1", cursor: { throughSeq: 5 },
      records: [nativeAssistantMessage(4, "foreign-chat", "submission-1", [{ type: "text", text: "foreign" }])],
      nextAfterSeq: null });
    const foreign = await get(app, subject);
    expect(foreign.status).not.toBe(200);
    expect(await foreign.text()).not.toContain("foreign");
    expect(app.observation.trajectoryRecord).not.toHaveBeenCalled();
    const { reference: foreignRef } = nativeTransfer(nativeAssistantMessage(4, "foreign-chat", "submission-1",
      [{ type: "text", text: "foreign body" }]), 4);
    app.pages.mockResolvedValueOnce({ format: "sp-pi-trajectory/v1",
      cursor: { throughSeq: 4 }, records: [foreignRef], nextAfterSeq: null });
    expect((await get(app, subject)).status).not.toBe(200);
    expect(app.observation.trajectoryRecord).not.toHaveBeenCalled();
    app.pages.mockResolvedValueOnce(page("subject-chat", 4, 5, 4))
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
      app.pages.mockResolvedValueOnce(invalid);
      expect((await get(app, subject)).status).not.toBe(200);
    }
    app.pages.mockResolvedValueOnce(page("subject-chat", [4, 6], 9, 6))
      .mockResolvedValueOnce(page("subject-chat", [6, 9], 9, null));
    const partial = await incompleteFile(await get(app, subject));
    expect(partial).toContain("entry 4");
    expect(partial).not.toContain("entry 9");
    expect(app.observation.trajectoryRecord).not.toHaveBeenCalled();
  });

  it("omits the manifest if the next frozen page is missing after multiple records were sent", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    app.pages.mockResolvedValueOnce(page("subject-chat", [1, 3, 5], 9, 5))
      .mockRejectedValueOnce(new Error("SP page unavailable"));
    const partial = await incompleteFile(await get(app, subject));
    expect(partial).toContain("entry 5");
    expect(app.pages).toHaveBeenCalledTimes(2);
  });

  it("aborts the next public SP page when the download request ends, without a terminal manifest", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    const upstreamAbort = vi.fn();
    const fetch = vi.fn(async (source: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(source, init);
      if (new URL(request.url).searchParams.get("afterSeq") === "0") {
        return Response.json({ success: true, msg: page("subject-chat", 4, 9, 4) });
      }
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => {
          upstreamAbort();
          reject(request.signal.reason);
        }, { once: true });
      });
    });
    withPublicSp(app, fetch);
    const abort = new AbortController();
    const response = await app.request(address(subject), {
      headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` }, signal: abort.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let prefix = "";
    for (;;) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      prefix += new TextDecoder().decode(chunk.value);
      if (prefix.endsWith("}\n")) break;
    }
    const pendingPage = reader.read();
    try {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      abort.abort(new Error("trusted adapter deadline"));
      await expect(pendingPage).rejects.toThrow();
      expect(upstreamAbort).toHaveBeenCalledOnce();
      expect(prefix).toContain("private subject-chat entry 4");
      expect(prefix).not.toContain('"type":"manifest"');
      expect(app.services.metrics.getSamplingDetail).toHaveBeenCalledTimes(1);
    } finally {
      abort.abort();
    }
  });

  it("never sends even a JSONL prefix for an unverified reference", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    const { reference } = nativeTransfer(nativeAssistantMessage(4, "subject-chat", "submission-1",
      [{ type: "text", text: "private rejected body" }]), 4);
    app.pages.mockResolvedValueOnce({
      format: "sp-pi-trajectory/v1", cursor: { throughSeq: 4 }, records: [reference], nextAfterSeq: null,
    });
    app.observation.trajectoryRecord.mockRejectedValueOnce(new Error("source is corrupt"));
    expect(await incompleteFile(await get(app, subject))).toBe("");
  });

  it("never certifies a record if its private spool becomes short while streaming to HTTP", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    const { reference, bytes } = nativeTransfer(nativeAssistantMessage(4, "subject-chat", "submission-1",
      [{ type: "text", text: "broken disk spool" }]), 4);
    app.pages.mockResolvedValueOnce({
      format: "sp-pi-trajectory/v1", cursor: { throughSeq: 4 }, records: [reference], nextAfterSeq: null,
    });
    const dispose = vi.fn(async () => {});
    app.observation.trajectoryRecord.mockResolvedValueOnce({
      byteLength: bytes.byteLength, sha256: reference.reference.sha256,
      async *bytes() {
        yield bytes.subarray(0, 100);
        yield bytes.subarray(100, -1);
      }, dispose,
    });
    const partial = await incompleteFile(await get(app, subject));
    expect(partial).toContain('{"ingestSeq":4,"record":');
    expect(partial).not.toContain('"type":"manifest"');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("withholds the terminal manifest if current ownership changes before completion", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValueOnce(detail)
      .mockRejectedValueOnce(new MetricsEntityNotFoundError("sampling", "sampling-1"));
    app.pages.mockResolvedValueOnce(page("subject-chat", 4, 4, null));
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
    app.pages.mockResolvedValueOnce({
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
    expect(app.pages).toHaveBeenCalledTimes(1);
    expect(app.services.metrics.getSamplingDetail).toHaveBeenCalledTimes(1);
  });

  it("stops sending the current inline record when the original request signal is aborted after its prefix", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    app.pages.mockResolvedValueOnce(page("subject-chat", 4, 4, null));
    const abort = new AbortController();
    const response = await app.request(address(subject), {
      headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` }, signal: abort.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('{"ingestSeq":4,"record":');
    abort.abort(new Error("downstream stopped"));
    await expect(reader.read()).rejects.toThrow("downstream stopped");
    expect(app.services.metrics.getSamplingDetail).toHaveBeenCalledTimes(1);
  });

  it("stops between a reference body and its NDJSON suffix on abort, and removes the spool", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    const { reference, bytes } = nativeTransfer(nativeAssistantMessage(4, "subject-chat", "submission-1",
      [{ type: "text", text: "private bytes" }]), 4);
    app.pages.mockResolvedValueOnce({
      format: "sp-pi-trajectory/v1", cursor: { throughSeq: 4 }, records: [reference], nextAfterSeq: null,
    });
    const dispose = vi.fn(async () => {});
    app.observation.trajectoryRecord.mockResolvedValueOnce({
      byteLength: bytes.byteLength, sha256: reference.reference.sha256,
      async *bytes() { yield bytes; }, dispose,
    });
    const abort = new AbortController();
    const response = await app.request(address(subject), {
      headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` }, signal: abort.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('{"ingestSeq":4,"record":');
    expect((await reader.read()).value).toEqual(bytes);
    abort.abort(new Error("reference transfer stopped"));
    await expect(reader.read()).rejects.toThrow("reference transfer stopped");
    expect(dispose).toHaveBeenCalledOnce();
    expect(app.services.metrics.getSamplingDetail).toHaveBeenCalledTimes(1);
  });

  it("streams a complete 136 MiB file that exceeds Moss's 128 MiB limit without allocating 500 MB", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    const transfers = [virtualReference(1, 2, 1_088), virtualReference(2, 2, 1_088)];
    for (const transfer of transfers) expect(transfer.reference.reference.byteLength).toBeLessThan(EVAL_EVIDENCE_FILE_MAX_BYTES);
    app.pages.mockResolvedValueOnce({
      format: "sp-pi-trajectory/v1", cursor: { throughSeq: 2 },
      records: transfers.map((transfer) => transfer.reference), nextAfterSeq: null,
    });
    const dispose = vi.fn(async () => {});
    app.observation.trajectoryRecord.mockImplementation(async (_chat, row) => {
      const transfer = transfers.find((item) => item.reference.ingestSeq === row.ingestSeq)!;
      return { byteLength: transfer.reference.reference.byteLength, sha256: transfer.reference.reference.sha256,
        bytes: () => transfer.bytes(), dispose };
    });
    const response = await get(app, subject);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const mossMaxBytes = 128 * 1024 * 1024;
    let downloaded = 0;
    let reachedClientLimitBeforeManifest = false;
    let manifest: { type: string; recordCount: number; recordsSha256: string; complete: boolean } | undefined;
    const sha = createHash("sha256");
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const part = next.value;
      if (part.byteLength < 1_000 && new TextDecoder().decode(part).startsWith('{"type":"manifest"')) {
        expect(manifest).toBeUndefined();
        manifest = JSON.parse(new TextDecoder().decode(part));
      } else {
        expect(manifest).toBeUndefined(); // manifest must be followed only by EOF
        downloaded += part.byteLength;
        sha.update(part);
        if (downloaded > mossMaxBytes) reachedClientLimitBeforeManifest = true;
      }
    }
    expect(reachedClientLimitBeforeManifest).toBe(true);
    expect(downloaded).toBeGreaterThan(mossMaxBytes);
    expect(manifest).toEqual({ type: "manifest", recordCount: 2, recordsSha256: sha.digest("hex"),
      complete: true, format: "sp-pi-trajectory/v1", projectId: project.projectId, samplingId: "sampling-1",
      runScope: "project_current", role: "subject", chatId: "subject-chat", throughSeq: 2 });
    // The EP server can complete; an adapter capped at 128 MiB cannot reach this terminal manifest.
    expect(app.observation.trajectoryRecord).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(app.services.metrics.getSamplingDetail).toHaveBeenCalledTimes(2);
  }, 30_000);

  it("shows the public paged source can exceed Moss's 100k-record limit below its byte ceiling", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    const totalRecords = 100_001;
    const base = nativeAssistantMessage(1, "subject-chat", "submission-1", [{ type: "text", text: "a" }]);
    expect(Buffer.byteLength(JSON.stringify(base))).toBeLessThan(1_000);
    app.pages.mockImplementation(async (request) => {
      const query = new URL(request.url).searchParams;
      const start = Number(query.get("afterSeq"));
      expect(query.get("limit")).toBe(String(EVAL_EVIDENCE_TRAJECTORY_PAGE_MAX));
      expect(query.get("throughSeq")).toBe(start === 0 ? null : String(totalRecords));
      const end = Math.min(start + EVAL_EVIDENCE_TRAJECTORY_PAGE_MAX, totalRecords);
      return {
        format: "sp-pi-trajectory/v1", cursor: { throughSeq: totalRecords },
        records: Array.from({ length: end - start }, (_, index) => ({ ...base, ingestSeq: start + index + 1 })),
        nextAfterSeq: end === totalRecords ? null : end,
      };
    });
    const response = await get(app, subject);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let records = 0;
    let downloaded = 0;
    let manifest: { recordCount: number; recordsSha256: string; complete: boolean } | undefined;
    const sha = createHash("sha256");
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const part = next.value!;
      if (part[0] === 123 && part[1] === 34 && part[2] === 116) {
        expect(manifest).toBeUndefined();
        manifest = JSON.parse(new TextDecoder().decode(part));
      } else {
        expect(manifest).toBeUndefined();
        downloaded += part.byteLength;
        sha.update(part);
        if (part.length === 2 && part[0] === 125 && part[1] === 10) records++;
      }
    }
    expect(records).toBe(totalRecords);
    expect(downloaded).toBeLessThan(128 * 1024 * 1024);
    expect(manifest).toMatchObject({ recordCount: totalRecords, recordsSha256: sha.digest("hex"), complete: true });
    // The full EP file is still too many records for Moss even though it is under Moss's byte limit.
    expect(app.pages).toHaveBeenCalledTimes(Math.ceil(totalRecords / EVAL_EVIDENCE_TRAJECTORY_PAGE_MAX));
    expect(app.services.metrics.getSamplingDetail).toHaveBeenCalledTimes(2);
  }, 60_000);
});
