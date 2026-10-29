import { describe, expect, it, vi } from "vitest";
import { digestJson, RuntimeAdmissionConflictError, type EvalRunAdmission } from "@eval-platform/eval-runtime";
import type { Data } from "@eval-platform/eval-dataset";
import type { AgentConfigService } from "../agent-configs.js";
import type { PostgresProjectStore, ProjectSnapshot, SelectedDataset, StoredProjectCreation } from "../db/project-store.js";
import { ProjectIdempotencyConflictError } from "../db/errors.js";
import type { createOutputSchemaCatalog } from "../db/output-schemas.js";
import { createProjectService } from "./service.js";
import { projectCreateSchema } from "./schemas.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const DATASET = "22222222-2222-4222-8222-222222222222";
const DATA = "33333333-3333-4333-8333-333333333333";
const SUBJECT = "44444444-4444-4444-8444-444444444444";
const EVALUATOR = "55555555-5555-4555-8555-555555555555";
const SCHEMA = "66666666-6666-4666-8666-666666666666";
const selected: SelectedDataset = {
  dataset: { datasetId: DATASET, name: "Reviewed", kind: "general" },
  data: [{ dataId: DATA, userPrompt: "Approved prompt", evalPrompt: "Approved evaluation" }],
};
const subjectSource = { id: SUBJECT, user_id: OWNER, name: "Approved Subject", setting: { instructions: "approved" } };
const evaluatorSource = { id: EVALUATOR, user_id: OWNER, name: "Approved Evaluator", setting: { instructions: "reviewed" } };
const outputSchema = { type: "object", properties: { score: { type: "number" } } } as const;

