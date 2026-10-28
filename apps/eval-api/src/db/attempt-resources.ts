import {
  isResourceSnapshotDownload, jsonObjectArrayInPlaceSchema, nativeRecordMayBelongToScope, nativeTrajectoryEntrySchema,
  type AgentResourceSnapshot, type AgentResourceState, type EvaluationRecord, type Sampling,
} from "@eval-platform/eval-contracts";
import {
  compactResourceSnapshot,
  MetricsSourceError,
  type MetricsEvaluation,
  type MetricsSampling,
  type WithResourceSnapshot,
} from "@eval-platform/eval-metrics";
import type { AttemptResourceSnapshot } from "@eval-platform/eval-runtime";
import { and, eq, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { EvalDb } from "./client.js";
import { requireOwnerUserId } from "./owner.js";
import { visibleProject } from "./project-plans.js";
import type { RecordReader } from "./run-records.js";
import { attemptResources, projects, samplings } from "./schema.js";

type RecordWriter = Pick<EvalDb, "update" | "insert">;

/** The stage record a snapshot belongs to; `evaluationId` is present for, and only for, an Evaluator. */
interface ResourceRecord {
  readonly ownerUserId: string;
  readonly samplingId: string;
  readonly evaluationId?: string;
}

/**
 * Runs one compare-and-set record update and, in the same transaction, stores the collected
 * snapshot with its Metrics projection; both or neither. Historical raw snapshots are left
 * unchanged; streamed Pi snapshots contain only verified compact native facts and do not
 * duplicate their evidence bodies in either PostgreSQL column.
 */
export async function updateWithResources(
  db: EvalDb, resources: AttemptResourceSnapshot | undefined, update: (writer: RecordWriter) => Promise<ResourceRecord>,
): Promise<void> {
  if (resources === undefined) {
    await update(db);
    return;
  }
  const { attemptId, snapshot } = resources;
  if (isResourceSnapshotDownload(snapshot)) {
    await db.transaction(async (transaction) => {
      // A CAS conflict rejects the download before reading its sealed spool. All fragment
      // inserts, both JSON columns and the collected summary share this one transaction.
      const { ownerUserId, samplingId, evaluationId } = await update(transaction);
      await transaction.execute(sql`CREATE TEMP TABLE eval_resource_fragments (
        position bigint PRIMARY KEY, stream text NOT NULL, records json NOT NULL
      ) ON COMMIT DROP`);
      const counts = { usageEvents: 0, nativeRecords: 0, billingSettlements: 0 };
      let lastSeq = 0;
      const verifiedSubmissions = new Set([snapshot.summary.scope.submissionId]);
      let position = 0;
      let usagePair: readonly Record<string, unknown>[] | undefined;
      let billingStarted = false;
      let actionPage = false;
      for await (const page of snapshot.readPages()) {
        const { stream, records } = page;
        if (!["nativeRecords", "usageEvents", "billingSettlements"].includes(stream)
          || !Array.isArray(records) || actionPage) {
          throw new Error("Sealed resource download has an invalid page");
        }
        if (stream === "nativeRecords") {
          if (billingStarted) {
            throw new Error("Native resource page follows billing facts");
          }
          for (const entry of records) {
            if (!nativeTrajectoryEntrySchema.safeParse(entry).success || entry.ingestSeq <= lastSeq
              || !nativeRecordMayBelongToScope(entry.record, snapshot.summary.scope, verifiedSubmissions)) {
              throw new Error("Sealed resource download has a foreign or unordered native record");
            }
            lastSeq = entry.ingestSeq;
            if (entry.record.submissionId !== null) verifiedSubmissions.add(entry.record.submissionId);
          }
        } else if (!jsonObjectArrayInPlaceSchema.safeParse(records).success) {
          throw new Error("Sealed resource download has invalid resource facts");
        } else if (stream === "usageEvents") {
          billingStarted = true;
          if (usagePair) throw new Error("Resource usage is not followed by its settlements");
          usagePair = records;
        } else if (stream === "billingSettlements") {
          if (usagePair) {
            if (records.length !== usagePair.length || records.some((fact, index) =>
              typeof usagePair![index]?.eventId !== "string" || !usagePair![index]?.eventId
              || fact.eventId !== usagePair![index]?.eventId)) {
              throw new Error("Sealed resource billing facts do not match usage in source order");
            }
            usagePair = undefined;
          } else {
            if (!billingStarted) throw new Error("Resource action facts have no API billing page");
            actionPage = true;
          }
        }
        const bytes = JSON.stringify(records);
        if (Buffer.byteLength(bytes) > 4_000_000) throw new Error("Sealed resource page exceeds the public byte bound");
        counts[stream] += records.length;
        if (!Number.isSafeInteger(counts[stream])) throw new Error("Resource page count exceeds safe integers");
        await transaction.execute(sql`INSERT INTO pg_temp.eval_resource_fragments (position, stream, records)
          VALUES (${position++}, ${stream}, ${bytes}::json)`);
      }
      if (usagePair || !actionPage || Object.keys(counts).some((stream) =>
        counts[stream as keyof typeof counts] !== snapshot.summary.counts[stream as keyof typeof counts])) {
        throw new Error("Sealed resource download is incomplete or changed before storage");
      }
      // JSON (not jsonb) preserves contract-permitted escaped surrogates and NUL.
      // PostgreSQL assembles the existing two columns without returning a full
      // nativeRecords/usage array or a whole JSON snapshot to the Node process.
      const parts = (stream: keyof typeof counts) => sql`coalesce((
        SELECT json_agg(item.value ORDER BY chunk.position, item.ordinal)
        FROM pg_temp.eval_resource_fragments AS chunk
        CROSS JOIN LATERAL json_array_elements(chunk.records) WITH ORDINALITY AS item(value, ordinal)
        WHERE chunk.stream = ${stream}
      ), '[]'::json)`;
      const { summary } = snapshot;
      await transaction.execute(sql`WITH body AS (
        SELECT json_build_object(
          'scope', ${JSON.stringify(summary.scope)}::json,
          'observedAt', ${summary.observedAt},
          'finalized', ${summary.finalized},
          'coverage', ${JSON.stringify(summary.coverage)}::json,
          'readiness', ${JSON.stringify(summary.readiness)}::json,
          'usageEvents', ${parts("usageEvents")},
          'nativeRecords', ${parts("nativeRecords")},
          'billingSettlements', ${parts("billingSettlements")}
        ) AS snapshot
      )
      INSERT INTO eval_attempt_resources
        (stage, record_id, attempt_id, owner_user_id, sampling_id, evaluation_id, snapshot, metric_snapshot)
      SELECT ${evaluationId === undefined ? "execution" : "evaluation"}, ${evaluationId ?? samplingId},
        ${attemptId}, ${ownerUserId}, ${samplingId}, ${evaluationId ?? null}, body.snapshot, body.snapshot FROM body
      ON CONFLICT (stage, record_id, attempt_id) DO UPDATE
        SET snapshot = excluded.snapshot, metric_snapshot = excluded.metric_snapshot`);
    });
    return;
  }
  const metricSnapshot = await compactResourceSnapshot(snapshot);
  await db.transaction(async (transaction) => {
    const { ownerUserId, samplingId, evaluationId } = await update(transaction);
    await transaction.insert(attemptResources).values({
      stage: evaluationId === undefined ? "execution" : "evaluation",
      recordId: evaluationId ?? samplingId,
      attemptId, ownerUserId, samplingId, evaluationId: evaluationId ?? null, snapshot, metricSnapshot,
    }).onConflictDoUpdate({
      target: [attemptResources.stage, attemptResources.recordId, attemptResources.attemptId],
      // Refer to the inserted row so the snapshot is serialized only once.
      set: { snapshot: sql`excluded.snapshot`, metricSnapshot: sql`excluded.metric_snapshot` },
    });
  });
}

/** The Metrics projections of one record's Attempts, by Attempt ID. */
async function metricSnapshots(
  reader: RecordReader, ownerUserId: string, stage: "execution" | "evaluation", recordId: string,
): Promise<ReadonlyMap<string, AgentResourceSnapshot>> {
  const rows = await reader.select({ attemptId: attemptResources.attemptId, snapshot: attemptResources.metricSnapshot })
    .from(attemptResources).where(and(eq(attemptResources.ownerUserId, ownerUserId),
      eq(attemptResources.stage, stage), eq(attemptResources.recordId, recordId)));
  return new Map(rows.map((row) => [row.attemptId, row.snapshot]));
}

function withSnapshot<T extends { readonly resources?: AgentResourceState }>(
  attempt: T, attemptId: string, snapshots: ReadonlyMap<string, AgentResourceSnapshot>,
): WithResourceSnapshot<T> {
  // Pending and failed resources carry no snapshot.
  if (attempt.resources?.status !== "collected") return attempt as WithResourceSnapshot<T>;
  const snapshot = snapshots.get(attemptId);
  if (!snapshot) throw new MetricsSourceError(`Attempt ${attemptId} has no stored resource snapshot`);
  return { ...attempt, resources: { ...attempt.resources, snapshot } };
}

/** One Sampling with the Metrics projection of each collected Attempt's snapshot. */
export async function readMetricSampling(reader: RecordReader, ownerUserId: string, sampling: Sampling): Promise<MetricsSampling> {
  const snapshots = await metricSnapshots(reader, ownerUserId, "execution", sampling.samplingId);
  return {
    ...sampling,
    executionAttempts: sampling.executionAttempts.map((attempt) => withSnapshot(attempt, attempt.executionAttemptId, snapshots)),
  };
}

/** One EvaluationRecord with the Metrics projection of each collected Attempt's snapshot. */
export async function readMetricEvaluation(reader: RecordReader, ownerUserId: string, evaluation: EvaluationRecord): Promise<MetricsEvaluation> {
  const snapshots = await metricSnapshots(reader, ownerUserId, "evaluation", evaluation.evaluationId);
  return {
    ...evaluation,
    attempts: evaluation.attempts.map((attempt) => withSnapshot(attempt, attempt.evaluationAttemptId, snapshots)),
  };
}

const SNAPSHOT_CHUNK_BYTES = 1 << 20;

/** Owner-scoped reads of raw snapshots for current records of a non-deleted Project. */
export function createPostgresResourceSnapshotReader(db: EvalDb, ownerUserId: string) {
  const owner = requireOwnerUserId(ownerUserId);
  return {
    /**
     * Streams one Attempt's stored raw snapshot as its JSON text through a cursor, a chunk of bytes
     * at a time, never parsing it; null when there is no such snapshot.
     */
    async open(projectId: string, stage: "execution" | "evaluation", recordId: string, attemptId: string): Promise<ReadableStream<Uint8Array> | null> {
      const body = db.select({ bytes: sql`convert_to(${attemptResources.snapshot}::text, 'UTF8')`.as("bytes") }).from(attemptResources)
        .innerJoin(samplings, and(eq(samplings.ownerUserId, attemptResources.ownerUserId), eq(samplings.samplingId, attemptResources.samplingId)))
        .innerJoin(projects, eq(projects.projectId, samplings.projectId))
        .where(and(eq(attemptResources.ownerUserId, owner), eq(attemptResources.stage, stage), eq(attemptResources.recordId, recordId),
          eq(attemptResources.attemptId, attemptId), visibleProject(projectId, owner)));
      const query = new PgDialect().sqlToQuery(sql`WITH body AS MATERIALIZED (${body})
        SELECT substring(body.bytes FROM start FOR ${SNAPSHOT_CHUNK_BYTES}) AS chunk
        FROM body, generate_series(1, octet_length(body.bytes), ${SNAPSHOT_CHUNK_BYTES}) AS start`);
      const client = await db.$client.connect();
      let open = true;
      const close = async (failed = false) => {
        if (!open) return;
        open = false;
        try {
          await client.query(failed ? "ROLLBACK" : "COMMIT");
          client.release();
        } catch (error) {
          client.release(error as Error);
        }
      };
      const next = async () => (await client.query<{ chunk: Buffer }>("FETCH 1 FROM resource_snapshot")).rows[0]?.chunk;
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await client.query(`DECLARE resource_snapshot NO SCROLL CURSOR FOR ${query.sql}`, query.params);
        let pending = await next();
        if (pending === undefined) {
          await close();
          return null;
        }
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = pending ?? await next();
              pending = undefined;
              if (chunk === undefined) {
                await close();
                controller.close();
              } else {
                controller.enqueue(chunk);
              }
            } catch (error) {
              await close(true);
              controller.error(error);
            }
          },
          cancel: () => close(true),
        });
      } catch (error) {
        await close(true);
        throw error;
      }
    },
  };
}
