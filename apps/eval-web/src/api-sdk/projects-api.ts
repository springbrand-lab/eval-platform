import { isWriteOutcomeUnknown } from "@/lib/errors";
import { api, ApiError, enc } from "./client";
import type { AgentObservationRef, EvaluationPlanInput, Project, ProjectCreateInput, ProjectView, RunHandle } from "./types";
import type { EvaluationOutputSchemaDocument } from "@eval-platform/eval-contracts";

export const projectKeys = {
  all: ["projects"] as const,
  list: () => ["projects", "list"] as const,
  detail: (projectId: string) => ["projects", "detail", projectId] as const,
  outputSchema: (projectId: string, evaluationDigest: string | null) => ["projects", "output-schema", projectId, evaluationDigest] as const,
};

export const listProjects = (signal?: AbortSignal) => api.get<Project[]>("/api/projects", { signal });
export const getProject = (projectId: string, signal?: AbortSignal) =>
  api.get<ProjectView>(`/api/projects/${enc(projectId)}`, { signal });
export const createProject = (input: ProjectCreateInput) =>
  api.post<{ project: Project; run: RunHandle | null }>("/api/projects", input);
export async function deleteProject(projectId: string): Promise<void> {
  try {
    await api.delete(`/api/projects/${enc(projectId)}`);
  } catch (error) {
    if (isWriteOutcomeUnknown(error)) {
      // The write may have committed before its response was lost; never replay it.
      try {
        await getProject(projectId);
      } catch (confirmationError) {
        if (confirmationError instanceof ApiError && confirmationError.status === 404
          && confirmationError.code === "PROJECT_NOT_FOUND") return;
      }
    }
    throw error;
  }
}
export const replaceEvaluationPlan = (projectId: string, plan: EvaluationPlanInput) =>
  api.put<ProjectView>(`/api/projects/${enc(projectId)}/evaluation-plan`, plan);
export const getProjectOutputSchema = (projectId: string, signal?: AbortSignal) =>
  api.get<EvaluationOutputSchemaDocument | null>(`/api/projects/${enc(projectId)}/evaluation-output-schema`, { signal });
export const observeSampling = (projectId: string, samplingId: string, signal?: AbortSignal) =>
  api.get<AgentObservationRef>(`/api/projects/${enc(projectId)}/samplings/${enc(samplingId)}/observation`, { signal });
export const observeEvaluation = (projectId: string, evaluationId: string, signal?: AbortSignal) =>
  api.get<AgentObservationRef>(`/api/projects/${enc(projectId)}/evaluations/${enc(evaluationId)}/observation`, { signal });
