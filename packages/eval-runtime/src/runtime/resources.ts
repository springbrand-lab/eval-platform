import { z } from "zod";
import {
  identifierSchema,
  jsonObjectSchema,
  type AgentResourceCollection,
  type AgentResourceFact,
  type AgentResourceReadinessReport,
  type AgentResourceScope,
  type AgentResourceSnapshot,
} from "@eval-platform/eval-contracts";

import type { AgentHandle, Harness, HarnessRuntimeOptions } from "../harness/model.js";
import { RuntimeRunStoppedError } from "./errors.js";
import type { RuntimeLog } from "./log.js";
import { describeRetryError, retryIdempotentOperation, type RetryController } from "./retry.js";

const completeness = z.enum(["complete", "partial", "unavailable"]);
const scopeSchema = z.strictObject({
  chatId: identifierSchema,
  idempotencyKey: identifierSchema,
  submissionId: identifierSchema,
});
const readinessSchema = z.strictObject({
  receiptTerminal: z.boolean(),
  stateUnreadable: z.boolean(),
  pendingTelemetryEvents: z.number().int().nonnegative(),
  pendingRuntimeEvents: z.number().int().nonnegative(),
  actionCharges: z.strictObject({
    complete: z.boolean(),
    unsettledExecutions: z.number().int().nonnegative(),
    missingExecutionIds: z.number().int().nonnegative(),
  }),
});
const reportSchema = z.strictObject({
  scope: scopeSchema,
  observedAt: z.iso.datetime({ offset: true }),
  finalized: z.boolean(),
  readiness: readinessSchema,
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
  readiness: readinessSchema,
});

/** Readiness checks right after the Agent ends; together about 75 seconds. */
export const RESOURCE_READINESS_DELAYS_MS = [0, 5_000, 10_000, 20_000, 40_000] as const;

export class AgentResourceValidationError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "AgentResourceValidationError";
  }
}

/** Same Chat and key; a Submission ID constrains the match only once both sides know it. */
export function resourceScopeMatches(stored: AgentResourceScope, requested: AgentResourceScope): boolean {
  return stored.chatId === requested.chatId
    && stored.idempotencyKey === requested.idempotencyKey
    && (stored.submissionId === undefined || requested.submissionId === undefined || stored.submissionId === requested.submissionId);
}

export function storedResourceScope(collection: AgentResourceCollection | undefined): AgentResourceScope | undefined {
  return collection?.status === "collected" ? collection.snapshot.scope : collection?.scope;
}

function parseScoped<T extends { readonly scope: AgentResourceScope }>(
  schema: z.ZodType<T>,
  value: unknown,
  scope: AgentResourceScope,
  label: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AgentResourceValidationError(`${label} is invalid: ${parsed.error.message}`);
  if (!resourceScopeMatches(parsed.data.scope, scope)) {
    throw new AgentResourceValidationError(`${label} does not match the requested operation scope`);
  }
  return parsed.data;
}

export function validateResourceSnapshot(value: unknown, scope: AgentResourceScope): AgentResourceSnapshot {
  return parseScoped(snapshotSchema, value, scope, "Resource snapshot");
}

export function validateResourceReadiness(value: unknown, scope: AgentResourceScope): AgentResourceReadinessReport {
  return parseScoped(reportSchema, value, scope, "Resource readiness");
}

/** One Attempt's resources under the exact scope it was submitted with. */
export interface ResourceSource {
  readonly harness: Pick<Harness, "inspectAgentResources" | "collectAgentResources">;
  readonly handle: AgentHandle;
  readonly scope: AgentResourceScope;
  readonly runtime?: HarnessRuntimeOptions;
  readonly retryController: RetryController;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly now: () => string;
  readonly log: RuntimeLog;
}

function scopeFields({ chatId, idempotencyKey, submissionId }: AgentResourceScope) {
  return { chatId, idempotencyKey, ...(submissionId === undefined ? {} : { submissionId }) };
}

/** Diagnostic only, never stored: model `debitedUnits` plus Action `chargedCredits` as SP reported them. */
function creditsTotal(settlements: readonly AgentResourceFact[]): number {
  let total = 0;
  for (const fact of settlements) {
    const value = typeof fact.executionId === "string" && fact.executionId !== "" ? fact.chargedCredits : fact.debitedUnits;
    if (typeof value === "number" && Number.isFinite(value)) total += value;
  }
  return total;
}

function readResources<T>(source: ResourceSource, read: () => Promise<T>): Promise<T> {
  return retryIdempotentOperation({
    operation: "resources",
    retryController: source.retryController,
    sleep: source.sleep,
    run: read,
    shouldAbort: (error) => error instanceof RuntimeRunStoppedError,
  });
}

function resourceInput({ handle, scope, runtime }: ResourceSource) {
  return {
    handle,
    idempotencyKey: scope.idempotencyKey,
    ...(scope.submissionId === undefined ? {} : { submissionId: scope.submissionId }),
    ...(runtime === undefined ? {} : { runtime }),
  };
}

/**
 * Checks readiness after each delay, never downloading events. Undefined once SP finalized the
 * snapshot; otherwise why it is still owed. A read failure ends the wait.
 */
export async function awaitResourceFinalization(
  source: ResourceSource,
  delays: readonly number[],
): Promise<string | undefined> {
  const started = Date.now();
  let checks = 0;
  const done = (outcome: { readonly finalized: true } | { readonly reason: string } | { readonly error: string }) => {
    source.log({ name: "resource_wait", ...scopeFields(source.scope), checks, finalized: "finalized" in outcome, ...outcome,
      durationMs: Date.now() - started });
    return "finalized" in outcome ? undefined : "reason" in outcome ? outcome.reason : outcome.error;
  };
  let reason = "resource snapshot was not checked";
  for (const delay of delays) {
    if (delay > 0) await source.sleep(delay);
    checks += 1;
    try {
      const report = await readResources(source, async () => (
        validateResourceReadiness(await source.harness.inspectAgentResources(resourceInput(source)), source.scope)
      ));
      if (report.finalized) return done({ finalized: true });
      reason = `resource snapshot is not finalized: ${JSON.stringify(report.readiness)}`;
    } catch (error) {
      if (error instanceof RuntimeRunStoppedError) throw error;
      return done({ error: describeRetryError(error).message });
    }
  }
  return done({ reason });
}

/** The single full download: the snapshot as SP reports it, finalized or not, or why it failed. */
export async function downloadResources(
  source: ResourceSource,
): Promise<Exclude<AgentResourceCollection, { readonly status: "pending" }>> {
  const started = Date.now();
  const fields = () => ({ name: "resources_collected", ...scopeFields(source.scope), durationMs: Date.now() - started });
  try {
    const snapshot = await readResources(source, async () => (
      validateResourceSnapshot(await source.harness.collectAgentResources(resourceInput(source)), source.scope)
    ));
    source.log({
      ...fields(), finalized: snapshot.finalized, coverage: snapshot.coverage,
      usageEvents: snapshot.usageEvents.length, telemetryEvents: snapshot.telemetryEvents.length,
      billingSettlements: snapshot.billingSettlements.length, creditsTotal: creditsTotal(snapshot.billingSettlements),
    });
    return { status: "collected", snapshot };
  } catch (error) {
    if (error instanceof RuntimeRunStoppedError) throw error;
    const message = describeRetryError(error).message;
    source.log({ ...fields(), error: message });
    return { status: "failed", scope: source.scope, collectedAt: source.now(), error: message };
  }
}
