import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { EvidenceRef, TrajectoryRef } from "@eval-platform/eval-contracts";
import type { Context } from "hono";
import type { z } from "zod";
import type { AppBindings } from "../lib/types.js";
import { requireRun, short } from "./common.js";
import { metricSummary, resourceSummary } from "./metrics.js";
import type { inspectCaseSchema } from "./schemas.js";

type Inspect = z.output<typeof inspectCaseSchema>;

function trajectoryRef(ref: TrajectoryRef | null | undefined) {
  return ref ? { trajectoryId: short(ref.trajectoryId), source: ref.source,
    contentHash: ref.contentHash ? short(ref.contentHash, 128) : null } : null;
}

/** Only internal Workspace paths, never an external URL or a signed file address. */
function safeEvidencePath(value: string): string | null {
  if (value.length > 256 || !/^\/(?:evidence|workspace|output)\/[^?#\\\u0000-\u001f\u007f]*$/u.test(value)
    || value.slice(1).split("/").some((segment) => !segment || segment === "." || segment === "..")) return null;
  return value;
}

function evidenceRefs(refs: readonly EvidenceRef[] | undefined) {
  return { total: refs?.length ?? 0, items: (refs ?? []).slice(0, 10).map((ref) => ({
    kind: ref.kind,
    ref: safeEvidencePath(ref.ref),
    contentHash: ref.contentHash ? short(ref.contentHash, 128) : null,
  })) };
}

/** The same owner/current/exact-Run checks guard bounded MCP inspection and bulk byte export. */
export async function ownedCase(c: Context<AppBindings>, input: Inspect) {
  const { projectId, runId, samplingId, evaluationId } = input;
  if (runId !== undefined) {
    const owned = await requireRun(c.var.services, projectId, runId);
    if (owned.run.runId !== runId || owned.run.projectId !== projectId) throw new HttpError("RUN_NOT_FOUND");
    if (!owned.run.samplingIds.includes(samplingId)) throw new HttpError("SAMPLING_NOT_FOUND");
    if (evaluationId && (!owned.run.evaluationIds.includes(evaluationId)
      || !owned.evaluations.some((item) => item.evaluationId === evaluationId && item.samplingId === samplingId))) {
      throw new HttpError("EVALUATION_NOT_FOUND");
    }
  }
  // Metrics' owner-scoped, current-facts snapshot is authoritative even for a selected old Run.
  const detail = await c.var.services.metrics.getSamplingDetail({
    projectId, samplingId, ...(runId === undefined ? {} : { runIds: [runId] }),
  });
  if (detail.project.projectId !== projectId || detail.project.ownerUserId !== c.var.user.id
    || detail.projectSample.projectId !== projectId || detail.sampling.projectId !== projectId
    || detail.sampling.samplingId !== samplingId
    || detail.sampling.projectSampleId !== detail.projectSample.projectSampleId
    || detail.subject.role !== "subject" || detail.subject.samplingId !== samplingId
    || detail.subject.evaluationId !== null || detail.subject.agentConfigRef.ownerUserId !== c.var.user.id
    || detail.subject.chatId !== (detail.sampling.subjectChatId ?? null)) {
    throw new HttpError("EVAL_SP_FORBIDDEN");
  }
  const selected = evaluationId
    ? detail.evaluations.find(({ record }) => record.evaluationId === evaluationId) : undefined;
  if (evaluationId && (!selected || selected.record.samplingId !== samplingId
    || selected.record.evaluator.ownerUserId !== c.var.user.id
    || selected.agent.role !== "evaluator" || selected.agent.samplingId !== samplingId
    || selected.agent.evaluationId !== evaluationId || selected.agent.agentConfigRef.ownerUserId !== c.var.user.id
    || selected.agent.chatId !== (selected.record.chatId ?? null))) {
    throw new HttpError("EVALUATION_NOT_FOUND");
  }
  return { detail, selected };
}

/** No Chat is read until its observed ID matches the owned current stage and requested role. */
export async function ownedTrajectoryChat(c: Context<AppBindings>, input: Inspect & { role: "subject" | "evaluator" }) {
  const { projectId, samplingId, evaluationId, role } = input;
  if (role === "subject" && evaluationId !== undefined || role === "evaluator" && evaluationId === undefined) {
    throw new HttpError("REQUEST_INVALID_INPUT", "The role and Evaluation ID do not match");
  }
  const { detail, selected } = await ownedCase(c, input);
  const ref = role === "subject"
    ? await c.var.services.observations.subject(projectId, samplingId)
    : await c.var.services.observations.evaluator(projectId, evaluationId!);
  const agent = role === "subject" ? detail.subject : selected!.agent;
  if (ref.ownerUserId !== c.var.user.id || ref.projectId !== projectId || ref.samplingId !== samplingId
    || ref.role !== role || role === "evaluator" && ref.evaluationId !== evaluationId
    || (ref.chatId ?? null) !== agent.chatId
    || ref.state !== "available" && ref.state !== "not-started") {
    throw new HttpError("EVAL_SP_FORBIDDEN");
  }
  if (ref.state === "not-started" || !ref.chatId) throw new HttpError("EVAL_SP_NOT_FOUND", "The Chat has not started");
  return { ownerUserId: ref.ownerUserId, chatId: ref.chatId };
}

export async function inspectCase(c: Context<AppBindings>, input: Inspect) {
  const { projectId, runId, samplingId } = input;
  const { detail, selected } = await ownedCase(c, input);
  const sampling = detail.sampling;
  const runScope = runId === undefined
    ? { runScope: "project_current" as const } : { runScope: "exact_run" as const, runId };
  const output = selected?.output;
  const content = output?.content;
  return {
    projectId, samplingId, ...runScope,
    projectSample: { projectSampleId: detail.projectSample.projectSampleId, dataId: detail.projectSample.dataId },
    sampling: {
      status: sampling.execution.status,
      evidence: sampling.evidence ? { evidenceId: sampling.evidence.evidenceId,
        manifestSha256: sampling.evidence.manifestSha256 } : null,
      artifactCount: sampling.artifacts?.length ?? 0, trajectory: trajectoryRef(sampling.trajectory),
    },
    summary: metricSummary(detail.summary, 1, 5),
    subject: resourceSummary(detail.subject.resources),
    evaluations: { total: detail.evaluations.length, items: detail.evaluations.slice(0, 10).map(({ record, output: item }) => ({
      evaluationId: record.evaluationId, status: record.status.status,
      validation: { status: item.validation.status, reason: item.validation.reason },
    })) },
    evaluation: selected ? {
      evaluationId: selected.record.evaluationId, status: selected.record.status.status,
      evaluator: resourceSummary(selected.agent.resources),
      validation: { status: output!.validation.status, reason: output!.validation.reason,
        errorCount: output!.validation.errors.length },
      result: content === null || content === undefined ? null : {
        excerpt: short(content, 1200), truncated: content.length > 1200,
        contentHash: output!.contentHash ? short(output!.contentHash, 128) : null,
      },
      artifacts: { total: output!.artifacts.length, items: output!.artifacts.slice(0, 10).map((artifact) => ({
        artifactId: short(artifact.artifactId), kind: short(artifact.kind, 40),
        contentHash: artifact.contentHash ? short(artifact.contentHash, 128) : null,
      })) },
      evidenceRefs: evidenceRefs(output!.evidenceRefs), trajectory: trajectoryRef(output!.trajectory),
    } : null,
  };
}
