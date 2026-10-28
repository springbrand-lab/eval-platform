/**
 * Regenerate fixtures/pi-native-public-v1.json from the PUBLISHED PUBLIC UA trajectory
 * export, not from SP private implementation or handcrafted event-shaped history.
 *
 * With @springbrand/agent-runtime installed locally:
 *   node scripts/generate-pi-native-fixture.mjs
 *
 * For offline verification against an already installed public package, set
 * EVAL_UA_PUBLIC_TRAJECTORY_MODULE to its exported dist/trajectory/index.js URL.
 * Optionally set EVAL_SP_PUBLIC_EVAL_HARNESS_MODULE to the public Eval Harness
 * index.ts from the SP release worktree and run with `node --import tsx` to
 * validate the same records against its pending public page/snapshot schemas.
 * This script prints JSON to stdout; it never writes to another worktree.
 */
const t = await import(process.env.EVAL_UA_PUBLIC_TRAJECTORY_MODULE ?? "@springbrand/agent-runtime/trajectory");

const resource = { agentId: "agent-1", sessionId: "chat-1" };
const metadata = { resource, submissionId: "submission-1" };
const eventResource = { serviceName: "test", agentName: "Agent", ...resource };
const policy = {
  id: "eval-native-fixture", version: 1, secrets: "redact",
  actionTools: { names: [], prefixes: [] }, allowedDetailsPaths: [],
};
const usage = (input, output) => ({
  input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const turn = t.telemetryOperations.turn(resource.sessionId, metadata.submissionId);
const gen1 = t.telemetryOperations.generation(metadata.submissionId, "model-1");
const gen2 = t.telemetryOperations.generation(metadata.submissionId, "model-2");
const tool = t.telemetryOperations.tool(metadata.submissionId, "call-1");

const entry = (id, value, facts = metadata) => t.createTrajectoryRecord(facts, {
  type: "entry", value: { id, conversationId: 1, ...value },
});
const bookkeeping = (id, data) => entry(id, t.createTrajectoryEntry(data));
const event = (id, type, operationId, payload, occurredAt, extra = {}, refs) => bookkeeping(id,
  t.createTrajectoryEventFact({
    schemaVersion: 1, type, eventId: `fact-${id}`, operationId,
    submissionId: metadata.submissionId, occurredAt, resource: eventResource, payload, ...extra,
  }, refs));
const assistant = (timestamp, stopReason, content, tokens) => ({
  role: "assistant", api: "test", provider: "test", model: "model-1",
  content, timestamp, stopReason, usage: tokens,
});
const raw = [
  t.createTrajectoryRecord(metadata, { type: "conversation", value: { id: 1 } }),
  entry(2, { kind: "pi.user", model: [{ role: "user", content: "Build a page", timestamp: 90 }] }),
  event(3, "turn.started", turn, {}, 100),
  bookkeeping(4, {
    type: "request", taskId: 5, purpose: "generation", method: "streamSimple",
    model: { provider: "test", modelId: "model-1", api: "test" },
    options: { temperature: 0.2 }, dispatchedAt: 105,
  }),
  event(5, "generation.started", gen1, { generationId: "model-1" }, 110, { parentOperationId: turn }),
  entry(6, { kind: "pi.assistant", byTaskId: 5,
    model: [assistant(255, "toolUse", [
      { type: "thinking", thinking: "reason", thinkingSignature: "safe-marker" },
      { type: "text", text: "Searching" },
      { type: "toolCall", id: "call-1", name: "search", arguments: { query: "é" } },
    ], usage(11, 5))] }),
  event(7, "generation.finished", gen1,
    { generationId: "model-1", outcome: "completed", durationMs: 145,
      inputTokens: 11, outputTokens: 5, totalTokens: 16 }, 255,
    { parentOperationId: turn }, { assistantTimestamp: 255 }),
  event(8, "tool.started", tool, { toolName: "search" }, 280,
    { parentOperationId: turn, toolCallId: "call-1" }),
  bookkeeping(9, {
    type: "hook", extension: "example", taskId: 5, hook: "beforeTool",
    toolCallId: "call-1", toolName: "search", startedAt: 280, endedAt: 285,
    result: { type: "decision", value: "allow" },
  }),
  entry(10, { kind: "pi.toolResult", model: [{
    role: "toolResult", toolCallId: "call-1", toolName: "search",
    content: [{ type: "text", text: "not found" }],
    isError: true, timestamp: 320, durationMs: 40,
  }] }),
  event(11, "tool.finished", tool,
    { toolName: "search", outcome: "failed", durationMs: 40 }, 320,
    { parentOperationId: turn, toolCallId: "call-1" }),
  bookkeeping(12, {
    type: "request", taskId: 13, purpose: "generation", method: "streamSimple",
    model: { provider: "test", modelId: "model-1", api: "test" },
    options: {}, dispatchedAt: 340,
  }),
  event(13, "generation.started", gen2, { generationId: "model-2" }, 350, { parentOperationId: turn }),
  entry(14, { kind: "pi.assistant", byTaskId: 13,
    model: [assistant(425, "stop", [{ type: "text", text: "{\"score\":1}" }], usage(4, 3))] }),
  event(15, "generation.finished", gen2,
    { generationId: "model-2", outcome: "completed", durationMs: 75,
      inputTokens: 4, outputTokens: 3, totalTokens: 7 }, 425,
    { parentOperationId: turn }, { assistantTimestamp: 425 }),
  event(16, "turn.finished", turn, { outcome: "completed", durationMs: 400 }, 500, {}, { entryId: 14 }),
];

const safe = await t.projectTrajectoryForExport(raw, policy);
const records = safe.map((record, index) => ({ ingestSeq: index + 1, record }));
for (const { record } of records) {
  if (!t.trajectoryRecordSchema.safeParse(record).success) throw new Error("Generated record failed UA public schema");
  if (record.record.type === "entry") {
    const parsed = t.readTrajectoryBookkeeping(record.record.value);
    if ((record.record.value.kind === t.PI_TRAJECTORY_ENTRY_KIND) !== (parsed !== undefined)) {
      throw new Error("Public bookkeeping parser disagrees with native Entry kind");
    }
  }
}
if (process.env.EVAL_SP_PUBLIC_EVAL_HARNESS_MODULE) {
  const sp = await import(process.env.EVAL_SP_PUBLIC_EVAL_HARNESS_MODULE);
  const page = {
    format: "sp-pi-trajectory/v1", cursor: { throughSeq: records.length }, records, nextAfterSeq: null,
  };
  const snapshot = {
    scope: { chatId: resource.sessionId, idempotencyKey: "fixture", submissionId: metadata.submissionId },
    observedAt: "2026-10-28T00:00:00Z", finalized: true,
    readiness: { receiptTerminal: true, stateUnreadable: false, pendingTelemetryEvents: 0, pendingRuntimeEvents: 0,
      actionCharges: { complete: true, unsettledExecutions: 0, missingExecutionIds: 0 } },
    coverage: { usageEvents: "complete", nativeRecords: "complete", billingSettlements: "complete" },
    usageEvents: [], nativeRecords: records, billingSettlements: [],
  };
  sp.evalEvidenceTrajectoryPageSchema.parse(page);
  sp.evalResourceSnapshotSchema.parse(snapshot);
}
process.stdout.write(`${JSON.stringify({
  generator: "@springbrand/agent-runtime/trajectory@0.3.1-alpha.9",
  resource, submissionId: metadata.submissionId, records,
}, null, process.argv.includes("--compact") ? 0 : 2)}\n`);