async function fixture(evaluating = false) {
  let source: SelectedDataset = structuredClone(selected);
  let evaluator: typeof evaluatorSource = structuredClone(evaluatorSource);
  let subject: typeof subjectSource = structuredClone(subjectSource);
  let schema: Record<string, unknown> = structuredClone(outputSchema);
  let schemaName = "Output";
  let persisted: ProjectSnapshot | null = null;
  let firstRun: { runId: string; samplingIds: string[] } | null = null;
  let changedEvaluationDigest: string | undefined;
  let evaluationReplaced = false;
  const readSelection = vi.fn(async (selections: readonly { datasetId: string; dataIds?: readonly string[] }[]) =>
    selections.map(({ datasetId, dataIds }) => {
      if (datasetId !== DATASET) throw new Error("Unknown Dataset");
      return { ...source, data: dataIds ? source.data.filter(({ dataId }) => dataIds.includes(dataId)) : source.data };
    }));
  const create = vi.fn(async (snapshot: ProjectSnapshot) => { persisted = snapshot; });
  const findCreation = vi.fn(async (key: string): Promise<StoredProjectCreation | null> => {
    const snapshot = persisted;
    if (!snapshot || key !== snapshot.creation.key) return null;
    return {
      project: snapshot.project, fingerprint: snapshot.creation.fingerprint,
      deleted: false, superseded: false, run: firstRun,
      planDigests: { execution: snapshot.execution.digest,
        ...(snapshot.evaluation ? { evaluation: changedEvaluationDigest ?? snapshot.evaluation.digest } : {}) },
      evaluationReplaced,
    };
  });
  const store = { readSelection, create, findCreation,
    deleteUnrun: vi.fn(async () => []), get: vi.fn(async () => null),
  } as unknown as PostgresProjectStore;
  const freeze = vi.fn(async (id: string, _purpose: string, _expectedDigest?: string) => ({
    userAgentId: id === SUBJECT ? "frozen-subject" : "frozen-evaluator",
    snapshot: { sourceUserAgentId: id, name: id === SUBJECT ? subject.name : evaluator.name,
      body: structuredClone(id === SUBJECT ? subject : evaluator) },
  }));
  const discard = vi.fn(async (_ids: readonly string[]) => undefined);
  const agentConfigs = { freeze, discard } as unknown as Pick<AgentConfigService, "freeze" | "discard">;
  const outputSchemas = { get: vi.fn(async (id: string) => id === SCHEMA
    ? { outputSchemaId: SCHEMA, name: schemaName, description: "Approved",
      schema: structuredClone(schema) } : null) } as unknown as Pick<ReturnType<typeof createOutputSchemaCatalog>, "get">;
  const preview = vi.fn(async ({ projectId, operation, selector }: Parameters<EvalRunAdmission["preview"]>[0]) => {
    const snapshot = persisted;
    if (!snapshot) throw new Error("Project was not saved");
    return {
      projectId, operation, selector,
      targets: { projectSampleIds: snapshot.samples.map(({ projectSampleId }) => projectSampleId), samplingIds: [] },
      replacedSamplingCount: 0, newSamplingCount: snapshot.samples.length, evaluationCount: operation === "execution" ? 0 : snapshot.samples.length,
      executionPlanDigest: snapshot.execution.digest,
      evaluationPlanDigest: operation === "execution" ? null : changedEvaluationDigest ?? snapshot.evaluation!.digest,
    };
  });
  const submit = vi.fn(async (request: Parameters<EvalRunAdmission["submit"]>[0]) => {
    firstRun = { runId: "original-first-run", samplingIds: [request.targets.projectSampleIds[0]!] };
    return firstRun;
  });
  const admission = { preview, submit };
  const service = createProjectService({ ownerUserId: OWNER, sourceBranch: "reviewed-branch",
    store, agentConfigs, outputSchemas, admission });
  const body = projectCreateSchema.parse({
    idempotencyKey: "reviewed-project", name: "Reviewed", datasets: [{ datasetId: DATASET, dataIds: [DATA] }],
    samplingCount: 1, execution: { userAgentId: SUBJECT, framework: "sp", executionConcurrency: 1 },
    ...(evaluating ? { evaluation: { userAgentId: EVALUATOR, evaluationConcurrency: 1, outputSchemaId: SCHEMA } } : {}),
    run: { operation: evaluating ? "pipeline" : "execution" },
    expectedSnapshots: {
      datasets: [{ datasetId: DATASET, digest: await digestJson({ dataset: selected.dataset, selected: selected.data }) }],
      executionAgent: await digestJson(subjectSource),
      ...(evaluating ? { evaluationAgent: await digestJson(evaluatorSource),
        outputSchema: await digestJson({ outputSchemaId: SCHEMA, name: schemaName, description: "Approved", schema: outputSchema }) } : {}),
    },
  });
  return { service, body, readSelection, create, findCreation, freeze, discard, preview, submit,
    setData(data: Data) { source = { ...source, data: [data] }; },
    setSubject(next: typeof subjectSource) { subject = next; },
    setEvaluator(next: typeof evaluatorSource) { evaluator = next; },
    setSchema(next: Record<string, unknown>) { schema = next; },
    setSchemaName(next: string) { schemaName = next; },
    replaceEvaluationPlan() { changedEvaluationDigest = "f".repeat(64); evaluationReplaced = true; },
    changeDuringPreview() { changedEvaluationDigest = "f".repeat(64); },
  };
}

