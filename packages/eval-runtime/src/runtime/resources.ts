import { z } from "zod";
import {
  identifierSchema,
  jsonObjectSchema,
  type AgentResourceScope,
  type AgentResourceSnapshot,
} from "@eval-platform/eval-contracts";

const completeness = z.enum(["complete", "partial", "unavailable"]);
const scopeSchema = z.strictObject({
  chatId: identifierSchema,
  idempotencyKey: identifierSchema,
  submissionId: identifierSchema,
});
const snapshotSchema = z.strictObject({
  scope: scopeSchema,
  observedAt: z.iso.datetime({ offset: true }),
  finalized: z.boolean(),
  coverage: z.strictObject({
    usageEvents: completeness,
    telemetryEvents: completeness,
    billingSettlements: completeness,
  }),
  usageEvents: z.array(jsonObjectSchema),
  telemetryEvents: z.array(jsonObjectSchema),
  billingSettlements: z.array(jsonObjectSchema),
});

export class AgentResourceValidationError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "AgentResourceValidationError";
  }
}

export function validateResourceSnapshot(
  value: unknown,
  scope: AgentResourceScope,
): AgentResourceSnapshot {
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new AgentResourceValidationError(`Invalid resource snapshot: ${parsed.error.message}`);
  }
  const snapshot: AgentResourceSnapshot = parsed.data;
  if (
    snapshot.scope.chatId !== scope.chatId
    || snapshot.scope.idempotencyKey !== scope.idempotencyKey
    || (scope.submissionId !== undefined && snapshot.scope.submissionId !== scope.submissionId)
  ) {
    throw new AgentResourceValidationError("Resource snapshot does not match the requested operation scope");
  }
  return snapshot;
}
