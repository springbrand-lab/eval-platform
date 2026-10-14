import { z } from "zod";
import type { AgentResourceFact, AgentResourceScope, AgentResourceSnapshot } from "@eval-platform/eval-contracts";

const identifier = z.string().refine((value) => value.trim().length > 0, "Identifier must not be blank");
const completeness = z.enum(["complete", "partial", "unavailable"]);
const scopeSchema = z.strictObject({
  chatId: identifier,
  idempotencyKey: identifier,
  submissionId: identifier,
});
const rawFactSchema = z.custom<AgentResourceFact>(isRawFact, "Expected an unmodified JSON object with finite numbers and safe integers");
const snapshotSchema = z.strictObject({
  scope: scopeSchema,
  observedAt: z.iso.datetime({ offset: true }),
  finalized: z.boolean(),
  coverage: z.strictObject({
    usageEvents: completeness,
    telemetryEvents: completeness,
    billingSettlements: completeness,
  }),
  usageEvents: z.array(rawFactSchema),
  telemetryEvents: z.array(rawFactSchema),
  billingSettlements: z.array(rawFactSchema),
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

  return structuredClone(snapshot);
}

function isRawFact(value: unknown): value is AgentResourceFact {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return isJsonValue(value, new Set());
  } catch {
    return false;
  }
}

function isJsonValue(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") {
    return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  }
  if (typeof value !== "object" || ancestors.has(value)) return false;
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) return false;

  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (isArray && keys.length !== value.length + 1) return false;
    for (const key of keys) {
      if (isArray && key === "length") continue;
      if (typeof key !== "string") return false;
      if (isArray && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return false;
      if (!isJsonValue(descriptor.value, ancestors)) return false;
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
}
