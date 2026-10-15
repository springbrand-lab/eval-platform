import type { EvaluationRecord, RunSnapshot } from "@eval-platform/eval-contracts";
import { toRunSnapshot } from "@eval-platform/eval-runtime";
import type { EvalDb } from "./client.js";
import { requireOwnerUserId } from "./owner.js";
import { readEvaluations, readRunRecords, readSamplings, requireMembers, type RecordReader } from "./run-records.js";

export interface ProjectRunView {
  readonly run: RunSnapshot;
  readonly evaluations: readonly EvaluationRecord[];
}

export type RunViewScope =
  | { readonly kind: "owner"; readonly ownerUserId: string }
  | { readonly kind: "project"; readonly ownerUserId: string; readonly projectId: string };

/** Reads one owned Run and its member records in bounded SQL batches; call inside one read-only snapshot. */
export async function readRunView(reader: RecordReader, runId: string, scope: RunViewScope): Promise<ProjectRunView | null> {
  const [record] = await readRunRecords(reader, [runId], scope);
  if (!record) return null;
  const [samplingRows, evaluationRows] = await Promise.all([
    readSamplings(reader, record.samplingIds, scope.ownerUserId),
    readEvaluations(reader, record.evaluationIds, scope.ownerUserId),
  ]);
  const missing = (kind: string) => (id: string) => new Error(`Run ${runId} is missing ${kind} ${id}`);
  const members = requireMembers(samplingRows, record.samplingIds, missing("Sampling"));
  const judges = requireMembers(evaluationRows, record.evaluationIds, missing("Evaluation"));
  return { run: toRunSnapshot(record, members, judges), evaluations: judges };
}

export function createPostgresProjectRunReader(db: EvalDb, ownerUserId: string) {
  const owner = requireOwnerUserId(ownerUserId);
  return (projectId: string, runId: string): Promise<ProjectRunView | null> => db.transaction(
    (transaction) => readRunView(transaction, runId, { kind: "project", ownerUserId: owner, projectId }),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
