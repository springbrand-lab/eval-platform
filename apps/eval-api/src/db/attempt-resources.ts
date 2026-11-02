import {
  isResourceSnapshotDownload, jsonObjectArrayInPlaceSchema, nativeRecordMayBelongToScope, nativeTrajectoryEntrySchema,
  type AgentResourceSnapshot, type AgentResourceState, type EvaluationRecord, type Sampling,
} from "@eval-platform/eval-contracts";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import {
  compactResourceSnapshot,
  MetricsSourceError,
  type MetricsEvaluation,
  type MetricsSampling,
  type WithResourceSnapshot,
} from "@eval-platform/eval-metrics";
import type { AttemptResourceSnapshot } from "@eval-platform/eval-runtime";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { READ_SNAPSHOT, type EvalDb } from "./client.js";
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
          'observedAt', ${summary.observedAt}::text,
          'finalized', ${summary.finalized}::boolean,
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

export interface CaseUsageQuery {
  readonly projectId: string;
  readonly samplingId: string;
  readonly role: "execution" | "evaluation";
  readonly evaluationId?: string | undefined;
  readonly runId?: string | undefined;
  readonly section: "attempts" | "models" | "actions";
  readonly attemptId?: string | undefined;
  readonly page: number;
  readonly pageSize: number;
}

/** Only fixed scalar paths, never the JSON column, nativeRecords or an arbitrary fact object. */
const bounded = (value: SQL, max: number) =>
  sql`CASE WHEN char_length(${value}) BETWEEN 1 AND ${max} THEN ${value} END`;
const number = (parent: SQL, key: string) =>
  sql`CASE WHEN json_typeof(${parent}->${key}::text) = 'number'
    AND char_length(${parent}->>${key}::text) <= 32 THEN ${parent}->>${key}::text END`;
const actionFact = sql`(b.value->>'executionId' IS NOT NULL OR b.value->>'source' IN ('action', 'tool')
  OR (b.value->>'chargedCredits' IS NOT NULL AND b.value->>'eventId' IS NULL))`;

