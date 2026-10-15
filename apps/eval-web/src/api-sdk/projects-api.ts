import { api, enc } from "./client";
import type { AgentObservationRef, EvaluationPlanInput, Project, ProjectCreateInput, ProjectView, RunHandle } from "./types";

export const projectKeys = {
  all: ["projects"] as const,
  list: () => ["projects", "list"] as const,
  detail: (projectId: string) => ["projects", "detail", projectId] as const,
};

export const listProjects = (signal?: AbortSignal) => api.get<Project[]>("/api/projects", { signal });
export const getProject = (projectId: string, signal?: AbortSignal) =>
  api.get<ProjectView>(`/api/projects/${enc(projectId)}`, { signal });
export const createProject = (input: ProjectCreateInput) =>
  api.post<{ project: Project; run: RunHandle | null }>("/api/projects", input);
export const deleteProject = (projectId: string) => api.delete(`/api/projects/${enc(projectId)}`);
export const replaceEvaluationPlan = (projectId: string, plan: EvaluationPlanInput) =>
  api.put<ProjectView>(`/api/projects/${enc(projectId)}/evaluation-plan`, plan);
export const observeSampling = (projectId: string, samplingId: string, signal?: AbortSignal) =>
  api.get<AgentObservationRef>(`/api/projects/${enc(projectId)}/samplings/${enc(samplingId)}/observation`, { signal });
export const observeEvaluation = (projectId: string, evaluationId: string, signal?: AbortSignal) =>
  api.get<AgentObservationRef>(`/api/projects/${enc(projectId)}/evaluations/${enc(evaluationId)}/observation`, { signal });
