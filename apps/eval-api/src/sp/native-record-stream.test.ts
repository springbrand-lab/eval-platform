import { createHash } from "node:crypto";
import { spPiTrajectoryRecordIdentity, type NativeTrajectoryEntry, type PiTrajectoryRecord } from "@eval-platform/eval-contracts";
import { compactNativeTrajectoryRecord } from "@eval-platform/eval-metrics";
import { describe, expect, it } from "vitest";
import { nativeAssistantMessage, nativeFixture, nativeToolBodyPair } from "./native-test-fixture.js";
import {
  NativeRecordStreamError, verifiedSafePiJsonlLine, verifiedSafePiRecordBytes,
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
 * The generated public UA assistant envelope, with a large SAFE Pi message inserted
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

describe("source-independent SAFE Pi streaming byte reader", () => {
  it.each([
    ["5 MiB", 150],
    ["30 MiB", 900],
  ])("verifies a real %s SAFE message in bounded memory and preserves the complete original JSONL hash", async (_size, repetitions) => {
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
    const line = verifiedSafePiJsonlLine(item.source(), {
      identity: spPiTrajectoryRecordIdentity(item.original.record),
      scope: { kind: "chat", chatId: CHAT },
      byteLength: item.byteLength, sha256: item.sha256, maxBytes: MAX_FILE_BYTES,
      ingestSeq: seq, maxFileBytes: MAX_FILE_BYTES,
      onVerified: (inspection) => inspections.push(inspection),
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
  }, 45_000);

  it("interprets a streamed 30+ MiB assistant as compact native facts without retaining its text", async () => {
    const item = largeAssistant(900);
    let inspected: NativeRecordInspection | undefined;
    await collectHash(verifiedSafePiRecordBytes(item.source(), {
      identity: spPiTrajectoryRecordIdentity(item.original.record), scope: {
        kind: "operation", chatId: CHAT, submissionId: SUBMISSION,
      },
      byteLength: item.byteLength, sha256: item.sha256, maxBytes: MAX_FILE_BYTES,
      interpret: "metrics", onVerified: (result) => { inspected = result; },
    }));
    expect(inspected).toMatchObject({
      reduced: true, sha256: item.sha256, maxBufferedBytes: expect.any(Number),
      record: { record: { type: "entry", value: { kind: "pi.assistant", model: [
        { role: "assistant", content: [{ type: "text", text: "[CONTENT OMITTED]" }] },
      ] } } },
    });
    expect(inspected!.maxBufferedBytes).toBeLessThanOrEqual(512 * 1024);
    const compact = await compactNativeTrajectoryRecord(
      { ingestSeq: item.original.ingestSeq, record: inspected!.record! },
      { chatId: CHAT, idempotencyKey: "execution", submissionId: SUBMISSION }, item.sha256,
    );
    expect(compact.metricProjection).toMatchObject({
      fingerprint: item.sha256, supported: true, facts: [
        { type: "assistant", thinking: false, content: true, inputTokens: 4, outputTokens: 3, totalTokens: 7 },
      ],
    });
    expect(JSON.stringify(compact).length).toBeLessThan(4_096);
  }, 45_000);

  it("reports a streamed 30+ MiB native Tool Result length as unknown, not zero", async () => {
    const original = nativeToolBodyPair(CHAT, SUBMISSION, "__TEST_BODY__", "search")[1]!;
    const item = largeNativeRecord(original, 900);
    let inspected: NativeRecordInspection | undefined;
    await collectHash(verifiedSafePiRecordBytes(item.source(), {
      identity: spPiTrajectoryRecordIdentity(original.record), scope: {
        kind: "operation", chatId: CHAT, submissionId: SUBMISSION,
      },
      byteLength: item.byteLength, sha256: item.sha256, maxBytes: MAX_FILE_BYTES,
      interpret: "metrics", onVerified: (result) => { inspected = result; },
    }));
    const compact = await compactNativeTrajectoryRecord(
      { ingestSeq: original.ingestSeq, record: inspected!.record! },
      { chatId: CHAT, idempotencyKey: "execution", submissionId: SUBMISSION }, item.sha256,
    );
    expect(compact.metricProjection).toMatchObject({
      fingerprint: item.sha256, supported: true,
      facts: [{ type: "tool", phase: "result", toolName: "search", outputLength: null, fromPiResult: true }],
    });
    expect(JSON.stringify(compact).length).toBeLessThan(4_096);
  }, 45_000);

  it("preserves only a bounded selected final reply; an oversized final assistant cannot fall back to an earlier one", async () => {
    const large = largeAssistant(150);
    let inspected: NativeRecordInspection | undefined;
    await collectHash(verifiedSafePiRecordBytes(large.source(), {
      identity: spPiTrajectoryRecordIdentity(large.original.record), scope: { kind: "chat", chatId: CHAT },
      byteLength: large.byteLength, sha256: large.sha256, maxBytes: MAX_FILE_BYTES,
      interpret: "reply", onVerified: (value) => { inspected = value; },
    }));
    expect(inspected?.reduced).toBe(true);
    expect(inspected!.record!.record.value.model).toMatchObject([
      { role: "assistant", content: [{ type: "text", text: "[CONTENT OMITTED]" }] },
    ]);
    expect(inspected!.maxCapturedChars).toBeLessThanOrEqual(1_000_001);
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
      for await (const chunk of verifiedSafePiJsonlLine(broken, expected)) partial += chunk.byteLength;
    })()).rejects.toThrow(/socket reset/u);
    expect(partial).toBeLessThan(bytes.byteLength);
    expect(completed).toBe(0);
    const short = verifiedSafePiRecordBytes(streamed(bytes.subarray(0, 80)), expected);
    await expect(collectHash(short)).rejects.toMatchObject({
      name: "NativeRecordStreamError", retryable: true,
    });
    expect(completed).toBe(0);
    expect(await collectHash(verifiedSafePiJsonlLine(streamed(bytes), expected))).toMatchObject({
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
    const reader = verifiedSafePiJsonlLine(source, {
      ...binding(record.record, bytes), ingestSeq: record.ingestSeq, maxFileBytes: MAX_FILE_BYTES,
      onVerified: () => { verified = true; },
    }).getReader();
    expect((await reader.read()).value).toBeDefined();
    expect((await reader.read()).value).toBeDefined();
    await reader.cancel();
    expect(canceled).toBe(true);
    expect(verified).toBe(false);
  });

  it("allows all SAFE Chat Context and prior Submission entries, but requires scope for resource records", async () => {
    const context: NativeTrajectoryEntry = {
      ...nativeFixture(1, CHAT, SUBMISSION),
      record: { ...nativeFixture(1, CHAT, SUBMISSION).record, submissionId: null, origin: "context" },
    };
    const prior = nativeFixture(14, CHAT, OTHER);
    for (const record of [context, prior]) {
      const bytes = encoder.encode(JSON.stringify(record.record));
      expect(await collectHash(verifiedSafePiJsonlLine(streamed(bytes), {
        ...binding(record.record, bytes), ingestSeq: record.ingestSeq, maxFileBytes: MAX_FILE_BYTES,
      }))).toMatchObject({ lines: 1 });
      await expect(collectHash(verifiedSafePiRecordBytes(streamed(bytes), binding(record.record, bytes,
        { kind: "operation", chatId: CHAT, submissionId: SUBMISSION })))).rejects.toMatchObject({
        name: "NativeRecordStreamError", retryable: false,
      });
    }
    const child = {
      ...prior.record, parent: { resource: { agentId: "parent-agent", sessionId: CHAT }, submissionId: SUBMISSION },
    } satisfies PiTrajectoryRecord;
    const body = encoder.encode(JSON.stringify(child));
    expect(await collectHash(verifiedSafePiRecordBytes(streamed(body), binding(child, body,
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
    const line = verifiedSafePiJsonlLine(streamed(bytes, 9), {
      ...binding(record.record, bytes), ingestSeq: record.ingestSeq, maxFileBytes: MAX_FILE_BYTES,
    });
    expect(new TextDecoder().decode(await new Response(line).arrayBuffer()))
      .toBe(`{"ingestSeq":${record.ingestSeq},"record":${raw}}\n`);
  });

  it.each([
    ["unsafe projection", (record: PiTrajectoryRecord) => ({ ...record, projection: { ...record.projection, kind: "unsafe" } })],
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
    await expect(collectHash(verifiedSafePiRecordBytes(streamed(bytes), {
      ...binding(trusted.record, bytes), onVerified: () => { completed = true; },
    }))).rejects.toMatchObject({ name: "NativeRecordStreamError", retryable: false });
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
        bytes[serialized.indexOf("\"policyId\"") + 1] = 255;
        return bytes;
      })(),
    ];
    for (const bytes of variants) {
      await expect(collectHash(verifiedSafePiRecordBytes(streamed(bytes, 13), binding(trusted.record, bytes))))
        .rejects.toMatchObject({ name: "NativeRecordStreamError", retryable: false });
    }
    const bytes = encoder.encode(serialized);
    await expect(collectHash(verifiedSafePiRecordBytes(streamed(bytes), {
      ...binding(trusted.record, bytes), sha256: "0".repeat(64),
    }))).rejects.toMatchObject({ name: "NativeRecordStreamError", retryable: false });
    expect(() => verifiedSafePiJsonlLine(streamed(bytes), {
      ...binding(trusted.record, bytes), ingestSeq: trusted.ingestSeq, maxFileBytes: bytes.byteLength,
    })).toThrow(NativeRecordStreamError);
  });
});