/** Owner-scoped reads of raw snapshots for current records of a non-deleted Project. */
export function createPostgresResourceSnapshotReader(db: EvalDb, ownerUserId: string) {
  const owner = requireOwnerUserId(ownerUserId);
  return {
    /**
     * A consistent, server-side JSON projection. Only up to ten scalar rows cross into Node;
     * PostgreSQL expands the stored JSON (including historical huge snapshots) on each page.
     */
    readCaseUsage(input: CaseUsageQuery) {
      const { projectId, samplingId, role, evaluationId, runId, section, attemptId, page, pageSize } = input;
      const idKey = role === "execution" ? "executionAttemptId" : "evaluationAttemptId";
      const scope = sql`SELECT ${role === "execution" ? sql`s.facts->'executionAttempts'` : sql`e.facts->'attempts'`} AS attempts
        FROM eval_samplings AS s
        JOIN eval_projects AS p ON p.project_id = s.project_id AND p.owner_user_id = s.owner_user_id
        ${role === "evaluation" ? sql`JOIN eval_evaluations AS e ON e.sampling_id = s.sampling_id
          AND e.owner_user_id = s.owner_user_id AND e.evaluation_id = ${evaluationId}` : sql``}
        WHERE p.project_id = ${projectId} AND p.owner_user_id = ${owner} AND p.deleted_at IS NULL
          AND s.sampling_id = ${samplingId} AND s.owner_user_id = ${owner}
          ${runId === undefined ? sql`` : sql`AND EXISTS (SELECT 1 FROM eval_runs AS r
            JOIN ${role === "execution" ? sql`eval_run_samplings` : sql`eval_run_evaluations`} AS m
              ON m.run_id = r.run_id AND m.owner_user_id = r.owner_user_id
            WHERE r.run_id = ${runId} AND r.owner_user_id = ${owner} AND r.project_id = ${projectId}
              ${role === "execution" ? sql`AND r.operation IN ('execution', 'pipeline')` : sql``}
              AND m.sampling_id = s.sampling_id
              ${role === "evaluation" ? sql`AND m.evaluation_id = e.evaluation_id` : sql``})`}`;
      const attemptSource = sql`FROM (${scope}) AS target
        CROSS JOIN LATERAL jsonb_array_elements(target.attempts) WITH ORDINALITY AS a(value, ordinal)`;
      const attemptFields = sql`
        ${bounded(sql`a.value->>${idKey}::text`, 512)} AS "attemptId",
        ${bounded(sql`a.value->>'attemptNumber'`, 16)} AS "attemptNumber",
        ${bounded(sql`a.value->>'status'`, 32)} AS status,
        ${bounded(sql`a.value->'resources'->>'status'`, 16)} AS "resourcesStatus",
        ${bounded(sql`a.value->'resources'->'summary'->>'finalized'`, 8)} AS finalized,
        ${bounded(sql`a.value->'resources'->'summary'->'coverage'->>'usageEvents'`, 16)} AS "usageCoverage",
        ${bounded(sql`a.value->'resources'->'summary'->'coverage'->>'nativeRecords'`, 16)} AS "nativeCoverage",
        ${bounded(sql`a.value->'resources'->'summary'->'coverage'->>'billingSettlements'`, 16)} AS "billingCoverage",
        ${bounded(sql`a.value->'resources'->'summary'->'readiness'->'actionCharges'->>'complete'`, 8)} AS "actionsComplete",
        ${bounded(sql`a.value->'resources'->'summary'->'readiness'->'actionCharges'->>'unsettledExecutions'`, 16)} AS "unsettledExecutions",
        ${bounded(sql`a.value->'resources'->'summary'->'readiness'->'actionCharges'->>'missingExecutionIds'`, 16)} AS "missingExecutionIds"`;
      const offset = (page - 1) * pageSize;
      return db.transaction(async (transaction) => {
        const [target] = (await transaction.execute<{ total: number }>(sql`
          SELECT jsonb_array_length(attempts) AS total FROM (${scope}) AS target`)).rows;
        if (!target) throw new HttpError(role === "execution" ? "SAMPLING_NOT_FOUND" : "EVALUATION_NOT_FOUND");
        if (!Number.isSafeInteger(target.total) || target.total < 0) throw new HttpError("RESPONSE_INVALID");
        if (section === "attempts") {
          const { rows } = await transaction.execute<Record<string, unknown>>(sql`
            SELECT ${attemptFields} ${attemptSource}
            ORDER BY a.ordinal OFFSET ${offset} LIMIT ${pageSize}`);
          return { total: target.total, rows, attempt: null };
        }
        const selected = (await transaction.execute<Record<string, unknown>>(sql`
          SELECT ${attemptFields} ${attemptSource}
          WHERE a.value->>${idKey}::text = ${attemptId} LIMIT 2`)).rows;
        if (selected.length !== 1) throw new HttpError("RESOURCE_SNAPSHOT_NOT_FOUND");
        const attempt = selected[0]!;
        if (attempt.resourcesStatus !== "collected") return { total: null, rows: [], attempt };
        const snapshot = sql`FROM eval_attempt_resources AS r WHERE r.owner_user_id = ${owner}
          AND r.stage = ${role} AND r.record_id = ${evaluationId ?? samplingId}
          AND r.sampling_id = ${samplingId} AND r.attempt_id = ${attemptId}
          AND r.evaluation_id ${role === "execution" ? sql`IS NULL` : sql`= ${evaluationId}`}`;
        const actionRows = sql`FROM json_array_elements(r.snapshot->'billingSettlements') AS b(value) WHERE ${actionFact}`;
        const counted = section === "models"
          ? sql`CASE WHEN json_typeof(r.snapshot->'usageEvents') = 'array'
            AND json_typeof(r.snapshot->'billingSettlements') = 'array'
            THEN json_array_length(r.snapshot->'usageEvents') END`
          : sql`CASE WHEN json_typeof(r.snapshot->'billingSettlements') = 'array'
            THEN (SELECT count(*)::integer ${actionRows}) END`;
        const [stored] = (await transaction.execute<{ total: number | null }>(sql`
          SELECT ${counted} AS total ${snapshot}`)).rows;
        if (!stored) return { total: null, rows: [], attempt };
        if (stored.total === null || !Number.isSafeInteger(stored.total) || stored.total < 0) {
          throw new HttpError("RESPONSE_INVALID");
        }
        if (offset >= stored.total) return { total: stored.total, rows: [], attempt };
        const body = sql`SELECT r.snapshot AS snapshot ${snapshot}`;
        if (section === "models") {
          const { rows } = await transaction.execute<Record<string, unknown>>(sql`
            WITH body AS MATERIALIZED (${body}),
              page AS MATERIALIZED (
                SELECT u.value AS fact, u.ordinal FROM body
                CROSS JOIN LATERAL json_array_elements(body.snapshot->'usageEvents') WITH ORDINALITY AS u(value, ordinal)
                WHERE u.ordinal > ${offset} ORDER BY u.ordinal LIMIT ${pageSize})
            SELECT page.ordinal::integer AS "index",
              ${bounded(sql`page.fact->>'eventId'`, 128)} AS "eventId",
              ${bounded(sql`page.fact->>'kind'`, 32)} AS kind,
              ${bounded(sql`page.fact->'providerMetadata'->>'provider'`, 96)} AS provider,
              ${bounded(sql`page.fact->'providerMetadata'->>'model'`, 96)} AS model,
              ${number(sql`page.fact->'metrics'`, "inputTokens")} AS "inputTokens",
              ${number(sql`page.fact->'metrics'`, "outputTokens")} AS "outputTokens",
              ${number(sql`page.fact->'metrics'`, "cacheReadTokens")} AS "cacheReadTokens",
              ${number(sql`page.fact->'metrics'`, "cacheWriteTokens")} AS "cacheWriteTokens",
              ${number(sql`page.fact->'metrics'`, "reasoningTokens")} AS "reasoningTokens",
              ${number(sql`page.fact->'metrics'`, "totalTokens")} AS "totalTokens",
              ${number(sql`page.fact->'providerCostUsd'`, "total")} AS "providerUsd",
              (SELECT count(*)::integer FROM json_array_elements(body.snapshot->'usageEvents') AS duplicate(value)
                WHERE page.fact->>'eventId' IS NOT NULL
                  AND duplicate.value->>'eventId' = page.fact->>'eventId') AS "usageMatches",
              bill.matches AS "settlementMatches", bill.account AS "accountPresent", bill.status,
              bill.rated AS "ratedUnits", bill.debited AS "debitedUnits", bill.shortfall AS "shortfallUnits",
              bill.platform AS "platformOwnedUnits"
            FROM page CROSS JOIN body
            CROSS JOIN LATERAL (
              SELECT count(*)::integer AS matches,
                bool_and(b.value->>'accountId' IS NOT NULL AND b.value->>'accountId' <> '') AS account,
                min(${bounded(sql`b.value->>'status'`, 32)}) AS status,
                min(${number(sql`b.value`, "ratedUnits")}) AS rated,
                min(${number(sql`b.value`, "debitedUnits")}) AS debited,
                min(${number(sql`b.value`, "shortfallUnits")}) AS shortfall,
                min(${number(sql`b.value->'platformOwned'`, "units")}) AS platform
              FROM json_array_elements(body.snapshot->'billingSettlements') AS b(value)
              WHERE page.fact->>'eventId' IS NOT NULL AND page.fact->>'eventId' <> ''
                AND b.value->>'executionId' IS NULL AND b.value->>'eventId' = page.fact->>'eventId'
            ) AS bill ORDER BY page.ordinal`);
          return { total: stored.total, rows, attempt };
        }
        const { rows } = await transaction.execute<Record<string, unknown>>(sql`
          WITH body AS MATERIALIZED (${body}),
            page AS MATERIALIZED (
              SELECT b.value AS fact, b.ordinal FROM body
              CROSS JOIN LATERAL json_array_elements(body.snapshot->'billingSettlements') WITH ORDINALITY AS b(value, ordinal)
              WHERE ${actionFact}
              ORDER BY b.ordinal OFFSET ${offset} LIMIT ${pageSize})
          SELECT page.ordinal::integer AS "index",
            ${bounded(sql`page.fact->>'executionId'`, 128)} AS "executionId",
            ${bounded(sql`page.fact->>'status'`, 32)} AS status,
            ${number(sql`page.fact`, "chargedCredits")} AS "chargedCredits",
            (SELECT count(*)::integer FROM json_array_elements(body.snapshot->'billingSettlements') AS duplicate(value)
              WHERE page.fact->>'executionId' IS NOT NULL AND page.fact->>'executionId' <> ''
                AND duplicate.value->>'executionId' = page.fact->>'executionId') AS "executionMatches"
          FROM page CROSS JOIN body ORDER BY page.ordinal`);
        return { total: stored.total, rows, attempt };
      }, READ_SNAPSHOT);
    },
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
