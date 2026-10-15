import type { EvaluationRecord, RunPhase, RunPhases, RunSnapshot, SamplingStatus } from "@eval-platform/eval-contracts";
import { isPendingSamplingStatus } from "@eval-platform/eval-contracts";
import type { SamplingSnapshot } from "./model.js";
import type { RuntimeRunRecord, SamplingState } from "./store.js";

export function currentRunPhase(records: readonly SamplingState[], phases: RunPhases): RunPhase {
  const firstPhase = phases[0];
  if (firstPhase === "execution" && phases.length === 2) {
    if (records.some((state) => isPendingSamplingStatus(state.execution.status))) return "execution";
    if (records.some((state) => state.execution.status === "succeeded")) return "evaluation";
  }
  return firstPhase;
}

function aggregateRunProgress(
  records: readonly SamplingState[],
  evaluations: readonly EvaluationRecord[],
  phases: RunPhases,
): Pick<RunSnapshot, "phase" | "status"> {
  const phase = currentRunPhase(records, phases);
  const evaluationBySamplingId = new Map(evaluations.map((evaluation) => [evaluation.samplingId, evaluation]));
  const phaseRecords = phase === "evaluation"
    ? records.filter((state) => state.execution.status === "succeeded")
    : records;
  const statuses = phaseRecords.map((state) => (
    phase === "execution"
      ? state.execution.status
      : evaluationBySamplingId.get(state.samplingId)?.status.status ?? "queued"
  ));
  const pending = statuses.filter(isPendingSamplingStatus);
  const hasExecutionFailure = phases.length === 2
    && records.some((state) => (
      state.execution.status === "failed" || state.execution.status === "cancelled"
    ));

  let status: SamplingStatus;
  if (records.length === 0 || phaseRecords.length === 0) {
    status = "failed";
  } else if (pending.some((item) => item === "retrying")) {
    status = "retrying";
  } else if (pending.some((item) => item === "starting" || item === "running")) {
    status = "running";
  } else if (pending.length > 0) {
    status = phase === "evaluation" && phases.length === 2 ? "running" : "queued";
  } else if (hasExecutionFailure || statuses.some((item) => item === "failed" || item === "cancelled")) {
    status = "failed";
  } else {
    status = "succeeded";
  }
  return { phase, status };
}

export function toRunSnapshot(
  run: RuntimeRunRecord,
  records: readonly SamplingState[],
  evaluations: readonly EvaluationRecord[],
): RunSnapshot {
  const progress = aggregateRunProgress(records, evaluations, run.phases);
  const stopFinalizing = run.stopRequested === true && run.stopFinalized !== true
    && !isPendingSamplingStatus(progress.status);
  const stopped = run.stopRequested === true && run.stopFinalized === true
    && !isPendingSamplingStatus(progress.status);
  return {
    runId: run.runId,
    samplingIds: [...run.samplingIds],
    projectId: run.projectId,
    sourceCommit: run.sourceCommit,
    phases: run.phases,
    evaluationIds: [...run.evaluationIds],
    ...progress,
    ...(run.stopRequested === true ? { stopRequested: true as const } : {}),
    ...(run.stopFinalized === true ? { stopFinalized: true as const } : {}),
    ...(stopFinalizing ? { status: "retrying" as const } : {}),
    ...(stopped ? { status: "cancelled" as const } : {}),
  };
}

export function toSamplingSnapshot(state: SamplingState): SamplingSnapshot {
  return structuredClone(state);
}
