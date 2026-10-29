import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { EvidenceRef, TrajectoryRef } from "@eval-platform/eval-contracts";
import type { Context } from "hono";
import type { z } from "zod";
import type { AppBindings } from "../lib/types.js";
import { record, requireRun, short } from "./common.js";
import { metricSummary } from "./metrics.js";
import type { inspectCaseSchema } from "./schemas.js";

type Inspect = z.output<typeof inspectCaseSchema>;
const invalid = () => new HttpError("RESPONSE_INVALID", "SP returned invalid trajectory metadata");

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

/** Trajectory events include full prompts and tool bodies; never serialize an event or its payload. */
function trajectoryMetadata(value: unknown, limit: number) {
  const response = record(value);
  if (!response || !Array.isArray(response.events) || response.events.length > limit
    || typeof response.hasOlder !== "boolean"
    || response.beforeSeq !== null && (!Number.isSafeInteger(response.beforeSeq) || (response.beforeSeq as number) < 0)) {
    throw invalid();
  }
  const events = response.events.map((item: unknown) => {
    const entry = record(item);
    const event = record(entry?.event);
    if (!event || !Number.isSafeInteger(entry?.ingestSeq) || (entry!.ingestSeq as number) < 0) throw invalid();
    // Only structured event identity/time. Never content, input, output, thinking or error text.
    const type = typeof event.type === "string" && /^[a-z][a-z0-9_.-]{0,63}$/iu.test(event.type) ? event.type : null;
    const occurredAt = typeof event.occurredAt === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/u.test(event.occurredAt)
      ? event.occurredAt : null;
    return { ingestSeq: entry!.ingestSeq as number, type, occurredAt };
  });
  return { events, beforeSeq: response.beforeSeq as number | null, hasOlder: response.hasOlder };
}

export async function inspectCase(c: Context<AppBindings>, input: Inspect) {
  const { projectId, runId, samplingId, evaluationId, trajectory, beforeSeq, limit } = input;
  const owned = await requireRun(c.var.services, projectId, runId);
  if (!owned.run.samplingIds.includes(samplingId)) throw new HttpError("SAMPLING_NOT_FOUND");
  if (evaluationId && (!owned.run.evaluationIds.includes(evaluationId)
    || !owned.evaluations.some((item) => item.evaluationId === evaluationId && item.samplingId === samplingId))) {
    throw new HttpError("EVALUATION_NOT_FOUND");
  }
  const detail = await c.var.services.metrics.getSamplingDetail({ projectId, runIds: [runId], samplingId });
  const selected = evaluationId
    ? detail.evaluations.find(({ record }) => record.evaluationId === evaluationId) : undefined;
  if (evaluationId && !selected) throw new HttpError("EVALUATION_NOT_FOUND");
  const sampling = detail.sampling;

  let trajectoryPage: ReturnType<typeof trajectoryMetadata> | { state: "not-started"; events: [] } | undefined;
  if (trajectory) {
    const ref = trajectory === "subject"
      ? await c.var.services.observations.subject(projectId, samplingId)
      : await c.var.services.observations.evaluator(projectId, evaluationId!);
    if (ref.ownerUserId !== c.var.user.id || ref.projectId !== projectId || ref.samplingId !== samplingId
      || ref.role !== (trajectory === "subject" ? "subject" : "evaluator")
      || (trajectory === "evaluator" && ref.evaluationId !== evaluationId)) {
      throw new HttpError("EVAL_SP_FORBIDDEN");
    }
    trajectoryPage = ref.chatId
      ? trajectoryMetadata(await c.env.observation.trajectory(
        { ownerUserId: ref.ownerUserId, chatId: ref.chatId },
        { limit, ...(beforeSeq === undefined ? {} : { beforeSeq }) },
      ), limit)
      : { state: "not-started", events: [] };
  }

  const output = selected?.output;
  const content = output?.content;
  return {
    projectId, runId, samplingId,
    projectSample: { projectSampleId: detail.projectSample.projectSampleId, dataId: detail.projectSample.dataId },
    sampling: {
      status: sampling.execution.status,
      evidence: sampling.evidence ? { evidenceId: sampling.evidence.evidenceId,
        manifestSha256: sampling.evidence.manifestSha256 } : null,
      artifactCount: sampling.artifacts?.length ?? 0, trajectory: trajectoryRef(sampling.trajectory),
    },
    summary: metricSummary(detail.summary, 1, 5),
    evaluations: { total: detail.evaluations.length, items: detail.evaluations.slice(0, 10).map(({ record, output: item }) => ({
      evaluationId: record.evaluationId, status: record.status.status,
      validation: { status: item.validation.status, reason: item.validation.reason },
    })) },
    evaluation: selected ? {
      evaluationId: selected.record.evaluationId, status: selected.record.status.status,
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
    ...(trajectoryPage === undefined ? {} : { trajectory: trajectoryPage }),
  };
}
