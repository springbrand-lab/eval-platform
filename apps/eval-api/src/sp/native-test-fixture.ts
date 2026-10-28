import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  SP_PI_TRAJECTORY_RECORD_FORMAT, nativeTrajectoryEntrySchema,
  type JsonValue, type NativeTrajectoryEntry, type SpPiTrajectoryRecordReference,
} from "@eval-platform/eval-contracts";

/** The checked-in records were projected by the published public UA trajectory
 * helpers. Test transport identities are substituted, never a new event envelope. */
const fixture = JSON.parse(readFileSync(new URL("../../../../fixtures/pi-native-public-v1.json", import.meta.url), "utf8")) as {
  readonly records: readonly NativeTrajectoryEntry[];
};

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected Pi fixture object");
  return value as Record<string, unknown>;
}

export function nativeFixture(ingestSeq: number, chatId: string, submissionId = "submission-1"): NativeTrajectoryEntry {
  const item = fixture.records.find((entry) => entry.ingestSeq === ingestSeq);
  if (!item) throw new Error(`Missing generated Pi fixture record ${ingestSeq}`);
  const entry = structuredClone(item);
  const record = object(entry.record);
  object(record.resource).sessionId = chatId;
  record.submissionId = submissionId;
  const parent = record.parent;
  if (parent) {
    object(object(parent).resource).sessionId = chatId;
    if (object(parent).submissionId === item.record.submissionId) object(parent).submissionId = submissionId;
  }
  const value = object(object(record.record).value);
  const data = value.data === undefined ? undefined : object(value.data);
  if (data?.type === "event") {
    const event = object(data.event);
    object(event.resource).sessionId = chatId;
    event.submissionId = submissionId;
  }
  return nativeTrajectoryEntrySchema.parse(entry);
}

export function nativeFixtureRecords(ingestSeqs: readonly number[], chatId: string, submissionId = "submission-1"): NativeTrajectoryEntry[] {
  return ingestSeqs.map((seq) => nativeFixture(seq, chatId, submissionId));
}

/** A targeted Pi assistant variant, based on the publicly projected assistant
 * Entry rather than an invented top-level `message` or event-shaped record. */
export function nativeAssistantMessage(
  ingestSeq: number, chatId: string, submissionId: string, content: readonly JsonValue[],
  stopReason = "stop",
): NativeTrajectoryEntry {
  const source = nativeFixture(14, chatId, submissionId);
  const write = source.record.record;
  if (write.type !== "entry" || !Array.isArray(write.value.model)) throw new Error("Expected generated Pi assistant");
  const original = object(write.value.model[0]);
  return nativeTrajectoryEntrySchema.parse({
    ingestSeq,
    record: { ...source.record,
      record: { type: "entry",
        value: { ...write.value, id: ingestSeq, model: [{ ...original, content, stopReason, timestamp: 425 + ingestSeq }] } } },
  });
}

/** The two publicly projected Pi message kinds carrying a Tool Call's safe
 * arguments and its Tool Result body. Used only for storage/Unicode stress. */
export function nativeToolBodyPair(
  chatId: string, submissionId: string, body: string, toolName: string, pairIndex = 0,
): NativeTrajectoryEntry[] {
  const assistant = nativeFixture(6, chatId, submissionId);
  const result = nativeFixture(10, chatId, submissionId);
  const callId = `tool-${pairIndex}`;
  const assistantValue = object(object(assistant.record.record).value);
  assistantValue.id = pairIndex * 2 + 1;
  const assistantMessage = object((assistantValue.model as unknown[])[0]);
  assistantMessage.timestamp = 255 + pairIndex;
  assistantMessage.content = [{ type: "toolCall", id: callId, name: toolName, arguments: body }];
  const resultValue = object(object(result.record.record).value);
  resultValue.id = pairIndex * 2 + 2;
  const toolResult = object((resultValue.model as unknown[])[0]);
  toolResult.timestamp = 320 + pairIndex;
  toolResult.toolCallId = callId;
  toolResult.toolName = toolName;
  toolResult.content = [{ type: "text", text: body }];
  return [
    nativeTrajectoryEntrySchema.parse({ ...assistant, ingestSeq: pairIndex * 2 + 1 }),
    nativeTrajectoryEntrySchema.parse({ ...result, ingestSeq: pairIndex * 2 + 2 }),
  ];
}

