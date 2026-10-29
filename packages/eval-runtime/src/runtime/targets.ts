import type { ProjectPlan, RunOperation, RunTargetSelector, RunTargets, Sampling } from "@eval-platform/eval-contracts";
import { planProjectSampleIds } from "../plan/index.js";
import { RuntimeAdmissionConflictError, RuntimeEntityNotFoundError } from "./errors.js";

/** Just the Sampling facts a preview or locked admission needs for selector expansion. */
export type RunSelectionSampling = Pick<Sampling, "samplingId" | "projectId" | "projectSampleId"> & {
  readonly execution: Pick<Sampling["execution"], "status">;
};

/** Runtime and the transactional Store supply the same selector semantics with different readers. */
export interface RunSelectionReader {
  getSamplings(ids: readonly string[]): Promise<readonly (RunSelectionSampling | null)[]>;
  listProjectSamplings(projectId: string, projectSampleIds: readonly string[]): Promise<readonly RunSelectionSampling[]>;
}

/** Expand only against Project snapshots/current Samplings; callers enforce preview or the Project row lock. */
export async function expandRunTargets(
  plan: ProjectPlan,
  operation: RunOperation,
  selector: RunTargetSelector,
  reader: RunSelectionReader,
): Promise<RunTargets> {
  const { projectId } = plan.project;
  const bound = planProjectSampleIds(plan);
  const selected = new Set<string>(selector.all ? bound : []);
  for (const datasetId of selector.datasetIds ?? []) {
    const dataset = plan.datasets.find((item) => item.datasetId === datasetId);
    if (!dataset) throw new RuntimeEntityNotFoundError("dataset", datasetId);
    for (const projectSampleId of dataset.projectSampleIds) selected.add(projectSampleId);
  }
  const known = new Set(bound);
  for (const projectSampleId of selector.projectSampleIds ?? []) {
    if (!known.has(projectSampleId)) throw new RuntimeEntityNotFoundError("project-sample", projectSampleId);
    selected.add(projectSampleId);
  }
  const explicitIds = selector.samplingIds ?? [];
  const explicit = explicitIds.length ? await reader.getSamplings(explicitIds) : [];
  for (const [index, sampling] of explicit.entries()) {
    if (!sampling || sampling.projectId !== projectId) {
      throw new RuntimeEntityNotFoundError("sampling", explicitIds[index]!);
    }
    if (operation === "evaluation" && sampling.execution.status !== "succeeded") {
      throw new RuntimeAdmissionConflictError(
        "sampling-unavailable",
        `Sampling ${sampling.samplingId} has no successful execution in Project ${projectId}`,
      );
    }
  }
  if (operation !== "evaluation") {
    return {
      projectSampleIds: [...selected],
      samplingIds: explicit.filter((sampling) => !selected.has(sampling!.projectSampleId)).map((sampling) => sampling!.samplingId),
    };
  }
  const expanded = selected.size === 0 ? [] : await reader.listProjectSamplings(projectId, [...selected]);
  return {
    projectSampleIds: [],
    samplingIds: [...new Set([
      ...expanded.filter(({ execution }) => execution.status === "succeeded"),
      ...explicit.filter((sampling): sampling is RunSelectionSampling => sampling !== null),
    ].map(({ samplingId }) => samplingId))],
  };
}
