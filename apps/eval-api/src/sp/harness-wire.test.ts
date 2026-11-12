import { describe, expect, it } from "vitest";
import { evalEvidenceTrajectoryPageSchema, evalResourceNativePageSchema } from "@springbrand/eval-harness";
import { evidenceTrajectoryPage, finalReplyText, resourceNativePage } from "./harness-wire.js";
import { nativeAssistantMessage, nativeFixtureRecords } from "./native-test-fixture.js";

const CHAT = "11111111-1111-4111-8111-111111111111";
const SUBMISSION = "22222222-2222-4222-8222-222222222222";
const page = () => ({
  format: "sp-pi-trajectory/v1",
  cursor: { throughSeq: 16 },
  records: nativeFixtureRecords([1, 6, 10, 14, 16], CHAT, SUBMISSION),
  nextAfterSeq: null,
});

describe("published raw Harness wire", () => {
  it.each([
    { name: "evidence", read: evidenceTrajectoryPage },
    { name: "resource", read: resourceNativePage },
  ])("uses the public $name page grammar for cutoff equality, EOF and malformed continuations", ({ read }) => {
    const reference = { ingestSeq: 5, reference: {
      format: "sp-pi-trajectory-record/v1", throughSeq: 5,
      identity: JSON.stringify(["agent", CHAT, "entry", 8]), byteLength: 5_500_000, sha256: "a".repeat(64),
    } };
    const source = { format: "sp-pi-trajectory/v1", cursor: { throughSeq: 5 },
      records: [reference], nextAfterSeq: 5 };
    expect(read(source)).toEqual(source);
    const eof = { ...source, records: [], nextAfterSeq: null };
    expect(read(eof)).toEqual(eof);
    for (const invalid of [
      { ...source, records: [] },
      { ...source, nextAfterSeq: 6 },
      { ...source, records: [reference, reference] },
      { ...source, cursor: { throughSeq: 4 } },
      { ...source, records: [{ ...reference, reference: { ...reference.reference, throughSeq: 6 } }] },
      { ...source, records: [{ ...reference, metricProjection: { supported: true, facts: [] } }] },
    ]) expect(() => read(invalid)).toThrowError(/invalid/u);
  });

  it.each([
    [evalEvidenceTrajectoryPageSchema, evidenceTrajectoryPage],
    [evalResourceNativePageSchema, resourceNativePage],
  ])("accepts raw native bodies with the actual public schema and retains all native fields", (schema, read) => {
    const source = page();
    expect(source.records.every(({ record }) => !("projection" in record))).toBe(true);
    expect(schema.safeParse(source).success).toBe(true);
    const result = read(source);
    expect(result).toEqual(source);
    const first = result.records[0]!;
    expect("record" in first && first.record).toBe(source.records[0]!.record);
  });

  it.each([
    ["legacy projection", (record: object) => ({ ...record,
      projection: { kind: "safe", policyId: "old", policyVersion: 1 } })],
    ["inner ingest sequence", (record: object) => ({ ...record, ingestSeq: 1 })],
    ["invalid native head", (record: object) => ({ ...record,
      record: { type: "entry", value: { id: 14, conversationId: 1, kind: "pi.assistant", head: -1 } } })],
    ["invalid native model", (record: object) => ({ ...record,
      record: { type: "entry", value: { id: 14, conversationId: 1, kind: "pi.assistant",
        model: [{ role: "assistant", content: "not native Pi blocks", timestamp: 1 }] } } })],
  ])("rejects %s at both real public page boundaries", (_label, change) => {
    const source = page();
    const invalid = { ...source, cursor: { throughSeq: 14 },
      records: [{ ingestSeq: 14, record: change(source.records[3]!.record) }] };
    expect(evalEvidenceTrajectoryPageSchema.safeParse(invalid).success).toBe(false);
    expect(evalResourceNativePageSchema.safeParse(invalid).success).toBe(false);
    for (const read of [evidenceTrajectoryPage, resourceNativePage]) {
      expect(() => read(invalid)).toThrowError(/invalid/u);
    }
  });

  it.each(["[CONTENT OMITTED]", "[REDACTED]", "[Action business data withheld from telemetry]"])(
    "treats literal %s as raw final-reply content, independently of local omissions", (text) => {
      const { record } = nativeAssistantMessage(14, CHAT, SUBMISSION, [{ type: "text", text }]);
      expect(finalReplyText(record, SUBMISSION)).toBe(text);
      expect(finalReplyText(record, SUBMISSION, ["/record/value/model/0/content/0/text"])).toBeNull();
      expect(finalReplyText(record, "other-submission")).toBeUndefined();
    });
});
