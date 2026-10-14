import type { EvaluationRecord, RunPhase, RunPhases, RunSnapshot, SamplingStatus } from "@eval-platform/eval-contracts";
import type { SamplingSnapshot } from "./model.js";
import type { RuntimeRunRecord, SamplingState } from "./store.js";

export function isPendingStatus(status: SamplingStatus): boolean {
  return status === "queued"
    || status === "starting"
    || status === "running"
    || status === "retrying";
}

export function currentRunPhase(records: readonly SamplingState[], phases: RunPhases): RunPhase {
  const firstPhase = phases[0];
  if (firstPhase === "execution" && phases.length === 2) {
    if (records.some((state) => isPendingStatus(state.execution.status))) return "execution";
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
  const pending = statuses.filter(isPendingStatus);
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
  return {
    runId: run.runId,
    samplingIds: [...run.samplingIds],
    projectId: run.projectId,
    phases: run.phases,
    evaluationIds: [...run.evaluationIds],
    ...aggregateRunProgress(records, evaluations, run.phases),
  };
}

export function toSamplingSnapshot(state: SamplingState): SamplingSnapshot {
  return {
    samplingId: state.samplingId,
    projectId: state.projectId,
    sampleId: state.sampleId,
    execution: { ...state.execution },
    subjectAgent: { ...state.subjectAgent },
    ...(state.subjectChatId === undefined
      ? {}
      : { subjectChatId: state.subjectChatId }),
    executionAttempts: structuredClone(state.executionAttempts),
    ...(state.artifacts === undefined
      ? {}
      : { artifacts: state.artifacts.map((artifact) => ({ ...artifact })) }),
    ...(state.trajectory === undefined
      ? {}
      : { trajectory: { ...state.trajectory } }),
  };
}
