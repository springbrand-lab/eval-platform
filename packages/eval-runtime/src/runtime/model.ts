import type { Data, Dataset } from "@eval-platform/eval-dataset";
import type {
  AgentConfigRef,
  AgentRole,
  EvaluateRequest,
  PipelineRequest,
  Project,
  RunHandle,
  RunSnapshot,
  StartRunRequest,
} from "@eval-platform/eval-contracts";

import type { Harness } from "../harness/index.js";
import type { RetryController } from "./retry.js";
import type { RuntimeSamplingRecord, RuntimeStore } from "./store.js";

export interface Sample {
  readonly sampleId: string;
  readonly dataId: string;
  readonly json: Data["json"];
  readonly initialContext?: Data["initialContext"];
  readonly initialMaterials?: Data["initialMaterials"];
  readonly metadata?: Data["metadata"];
}

export interface AgentOption {
  readonly agentConfig: AgentConfigRef;
  readonly name: string;
  readonly role: AgentRole;
}

export interface RuntimeCatalog {
  listProjects(): Promise<readonly Project[]>;
  listAgents(role?: AgentRole): Promise<readonly AgentOption[]>;
  listDatasets(): Promise<readonly Dataset[]>;
  listData(datasetId: string): Promise<readonly Data[]>;
  listSamples(dataId: string): Promise<readonly Sample[]>;
}

export interface EvalRuntime {
  listProjects(): Promise<readonly Project[]>;
  listAgents(role?: AgentRole): Promise<readonly AgentOption[]>;
  listDatasets(): Promise<readonly Dataset[]>;
  listData(datasetId: string): Promise<readonly Data[]>;
  listSamples(dataId: string): Promise<readonly Sample[]>;
  start(request: StartRunRequest): Promise<RunHandle>;
  evaluate(request: EvaluateRequest): Promise<RunHandle>;
  pipeline(request: PipelineRequest): Promise<RunHandle>;
  getRun(runId: string): Promise<RunSnapshot>;
  getSampling(samplingId: string): Promise<RuntimeSamplingRecord>;
}

export interface EvalRuntimeDependencies {
  readonly catalog: RuntimeCatalog;
  readonly harness: Harness;
  readonly store: RuntimeStore;
  readonly createRetryController?: (
    policy?: import("@eval-platform/eval-contracts").RetryPolicy,
  ) => RetryController;
  readonly idFactory?: () => string;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}
