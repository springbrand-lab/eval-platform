import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { Context } from "hono";
import type { z } from "zod";
import { requireRunTargetCount } from "../limits.js";
import type { AppBindings } from "../lib/types.js";
import { MAX_PREVIEW_TARGETS, pageOf, short } from "./common.js";
import type {
  createProjectSchema, getRunSchema, previewRunSchema, reconcileOperationSchema, stopRunSchema, submitRunSchema,
} from "./schemas.js";

function boundedTargets(targets: { readonly projectSampleIds: readonly string[]; readonly samplingIds: readonly string[] }) {
  const count = targets.projectSampleIds.length + targets.samplingIds.length;
  requireRunTargetCount(count); // Same hard admission limit as the HTTP control plane.
  if (count > MAX_PREVIEW_TARGETS) {
    throw new HttpError("RUN_TARGETS_TOO_LARGE", "Narrow the selection before submitting it through MCP");
  }
}

export async function createProject(c: Context<AppBindings>, body: z.output<typeof createProjectSchema>) {
  // A planned Prompt Dataset is visible before its per-Data resource bindings finish.
  await c.env.evalManagement?.store.assertReadyDatasets(c.var.user.id, body.datasets.map((item) => item.datasetId));
  const { project, run } = await c.var.services.projects.create(body);
  return { project: { projectId: project.projectId, name: short(project.name), createdAt: project.createdAt },
    run: run ? { runId: run.runId, samplingCount: run.samplingIds.length } : null };
}

export async function previewRun(c: Context<AppBindings>, body: z.output<typeof previewRunSchema>) {
  const preview = await c.var.services.admission.preview(body);
  boundedTargets(preview.targets);
  return {
    projectId: preview.projectId, operation: preview.operation,
    targets: preview.targets, replacedSamplingCount: preview.replacedSamplingCount,
    newSamplingCount: preview.newSamplingCount, evaluationCount: preview.evaluationCount,
    executionPlanDigest: preview.executionPlanDigest, evaluationPlanDigest: preview.evaluationPlanDigest,
  };
}

export async function submitRun(c: Context<AppBindings>, body: z.output<typeof submitRunSchema>) {
  boundedTargets(body.targets);
  const run = await c.var.services.admission.submit(body);
  return { runId: run.runId, samplingCount: run.samplingIds.length };
}

/** No Project first Run means the persisted creation is not a confirmed completed operation. */
export class ManagementReconciliationUnknownError extends Error {
  constructor() {
    super("Project exists without its first Run");
    this.name = "ManagementReconciliationUnknownError";
  }
}

/** Only read the original persisted Project or Run identity. No preview, admission or creation. */
export async function reconcileOperation(c: Context<AppBindings>, body: z.output<typeof reconcileOperationSchema>) {
  if (body.kind === "run") {
    boundedTargets(body.request.targets);
    const run = await c.var.services.admission.replay(body.request);
    if (!run) throw new HttpError("RUN_NOT_FOUND");
    return { projectId: body.request.projectId, runId: run.runId, samplingCount: run.samplingIds.length };
  }
  if (body.request.datasets.length > MAX_PREVIEW_TARGETS) {
    throw new HttpError("RUN_TARGETS_TOO_LARGE", "Narrow the original Project request");
  }
  const creation = await c.var.services.projects.reconcile(body.request);
  if (!creation) throw new HttpError("PROJECT_NOT_FOUND");
  if (!creation.run) throw new ManagementReconciliationUnknownError();
  return { projectId: creation.project.projectId, runId: creation.run.runId, samplingCount: creation.run.samplingIds.length };
}

export async function stopRun(c: Context<AppBindings>, { projectId, runId }: z.output<typeof stopRunSchema>) {
  const stopped = await c.var.services.projectRuns.stopRun(projectId, runId);
  if (!stopped) throw new HttpError("RUN_NOT_FOUND");
  return { runId: stopped.runId, stopRequested: stopped.stopRequested };
}

export async function getRun(c: Context<AppBindings>, { runId, page, pageSize }: z.output<typeof getRunSchema>) {
  const run = await c.var.services.results.getRun(runId);
  return {
    runId: run.runId, projectId: run.projectId, operation: run.operation,
    status: run.status, phase: run.phase, phases: run.phases,
    stopRequested: run.stopRequested === true, stopFinalized: run.stopFinalized === true,
    counts: { samplings: run.samplingIds.length, evaluations: run.evaluationIds.length },
    samplings: pageOf(run.samplingIds, page, pageSize),
    evaluations: pageOf(run.evaluationIds, page, pageSize),
  };
}
