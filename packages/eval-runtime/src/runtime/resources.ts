import { z } from "zod";
import {
  identifierSchema,
  jsonObjectInPlaceSchema,
  summarizeResourceSnapshot,
  type AgentResourceFact,
  type AgentResourceReadinessReport,
  type AgentResourceScope,
  type AgentResourceSnapshot,
  type AgentResourceState,
} from "@eval-platform/eval-contracts";

import type { AgentHandle, Harness, HarnessRuntimeOptions } from "../harness/model.js";
import { RuntimeRecordPersistenceError, RuntimeRunStoppedError } from "./errors.js";
import type { RuntimeLog } from "./log.js";
import { describeRetryError, retryIdempotentOperation, type RetryController, type RetryErrorDetails } from "./retry.js";

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
/** Raw records are validated in place; a snapshot can be hundreds of megabytes. */
function factsSchema() {
  return z.custom<readonly AgentResourceFact[]>(
    (value) => Array.isArray(value) && value.every((fact) => jsonObjectInPlaceSchema.safeParse(fact).success),
    "Expected an array of plain JSON objects",
  );
}

const snapshotSchema = z.strictObject({
  scope: scopeSchema,
  observedAt: z.iso.datetime({ offset: true }),
  finalized: z.boolean(),
  coverage: z.strictObject({
    usageEvents: completeness,
    telemetryEvents: completeness,
    billingSettlements: completeness,
  }),
  usageEvents: factsSchema(),
  telemetryEvents: factsSchema(),
  billingSettlements: factsSchema(),
  readiness: readinessSchema,
});

/** Recorded on each Attempt still owing resources when a stopping or stopped Run would otherwise read them. */
export const STOPPED_RESOURCES_ERROR = "Run stopped before resources were collected";

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

export function storedResourceScope(resources: AgentResourceState | undefined): AgentResourceScope | undefined {
  return resources?.status === "collected" ? resources.summary.scope : resources?.scope;
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

/** Returns the validated value itself, never a copy. */
export function validateResourceSnapshot(value: unknown, scope: AgentResourceScope): AgentResourceSnapshot {
  parseScoped(snapshotSchema, value, scope, "Resource snapshot");
  return value as AgentResourceSnapshot;
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

let downloadQueue: Promise<unknown> = Promise.resolve();

/** Runs one snapshot download and its persistence at a time in this process; a snapshot can be hundreds of megabytes. */
function exclusively<T>(task: () => Promise<T>): Promise<T> {
  const run = downloadQueue.then(task);
  downloadQueue = run.catch(() => undefined);
  return run;
}

export interface ResourceDownload {
  readonly source: ResourceSource;
  /** The Attempt's stored resources; a collected snapshot is kept when no newer one is stored. */
  readonly current: AgentResourceState;
  /** Stores the raw snapshot unchanged, before the stage record refers to it. */
  readonly saveSnapshot: (snapshot: AgentResourceSnapshot) => Promise<void>;
  /** Saves the Attempt's resources on its stage record. */
  readonly save: (resources: AgentResourceState) => Promise<void>;
}

/**
 * The single full download of an Attempt's snapshot as SP reports it, finalized or not. Each download
 * is counted on the Attempt before it starts, so one a crash interrupted counts against the same
 * `resources` retry budget. Once the budget is spent the Attempt is given up: `failed`, or its
 * already collected snapshot kept, and Runtime no longer owes it.
 */
export async function collectResources(download: ResourceDownload): Promise<AgentResourceState> {
  const { source } = download;
  const started = Date.now();
  const fields = () => ({ name: "resources_collected", ...scopeFields(source.scope), durationMs: Date.now() - started });
  let state = download.current;
  let failure: RetryErrorDetails = { message: "resource download was interrupted", failureKind: "network", retryable: true };
  for (;;) {
    const downloads = state.downloads ?? 0;
    if (downloads > 0) {
      const decision = failure.retryable
        ? await source.retryController.decide({ operation: "resources", failureKind: failure.failureKind, attemptNumber: downloads, error: failure.message })
        : { shouldRetry: false };
      if (!decision.shouldRetry) {
        const given: AgentResourceState = state.status === "collected"
          ? { ...state, exhausted: true }
          : { status: "failed", scope: source.scope, collectedAt: source.now(), error: failure.message, downloads, exhausted: true };
        await download.save(given);
        source.log({ ...fields(), downloads, error: failure.message });
        return given;
      }
      await source.sleep(decision.backoffMs ?? 0);
    }
    try {
      return await exclusively(async () => {
        state = { ...state, downloads: downloads + 1 };
        await download.save(state);
        const snapshot = validateResourceSnapshot(await source.harness.collectAgentResources(resourceInput(source)), source.scope);
        await download.saveSnapshot(snapshot);
        const collected: AgentResourceState = { status: "collected", summary: summarizeResourceSnapshot(snapshot) };
        await download.save(collected);
        source.log({
          ...fields(), finalized: snapshot.finalized, coverage: snapshot.coverage,
          ...collected.summary.counts, creditsTotal: creditsTotal(snapshot.billingSettlements),
        });
        return collected;
      });
    } catch (error) {
      if (error instanceof RuntimeRunStoppedError || error instanceof RuntimeRecordPersistenceError) throw error;
      failure = describeRetryError(error);
    }
  }
}
