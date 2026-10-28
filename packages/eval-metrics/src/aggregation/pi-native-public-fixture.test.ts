import { readFileSync } from "node:fs";
import { canonicalJsonBytes, nativeTrajectoryEntrySchema, type NativeTrajectoryEntry } from "@eval-platform/eval-contracts";
import { describe, expect, it } from "vitest";
import { resourceInput, settlement, usage } from "../test-support.js";
import { aggregateResources } from "./resources.js";
import { compactResourceSnapshot } from "./compact-resources.js";

/** Written by scripts/generate-pi-native-fixture.mjs via the published public UA
 * createTrajectoryRecord/createTrajectoryEntry/projectTrajectoryForExport helpers.
 * No hand-authored `kind: "event"` envelope or event-only mock is accepted. */
const fixture = JSON.parse(readFileSync(new URL("../../../../fixtures/pi-native-public-v1.json", import.meta.url), "utf8")) as {
  readonly generator: string;
  readonly records: readonly NativeTrajectoryEntry[];
};
const snapshot = () => resourceInput({
  scope: { chatId: "chat-1", idempotencyKey: "key-1", submissionId: "submission-1" },
  nativeRecords: fixture.records,
  usageEvents: [usage("billed-1", { metrics: { inputTokens: 100, outputTokens: 2, totalTokens: 102 } })],
  billingSettlements: [settlement("billed-1")],
});

describe("published UA safe Pi trajectory fixture", () => {
  it("rejects invented top-level record shapes and keeps source Pi history intact", () => {
    expect(fixture.generator).toBe("@springbrand/agent-runtime/trajectory@0.3.1-alpha.9");
    expect(fixture.records).toHaveLength(16);
    for (const item of fixture.records) {
      expect(nativeTrajectoryEntrySchema.safeParse(item).success).toBe(true);
      expect(item.record).not.toHaveProperty("kind");
      expect(item.record).toMatchObject({
        format: "pi-trajectory/v1",
        resource: { agentId: "agent-1", sessionId: "chat-1" },
        projection: { kind: "safe", policyId: "eval-native-fixture", policyVersion: 1 },
      });
    }
    const history = fixture.records[6]!.record.record;
    expect(history).toMatchObject({ type: "entry", value: { kind: "springbrand.trajectory",
      data: { type: "event", event: { type: "generation.finished", payload: { totalTokens: 16 } } } } });
  });

  it("measures actual Pi event/request/hook/message/Tool facts without double billing", async () => {
    const input = snapshot();
    const result = aggregateResources([input]);
    expect(result.modelRequests).toMatchObject({ count: { value: 2, coverage: "complete" }, completed: 2 });
    expect(result.trajectory.turns).toMatchObject({ count: { value: 1, coverage: "complete" }, completed: 1, durationMs: { total: 400 } });
    expect(result.trajectory.tools).toMatchObject({ count: { value: 1, coverage: "complete" }, failed: 1 });
    expect(result.trajectory.byTool[0]).toMatchObject({
      toolName: "search", inputLength: { count: 1, missing: 0, total: canonicalJsonBytes({ query: "é" }).byteLength },
      outputLength: { count: 1, missing: 0, total: canonicalJsonBytes([{ type: "text", text: "not found" }]).byteLength },
    });
    expect(result.trajectory.thinkingSteps).toEqual({ value: 1, coverage: "complete" });
    expect(result.trajectory.contentSteps).toEqual({ value: 2, coverage: "complete" });
    expect(result.trajectory.thinkingStepTokens.total.value).toBe(16);
    expect(result.trajectory.contentStepTokens.total.value).toBe(23);
    expect(result.trajectory.unlinkedOperations).toEqual({ tools: 0, generations: 0 });
    expect(result.tokens.total.value).toBe(102);
    expect(result.costs.modelDebitedUnits.value).toBe(8);

    const collection = input.collection;
    if (!collection || collection.status !== "collected") throw new Error("missing collection");
    const projected = { ...input, collection: { ...collection, snapshot: await compactResourceSnapshot(collection.snapshot) } };
    const nativeProjection = JSON.stringify(projected.collection.snapshot.nativeRecords);
    for (const hidden of ["Build a page", "temperature", "not found", "reason"]) {
      expect(nativeProjection).not.toContain(hidden);
    }
    expect(aggregateResources([projected])).toEqual(result);
  });

  it("deduplicates the replayed native ingestion identity without mistaking Pi usage for a second model bill", () => {
    const input = snapshot();
    const replay = resourceInput({
      scope: { chatId: "chat-1", idempotencyKey: "key-2", submissionId: "submission-1" },
      nativeRecords: fixture.records.slice(0, 7),
    });
    const result = aggregateResources([input, replay]);
    expect(result.duplicateRecords.nativeRecords).toBe(7);
    expect(result.modelRequests.count.value).toBe(2);
    expect(result.costs.modelDebitedUnits.value).toBe(8);
  });
});
