import type { EvaluationRecord } from "@eval-platform/eval-contracts";
import { RuntimeEntityNotFoundError } from "./errors.js";
import type { RuntimeCatalog, Sample } from "./model.js";
import type { RuntimeStore, SamplingState } from "./store.js";

/** Ordered, identity-checked batch reads of persisted Run facts. */
export class RunRecords {
  readonly #store: RuntimeStore;
  readonly #getSamples: RuntimeCatalog["getSamples"];

  constructor(store: RuntimeStore, getSamples: RuntimeCatalog["getSamples"]) {
    this.#store = store;
    this.#getSamples = getSamples;
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

  /** Load each distinct Sample once and return a lookup for these Project Samplings. */
  async samples(
    records: readonly SamplingState[],
    projectId: string,
  ): Promise<(record: SamplingState) => Sample> {
    for (const record of records) {
      if (record.projectId !== projectId) {
        throw new Error(`Sampling ${record.samplingId} does not belong to project ${projectId}`);
      }
    }
    const sampleIds = [...new Set(records.map((record) => record.sampleId))];
    const samples = await this.#getSamples(sampleIds);
    if (samples.length !== sampleIds.length) throw new Error("Catalog returned an incomplete Sample batch");
    const byId = new Map<string, Sample>();
    sampleIds.forEach((sampleId, index) => {
      const sample = samples[index];
      if (!sample) throw new RuntimeEntityNotFoundError("sample", sampleId);
      if (sample.sampleId !== sampleId) throw new Error(`Catalog returned sample ${sample.sampleId} for ${sampleId}`);
      byId.set(sampleId, sample);
    });
    return (record) => {
      const sample = byId.get(record.sampleId);
      if (!sample) throw new Error(`Sample ${record.sampleId} was not loaded for Sampling ${record.samplingId}`);
      return sample;
    };
  }
}
