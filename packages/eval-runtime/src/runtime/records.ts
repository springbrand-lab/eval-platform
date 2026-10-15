import type { EvaluationPlan, EvaluationRecord, ExecutionPlan } from "@eval-platform/eval-contracts";
import { RuntimeEntityNotFoundError } from "./errors.js";
import type { ProjectPlanReader, ProjectSample } from "./model.js";
import type { RuntimeRunRecord, RuntimeStore, SamplingState } from "./store.js";

/** The Project plan stages a Run was admitted against, verified by digest. */
export type RunStagePlans =
  | { readonly operation: "execution"; readonly execution: ExecutionPlan }
  | {
    readonly operation: "pipeline" | "evaluation";
    readonly execution: ExecutionPlan;
    readonly evaluation: EvaluationPlan;
  };

/** Ordered, identity-checked batch reads of persisted Run facts and their Project plan. */
export class RunRecords {
  readonly #store: RuntimeStore;
  readonly #plans: ProjectPlanReader;

  constructor(store: RuntimeStore, plans: ProjectPlanReader) {
    this.#store = store;
    this.#plans = plans;
  }

  /** Read the current Project plan and reject one whose digests differ from the Run's. */
  async plan(run: RuntimeRunRecord): Promise<RunStagePlans> {
    const plan = await this.#plans.getProjectPlan(run.projectId);
    if (!plan) throw new RuntimeEntityNotFoundError("project", run.projectId);
    const mismatch = () => new Error(`Run ${run.runId} was admitted against a different plan of Project ${run.projectId}`);
    if (plan.executionPlanDigest !== run.planDigests.execution) throw mismatch();
    if (run.operation === "execution") return { operation: run.operation, execution: plan.execution };
    if (!plan.evaluation || plan.evaluationPlanDigest !== run.planDigests.evaluation) throw mismatch();
    return { operation: run.operation, execution: plan.execution, evaluation: plan.evaluation };
  }

  async samplings(samplingIds: readonly string[]): Promise<readonly SamplingState[]> {
    const records = await this.#store.getSamplings(samplingIds);
    if (records.length !== samplingIds.length) throw new Error("Store returned an incomplete Sampling batch");
    return samplingIds.map((samplingId, index) => {
      const record = records[index];
      if (!record) throw new RuntimeEntityNotFoundError("sampling", samplingId);
      if (record.samplingId !== samplingId) throw new Error(`Store returned Sampling ${record.samplingId} for ${samplingId}`);
      return record;
    });
  }

  async evaluations(evaluationIds: readonly string[]): Promise<readonly EvaluationRecord[]> {
    const records = await this.#store.getEvaluations(evaluationIds);
    if (records.length !== evaluationIds.length) throw new Error("Store returned an incomplete Evaluation batch");
    return evaluationIds.map((evaluationId, index) => {
      const record = records[index];
      if (!record) throw new RuntimeEntityNotFoundError("evaluation", evaluationId);
      if (record.evaluationId !== evaluationId) {
        throw new Error(`Store returned Evaluation ${record.evaluationId} for ${evaluationId}`);
      }
      return record;
    });
  }

  /** Load each distinct ProjectSample of a Project once, in input order. */
  async projectSamples(projectId: string, projectSampleIds: readonly string[]): Promise<ReadonlyMap<string, ProjectSample>> {
    const ids = [...new Set(projectSampleIds)];
    const samples = ids.length === 0 ? [] : await this.#plans.getProjectSamples(projectId, ids);
    if (samples.length !== ids.length) throw new Error("Plan reader returned an incomplete ProjectSample batch");
    const byId = new Map<string, ProjectSample>();
    ids.forEach((projectSampleId, index) => {
      const sample = samples[index];
      if (!sample) throw new RuntimeEntityNotFoundError("project-sample", projectSampleId);
      if (sample.projectSampleId !== projectSampleId || sample.projectId !== projectId) {
        throw new Error(`Plan reader returned ProjectSample ${sample.projectSampleId} for ${projectSampleId}`);
      }
      byId.set(projectSampleId, sample);
    });
    return byId;
  }

  /** Load each distinct ProjectSample once and return a lookup for these Project Samplings. */
  async samples(
    records: readonly SamplingState[],
    projectId: string,
  ): Promise<(record: SamplingState) => ProjectSample> {
    for (const record of records) {
      if (record.projectId !== projectId) {
        throw new Error(`Sampling ${record.samplingId} does not belong to project ${projectId}`);
      }
    }
    const byId = await this.projectSamples(projectId, records.map((record) => record.projectSampleId));
    return (record) => {
      const sample = byId.get(record.projectSampleId);
      if (!sample) throw new Error(`ProjectSample ${record.projectSampleId} was not loaded for Sampling ${record.samplingId}`);
      return sample;
    };
  }
}
