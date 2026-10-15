import type { JsonValue, TrajectoryEvent, TrajectoryEventType } from "@eval-platform/eval-contracts";
import { z } from "zod";

/** The SP Universal telemetry envelope, as far as normalization needs it; everything else stays in `raw`. */
const universalEventSchema = z.looseObject({
  type: z.string().min(1),
  eventId: z.string().min(1),
  operationId: z.string().min(1),
  submissionId: z.string().min(1).optional(),
  toolCallId: z.string().min(1).optional(),
  occurredAt: z.number().finite(),
  payload: z.record(z.string(), z.unknown()),
});

export const storedTrajectoryEventSchema = z.object({
  ingestSeq: z.number().int().positive(),
  event: universalEventSchema,
});

export type StoredTrajectoryEvent = z.output<typeof storedTrajectoryEventSchema>;

/** Payload fields copied into `content` for each normalized type; the full payload remains in `raw`. */
const MAPPING: Readonly<Record<string, { readonly type: TrajectoryEventType; readonly fields: readonly string[] }>> = {
  "turn.admitted": { type: "user-message", fields: ["prompt", "input", "content"] },
  "turn.steered": { type: "user-message", fields: ["prompt", "input", "content", "steerId"] },
  "generation.finished": {
    type: "assistant-message",
    fields: ["output", "response", "content", "provider", "model", "inputTokens", "outputTokens", "totalTokens", "cost", "error"],
  },
  "tool.started": { type: "tool-call", fields: ["toolName", "input", "executionId"] },
  "tool.finished": { type: "tool-result", fields: ["toolName", "output", "outcome", "error", "executionId", "durationMs"] },
  "approval.requested": { type: "approval", fields: ["toolName", "input", "prompt"] },
  "approval.decided": { type: "approval", fields: ["decision", "reason"] },
  "interaction.requested": { type: "question", fields: ["interactionId", "prompt", "input"] },
  "interaction.responded": { type: "question", fields: ["interactionId", "response", "output"] },
  "interaction.cancelled": { type: "question", fields: ["interactionId", "reason"] },
};

/** Maps one stored SP event; unmapped types and failed turns keep their original event in `raw`. */
export function normalizeSpTrajectoryEvent({ ingestSeq, event }: StoredTrajectoryEvent): TrajectoryEvent {
  const failedTurn = event.type === "turn.finished" && (event.payload.outcome === "failed" || event.payload.error !== undefined);
  const mapping = failedTurn ? { type: "error" as const, fields: ["error", "reason", "outcome"] } : MAPPING[event.type];
  const content: Record<string, JsonValue> = { event: event.type };
  if (event.toolCallId !== undefined) content.toolCallId = event.toolCallId;
  for (const field of mapping?.fields ?? []) {
    const value = json(event.payload[field]);
    if (value !== undefined) content[field] = value;
  }
  return {
    seq: ingestSeq,
    at: new Date(event.occurredAt).toISOString(),
    type: mapping?.type ?? "other",
    ...(event.submissionId === undefined ? {} : { submissionId: event.submissionId }),
    operationId: event.operationId,
    content,
    raw: json(event) ?? null,
  };
}

/** Telemetry payloads are JSON on the wire; this drops anything JSON cannot carry. */
function json(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  return text === undefined ? undefined : JSON.parse(text) as JsonValue;
}
