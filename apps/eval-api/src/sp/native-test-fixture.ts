import { readFileSync } from "node:fs";
import { nativeTrajectoryEntrySchema, type JsonValue, type NativeTrajectoryEntry } from "@eval-platform/eval-contracts";

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
