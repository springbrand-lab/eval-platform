import type { RecollectTarget, RunRequest } from "@eval-platform/eval-contracts";
import { api, enc } from "./client";
import type {
  EvaluationRecord, RunEvaluation, RunHandle, RunOperation, RunPreview, RunSnapshot, RunTargetSelector,
  Sampling, ScoreSyncSummary,
} from "./types";

export const runKeys = {
  detail: (projectId: string, runId: string) => ["runs", "detail", projectId, runId] as const,
  evaluations: (projectId: string, runId: string) => ["evaluations", projectId, "run", runId] as const,
  samplingEvaluations: (projectId: string, samplingId: string) => ["evaluations", projectId, "sampling", samplingId] as const,
};

const base = (projectId: string) => `/api/projects/${enc(projectId)}/runs`;

export const previewRun = (projectId: string, input: { operation: RunOperation; selector: RunTargetSelector }) =>
  api.post<RunPreview>(`${base(projectId)}/preview`, input);
export const submitRun = (projectId: string, input: Omit<RunRequest, "projectId">) =>
  api.post<RunHandle>(base(projectId), input);
export const getProjectRun = (projectId: string, runId: string, signal?: AbortSignal) =>
  api.get<{ run: RunSnapshot }>(`${base(projectId)}/${enc(runId)}`, { signal });
export const listRunEvaluations = (projectId: string, runId: string, signal?: AbortSignal) =>
  api.get<{ evaluations: RunEvaluation[] }>(`${base(projectId)}/${enc(runId)}/evaluations`, { signal });
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

export const recollectResult = (projectId: string, kind: "samplings" | "evaluations", id: string, target: RecollectTarget) =>
  api.post<{ runId: string; queued: boolean }>(`/api/projects/${enc(projectId)}/${kind}/${enc(id)}/collect`, { target });