describe("ProjectService approved source and first-Run binding (no database or SP calls)", () => {
  it("uses the same consistent selection for review and creation; rejects changed Data before freezing", async () => {
    const f = await fixture();
    const reviewed = await f.service.reviewSelection(f.body.datasets[0]!);
    expect(reviewed.digest).toBe(f.body.expectedSnapshots!.datasets[0]!.digest);
    f.setData({ ...selected.data[0]!, userPrompt: "Mutated after review" });
    await expect(f.service.create(f.body)).rejects.toMatchObject({ reason: "plan-changed" });
    expect(f.freeze).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("rejects changed output Schema before a copy, and a changed Agent snapshot before persisting anything", async () => {
    const schema = await fixture(true);
    schema.setSchema({ ...outputSchema, properties: { score: { type: "string" } } });
    await expect(schema.service.create(schema.body)).rejects.toMatchObject({ reason: "plan-changed" });
    expect(schema.freeze).not.toHaveBeenCalled();
    expect(schema.create).not.toHaveBeenCalled();
    const renamed = await fixture(true);
    renamed.setSchemaName("Changed after review");
    await expect(renamed.service.create(renamed.body)).rejects.toMatchObject({ reason: "plan-changed" });
    expect(renamed.freeze).not.toHaveBeenCalled();

    const agent = await fixture(true);
    agent.setSubject({ ...subjectSource, setting: { instructions: "Mutated after approval" } });
    await expect(agent.service.create(agent.body)).rejects.toMatchObject({ reason: "plan-changed" });
    expect(agent.discard).toHaveBeenCalledWith(["frozen-subject"]);
    expect(agent.create).not.toHaveBeenCalled();
    expect(agent.submit).not.toHaveBeenCalled();

    const evaluator = await fixture(true);
    evaluator.setEvaluator({ ...evaluatorSource, setting: { instructions: "Mutated after approval" } });
    await expect(evaluator.service.create(evaluator.body)).rejects.toMatchObject({ reason: "plan-changed" });
    expect(evaluator.discard).toHaveBeenCalledWith(["frozen-subject", "frozen-evaluator"]);
    expect(evaluator.create).not.toHaveBeenCalled();
  });

  it("refuses a changed first-Run evaluation plan after the approved snapshot was persisted", async () => {
    const f = await fixture(true);
    f.preview.mockImplementationOnce(async (input) => {
      f.changeDuringPreview();
      const saved = f.create.mock.calls[0]![0];
      return { projectId: input.projectId, operation: input.operation, selector: input.selector,
        targets: { projectSampleIds: saved.samples.map(({ projectSampleId }) => projectSampleId), samplingIds: [] },
        executionPlanDigest: saved.execution.digest, evaluationPlanDigest: "f".repeat(64),
        replacedSamplingCount: 0, newSamplingCount: 1, evaluationCount: 1 };
    });
    await expect(f.service.create(f.body)).rejects.toBeInstanceOf(RuntimeAdmissionConflictError);
    expect(f.create).toHaveBeenCalledOnce(); // an already-saved Project may remain for read-only reconciliation
    expect(f.submit).not.toHaveBeenCalled();
    const previews = f.preview.mock.calls.length;
    expect(await f.service.reconcile(f.body)).toMatchObject({ project: { name: "Reviewed" }, run: null });
    expect(f.preview).toHaveBeenCalledTimes(previews);
    f.replaceEvaluationPlan();
    await expect(f.service.create(f.body)).rejects.toMatchObject({ reason: "plan-changed" });
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("binds its first Run to the stored plan and reconciles only an exact persisted creation fingerprint", async () => {
    const f = await fixture(true);
    const created = await f.service.create(f.body);
    const approved = f.preview.mock.results[0]?.value as Promise<Awaited<ReturnType<EvalRunAdmission["preview"]>>>;
    const preview = await approved;
    expect(f.submit).toHaveBeenCalledExactlyOnceWith({
      idempotencyKey: f.body.idempotencyKey, projectId: created.project.projectId,
      operation: "pipeline", selector: { all: true }, targets: preview.targets,
      expectedPlanDigests: { execution: preview.executionPlanDigest, evaluation: preview.evaluationPlanDigest },
    });
    f.replaceEvaluationPlan();
    const readCount = f.readSelection.mock.calls.length;
    expect(await f.service.reconcile(f.body)).toEqual(created);
    await expect(f.service.reconcile({ ...f.body, name: "Wrong body" }))
      .rejects.toBeInstanceOf(ProjectIdempotencyConflictError);
    expect(await f.service.reconcile({ ...f.body, idempotencyKey: "not-created" })).toBeNull();
    expect(f.readSelection).toHaveBeenCalledTimes(readCount);
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.submit).toHaveBeenCalledOnce();
  });
});
