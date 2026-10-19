import type { EvaluationRecord, RunSnapshot, Sampling } from "@eval-platform/eval-contracts";
import { toRunSnapshot } from "@eval-platform/eval-runtime";
import { readMetricEvaluations } from "./metric-facts.js";
import { READ_SNAPSHOT, type EvalDb } from "./client.js";
import { requireOwnerUserId } from "./owner.js";
import { projectExists } from "./project-plans.js";
import { readRunRecords, readSamplingProgress, requireMembers, type RecordReader } from "./run-records.js";

export interface ProjectRunView {
  readonly run: RunSnapshot;
  readonly samplings: readonly Pick<Sampling, "samplingId" | "execution">[];
  readonly evaluations: readonly EvaluationRecord[];
}

export type RunViewScope =
  | { readonly kind: "owner"; readonly ownerUserId: string }
  | { readonly kind: "project"; readonly ownerUserId: string; readonly projectId: string };

/**
 * Reads one owned Run of a non-deleted Project and its current member records in bounded SQL
 * batches; call inside one read-only snapshot.
 */
export async function readRunView(reader: RecordReader, runId: string, scope: RunViewScope): Promise<ProjectRunView | null> {
  const [record] = await readRunRecords(reader, [runId], scope);
  if (!record || !await projectExists(reader, record.projectId, scope.ownerUserId)) return null;
  const samplingRows = await readSamplingProgress(reader, record.samplingIds, scope.ownerUserId);
  const evaluationRows = await readMetricEvaluations(reader, record.evaluationIds, scope.ownerUserId);
  const missing = (kind: string) => (id: string) => new Error(`Run ${runId} is missing ${kind} ${id}`);
  const members = requireMembers(samplingRows, record.samplingIds, missing("Sampling"));
  const evaluationRecords = requireMembers(evaluationRows, record.evaluationIds, missing("Evaluation"));
  return { run: toRunSnapshot(record, members, evaluationRecords), samplings: members, evaluations: evaluationRecords };
}

export function createPostgresProjectRunReader(db: EvalDb, ownerUserId: string) {
  const owner = requireOwnerUserId(ownerUserId);
  return (projectId: string, runId: string): Promise<ProjectRunView | null> => db.transaction(
    (transaction) => readRunView(transaction, runId, { kind: "project", ownerUserId: owner, projectId }),
    READ_SNAPSHOT,
  );
}
