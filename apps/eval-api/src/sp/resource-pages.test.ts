import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_EVIDENCE_LIMITS, SP_PI_TRAJECTORY_FORMAT,
  isResourceSnapshotDownload,
  type AgentResourceSnapshotPage, type AgentResourceSnapshotDownload, type NativeTrajectoryEntry } from "@eval-platform/eval-contracts";
import { createEvalRunResumer, type AttemptResourceSnapshot, type ProjectPlanReader, type ProjectSample, type RuntimeRunRecord,
  type RuntimeStore, type SamplingState, withFreshResourceBudget } from "@eval-platform/eval-runtime";
import { createEvidenceStore, type AgentHandle, type EvidenceStore } from "@eval-platform/eval-runtime/harness";
import { isRequestCancelled } from "@springbrand/http/errors";
import { openLocalEvidenceBlobs } from "../evidence/local-blobs.js";
import { createSpHarness } from "./harness.js";
import type { SpResourceHeader } from "./harness-wire.js";
import { nativeAssistantMessage, nativeFixture, nativeTransfer, nativeTransferResponse, streamedAssistantTransfer } from "./native-test-fixture.js";

const chatId = "33333333-3333-4333-8333-333333333333";
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const submissionId = "77777777-7777-4777-8777-777777777777";
const handle: AgentHandle = { ownerUserId, chatId, samplingId: "sampling-1", role: "subject", framework: "sp" };
const key = "execution:sampling-1";
const scope = { chatId, idempotencyKey: key, submissionId };
const readiness = {
  receiptTerminal: true, stateUnreadable: false, pendingTelemetryEvents: 0, pendingRuntimeEvents: 0,
  actionCharges: { complete: true, unsettledExecutions: 0, missingExecutionIds: 0 },
};
const coverage = { usageEvents: "complete", nativeRecords: "complete", billingSettlements: "partial" } as const;
const action = { source: "action", executionId: "88888888-8888-4888-8888-888888888888",
  status: "outcome_unknown", chargedCredits: 0 };
const header = {
  scope, observedAt: "2026-10-28T00:00:00.000Z", finalized: true, readiness, coverage,
  cursor: { throughSeq: 8 }, actionCharges: [action],
};
const prefix = `/internal/v1/eval-harness/users/${ownerUserId}/chats/${chatId}/resources/by-key/execution%3Asampling-1`;
const nativePage = (records: unknown[], nextAfterSeq: number | null) =>
  ({ format: SP_PI_TRAJECTORY_FORMAT, cursor: header.cursor, records, nextAfterSeq });
const events = Array.from({ length: 300 }, (_, index) =>
  ({ eventId: `event-${index}`, kind: "assistant_model", metrics: { totalTokens: index + 1 } }));
const settlements = events.map((event) => ({
  eventId: event.eventId, accountId: ownerUserId, status: "settled", debitedUnits: 2,
}));
const fingerprint = "a".repeat(64);
const billingPage = (after: number, length: number) => ({
  scope: { chatId, submissionId }, cursor: { throughCount: events.length, sha256: fingerprint },
  after, usageEvents: events.slice(after, after + length), billingSettlements: settlements.slice(after, after + length),
  nextAfter: after + length === events.length ? null : after + length,
});
const emptyBilling = () => ({
  scope: { chatId, submissionId }, cursor: { throughCount: 0, sha256: fingerprint },
  after: 0, usageEvents: [], billingSettlements: [], nextAfter: null,
});
const input = { handle, idempotencyKey: key, submissionId };
const cleanHeader = { ...header, coverage: { usageEvents: "complete", nativeRecords: "complete",
  billingSettlements: "complete" } as const, actionCharges: [] };

/** No test double answers the legacy combined endpoint. Each response has the public
 * header/native/billing shape; referenced bytes use the existing evidence byte route. */
function resourceService(serve: (url: URL) => Response | undefined, current: SpResourceHeader = cleanHeader) {
  const requests: URL[] = [];
  const fetch = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(request, init).url);
    requests.push(url);
    const custom = serve(url);
    if (custom) return custom;
    if (url.pathname === `${prefix}/header`) return Response.json(current);
    if (url.pathname === `${prefix}/native-records`) return Response.json(nativePage([], null));
    if (url.pathname === `${prefix}/billing`) return Response.json(emptyBilling());
    throw new Error(`Unexpected resource route ${url}`);
  });
  return { fetch, requests };
}

