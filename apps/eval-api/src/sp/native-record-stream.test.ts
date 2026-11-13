import { createHash } from "node:crypto";
import { spPiTrajectoryRecordIdentity, type NativeTrajectoryEntry, type PiTrajectoryRecord } from "@eval-platform/eval-contracts";
import { compactNativeTrajectoryRecord } from "@eval-platform/eval-metrics";
import { EVAL_RESULT_MAX_BYTES, EVAL_TRAJECTORY_RECORD_FORMAT, type EvalNativeRecordReference } from "@springbrand/eval-harness";
import { describe, expect, it } from "vitest";
import { nativeAssistantMessage, nativeFixture, nativeToolBodyPair } from "./native-test-fixture.js";
import { finalReplyText } from "./harness-wire.js";
import {
  NativeRecordStreamError, verifiedPiJsonlLine, verifiedPiRecordBytes,
  type NativeRecordByteBinding, type NativeRecordInspection,
} from "./native-record-stream.js";

const CHAT = "11111111-1111-4111-8111-111111111111";
const SUBMISSION = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const MAX_FILE_BYTES = 95_000_000;
const encoder = new TextEncoder();
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function streamChunks(parts: Iterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = parts[Symbol.iterator]();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const { done, value } = iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel() { iterator.return?.(); },
  });
}

const streamed = (bytes: Uint8Array, chunkBytes = 127) => streamChunks((function* () {
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) yield bytes.subarray(offset, offset + chunkBytes);
})());

function binding(record: PiTrajectoryRecord, bytes: Uint8Array, scope: NativeRecordByteBinding["scope"] = {
  kind: "chat", chatId: CHAT,
}): NativeRecordByteBinding {
  return {
    scope, identity: spPiTrajectoryRecordIdentity(record), byteLength: bytes.byteLength, sha256: digest(bytes),
    maxBytes: MAX_FILE_BYTES,
  };
}

function recordReference(ingestSeq: number,
  header: Pick<NativeRecordByteBinding, "identity" | "byteLength" | "sha256">): EvalNativeRecordReference {
  return { ingestSeq, reference: {
    format: EVAL_TRAJECTORY_RECORD_FORMAT, throughSeq: ingestSeq,
    identity: header.identity, byteLength: header.byteLength, sha256: header.sha256,
  } };
}

async function collectHash(stream: ReadableStream<Uint8Array>): Promise<{
  bytes: number; sha256: string; chunks: number; lines: number; largestChunkBytes: number;
}> {
  const hash = createHash("sha256");
  let bytes = 0;
  let chunks = 0;
  let lines = 0;
  let largestChunkBytes = 0;
  for await (const chunk of stream) {
    chunks++;
    bytes += chunk.byteLength;
    largestChunkBytes = Math.max(largestChunkBytes, chunk.byteLength);
    hash.update(chunk);
    for (const byte of chunk) if (byte === 10) lines++;
  }
  return { bytes, sha256: hash.digest("hex"), chunks, lines, largestChunkBytes };
}

/**
 * The generated public UA assistant envelope, with a large raw Pi message inserted
 * as bytes. Neither test nor implementation builds a 5/30 MiB JS string/object.
 */
function largeNativeRecord(original: NativeTrajectoryEntry, repetitions: number) {
  const template = JSON.stringify(original.record);
  const marker = "\"__TEST_BODY__\"";
  const index = template.indexOf(marker);
  if (index < 0 || template.indexOf(marker, index + 1) !== -1) throw new Error("Unsafe Pi fixture marker");
  const prefix = encoder.encode(`${template.slice(0, index)}"`);
  const suffix = encoder.encode(`"${template.slice(index + marker.length)}`);
  // Nine UTF-8 bytes, three JS characters; the 257-byte transport chunks split characters.
  const body = encoder.encode("汉🌎é".repeat(4_096));
  const bodyParts = (function* () {
    for (let index = 0; index < repetitions; index++) {
      for (let offset = 0; offset < body.byteLength; offset += 257) yield body.subarray(offset, offset + 257);
    }
  });
  const byteLength = prefix.byteLength + body.byteLength * repetitions + suffix.byteLength;
  const expected = createHash("sha256").update(prefix);
  for (let index = 0; index < repetitions; index++) expected.update(body);
  expected.update(suffix);
  return {
    original,
    byteLength,
    sha256: expected.digest("hex"),
    source: () => streamChunks((function* () {
      yield prefix;
      yield* bodyParts();
      yield suffix;
    })()),
  };
}
const largeAssistant = (repetitions: number) =>
  largeNativeRecord(nativeAssistantMessage(14, CHAT, SUBMISSION, [{ type: "text", text: "__TEST_BODY__" }]), repetitions);