/** Test the published SP reference wire with a real source-projected Pi record, not an event-shaped fake. */
export function nativeTransfer(entry: NativeTrajectoryEntry, throughSeq: number): {
  reference: SpPiTrajectoryRecordReference;
  bytes: Uint8Array;
} {
  const bytes = new TextEncoder().encode(JSON.stringify(entry.record));
  const reference = {
    ingestSeq: entry.ingestSeq,
    reference: {
      format: SP_PI_TRAJECTORY_RECORD_FORMAT,
      throughSeq,
      identity: JSON.stringify([entry.record.resource.agentId, entry.record.resource.sessionId,
        entry.record.record.type, entry.record.record.value.id]),
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  } satisfies SpPiTrajectoryRecordReference;
  return { reference, bytes };
}

/** SP's raw record GET returns the exact JSON bytes; header overrides exercise operator failures. */
export function nativeTransferResponse(
  reference: SpPiTrajectoryRecordReference,
  bytes: Uint8Array,
  overrides: Readonly<Record<string, string>> = {},
): Response {
  const stream = new Blob([new Uint8Array(bytes)]).stream();
  return new Response(stream, { headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(reference.reference.byteLength),
    "X-Eval-Content-Sha256": reference.reference.sha256,
    "X-Eval-Trajectory-Identity": encodeURIComponent(reference.reference.identity),
    "X-Eval-Trajectory-Ingest-Seq": String(reference.ingestSeq),
    "X-Eval-Trajectory-Through-Seq": String(reference.reference.throughSeq),
    ...overrides,
  } });
}

/** Test-only 30+ MiB SAFE Pi response generated from small, reusable UTF-8 chunks.
 * Neither the test nor the HTTP consumer allocates a whole giant source record. */
export function streamedAssistantTransfer(chatId: string, submissionId: string, repetitions = 900) {
  const small = nativeAssistantMessage(14, chatId, submissionId, [{ type: "text", text: "__STREAM_BODY__" }]);
  const template = JSON.stringify(small.record);
  const marker = "\"__STREAM_BODY__\"";
  const at = template.indexOf(marker);
  if (at < 0 || template.indexOf(marker, at + marker.length) !== -1) throw new Error("Missing unique Pi marker");
  const encoder = new TextEncoder();
  const prefix = encoder.encode(`${template.slice(0, at)}"`);
  const suffix = encoder.encode(`"${template.slice(at + marker.length)}`);
  const body = encoder.encode("汉🌎é".repeat(4_096));
  const recordLength = prefix.byteLength + body.byteLength * repetitions + suffix.byteLength;
  const recordHash = createHash("sha256").update(prefix);
  const fileHash = createHash("sha256").update(encoder.encode(`{"ingestSeq":14,"record":`)).update(prefix);
  for (let index = 0; index < repetitions; index++) {
    recordHash.update(body);
    fileHash.update(body);
  }
  recordHash.update(suffix);
  fileHash.update(suffix).update(encoder.encode("}\n"));
  const { reference: base } = nativeTransfer(small, 14);
  const reference: SpPiTrajectoryRecordReference = { ...base, reference: {
    ...base.reference, byteLength: recordLength, sha256: recordHash.digest("hex"),
  } };
  const stream = () => {
    const parts = (function* () {
      yield prefix;
      for (let index = 0; index < repetitions; index++) {
        for (let offset = 0; offset < body.byteLength; offset += 257) yield body.subarray(offset, offset + 257);
      }
      yield suffix;
    })();
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = parts.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
    });
  };
  return {
    reference, recordLength, fileSha256: fileHash.digest("hex"), stream,
    response: () => new Response(stream(), { headers: nativeTransferResponse(reference, new Uint8Array()).headers }),
  };
}
