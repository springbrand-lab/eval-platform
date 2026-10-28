import { z } from "zod";
import {
  identifierSchema,
  nativeTrajectoryEntrySchema,
  jsonObjectArrayInPlaceSchema,
  summarizeResourceSnapshot,
  type AgentResourceFact,
  type AgentResourceReadinessReport,
  type AgentResourceScope,
  type AgentResourceSnapshot,
  type AgentResourceState,
} from "@eval-platform/eval-contracts";

import type { AgentHandle, Harness, HarnessRuntimeOptions } from "../harness/model.js";
import { RuntimeRecordPersistenceError, RuntimeRunStoppedError } from "./errors.js";
import { reportError, type RuntimeLog } from "./log.js";
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
const snapshotSchema = z.strictObject({
  scope: scopeSchema,
  observedAt: z.iso.datetime({ offset: true }),
  finalized: z.boolean(),
  coverage: z.strictObject({
    usageEvents: completeness,
    nativeRecords: completeness,
    billingSettlements: completeness,
  }),
  usageEvents: jsonObjectArrayInPlaceSchema,
  nativeRecords: z.array(nativeTrajectoryEntrySchema),
  billingSettlements: jsonObjectArrayInPlaceSchema,
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
  readonly onError: (error: Error) => void;
  readonly stop?: { readonly runId: string; readonly signal: AbortSignal };
}

function checkResourceStop(source: ResourceSource): void {
  if (source.stop?.signal.aborted) throw new RuntimeRunStoppedError(source.stop.runId);
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
    run: async () => {
      checkResourceStop(source);
      try {
        return await read();
      } finally {
        checkResourceStop(source);
      }
    },
    shouldAbort: (error) => error instanceof RuntimeRunStoppedError,
  });
}

function resourceInput({ handle, scope, runtime, stop }: ResourceSource) {
  return {
    handle,
    idempotencyKey: scope.idempotencyKey,
    ...(scope.submissionId === undefined ? {} : { submissionId: scope.submissionId }),
    ...(runtime === undefined ? {} : { runtime }),
    ...(stop === undefined ? {} : { signal: stop.signal }),
  };
}

/**
 * Checks readiness after each delay, never downloading events. Undefined once SP finalized the
 * snapshot; otherwise why it is still owed. A read failure ends the wait.
 */
async function awaitResourceFinalization(
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
    checkResourceStop(source);
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

/** Cancels queued tasks, but waits for running tasks to settle before releasing their slot. */
export type ExclusiveRunner = <T>(task: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

export function createExclusiveRunner(): ExclusiveRunner {
  let queue: Promise<unknown> = Promise.resolve();
  return (task, signal) => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    let started = false;
    const run = queue.then(() => {
      started = true;
      signal?.throwIfAborted();
      return task();
    });
    queue = run.catch(() => undefined);
    if (!signal) return run;
    return new Promise((resolve, reject) => {
      const onAbort = () => { if (!started) reject(signal.reason); };
      const clear = () => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
      run.then(
        (value) => { clear(); resolve(value); },
        (error: unknown) => { clear(); reject(error); },
      );
      if (signal.aborted) onAbort();
    });
  };
}

/** Records resources as failed with `error`, keeping their download count. */
export function failedResources(
  resources: AgentResourceState, scope: AgentResourceScope, collectedAt: string, error: string,
): Extract<AgentResourceState, { readonly status: "failed" }> {
  const { downloads } = resources;
  return { status: "failed", scope, collectedAt, error, ...(downloads === undefined ? {} : { downloads }) };
}

export interface ResourceDownload {
  readonly source: ResourceSource;
  /** The Attempt's stored resources; a collected snapshot is kept when no newer one is stored. */
  readonly current: AgentResourceState;
  /** One snapshot download and its save at a time in this process; a snapshot can be hundreds of megabytes. */
  readonly exclusively: ExclusiveRunner;
  readonly readinessDelays: readonly number[];
  readonly allowUnfinalized: boolean;
  /** Persists confirmed Agent terminal facts after budget admission, before resource reads. */
  readonly prepare?: () => Promise<void>;
  /** Saves the Attempt's resources on its stage record, with the raw snapshot they summarize in the same write. */
  readonly save: (resources: AgentResourceState, snapshot?: AgentResourceSnapshot) => Promise<void>;
}

const INTERRUPTED: RetryErrorDetails = { message: "resource download was interrupted", failureKind: "network", retryable: true };

/**
 * The resource flow for both entry paths: budget before terminal preparation and readiness, then one
 * download and atomic save at a time. A crash-safe count is committed only after acquiring the slot.
 * Giving up preserves any stored snapshot and reports once, after saving `exhausted`.
 */
export async function collectResources(download: ResourceDownload): Promise<{ readonly pending?: string }> {
  const { source } = download;
  const started = Date.now();
  const fields = () => ({ name: "resources_collected", ...scopeFields(source.scope), durationMs: Date.now() - started });
  let state = download.current;
  if (state.exhausted) return {};
  let failure: RetryErrorDetails | undefined;
  let checkedReadiness = false;
  let owed: string | undefined;
  for (;;) {
    checkResourceStop(source);
    const downloads = state.downloads ?? 0;
    const last = failure ?? INTERRUPTED;
    const decision = downloads > 0
      ? last.retryable
        ? await source.retryController.decide({ operation: "resources", failureKind: last.failureKind, attemptNumber: downloads, error: last.message })
        : { shouldRetry: false }
      : { shouldRetry: true };
    checkResourceStop(source);
    if (!decision.shouldRetry) {
      const given: AgentResourceState = state.status === "collected"
        ? { ...state, exhausted: true }
        : { ...failedResources(state, source.scope, source.now(), last.message), exhausted: true };
      await download.save(given);
      source.log({ ...fields(), downloads, error: last.message });
      reportError(source.onError, new Error(
        `Resources for Chat ${source.scope.chatId}, operation ${source.scope.idempotencyKey} were given up after ${downloads} downloads: ${last.message}`,
      ));
      return {};
    }
    if (!checkedReadiness) {
      await download.prepare?.();
      checkResourceStop(source);
      if (state.status === "collected" && state.summary.finalized) return {};
      owed = await awaitResourceFinalization(source, download.readinessDelays);
      if (owed !== undefined && !download.allowUnfinalized) return { pending: owed };
      checkedReadiness = true;
    }
    if (downloads > 0) await source.sleep(decision.backoffMs ?? 0);
    try {
      const collected = await download.exclusively(async () => {
        checkResourceStop(source);
        state = { ...state, downloads: downloads + 1, ...(state.status === "failed" && failure ? { error: failure.message } : {}) };
        await download.save(state);
        checkResourceStop(source);
        const snapshot = validateResourceSnapshot(await source.harness.collectAgentResources(resourceInput(source)), source.scope);
        checkResourceStop(source);
        const collected: AgentResourceState = { status: "collected", summary: summarizeResourceSnapshot(snapshot) };
        await download.save(collected, snapshot);
        source.log({
          ...fields(), finalized: snapshot.finalized, coverage: snapshot.coverage,
          ...collected.summary.counts, creditsTotal: creditsTotal(snapshot.billingSettlements),
        });
        return collected;
      }, source.stop?.signal);
      return collected.summary.finalized ? {} : { pending: owed ?? "resource snapshot is not finalized" };
    } catch (error) {
      if (error instanceof RuntimeRunStoppedError || error instanceof RuntimeRecordPersistenceError) throw error;
      checkResourceStop(source);
      failure = describeRetryError(error);
    }
  }
}