describe("public SP raw record verification with bounded Eval interpretation", () => {
  it("does not complete a verified record before its asynchronous completion succeeds", async () => {
    const entry = nativeFixture(14, CHAT, SUBMISSION);
    const bytes = encoder.encode(JSON.stringify(entry.record));
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let completed = false;
    const reading = collectHash(verifiedPiRecordBytes(streamed(bytes), {
      ...binding(entry.record, bytes),
      onVerified: async () => { started(); await pending; },
    })).then((value) => { completed = true; return value; });
    await entered;
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    const completedBeforeRelease = completed;
    release();
    expect(await reading).toMatchObject({ bytes: bytes.byteLength, sha256: digest(bytes) });
    expect(completedBeforeRelease).toBe(false);
  });

  it("rejects an invalid interpretation binding without locking or reading its source", async () => {
    const entry = nativeFixture(14, CHAT, SUBMISSION);
    const bytes = encoder.encode(JSON.stringify(entry.record));
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      pull() { pulls++; },
    }, { highWaterMark: 0 });
    expect(() => verifiedPiRecordBytes(source, {
      ...binding(entry.record, bytes), sha256: "invalid", interpret: "metrics",
    })).toThrow(NativeRecordStreamError);
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    const locked = source.locked;
    const readBeforeValidation = pulls;
    controller.close();
    expect(locked).toBe(false);
    expect(readBeforeValidation).toBe(0);
  });

  it("keeps raw marker-looking content as ordinary data without inventing omission facts", async () => {
    const entry = nativeAssistantMessage(14, CHAT, SUBMISSION, [
      { type: "text", text: "[CONTENT OMITTED]" },
    ]);
    const bytes = encoder.encode(JSON.stringify(entry.record));
    let inspected: NativeRecordInspection | undefined;
    expect(await collectHash(verifiedPiRecordBytes(streamed(bytes, 1), {
      ...binding(entry.record, bytes), interpret: "reply", onVerified: (value) => { inspected = value; },
    }))).toMatchObject({ bytes: bytes.byteLength, sha256: digest(bytes) });
    expect(inspected).toMatchObject({
      validation: "integrity-and-envelope", record: entry.record, reduced: false, interpretation: { omittedPaths: [] },
    });
  });

  it("propagates an asynchronous verified-completion rejection without a successful EOF", async () => {
    const entry = nativeFixture(14, CHAT, SUBMISSION);
    const bytes = encoder.encode(JSON.stringify(entry.record));
    const failure = new Error("verified completion was not persisted");
    await expect(collectHash(verifiedPiRecordBytes(streamed(bytes), {
      ...binding(entry.record, bytes), interpret: "metrics",
      onVerified: async () => { throw failure; },
    }))).rejects.toBe(failure);
  });

  it("validates a fully captured native message with the public schema even when duplicate keys make interpretation ambiguous", async () => {
    const entry = nativeFixture(14, CHAT, SUBMISSION);
    const raw = JSON.stringify(entry.record).replace('"role":"assistant"', '"role":"assistant","role":"not-a-native-role"');
    const bytes = encoder.encode(raw);
    let completed = false;
    await expect(collectHash(verifiedPiRecordBytes(streamed(bytes), {
      ...binding(entry.record, bytes), interpret: "metrics",
      onVerified: () => { completed = true; },
    }))).rejects.toMatchObject({ name: "TrajectoryRecordStreamError", code: "invalid_envelope", retryable: false });
    expect(completed).toBe(false);
  });

  it("keeps omission facts separate from a bounded interpretation and the original raw bytes", async () => {
    const entry = nativeToolBodyPair(CHAT, SUBMISSION, "x".repeat(600_000), "search")[1]!;
    const bytes = encoder.encode(JSON.stringify(entry.record));
    let inspected: NativeRecordInspection | undefined;
    expect(await collectHash(verifiedPiRecordBytes(streamed(bytes), {
      ...binding(entry.record, bytes), interpret: "metrics", onVerified: (value) => { inspected = value; },
    }))).toMatchObject({ bytes: bytes.byteLength, sha256: digest(bytes) });
    expect(inspected).toMatchObject({
      reduced: true,
      interpretation: { omittedPaths: expect.arrayContaining(["/record/value/model/0/content/0/text"]) },
    });
    expect(inspected?.record).toBeUndefined();
    expect(JSON.stringify(inspected?.interpretation)).not.toContain("[CONTENT OMITTED]");
    expect(inspected?.interpretation?.record.record.value.model).toMatchObject([
      { role: "toolResult", content: [{ type: "text" }] },
    ]);
  });

  it("can keep a complete literal reply from a large raw record whose unrelated native data is not interpreted", async () => {
    const entry = nativeAssistantMessage(14, CHAT, SUBMISSION, [{ type: "text", text: "[CONTENT OMITTED]" }]);
    if (entry.record.record.type !== "entry") throw new Error("Expected Pi assistant");
    const record: PiTrajectoryRecord = { ...entry.record, record: { ...entry.record.record, value: {
      ...entry.record.record.value, data: { opaque: "x".repeat(600_000) },
    } } };
    const bytes = encoder.encode(JSON.stringify(record));
    let inspected: NativeRecordInspection | undefined;
    expect(await collectHash(verifiedPiRecordBytes(streamed(bytes), {
      ...binding(record, bytes), interpret: "reply", onVerified: (value) => { inspected = value; },
    }))).toMatchObject({ bytes: bytes.byteLength, sha256: digest(bytes) });
    expect(inspected?.record).toBeUndefined();
    expect(inspected?.reduced).toBe(true);
    expect(inspected?.interpretation?.record).not.toHaveProperty("format");
    expect(inspected?.interpretation?.omittedPaths).toEqual([]);
    expect(finalReplyText(inspected!.interpretation!.record, SUBMISSION, inspected!.interpretation!.omittedPaths))
      .toBe("[CONTENT OMITTED]");
  });

  it("captures a decoded bounded reply even when its escaped JSON token exceeds the result byte limit", async () => {
    const entry = nativeAssistantMessage(14, CHAT, SUBMISSION, [{ type: "text", text: "__ESCAPED_REPLY__" }]);
    const reply = `${"A".repeat(170_000)}\ud800\u0000汉🌎é`;
    const escaped = `${"\\u0041".repeat(170_000)}\\ud800\\u0000\\u6c49\\ud83c\\udf0e\\u00e9`;
    const bytes = encoder.encode(JSON.stringify(entry.record).replace('"__ESCAPED_REPLY__"', `"${escaped}"`));
    expect(bytes.byteLength).toBeGreaterThan(EVAL_RESULT_MAX_BYTES);
    let inspected: NativeRecordInspection | undefined;
    await collectHash(verifiedPiRecordBytes(streamed(bytes, 257), {
      ...binding(entry.record, bytes), interpret: "reply", onVerified: (value) => { inspected = value; },
    }));
    expect(inspected).toMatchObject({ reduced: true, maxBufferedBytes: 0, interpretation: { omittedPaths: [] } });
    expect(finalReplyText(inspected!.interpretation!.record, SUBMISSION, inspected!.interpretation!.omittedPaths)).toBe(reply);
    expect(inspected!.maxCapturedChars).toBeLessThanOrEqual(6 * EVAL_RESULT_MAX_BYTES + 2);
    expect(inspected!.maxReplyCapturedChars).toBe(reply.length);
  });

  it("bounds aggregate UTF-8 reply bytes separately from decoded character and token budgets", async () => {
    const entry = nativeAssistantMessage(14, CHAT, SUBMISSION, [
      { type: "text", text: "汉".repeat(200_000) },
      { type: "text", text: "🌎".repeat(110_000) },
    ]);
    const bytes = encoder.encode(JSON.stringify(entry.record));
    let inspected: NativeRecordInspection | undefined;
    await collectHash(verifiedPiRecordBytes(streamed(bytes), {
      ...binding(entry.record, bytes), interpret: "reply", onVerified: (value) => { inspected = value; },
    }));
    expect(inspected).toMatchObject({ reduced: true, maxReplyCapturedChars: 200_000 });
    expect(inspected!.interpretation!.omittedPaths).toEqual(["/record/value/model/0/content/1/text"]);
    expect(finalReplyText(inspected!.interpretation!.record, SUBMISSION, inspected!.interpretation!.omittedPaths)).toBeNull();
    expect(JSON.stringify(inspected!.interpretation!.record)).not.toContain("🌎");
  });

  it("uses actual JSON key and array-index paths rather than interpreting dotted or bracket-looking provider keys", async () => {
    const entry = nativeAssistantMessage(14, CHAT, SUBMISSION, [{ type: "text", text: "trusted reply" }]);
    const value = entry.record.record.value as Record<string, unknown>;
    value.data = { opaque: "x".repeat(600_000) };
    value["model[0]"] = { role: "assistant", timestamp: 1, stopReason: "stop",
      content: [{ type: "text", text: "not the reply" }] };
    let inspected: NativeRecordInspection | undefined;
    const bytes = encoder.encode(JSON.stringify(entry.record));
    await collectHash(verifiedPiRecordBytes(streamed(bytes), {
      ...binding(entry.record, bytes), interpret: "reply", onVerified: (inspection) => { inspected = inspection; },
    }));
    expect(inspected!.interpretation!.omittedPaths).toEqual([]);
    expect(finalReplyText(inspected!.interpretation!.record, SUBMISSION, inspected!.interpretation!.omittedPaths)).toBe("trusted reply");
    expect(JSON.stringify(inspected!.interpretation!.record)).not.toContain("not the reply");
  });

  it("keeps duplicate escaped message keys ambiguous instead of accepting JSON.parse's last value", async () => {
    const entry = nativeAssistantMessage(14, CHAT, SUBMISSION, [{ type: "text", text: "not uniquely proven" }]);
    const bytes = encoder.encode(JSON.stringify(entry.record)
      .replace('"stopReason":"stop"', '"stopReason":"stop","stop\\u0052eason":"stop"'));
    let inspected: NativeRecordInspection | undefined;
    await collectHash(verifiedPiRecordBytes(streamed(bytes, 1), {
      ...binding(entry.record, bytes), interpret: "reply", onVerified: (inspection) => { inspected = inspection; },
    }));
    expect(inspected?.record).toBeUndefined();
    expect(inspected).toMatchObject({ reduced: true, interpretation: { omittedPaths: ["/record/value/model"] } });
    expect(finalReplyText(inspected!.interpretation!.record, SUBMISSION, inspected!.interpretation!.omittedPaths)).toBeNull();
  });

  it("bounds omission paths for raw provider fields rather than retaining arbitrary field names or values", async () => {
    const entry = nativeAssistantMessage(14, CHAT, SUBMISSION, [{ type: "text", text: "reply" }]);
    if (entry.record.record.type !== "entry") throw new Error("Expected Pi assistant");
    const message = (entry.record.record.value.model as Record<string, unknown>[])[0]!;
    const block = (message.content as Record<string, unknown>[])[0]!;
    for (let index = 0; index < 40_000; index++) block[`provider-field-${index}`] = "opaque";
    const bytes = encoder.encode(JSON.stringify(entry.record));
    let inspected: NativeRecordInspection | undefined;
    await collectHash(verifiedPiRecordBytes(streamed(bytes), {
      ...binding(entry.record, bytes), interpret: "metrics", onVerified: (value) => { inspected = value; },
    }));
    expect(inspected?.reduced).toBe(true);
    expect(inspected?.interpretation?.omittedPaths).toEqual([
      "/record/value/model/0/content/0/text", "/record/value/model/0/content/0",
    ]);
    expect(JSON.stringify(inspected?.interpretation)).not.toMatch(/provider-field|opaque/u);
    expect(inspected?.maxCapturedChars).toBeLessThan(4_096);
  });

  it("bounds total reply capture across many individually small raw text blocks", async () => {
    const entry = nativeAssistantMessage(14, CHAT, SUBMISSION,
      Array.from({ length: 256 }, () => ({ type: "text", text: "x".repeat(6_000) })));
    const bytes = encoder.encode(JSON.stringify(entry.record));
    let inspected: NativeRecordInspection | undefined;
    expect(await collectHash(verifiedPiRecordBytes(streamed(bytes), {
      ...binding(entry.record, bytes), interpret: "reply", onVerified: (value) => { inspected = value; },
    }))).toMatchObject({ bytes: bytes.byteLength, sha256: digest(bytes) });
    expect(inspected?.maxReplyCapturedChars).toBeLessThanOrEqual(EVAL_RESULT_MAX_BYTES + 1);
    expect(JSON.stringify(inspected?.interpretation).length).toBeLessThan(EVAL_RESULT_MAX_BYTES + 40_000);
    expect(inspected?.interpretation?.omittedPaths.length).toBeGreaterThan(0);
    expect(finalReplyText(inspected!.interpretation!.record, SUBMISSION, inspected!.interpretation!.omittedPaths))
      .toBeNull();
  });

  it.each([
    ["5 MiB", 150],
    ["30 MiB", 900],
  ])("verifies a real %s raw message in bounded memory and preserves the complete original JSONL hash", async (_size, repetitions) => {
    const item = largeAssistant(repetitions);
    expect(item.byteLength).toBeGreaterThan(_size === "5 MiB" ? 5 * 1024 * 1024 : 30 * 1024 * 1024);
    const inspections: NativeRecordInspection[] = [];
    const seq = item.original.ingestSeq;
    const prefix = encoder.encode(`{"ingestSeq":${seq},"record":`);
    const suffix = encoder.encode("}\n");
    const hash = createHash("sha256").update(prefix);
    // The expected file hash is computed directly from small source chunks.
    const expectedBody = largeAssistant(repetitions);
    for await (const part of expectedBody.source()) hash.update(part);
    hash.update(suffix);
    const frozen = {
      identity: spPiTrajectoryRecordIdentity(item.original.record),
      byteLength: item.byteLength, sha256: item.sha256, maxBytes: MAX_FILE_BYTES,
    };
    const line = verifiedPiJsonlLine(item.source(), recordReference(seq, frozen), {
      scope: { kind: "chat", chatId: CHAT }, maxBytes: MAX_FILE_BYTES, maxFileBytes: MAX_FILE_BYTES,
      onVerified: (inspection) => { inspections.push(inspection); },
    });
    const result = await collectHash(line);
    expect(result).toEqual({
      bytes: prefix.byteLength + item.byteLength + suffix.byteLength,
      sha256: hash.digest("hex"), chunks: expect.any(Number), lines: 1,
      largestChunkBytes: expect.any(Number),
    });
    expect(result.chunks).toBeGreaterThan(1_000);
    expect(result.largestChunkBytes).toBeLessThan(4 * 1024);
    expect(inspections).toEqual([expect.objectContaining({
      identity: spPiTrajectoryRecordIdentity(item.original.record),
      byteLength: item.byteLength, sha256: item.sha256,
    })]);
    expect(inspections[0]!.maxDecodedChars).toBeLessThanOrEqual(64 * 1024);
    expect(inspections[0]!.maxCapturedChars).toBeLessThanOrEqual(512);
    expect(inspections[0]!.maxDepth).toBeLessThan(32);
    expect(inspections[0]).not.toHaveProperty("record");
    expect(inspections[0]).not.toHaveProperty("interpretation");
    expect(inspections[0]).not.toHaveProperty("maxBufferedBytes");
  }, 45_000);

  it("interprets a streamed 30+ MiB assistant as compact native facts without retaining its text", async () => {
    const item = largeAssistant(900);
    let inspected: NativeRecordInspection | undefined;
    await collectHash(verifiedPiRecordBytes(item.source(), {
      identity: spPiTrajectoryRecordIdentity(item.original.record), scope: {
        kind: "operation", chatId: CHAT, submissionId: SUBMISSION,
      },
      byteLength: item.byteLength, sha256: item.sha256, maxBytes: MAX_FILE_BYTES,
      interpret: "metrics", onVerified: (result) => { inspected = result; },
    }));
    expect(inspected).toMatchObject({
      reduced: true, sha256: item.sha256, maxBufferedBytes: expect.any(Number),
      interpretation: { record: { record: { type: "entry", value: { kind: "pi.assistant", model: [
        { role: "assistant", content: [{ type: "text" }] },
      ] } } }, omittedPaths: ["/record/value/model/0/content/0/text"] },
    });
    expect(inspected!.maxBufferedBytes).toBeLessThanOrEqual(512 * 1024);
    const compact = await compactNativeTrajectoryRecord(
      { ingestSeq: item.original.ingestSeq, interpretation: inspected!.interpretation! },
      { chatId: CHAT, idempotencyKey: "execution", submissionId: SUBMISSION }, item.sha256,
    );
    expect(compact.metricProjection).toMatchObject({
      fingerprint: item.sha256, supported: true, facts: [
        { type: "assistant", thinking: null, content: null, inputTokens: 4, outputTokens: 3, totalTokens: 7 },
      ],
    });
    expect(JSON.stringify(compact).length).toBeLessThan(4_096);
  }, 45_000);

  it("keeps a 30+ MiB Result's Pi milliseconds while its withheld body length remains unknown", async () => {
    const original = nativeToolBodyPair(CHAT, SUBMISSION, "__TEST_BODY__", "search")[1]!;
    if (original.record.record.type !== "entry") throw new Error("Expected Pi Tool Result");
    const message = (original.record.record.value.model as Record<string, unknown>[])[0]!;
    message.durationMs = 321;
    message.details = { executionId: "execution-large", capabilityId: "capability-large",
      business: "private-business-body", apiKey: "private-key" };
    const item = largeNativeRecord(original, 900);
    let inspected: NativeRecordInspection | undefined;
    await collectHash(verifiedPiRecordBytes(item.source(), {
      identity: spPiTrajectoryRecordIdentity(original.record), scope: {
        kind: "operation", chatId: CHAT, submissionId: SUBMISSION,
      },
      byteLength: item.byteLength, sha256: item.sha256, maxBytes: MAX_FILE_BYTES,
      interpret: "metrics", onVerified: (result) => { inspected = result; },
    }));
    const compact = await compactNativeTrajectoryRecord(
      { ingestSeq: original.ingestSeq, interpretation: inspected!.interpretation! },
      { chatId: CHAT, idempotencyKey: "execution", submissionId: SUBMISSION }, item.sha256,
    );
    expect(compact.metricProjection).toMatchObject({
      fingerprint: item.sha256, supported: true, chargeLinkVersion: 2,
      facts: [{ type: "tool", phase: "result", toolName: "search", outputLength: null, fromPiResult: true,
        executionId: "execution-large", durationMs: 321,
        agentId: "agent-1", submissionId: SUBMISSION,
        toolCallKey: expect.stringMatching(/^tck2_[0-9a-f]{64}$/u) }],
    });
    expect(JSON.stringify(compact).length).toBeLessThan(4_096);
    expect(JSON.stringify(compact)).not.toMatch(/capability-large|private-business-body|private-key|apiKey|details/u);
  }, 45_000);

  it("preserves a real zero and rejects duplicate execution ID or Pi duration on oversized Results", async () => {
    const result = nativeToolBodyPair(CHAT, SUBMISSION, "x".repeat(600_000), "search")[1]!;
    if (result.record.record.type !== "entry") throw new Error("Expected Pi Tool Result");
    (result.record.record.value.model as Record<string, unknown>[])[0]!.durationMs = 0;
    (result.record.record.value.model as Record<string, unknown>[])[0]!.details = {
      executionId: "execution-1", capabilityId: "capability-1", business: "private-business-body",
    };
    const serialized = JSON.stringify(result.record);
    const variants = [
      serialized.replace('"capabilityId":"capability-1"', '"capabilityId":"sk-private-credential"'),
      serialized.replace('"executionId":"execution-1"',
        '"executionId":"execution-1","executionId":"execution-duplicate"'),
      serialized.replace('"durationMs":0', '"durationMs":0,"durationMs":1'),
    ];
    for (const [index, text] of variants.entries()) {
      const bytes = encoder.encode(text);
      let inspected: NativeRecordInspection | undefined;
      await collectHash(verifiedPiRecordBytes(streamed(bytes), {
        ...binding(result.record, bytes, { kind: "operation", chatId: CHAT, submissionId: SUBMISSION }),
        interpret: "metrics", onVerified: (inspection) => { inspected = inspection; },
      }));
      expect(inspected?.reduced).toBe(true);
      const compact = await compactNativeTrajectoryRecord(
        { ingestSeq: result.ingestSeq, interpretation: inspected!.interpretation! },
        { chatId: CHAT, submissionId: SUBMISSION, idempotencyKey: "execution" }, inspected!.sha256,
      );
      expect(compact.metricProjection).toMatchObject({ chargeLinkVersion: 2, supported: index === 0 });
      expect(JSON.stringify(compact)).not.toMatch(/capability-1|private-business-body|private-credential/u);
      if (index === 0) expect(compact.metricProjection?.facts).toEqual(expect.arrayContaining([
        expect.objectContaining({ executionId: "execution-1", durationMs: 0 }),
      ]));
      else expect(compact.metricProjection?.facts).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ executionId: "execution-1" }),
      ]));
      expect(inspected!.maxCapturedChars).toBeLessThan(4_096);
    }
  });

  it("preserves only a bounded selected final reply; an oversized final assistant cannot fall back to an earlier one", async () => {
    const large = largeAssistant(150);
    let inspected: NativeRecordInspection | undefined;
    await collectHash(verifiedPiRecordBytes(large.source(), {
      identity: spPiTrajectoryRecordIdentity(large.original.record), scope: { kind: "chat", chatId: CHAT },
      byteLength: large.byteLength, sha256: large.sha256, maxBytes: MAX_FILE_BYTES,
      interpret: "reply", onVerified: (value) => { inspected = value; },
    }));
    expect(inspected?.reduced).toBe(true);
    expect(inspected!.interpretation!.record.record.value.model).toMatchObject([
      { role: "assistant", content: [{ type: "text" }] },
    ]);
    expect(inspected!.interpretation!.omittedPaths).toContain("/record/value/model/0/content/0/text");
    expect(inspected!.maxCapturedChars).toBeLessThanOrEqual(6 * EVAL_RESULT_MAX_BYTES + 2);
    expect(inspected!.maxReplyCapturedChars).toBeLessThanOrEqual(EVAL_RESULT_MAX_BYTES);
  }, 30_000);

  it("retries from the beginning after an interrupted midchunk stream; neither a partial JSONL line nor a short EOF is verified", async () => {
    const record = nativeFixture(14, CHAT, SUBMISSION);
    const bytes = encoder.encode(JSON.stringify(record.record));
    let completed = 0;
    let delivered = 0;
    const expected = { ...binding(record.record, bytes), ingestSeq: record.ingestSeq, maxFileBytes: MAX_FILE_BYTES,
      onVerified: () => { completed++; } };
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!delivered) {
          delivered++;
          controller.enqueue(bytes.subarray(0, 57));
        } else controller.error(new TypeError("socket reset"));
      },
    });
    let partial = 0;
    await expect((async () => {
      for await (const chunk of verifiedPiJsonlLine(broken, recordReference(record.ingestSeq, expected), expected)) {
        partial += chunk.byteLength;
      }
    })()).rejects.toThrow(/socket reset/u);
    expect(partial).toBeLessThan(bytes.byteLength);
    expect(completed).toBe(0);
    const short = verifiedPiRecordBytes(streamed(bytes.subarray(0, 80)), expected);
    await expect(collectHash(short)).rejects.toMatchObject({
      name: "TrajectoryRecordStreamError", code: "truncated", retryable: true,
    });
    expect(completed).toBe(0);
    expect(await collectHash(verifiedPiJsonlLine(streamed(bytes), recordReference(record.ingestSeq, expected), expected))).toMatchObject({
      bytes: bytes.byteLength + encoder.encode(`{"ingestSeq":${record.ingestSeq},"record":}\n`).byteLength,
      lines: 1,
    });
    expect(completed).toBe(1);
  });

  it("cancels the upstream body when the consumer stops before a native record is complete", async () => {
    const record = nativeFixture(14, CHAT, SUBMISSION);
    const bytes = encoder.encode(JSON.stringify(record.record));
    let canceled = false;
    let verified = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(bytes.subarray(0, 29)); },
      cancel() { canceled = true; },
    });
    const reader = verifiedPiJsonlLine(source, recordReference(record.ingestSeq, binding(record.record, bytes)), {
      ...binding(record.record, bytes), maxFileBytes: MAX_FILE_BYTES,
      onVerified: () => { verified = true; },
    }).getReader();
    expect((await reader.read()).value).toBeDefined();
    expect((await reader.read()).value).toBeDefined();
    await reader.cancel();
    expect(canceled).toBe(true);
    expect(verified).toBe(false);
  });

  it.each([undefined, "metrics"] as const)("cancels a pending upstream read and releases its lock with interpretation %s", async (interpret) => {
    const entry = nativeFixture(14, CHAT, SUBMISSION);
    const bytes = encoder.encode(JSON.stringify(entry.record));
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let cancellation: unknown;
    let completed = false;
    const source = new ReadableStream<Uint8Array>({
      pull() { started(); },
      cancel(reason) { cancellation = reason; },
    }, { highWaterMark: 0 });
    const reader = verifiedPiRecordBytes(source, {
      ...binding(entry.record, bytes), ...(interpret === undefined ? {} : { interpret }),
      onVerified: () => { completed = true; },
    }).getReader();
    const pending = reader.read();
    await entered;
    const reason = new Error("consumer left");
    await reader.cancel(reason);
    expect(await pending).toEqual({ value: undefined, done: true });
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(cancellation).toBe(reason);
    expect(source.locked).toBe(false);
    expect(completed).toBe(false);
    reader.releaseLock();
  });

  it.each([undefined, "metrics"] as const)("preserves an abort reason during a pending read with interpretation %s", async (interpret) => {
    const entry = nativeFixture(14, CHAT, SUBMISSION);
    const bytes = encoder.encode(JSON.stringify(entry.record));
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let cancellation: unknown;
    let completed = false;
    const source = new ReadableStream<Uint8Array>({
      pull() { started(); },
      cancel(reason) { cancellation = reason; },
    }, { highWaterMark: 0 });
    const abort = new AbortController();
    const reader = verifiedPiRecordBytes(source, {
      ...binding(entry.record, bytes), ...(interpret === undefined ? {} : { interpret }), signal: abort.signal,
      onVerified: () => { completed = true; },
    }).getReader();
    const pending = reader.read();
    await entered;
    const reason = new Error("Attempt cancelled");
    abort.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(cancellation).toBe(reason);
    expect(source.locked).toBe(false);
    expect(completed).toBe(false);
    reader.releaseLock();
  });

  it("allows all raw Chat Context and prior Submission entries, but requires scope for resource records", async () => {
    const context: NativeTrajectoryEntry = {
      ...nativeFixture(1, CHAT, SUBMISSION),
      record: { ...nativeFixture(1, CHAT, SUBMISSION).record, submissionId: null, origin: "context" },
    };
    const prior = nativeFixture(14, CHAT, OTHER);
    for (const record of [context, prior]) {
      const bytes = encoder.encode(JSON.stringify(record.record));
      expect(await collectHash(verifiedPiJsonlLine(streamed(bytes), recordReference(record.ingestSeq, binding(record.record, bytes)), {
        ...binding(record.record, bytes), maxFileBytes: MAX_FILE_BYTES,
      }))).toMatchObject({ lines: 1 });
      await expect(collectHash(verifiedPiRecordBytes(streamed(bytes), binding(record.record, bytes,
        { kind: "operation", chatId: CHAT, submissionId: SUBMISSION })))).rejects.toMatchObject({
        name: "TrajectoryRecordStreamError", retryable: false,
      });
    }
    const child = {
      ...prior.record, parent: { resource: { agentId: "parent-agent", sessionId: CHAT }, submissionId: SUBMISSION },
    } satisfies PiTrajectoryRecord;
    const body = encoder.encode(JSON.stringify(child));
    expect(await collectHash(verifiedPiRecordBytes(streamed(body), binding(child, body,
      { kind: "operation", chatId: CHAT, submissionId: SUBMISSION })))).toMatchObject({
      bytes: body.byteLength, sha256: digest(body),
    });
  });

  it("keeps noncanonical but valid source JSON bytes, escapes and key spacing unchanged in the JSONL file", async () => {
    const record = nativeFixture(6, CHAT, SUBMISSION);
    const raw = `${JSON.stringify(record.record)
      .replace("\"format\":", "\"format\" : ")
      .replace("é", "\\u00e9")}   `;
    const bytes = encoder.encode(raw);
    const line = verifiedPiJsonlLine(streamed(bytes, 9), recordReference(record.ingestSeq, binding(record.record, bytes)), {
      ...binding(record.record, bytes), maxFileBytes: MAX_FILE_BYTES,
    });
    expect(new TextDecoder().decode(await new Response(line).arrayBuffer()))
      .toBe(`{"ingestSeq":${record.ingestSeq},"record":${raw}}\n`);
  });

  it("preserves native identity whitespace rather than trimming public Runtime identifiers", async () => {
    const entry = nativeFixture(14, CHAT, SUBMISSION);
    const source = entry.record;
    if (source.submissionId === null) throw new Error("Expected an execution record");
    const record: PiTrajectoryRecord = { ...source,
      resource: { ...source.resource, agentId: " agent-1 " }, submissionId: ` ${SUBMISSION} `,
    };
    const bytes = encoder.encode(JSON.stringify(record));
    let inspected: NativeRecordInspection | undefined;
    const header = binding(record, bytes);
    const result = await new Response(verifiedPiJsonlLine(streamed(bytes), recordReference(entry.ingestSeq, header), {
      ...header, maxFileBytes: MAX_FILE_BYTES, interpret: "reply", onVerified: (value) => { inspected = value; },
    })).text();
    expect(result).toBe(`{"ingestSeq":14,"record":${JSON.stringify(record)}}\n`);
    expect(inspected?.identity).toBe(`[" agent-1 ","${CHAT}","entry",14]`);
    expect(inspected?.record).toEqual(record);
    expect(inspected?.interpretation?.record.submissionId).toBe(` ${SUBMISSION} `);
  });

  it.each([0, 600_000])("keeps valid opaque large finite numbers with %i bytes of unrelated native content", async (padding) => {
    const entry = nativeFixture(14, CHAT, SUBMISSION);
    if (entry.record.record.type !== "entry") throw new Error("Expected Pi assistant");
    const record: PiTrajectoryRecord = { ...entry.record, record: { ...entry.record.record, value: {
      ...entry.record.record.value, data: { numbers: [1e100, 9_007_199_254_740_992, -1e100], opaque: "x".repeat(padding) },
    } } };
    const bytes = encoder.encode(JSON.stringify(record));
    let inspected: NativeRecordInspection | undefined;
    expect(await collectHash(verifiedPiRecordBytes(streamed(bytes), {
      ...binding(record, bytes), interpret: "reply", onVerified: (value) => { inspected = value; },
    }))).toMatchObject({ bytes: bytes.byteLength, sha256: digest(bytes) });
    expect(inspected?.reduced).toBe(padding !== 0);
    expect(inspected?.interpretation?.omittedPaths).toEqual([]);
    expect(finalReplyText(inspected!.interpretation!.record, SUBMISSION, inspected!.interpretation!.omittedPaths)).toBe('{"score":1}');
    if (padding === 0) expect(inspected?.record).toEqual(record);
    else expect(inspected?.record).toBeUndefined();
  });

  it.each([
    ["legacy projection", (record: PiTrajectoryRecord) => ({ ...record,
      projection: { kind: "safe", policyId: "legacy", policyVersion: 1 } })],
    ["foreign Chat", (record: PiTrajectoryRecord) => ({ ...record, resource: { ...record.resource, sessionId: OTHER } })],
    ["foreign parent Chat", (record: PiTrajectoryRecord) => ({
      ...record, parent: { resource: { agentId: "agent-1", sessionId: OTHER }, submissionId: SUBMISSION },
    })],
    ["invalid origin", (record: PiTrajectoryRecord) => ({ ...record, submissionId: null })],
    ["record key ambiguity", (record: PiTrajectoryRecord) => ({ ...record, ingestSeq: 1 })],
    ["non-JSON number", (record: PiTrajectoryRecord) => ({ ...record,
      record: { type: "entry", value: { id: 9_007_199_254_740_992, conversationId: 1, kind: "pi.user" } } })],
  ])("rejects %s without claiming a verified record", async (_name, change) => {
    const trusted = nativeFixture(14, CHAT, SUBMISSION);
    const bad = change(trusted.record);
    const bytes = encoder.encode(JSON.stringify(bad));
    let completed = false;
    await expect(collectHash(verifiedPiRecordBytes(streamed(bytes), {
      ...binding(trusted.record, bytes), onVerified: () => { completed = true; },
    }))).rejects.toMatchObject({ name: "TrajectoryRecordStreamError", retryable: false });
    expect(completed).toBe(false);
  });

  it("rejects duplicate envelope keys, invalid UTF-8, malformed JSON, changed digest and oversized original records", async () => {
    const trusted = nativeFixture(14, CHAT, SUBMISSION);
    const serialized = JSON.stringify(trusted.record);
    const variants = [
      encoder.encode(serialized.replace("\"format\":\"pi-trajectory/v1\"",
        "\"format\":\"pi-trajectory/v1\",\"format\":\"pi-trajectory/v1\"")),
      encoder.encode(serialized.replace("\"record\":", "\"record\" ")),
      encoder.encode(`${serialized}\n`),
      (() => {
        const bytes = encoder.encode(serialized);
        bytes[serialized.indexOf("\"resource\"") + 1] = 255;
        return bytes;
      })(),
    ];
    for (const bytes of variants) {
      await expect(collectHash(verifiedPiRecordBytes(streamed(bytes, 13), binding(trusted.record, bytes))))
        .rejects.toMatchObject({ name: "TrajectoryRecordStreamError", retryable: false });
    }
    const bytes = encoder.encode(serialized);
    await expect(collectHash(verifiedPiRecordBytes(streamed(bytes), {
      ...binding(trusted.record, bytes), sha256: "0".repeat(64),
    }))).rejects.toMatchObject({ name: "TrajectoryRecordStreamError", retryable: false });
    expect(() => verifiedPiJsonlLine(streamed(bytes), recordReference(trusted.ingestSeq, binding(trusted.record, bytes)), {
      ...binding(trusted.record, bytes), maxFileBytes: bytes.byteLength,
    })).toThrow(NativeRecordStreamError);
  });
});