describe("public paged SP resource collection", () => {
  it("keeps nine known facts when the tenth remains unsettled past the Runtime wait, without claiming finality", async () => {
    const waiting = { ...readiness, pendingTelemetryEvents: 1, actionCharges: {
      complete: false, unsettledExecutions: 0, missingExecutionIds: 0,
    } };
    const partial = { ...cleanHeader, finalized: false, readiness: waiting, cursor: { throughSeq: 9 },
      coverage: { usageEvents: "partial", nativeRecords: "partial", billingSettlements: "partial" } as const };
    const knownUsage = events.slice(0, 9);
    const knownBills = settlements.slice(0, 9);
    const knownNative = Array.from({ length: 9 }, (_, index) => nativeFixture(index + 1, chatId, submissionId));
    let finalized = false;
    const finalizedHeader = { ...cleanHeader, cursor: { throughSeq: 10 } };
    const { fetch, requests } = resourceService((url) => {
      if (url.pathname === `${prefix}/header` && finalized) return Response.json(finalizedHeader);
      if (url.pathname === `${prefix}/readiness`) return Response.json({
        scope, observedAt: partial.observedAt, finalized, readiness: finalized ? readiness : waiting,
      });
      if (url.pathname === `${prefix}/native-records`) {
        return Response.json({ format: SP_PI_TRAJECTORY_FORMAT,
          cursor: finalized ? finalizedHeader.cursor : partial.cursor,
          records: finalized ? [...knownNative, nativeFixture(10, chatId, submissionId)] : knownNative,
          nextAfterSeq: null });
      }
      if (url.pathname === `${prefix}/billing`) {
        const after = Number(url.searchParams.get("after"));
        const count = url.searchParams.get("limit") === "1" ? 1 : after === 0 ? 5 : 200;
        const usage = finalized ? events.slice(0, 10) : knownUsage;
        const bills = finalized ? settlements.slice(0, 10) : knownBills;
        return Response.json({ scope: { chatId, submissionId },
          cursor: { throughCount: usage.length, sha256: finalized ? "b".repeat(64) : fingerprint },
          after, usageEvents: usage.slice(after, after + count),
          billingSettlements: bills.slice(after, after + count),
          nextAfter: after + count < usage.length ? after + count : null });
      }
      return undefined;
    }, partial);
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    const run: RuntimeRunRecord = {
      runId: "run-1", projectId: "project-1", sourceCommit: "a".repeat(40),
      operation: "execution", phases: ["execution"], selector: { all: true },
      targets: { projectSampleIds: ["sample-1"], samplingIds: [] },
      samplingIds: ["sampling-1"], evaluationIds: [],
      planDigests: { execution: "digest" }, requestIdentity: { idempotencyKey: "run-key", requestFingerprint: "digest" },
    };
    const sample: ProjectSample = {
      projectSampleId: "sample-1", projectId: "project-1", dataId: "data-1", datasetIds: ["dataset-1"],
      samplingCount: 1, data: { dataId: "data-1", userPrompt: "Build the page" },
    };
    const plans: ProjectPlanReader = {
      getProjectPlan: async () => ({
        project: { projectId: run.projectId, ownerUserId, name: "Test",
          sourceBranch: "eval", createdAt: "2026-10-28T00:00:00.000Z" },
        datasets: [], execution: {
          harness: { kind: "sp", framework: "sp", agentConfig: { ownerUserId, userAgentId: "agent-1" } },
          subjectAgentConfig: { sourceUserAgentId: "agent-1", name: "Test", body: {} },
          executionConcurrency: 1, retryPolicy: { maxRestarts: 0, initialBackoffMs: 0, maxBackoffMs: 0 },
        },
        executionPlanDigest: run.planDigests.execution, evaluation: null,
      }),
      getProjectSamples: async () => [sample],
      getEvaluationOutputSchema: async () => null,
    };
    const deadline = "2026-10-28T00:10:00.000Z";
    let now = "2026-10-28T00:09:00.000Z";
    let sampling: SamplingState = {
      revision: 0, samplingId: "sampling-1", projectId: run.projectId, projectSampleId: sample.projectSampleId,
      subjectAgent: { ownerUserId, userAgentId: "agent-1" }, subjectChatId: chatId,
      execution: { status: "succeeded", resourcesPending: { deadline, nextAttemptAt: now } },
      executionAttempts: [{ executionAttemptId: "attempt-1", samplingId: "sampling-1", attemptNumber: 1,
        status: "completed", submissionId, completedAt: "2026-10-28T00:00:00.000Z",
        resources: { status: "pending", scope } }],
    };
    let stored: AgentResourceSnapshotPage[] | undefined;
    const store = {
      getRun: async () => run,
      getSamplings: async () => [sampling],
      getSampling: async () => sampling,
      updateSampling: async (next: SamplingState, expected: SamplingState, resources?: AttemptResourceSnapshot) => {
        expect(expected.revision).toBe(sampling.revision);
        if (resources) {
          expect(resources.attemptId).toBe("attempt-1");
          if (!isResourceSnapshotDownload(resources.snapshot)) throw new Error("Expected sealed page download");
          stored = [];
          for await (const page of resources.snapshot.readPages()) stored.push(page);
        }
        sampling = next;
      },
    } as unknown as RuntimeStore;
    const onError = vi.fn();
    const runtime = createEvalRunResumer({
      plans, harness, store, evidence: {} as EvidenceStore, onError,
      now: () => now, sleep: async () => undefined,
    });
    await runtime.resume(run.runId);
    expect(requests.map(({ pathname }) => pathname)).toEqual([`${prefix}/readiness`]);
    expect(sampling.execution.resourcesPending).toBeDefined();
    expect(stored).toBeUndefined();

    now = "2026-10-28T00:10:01.000Z";
    await runtime.resume(run.runId);
    expect(sampling.execution.resourcesPending).toBeUndefined();
    expect(sampling.executionAttempts[0]!.resources).toMatchObject({
      status: "collected",
      summary: { finalized: false, coverage: partial.coverage, readiness: waiting,
        counts: { usageEvents: 9, nativeRecords: 9, billingSettlements: 9 } },
    });
    expect(stored?.flatMap((page) => page.stream === "usageEvents" ? page.records : [])).toEqual(knownUsage);
    expect(stored?.flatMap((page) => page.stream === "billingSettlements" ? page.records : [])).toEqual(knownBills);
    expect(stored?.flatMap((page) => page.stream === "nativeRecords" ? page.records : [])).toHaveLength(9);
    expect(requests.filter(({ pathname }) => pathname === `${prefix}/header`)).toHaveLength(2);
    expect(requests.filter(({ pathname }) => pathname.endsWith("/native-records") || pathname.endsWith("/billing"))
      .every(({ searchParams }) => searchParams.get("allowPartial") === "true")).toBe(true);
    expect(requests.filter(({ pathname }) => pathname.endsWith("/billing"))
      .every(({ searchParams }) => searchParams.get("throughSeq") === "9")).toBe(true);
    expect(requests.every(({ pathname }) => pathname !== prefix)).toBe(true);

    // A later manual resource retry gives this same Attempt a fresh budget. The
    // earlier partial snapshot remains honest until a new finalized one commits.
    requests.length = 0;
    finalized = true;
    now = "2026-10-28T00:12:00.000Z";
    sampling = { ...sampling, revision: sampling.revision + 1,
      execution: { status: "succeeded", resourcesPending: { deadline: "2026-10-28T00:22:00.000Z", nextAttemptAt: now } },
      executionAttempts: withFreshResourceBudget(sampling.executionAttempts) };
    await runtime.resume(run.runId);
    expect(sampling.executionAttempts[0]!.resources).toMatchObject({
      status: "collected", summary: { finalized: true,
        counts: { usageEvents: 10, nativeRecords: 10, billingSettlements: 10 } },
    });
    expect(stored?.flatMap((page) => page.stream === "billingSettlements" ? page.records : []))
      .toEqual(settlements.slice(0, 10));
    expect(requests.filter(({ pathname }) => pathname === `${prefix}/native-records`
      || pathname === `${prefix}/billing`).every(({ searchParams }) => !searchParams.has("allowPartial"))).toBe(true);
    expect(onError).toHaveBeenCalledOnce(); // Only the original wait's partial shortfall.
  });

  it("does not call the legacy whole-response route, retains 300 paired API facts and independently settled Action facts", async () => {
    const child = nativeFixture(8, chatId, "child-submission");
    const row = { ...child, record: { ...child.record, parent: {
      resource: { agentId: "agent-1", sessionId: chatId }, submissionId,
    } } };
    const requests: Request[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === `${prefix}/header`) return Response.json(header);
      if (url.pathname === `${prefix}/native-records`) {
        expect(url.searchParams.get("throughSeq")).toBe("8");
        return Response.json(url.searchParams.get("afterSeq") === "0"
          ? nativePage([nativeFixture(3, chatId, submissionId)], 3) : nativePage([row], null));
      }
      if (url.pathname === `${prefix}/billing`) {
        const after = Number(url.searchParams.get("after"));
        if (after) {
          expect(url.searchParams.get("throughCount")).toBe("300");
          expect(url.searchParams.get("throughSha256")).toBe(fingerprint);
        }
        return Response.json(billingPage(after, url.searchParams.get("limit") === "1" ? 1 : after ? 100 : 200));
      }
      throw new Error(`Unexpected resource route ${url}`);
    });
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    const collected = await harness.collectAgentResources({ handle, idempotencyKey: key, submissionId }) as AgentResourceSnapshotDownload;
    try {
      expect(collected.kind).toBe("pages");
      expect(collected.summary).toMatchObject({
        scope, coverage, counts: { usageEvents: 300, nativeRecords: 2, billingSettlements: 301 },
      });
      const pages: AgentResourceSnapshotPage[] = [];
      for await (const page of collected.readPages()) pages.push(page);
      expect(pages.flatMap((page) => page.stream === "usageEvents" ? page.records : [])).toEqual(events);
      expect(pages.flatMap((page) => page.stream === "billingSettlements" ? page.records : []))
        .toEqual([...settlements, action]);
      expect(pages.flatMap((page) => page.stream === "nativeRecords" ? page.records : []))
        .toEqual(expect.arrayContaining([expect.objectContaining({ ingestSeq: 8, metricProjection: expect.any(Object) })]));
    } finally {
      await collected.dispose();
    }
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      `${prefix}/header`, `${prefix}/native-records`, `${prefix}/native-records`,
      `${prefix}/billing`, `${prefix}/billing`, `${prefix}/billing`,
      `${prefix}/header`,
    ]);
    const probe = new URL(requests.at(-2)!.url).searchParams;
    expect(probe.get("limit")).toBe("1");
    expect(probe.get("throughCount")).toBe("300");
    expect(probe.get("throughSha256")).toBe(fingerprint);
    expect(requests.every((request) => request.headers.get("X-Eval-Service-Token") === "secret"
      && !request.headers.has("Origin"))).toBe(true);
  });

  it("spools hundreds of SAFE native rows one at a time rather than assembling an operation-sized array", async () => {
    const base = nativeFixture(3, chatId, submissionId);
    const rows = Array.from({ length: 450 }, (_, index) => ({
      ingestSeq: index + 1, record: { ...base.record, record: { ...base.record.record,
        value: { ...base.record.record.value, id: index + 1 } } },
    }));
    const local = { ...cleanHeader, cursor: { throughSeq: 450 } };
    const { fetch, requests } = resourceService((url) => url.pathname === `${prefix}/native-records`
      ? Response.json({ format: SP_PI_TRAJECTORY_FORMAT, cursor: local.cursor,
        records: rows.slice(Number(url.searchParams.get("afterSeq")), Number(url.searchParams.get("afterSeq")) + 200),
        nextAfterSeq: Number(url.searchParams.get("afterSeq")) + 200 < 450
          ? Math.min(450, Number(url.searchParams.get("afterSeq")) + 200) : null })
      : undefined, local);
    const result = await createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch })
      .collectAgentResources(input) as AgentResourceSnapshotDownload;
    try {
      expect(result.summary.counts).toEqual({ usageEvents: 0, nativeRecords: 450, billingSettlements: 0 });
      let count = 0;
      for await (const part of result.readPages()) {
        if (part.stream === "nativeRecords") {
          expect(part.records).toHaveLength(1);
          count += part.records.length;
        }
      }
      expect(count).toBe(450);
    } finally {
      await result.dispose();
    }
    expect(requests.filter((url) => url.pathname === `${prefix}/native-records`)
      .map((url) => url.searchParams.get("afterSeq"))).toEqual(["0", "200", "400"]);
  });

  it("keeps a directly attributed child Context and a nested Submission only with a verified parent chain", async () => {
    const root = nativeFixture(3, chatId, submissionId);
    const context = nativeFixture(1, chatId, "child-submission");
    const child = nativeFixture(8, chatId, "child-submission");
    const nested = nativeFixture(14, chatId, "nested-submission");
    const parent = { resource: { agentId: "agent-1", sessionId: chatId }, submissionId };
    const contextRow: NativeTrajectoryEntry = { ...context, ingestSeq: 4, record: {
      ...context.record, submissionId: null, origin: "context", parent,
    } };
    const { reference: contextRef, bytes: contextBytes } = nativeTransfer(contextRow, 6);
    const nestedRow: NativeTrajectoryEntry = { ...nested, ingestSeq: 6, record: { ...nested.record,
      parent: { ...parent, submissionId: "child-submission" } } };
    const { reference, bytes } = nativeTransfer(nestedRow, 6);
    const rows = [
      root,
      contextRef,
      { ...child, ingestSeq: 5, record: { ...child.record, parent } },
      reference,
    ];
    const local = { ...cleanHeader, cursor: { throughSeq: 6 } };
    const { fetch } = resourceService((url) =>
      url.pathname === `${prefix}/native-records`
        ? Response.json({ format: SP_PI_TRAJECTORY_FORMAT, cursor: local.cursor, records: rows, nextAfterSeq: null })
        : url.pathname.endsWith(`/trajectory/records/${contextRef.ingestSeq}`)
          ? nativeTransferResponse(contextRef, contextBytes)
          : url.pathname.endsWith(`/trajectory/records/${reference.ingestSeq}`)
            ? nativeTransferResponse(reference, bytes) : undefined, local);
    const download = await createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch })
      .collectAgentResources(input) as AgentResourceSnapshotDownload;
    try {
      expect(download.summary.counts.nativeRecords).toBe(4);
      const stored = [];
      for await (const page of download.readPages()) if (page.stream === "nativeRecords") stored.push(...page.records);
      expect(stored.map(({ record }) => [record.submissionId, record.parent?.submissionId ?? null])).toEqual([
        [submissionId, null], [null, submissionId], ["child-submission", submissionId],
        ["nested-submission", "child-submission"],
      ]);
    } finally {
      await download.dispose();
    }
  });

  it("keeps prior Submission and imported Context in complete Subject evidence, while the resource snapshot contains only this operation", async () => {
    const context = nativeFixture(1, chatId, "imported-context");
    const imported = { ...context, record: { ...context.record, submissionId: null, origin: "context" as const } };
    const prior = nativeFixture(2, chatId, "prior-submission");
    const selected = nativeFixture(3, chatId, submissionId);
    const artifact = new TextEncoder().encode("hello");
    const local = { ...cleanHeader, cursor: { throughSeq: 3 } };
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/evidence/artifacts")) return Response.json({ artifacts: [
        { path: "/site/index.html", size: artifact.byteLength, mediaType: "text/html" },
      ] });
      if (url.pathname.endsWith("/evidence/files")) return new Response(artifact);
      if (url.pathname.endsWith("/evidence/trajectory")) return Response.json({
        format: SP_PI_TRAJECTORY_FORMAT, cursor: local.cursor, records: [imported, prior, selected], nextAfterSeq: null,
      });
      if (url.pathname === `${prefix}/header`) return Response.json(local);
      if (url.pathname === `${prefix}/native-records`) return Response.json({
        format: SP_PI_TRAJECTORY_FORMAT, cursor: local.cursor, records: [selected], nextAfterSeq: null,
      });
      if (url.pathname === `${prefix}/billing`) return Response.json(emptyBilling());
      throw new Error(`Unexpected ${url}`);
    });
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    const root = await mkdtemp(join(tmpdir(), "eval-resource-evidence-"));
    try {
      const evidence = await harness.exportEvidence({ handle, submissionId, limits: DEFAULT_EVIDENCE_LIMITS });
      const store = createEvidenceStore(await openLocalEvidenceBlobs(root));
      const bundle = await store.open(await store.resume({ evidence, limits: DEFAULT_EVIDENCE_LIMITS }));
      expect(bundle.manifest.artifacts).toMatchObject([{ path: "/site/index.html", size: 5 }]);
      expect(bundle.manifest.trajectory).toMatchObject({ complete: true, records: 3 });
      const part = bundle.manifest.trajectory.parts[0]!;
      expect(await new Response(await bundle.readBlob(part.sha256)).text())
        .toBe([imported, prior, selected].map((row) => `${JSON.stringify(row)}\n`).join(""));
      const download = await harness.collectAgentResources(input) as AgentResourceSnapshotDownload;
      try {
        expect(download.summary.counts).toEqual({ usageEvents: 0, nativeRecords: 1, billingSettlements: 0 });
        const records = [];
        for await (const page of download.readPages()) if (page.stream === "nativeRecords") records.push(...page.records);
        expect(records.map(({ record }) => record.submissionId)).toEqual([submissionId]);
      } finally {
        await download.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a missing receipt ID by the readiness operation key, never by a Chat-only guess", async () => {
    const { fetch, requests } = resourceService((url) => url.pathname === `${prefix}/readiness`
      ? Response.json({ scope, observedAt: header.observedAt, finalized: true, readiness }) : undefined);
    const download = await createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch })
      .collectAgentResources({ handle, idempotencyKey: key }) as AgentResourceSnapshotDownload;
    await download.dispose();
    expect(requests[0]?.pathname).toBe(`${prefix}/readiness`);
    expect(requests[0]?.searchParams.has("submissionId")).toBe(false);
    expect(requests.slice(1).every((url) => url.searchParams.get("submissionId") === submissionId)).toBe(true);
  });

  it("fails closed when the deployed SP has no new header instead of reading the legacy full resource body", async () => {
    const { fetch, requests } = resourceService((url) => url.pathname === `${prefix}/header`
      ? Response.json({ code: "REQUEST_NOT_FOUND", errMsg: "No paged resource header" }, { status: 404 })
      : undefined);
    await expect(createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch })
      .collectAgentResources(input)).rejects.toMatchObject({ status: 404, retryable: false });
    expect(requests.map((url) => url.pathname)).toEqual([`${prefix}/header`]);
  });

  it.each([170, 900])("verifies %i streamed chunks of a >5/30 MiB SAFE Pi reference without retaining a JSON body", async (repetitions) => {
    const { reference, recordLength, response } = streamedAssistantTransfer(chatId, submissionId, repetitions);
    expect(recordLength).toBeGreaterThan(repetitions < 900 ? 5 * 1024 * 1024 : 30 * 1024 * 1024);
    const local = { ...cleanHeader, cursor: { throughSeq: reference.ingestSeq } };
    let byteReads = 0;
    const { fetch, requests } = resourceService((url) => {
      if (url.pathname.endsWith(`/trajectory/records/${reference.ingestSeq}`)) {
        byteReads++;
        expect(url.searchParams.get("submissionId")).toBe(submissionId);
        expect(url.searchParams.get("throughSeq")).toBe(String(local.cursor.throughSeq));
        expect(url.searchParams.get("identity")).toBe(reference.reference.identity);
        expect(url.searchParams.get("byteLength")).toBe(String(recordLength));
        expect(url.searchParams.get("sha256")).toBe(reference.reference.sha256);
        return response();
      }
      if (url.pathname === `${prefix}/native-records`) {
        return Response.json({ format: SP_PI_TRAJECTORY_FORMAT, cursor: local.cursor,
          records: [reference], nextAfterSeq: null });
      }
      return undefined;
    }, local);
    const download = await createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch })
      .collectAgentResources(input) as AgentResourceSnapshotDownload;
    try {
      expect(download.summary.counts.nativeRecords).toBe(1);
      const entries = [];
      for await (const part of download.readPages()) if (part.stream === "nativeRecords") entries.push(...part.records);
      expect(entries[0]).toMatchObject({
        ingestSeq: reference.ingestSeq, metricProjection: { supported: true, fingerprint: reference.reference.sha256 },
      });
      expect(JSON.stringify(entries).length).toBeLessThan(10_000);
      expect(requests.every((url) => url.pathname !== prefix)).toBe(true);
      expect(byteReads).toBe(1);
    } finally {
      await download.dispose();
    }
  }, 60_000);

  it.each(["foreign-submission", "foreign-parent-chat", "context", "foreign-chat"] as const)(
    "rejects an inline %s native resource instead of charging a different operation", async (kind) => {
      const source = nativeFixture(3, chatId, kind === "foreign-submission" ? "prior-submission" : submissionId);
      const record = kind === "foreign-parent-chat"
        ? { ...source.record, parent: { resource: { agentId: "agent", sessionId: "other-chat" }, submissionId } }
        : kind === "context"
          ? { ...source.record, submissionId: null, origin: "context" as const }
          : kind === "foreign-chat"
            ? { ...source.record, resource: { ...source.record.resource, sessionId: "other-chat" } }
            : source.record;
      const local = { ...cleanHeader, cursor: { throughSeq: 3 } };
      const { fetch } = resourceService((url) => url.pathname === `${prefix}/native-records`
        ? Response.json({ ...nativePage([{ ingestSeq: 3, record }], null), cursor: local.cursor }) : undefined, local);
      await expect(createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch })
        .collectAgentResources(input)).rejects.toMatchObject({ retryable: false });
    },
  );

  it.each(["foreign-submission", "foreign-parent-chat", "unproven-parent", "context"] as const)(
    "rejects a referenced %s native body only after verifying its complete byte stream", async (kind) => {
      const source = nativeAssistantMessage(14, chatId, submissionId, [{ type: "text", text: "not this operation" }]);
      const record = kind === "foreign-submission"
        ? { ...source.record, submissionId: "prior-submission" }
        : kind === "foreign-parent-chat"
          ? { ...source.record, parent: { resource: { agentId: "other", sessionId: "other-chat" }, submissionId } }
          : kind === "unproven-parent"
            ? { ...source.record, submissionId: "nested-submission",
              parent: { resource: { agentId: "other", sessionId: chatId }, submissionId: "foreign-parent" } }
            : { ...source.record, submissionId: null, origin: "context" as const };
      const { reference, bytes } = nativeTransfer({ ingestSeq: 14, record }, 14);
      const local = { ...cleanHeader, cursor: { throughSeq: 14 } };
      const { fetch } = resourceService((url) => {
        if (url.pathname.endsWith(`/trajectory/records/${reference.ingestSeq}`)) return nativeTransferResponse(reference, bytes);
        if (url.pathname === `${prefix}/native-records`) {
          return Response.json({ format: SP_PI_TRAJECTORY_FORMAT, cursor: local.cursor,
            records: [reference], nextAfterSeq: null });
        }
        return undefined;
      }, local);
      await expect(createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch })
        .collectAgentResources(input)).rejects.toMatchObject({ retryable: false });
    },
  );

  it("rejects a foreign Chat reference before requesting native record bytes", async () => {
    const { reference } = nativeTransfer(nativeFixture(3, chatId, submissionId), 3);
    const foreign = { ...reference, reference: { ...reference.reference,
      identity: JSON.stringify(["agent-1", "foreign-chat", "entry", 3]) } };
    const local = { ...cleanHeader, cursor: { throughSeq: 3 } };
    const { fetch, requests } = resourceService((url) => url.pathname === `${prefix}/native-records`
      ? Response.json({ format: SP_PI_TRAJECTORY_FORMAT, cursor: local.cursor, records: [foreign], nextAfterSeq: null })
      : undefined, local);
    await expect(createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch })
      .collectAgentResources(input)).rejects.toMatchObject({ retryable: false });
    expect(requests.some((url) => url.pathname.includes("/trajectory/records/"))).toBe(false);
  });

  it("rejects a reference whose complete body differs from its frozen SHA-256, without saving partial facts", async () => {
    const { reference, bytes } = nativeTransfer(nativeAssistantMessage(14, chatId, submissionId,
      [{ type: "text", text: "original" }]), 14);
    const corrupt = new Uint8Array(bytes);
    const index = Buffer.from(corrupt).indexOf("original");
    expect(index).toBeGreaterThan(0);
    corrupt[index] = "X".charCodeAt(0);
    const local = { ...cleanHeader, cursor: { throughSeq: 14 } };
    const { fetch } = resourceService((url) => url.pathname === `${prefix}/native-records`
      ? Response.json({ format: SP_PI_TRAJECTORY_FORMAT, cursor: local.cursor, records: [reference], nextAfterSeq: null })
      : url.pathname.endsWith(`/trajectory/records/${reference.ingestSeq}`)
        ? nativeTransferResponse(reference, corrupt) : undefined, local);
    await expect(createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch })
      .collectAgentResources(input)).rejects.toMatchObject({ retryable: false });
  });

  it.each([["EVIDENCE_NOT_READY", true], ["REQUEST_CONFLICT", false]] as const)(
    "only retries the public resource billing GET's %s conflict when SP still needs to finalize", async (code, retryable) => {
      const { fetch, requests } = resourceService((url) => url.pathname === `${prefix}/billing`
        ? Response.json({ code, errMsg: "billing unavailable" }, { status: 409 }) : undefined);
      await expect(createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch })
        .collectAgentResources(input)).rejects.toMatchObject({ status: 409, retryable });
      expect(requests.some((url) => url.pathname === prefix)).toBe(false);
    },
  );

  it("cancels a referenced byte stream when a counted resource download is stopped", async () => {
    const { reference, bytes } = nativeTransfer(nativeAssistantMessage(14, chatId, submissionId,
      [{ type: "text", text: "only verified bytes can be stored" }]), 14);
    const local = { ...cleanHeader, cursor: { throughSeq: 14 } };
    const stopped = new AbortController();
    let canceled = false;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    let first = true;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (first) { first = false; controller.enqueue(bytes.subarray(0, 7)); }
        else started();
      },
      cancel() { canceled = true; },
    });
    const { fetch } = resourceService((url) => {
      if (url.pathname.endsWith(`/trajectory/records/${reference.ingestSeq}`)) {
        return new Response(body, { headers: nativeTransferResponse(reference, bytes).headers });
      }
      if (url.pathname === `${prefix}/native-records`) {
        return Response.json({ format: SP_PI_TRAJECTORY_FORMAT, cursor: local.cursor,
          records: [reference], nextAfterSeq: null });
      }
      return undefined;
    }, local);
    const promise = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch })
      .collectAgentResources({ ...input, signal: stopped.signal }).catch((error: unknown) => error);
    await reading;
    stopped.abort();
    expect(isRequestCancelled(await promise)).toBe(true);
    expect(canceled).toBe(true);
  });

  it("rejects an oversized JSON native page explicitly instead of allocating an unbounded response", async () => {
    const local = { ...cleanHeader, cursor: { throughSeq: 3 } };
    const big = nativeAssistantMessage(3, chatId, submissionId, [{ type: "text", text: "x".repeat(2_048) }]);
    const { fetch, requests } = resourceService((url) => url.pathname === `${prefix}/native-records`
      ? Response.json({ format: SP_PI_TRAJECTORY_FORMAT, cursor: local.cursor, records: [big], nextAfterSeq: null })
      : undefined, local);
    await expect(createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch, maxResponseBytes: 1_024 })
      .collectAgentResources(input)).rejects.toMatchObject({
      retryable: false, message: "Eval SP resource native page exceeded the 1024-byte response limit",
    });
    expect(requests.some((url) => url.pathname === `${prefix}/billing`)).toBe(false);
  });

  it.each([
    ["foreign Chat", { ...cleanHeader, scope: { ...scope, chatId: "foreign-chat" } }],
    ["foreign key", { ...cleanHeader, scope: { ...scope, idempotencyKey: "another-operation" } }],
    ["foreign Submission", { ...cleanHeader, scope: { ...scope, submissionId: "another-submission" } }],
    ["missing coverage", (({ coverage: _coverage, ...rest }) => rest)(cleanHeader)],
    ["missing readiness", (({ readiness: _readiness, ...rest }) => rest)(cleanHeader)],
    ["unsettled readiness", { ...cleanHeader, readiness: {
      ...readiness, actionCharges: { complete: false, unsettledExecutions: 1, missingExecutionIds: 0 },
    } }],
    ["partial native inventory", { ...cleanHeader, coverage: { ...cleanHeader.coverage, nativeRecords: "partial" } }],
  ])("rejects a %s header before making any page request", async (_label, malformed) => {
    const { fetch, requests } = resourceService((url) => url.pathname === `${prefix}/header`
      ? Response.json(malformed) : undefined);
    await expect(createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch })
      .collectAgentResources(input)).rejects.toMatchObject({ retryable: false });
    expect(requests).toHaveLength(1);
  });

  it("refuses a nonfinalized header without interpreting absence as zero usage", async () => {
    const { fetch, requests } = resourceService(() => undefined, { ...cleanHeader, finalized: false,
      coverage: { usageEvents: "partial" as const, nativeRecords: "partial" as const, billingSettlements: "partial" as const } });
    await expect(createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch })
      .collectAgentResources(input)).rejects.toMatchObject({ retryable: true, message: expect.stringContaining("not finalized") });
    expect(requests.map((url) => url.pathname)).toEqual([`${prefix}/header`]);
  });

  it("retries from a finalized header when a partial download finalizes mid-stream, never sealing the old pages", async () => {
    const waiting = { ...readiness, pendingRuntimeEvents: 1, actionCharges: {
      complete: false, unsettledExecutions: 0, missingExecutionIds: 0,
    } };
    const partial = { ...cleanHeader, finalized: false, readiness: waiting, cursor: { throughSeq: 3 },
      coverage: { usageEvents: "partial", nativeRecords: "partial", billingSettlements: "partial" } as const };
    const complete = { ...cleanHeader, cursor: partial.cursor };
    let headerReads = 0;
    const before = (await readdir(tmpdir())).filter((entry) => entry.startsWith("eval-resources-"));
    const { fetch, requests } = resourceService((url) => {
      if (url.pathname === `${prefix}/header`) return Response.json(++headerReads === 1 ? partial : complete);
      if (url.pathname === `${prefix}/native-records`) return Response.json({
        format: SP_PI_TRAJECTORY_FORMAT, cursor: partial.cursor,
        records: [nativeFixture(3, chatId, submissionId)], nextAfterSeq: null,
      });
      if (url.pathname === `${prefix}/billing`) {
        return Response.json({ scope: { chatId, submissionId }, cursor: { throughCount: 1, sha256: fingerprint },
          after: 0, usageEvents: events.slice(0, 1), billingSettlements: settlements.slice(0, 1), nextAfter: null });
      }
      return undefined;
    }, partial);
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    await expect(harness.collectAgentResources({ ...input, allowPartial: true }))
      .rejects.toMatchObject({ retryable: true, message: expect.stringContaining("header during collection") });
    expect((await readdir(tmpdir())).filter((entry) => entry.startsWith("eval-resources-"))).toEqual(before);
    const completed = await harness.collectAgentResources(input) as AgentResourceSnapshotDownload;
    try {
      expect(completed.summary).toMatchObject({ finalized: true,
        coverage: complete.coverage, counts: { usageEvents: 1, nativeRecords: 1, billingSettlements: 1 } });
      const facts = [];
      for await (const page of completed.readPages()) facts.push(page);
      expect(facts.filter((page) => page.stream === "usageEvents")).toMatchObject([{ records: events.slice(0, 1) }]);
    } finally {
      await completed.dispose();
    }
    expect(headerReads).toBe(4);
    expect(requests.filter(({ pathname }) => pathname === `${prefix}/billing`)).toHaveLength(4);
    expect(requests.filter(({ pathname }) => pathname === `${prefix}/native-records`)
      .map(({ searchParams }) => searchParams.get("allowPartial"))).toEqual(["true", null]);
  });

  it("rejects a changed billing source after a single partial page, even if the header stayed the same", async () => {
    const partial = { ...cleanHeader, finalized: false, cursor: { throughSeq: 3 },
      coverage: { usageEvents: "partial", nativeRecords: "partial", billingSettlements: "partial" } as const };
    let reads = 0;
    const before = (await readdir(tmpdir())).filter((entry) => entry.startsWith("eval-resources-"));
    const { fetch, requests } = resourceService((url) => {
      if (url.pathname === `${prefix}/native-records`) return Response.json({
        format: SP_PI_TRAJECTORY_FORMAT, cursor: partial.cursor, records: [nativeFixture(3, chatId, submissionId)],
        nextAfterSeq: null,
      });
      if (url.pathname === `${prefix}/billing`) {
        if (++reads === 2) {
          expect(url.searchParams.get("throughCount")).toBe("1");
          expect(url.searchParams.get("throughSha256")).toBe(fingerprint);
          expect(url.searchParams.get("limit")).toBe("1");
        }
        expect(url.searchParams.get("allowPartial")).toBe("true");
        expect(url.searchParams.get("throughSeq")).toBe("3");
        return Response.json({ scope: { chatId, submissionId },
          cursor: { throughCount: 1, sha256: reads === 1 ? fingerprint : "b".repeat(64) },
          after: 0, usageEvents: events.slice(0, 1), billingSettlements: settlements.slice(0, 1), nextAfter: null });
      }
      return undefined;
    }, partial);
    await expect(createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch })
      .collectAgentResources({ ...input, allowPartial: true }))
      .rejects.toMatchObject({ retryable: false, message: expect.stringContaining("billing source fingerprint") });
    expect(reads).toBe(2);
    expect(requests.filter(({ pathname }) => pathname === `${prefix}/header`)).toHaveLength(1);
    expect((await readdir(tmpdir())).filter((entry) => entry.startsWith("eval-resources-"))).toEqual(before);
  });

  it("stops after one guaranteed-unpageable partial read on an older SP instead of exhausting the download budget", async () => {
    const partial = { ...cleanHeader, finalized: false,
      coverage: { usageEvents: "partial", nativeRecords: "partial", billingSettlements: "partial" } as const };
    const { fetch, requests } = resourceService((url) => url.pathname === `${prefix}/native-records`
      ? Response.json({ code: "EVIDENCE_NOT_READY", errMsg: "Resources are not finalized" },
        { status: 409, headers: { "Retry-After": "5" } }) : undefined, partial);
    await expect(createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch })
      .collectAgentResources({ ...input, allowPartial: true }))
      .rejects.toMatchObject({ retryable: false, status: 409, message: expect.stringContaining("no readable partial resource pages") });
    expect(requests.map(({ pathname }) => pathname)).toEqual([`${prefix}/header`, `${prefix}/native-records`]);
  });

  it("passes the operation-bound partial opt-in through a referenced SAFE byte read without storing its body", async () => {
    const source = nativeAssistantMessage(8, chatId, submissionId, [{ type: "text", text: "known native body" }]);
    const { reference, bytes } = nativeTransfer(source, 8);
    const partial = { ...cleanHeader, finalized: false, cursor: { throughSeq: 8 },
      coverage: { usageEvents: "partial", nativeRecords: "partial", billingSettlements: "partial" } as const };
    const { fetch, requests } = resourceService((url) => {
      if (url.pathname === `${prefix}/native-records`) return Response.json({
        format: SP_PI_TRAJECTORY_FORMAT, cursor: partial.cursor, records: [reference], nextAfterSeq: null,
      });
      if (url.pathname.endsWith(`/trajectory/records/${reference.ingestSeq}`)) {
        expect(url.searchParams.get("allowPartial")).toBe("true");
        expect(url.searchParams.get("resourceKey")).toBe(key);
        return nativeTransferResponse(reference, bytes);
      }
      return undefined;
    }, partial);
    const download = await createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch })
      .collectAgentResources({ ...input, allowPartial: true }) as AgentResourceSnapshotDownload;
    try {
      expect(download.summary).toMatchObject({
        finalized: false, coverage: partial.coverage,
        counts: { usageEvents: 0, nativeRecords: 1, billingSettlements: 0 },
      });
      const pages = [];
      for await (const page of download.readPages()) pages.push(page);
      const compact = pages.flatMap((page) => page.stream === "nativeRecords" ? page.records : []);
      expect(compact).toMatchObject([{ ingestSeq: 8, metricProjection: { supported: true, fingerprint: reference.reference.sha256 } }]);
      expect(JSON.stringify(compact)).not.toContain("known native body");
    } finally {
      await download.dispose();
    }
    expect(requests.some(({ pathname }) => pathname === prefix)).toBe(false);
  });

  it.each(["native-cutoff", "native-cursor", "billing-cursor", "billing-fingerprint", "billing-pair", "header-charges"] as const)(
    "fails closed if the %s changes mid-pages", async (kind) => {
      const local = { ...cleanHeader, cursor: { throughSeq: 3 } };
      let headerReads = 0;
      const firstBilling = { scope: { chatId, submissionId }, cursor: { throughCount: 2, sha256: fingerprint },
        after: 0, usageEvents: events.slice(0, 1), billingSettlements: settlements.slice(0, 1), nextAfter: 1 };
      const nextBilling = { ...firstBilling, after: 1, usageEvents: events.slice(1, 2),
        billingSettlements: settlements.slice(1, 2), nextAfter: null };
      const { fetch } = resourceService((url) => {
        if (url.pathname === `${prefix}/header`) {
          headerReads++;
          return Response.json(kind === "header-charges" && headerReads === 2
            ? { ...local, actionCharges: [action] } : local);
        }
        if (url.pathname === `${prefix}/native-records`) return Response.json({
          ...nativePage([nativeFixture(3, chatId, submissionId)], kind === "native-cursor" ? 0 : null),
          cursor: { throughSeq: kind === "native-cutoff" ? 4 : 3 },
        });
        if (url.pathname === `${prefix}/billing`) {
          if (url.searchParams.get("after") === "0") return Response.json(firstBilling);
          if (kind === "billing-cursor") return Response.json({ ...nextBilling, nextAfter: 3 });
          if (kind === "billing-fingerprint") return Response.json({ ...nextBilling,
            cursor: { throughCount: 2, sha256: "b".repeat(64) } });
          if (kind === "billing-pair") return Response.json({ ...nextBilling,
            billingSettlements: [{ ...settlements[1], eventId: "another-event" }] });
          return Response.json(nextBilling);
        }
        return undefined;
      }, local);
      await expect(createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch })
        .collectAgentResources(input)).rejects.toMatchObject({ retryable: false });
    },
  );

  it("does not publish a partial resource download if the second page disconnects after the first is received", async () => {
    const local = { ...cleanHeader, cursor: { throughSeq: 4 } };
    const first = { ...nativePage([nativeFixture(3, chatId, submissionId)], 3),
      cursor: local.cursor };
    const spoolsBefore = (await readdir(tmpdir())).filter((entry) => entry.startsWith("eval-resources-"));
    const { fetch } = resourceService((url) => {
      if (url.pathname === `${prefix}/native-records`) {
        if (url.searchParams.get("afterSeq") === "0") return Response.json(first);
        const cut = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"format":"sp-pi-trajectory/v1","cursor":'));
            controller.error(new TypeError("connection lost"));
          },
        });
        return new Response(cut, { headers: { "Content-Type": "application/json" } });
      }
      return undefined;
    }, local);
    await expect(createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch })
      .collectAgentResources(input)).rejects.toMatchObject({ retryable: true });
    expect((await readdir(tmpdir())).filter((entry) => entry.startsWith("eval-resources-"))).toEqual(spoolsBefore);
  });
});
