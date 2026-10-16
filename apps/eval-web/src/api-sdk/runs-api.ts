import { api, enc } from "./client";
import type {
  CurrentRun, EvaluationRecord, RunHandle, RunOperation, RunPreview, RunSnapshot, RunTargetSelector, RunTargets,
  Sampling, ScoreSyncSummary,
} from "./types";

export const runKeys = {
  current: (projectId: string) => ["runs", "current", projectId] as const,
  detail: (projectId: string, runId: string) => ["runs", "detail", projectId, runId] as const,
  evaluations: (projectId: string, runId: string) => ["runs", "evaluations", projectId, runId] as const,
  sampling: (samplingId: string) => ["samplings", samplingId] as const,
  samplingEvaluations: (samplingId: string) => ["samplings", samplingId, "evaluations"] as const,
};

const base = (projectId: string) => `/api/projects/${enc(projectId)}/runs`;

export const previewRun = (projectId: string, input: { operation: RunOperation; selector: RunTargetSelector }) =>
  api.post<RunPreview>(`${base(projectId)}/preview`, input);
export const submitRun = (projectId: string, input: {
  idempotencyKey: string; operation: RunOperation; selector: RunTargetSelector; targets: RunTargets;
}) => api.post<RunHandle>(base(projectId), input);
export const getCurrentRun = (projectId: string, signal?: AbortSignal) =>
  api.get<{ run: CurrentRun | null }>(`${base(projectId)}/current`, { signal });
export const getProjectRun = (projectId: string, runId: string, signal?: AbortSignal) =>
  api.get<{ run: RunSnapshot }>(`${base(projectId)}/${enc(runId)}`, { signal });
export const listRunEvaluations = (projectId: string, runId: string, signal?: AbortSignal) =>
  api.get<{ evaluations: EvaluationRecord[] }>(`${base(projectId)}/${enc(runId)}/evaluations`, { signal });
export const stopRun = (projectId: string, runId: string) =>
  api.post<{ runId: string; stopRequested: true }>(`${base(projectId)}/${enc(runId)}/stop`);
export const syncRunScores = (projectId: string, runId: string) =>
  api.post<ScoreSyncSummary>(`${base(projectId)}/${enc(runId)}/score-sync`);
export const getSampling = (samplingId: string, signal?: AbortSignal) =>
  api.get<Sampling>(`/api/samplings/${enc(samplingId)}`, { signal });
export const listSamplingEvaluations = (samplingId: string, signal?: AbortSignal) =>
  api.get<EvaluationRecord[]>(`/api/samplings/${enc(samplingId)}/evaluations`, { signal });
export const getEvaluation = (evaluationId: string, signal?: AbortSignal) =>
  api.get<EvaluationRecord>(`/api/evaluations/${enc(evaluationId)}`, { signal });
