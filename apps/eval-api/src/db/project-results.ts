import { RuntimeEntityNotFoundError, planProjectSampleIds, type ProjectSample } from "@eval-platform/eval-runtime";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import type { ProjectResultsRecord, ProjectResultsSource } from "../projects/evaluation-results.js";
import { READ_SNAPSHOT, type EvalDb } from "./client.js";
import { requireOwnerUserId } from "./owner.js";
import { readEvaluationOutputSchema, readProjectPlan, readProjectSamples } from "./project-plans.js";
import { evaluationFromRow, samplingFromRow, type RecordReader } from "./run-records.js";
import { evaluations, samplings } from "./schema.js";

const SAMPLE_PAGE_SIZE = 32;

async function acquireClient(db: EvalDb, signal: AbortSignal): Promise<PoolClient> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    db.$client.connect().then((client) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) {
        client.release();
        reject(signal.reason);
      } else {
        resolve(client);
      }
    }, (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

async function* samples(
  reader: RecordReader, projectId: string, projectSampleIds: readonly string[], signal: AbortSignal,
): AsyncIterable<ProjectSample> {
  for (let offset = 0; offset < projectSampleIds.length; offset += SAMPLE_PAGE_SIZE) {
    signal.throwIfAborted();
    const ids = projectSampleIds.slice(offset, offset + SAMPLE_PAGE_SIZE);
    const page = await readProjectSamples(reader, projectId, ids);
    signal.throwIfAborted();
    for (const [index, sample] of page.entries()) {
      if (sample === null) throw new Error(`ProjectSample ${ids[index]} is missing from the frozen Project`);
      yield sample;
    }
  }
}

interface ResultRow {
  readonly sampling_id: string;
  readonly project_id: string;
  readonly project_sample_id: string;
  readonly sampling_facts: typeof samplings.$inferSelect.facts;
  readonly evaluation_id: string | null;
  readonly evaluation_facts: typeof evaluations.$inferSelect.facts | null;
}

async function* records(
  reader: RecordReader, client: PoolClient, projectId: string, ownerUserId: string, signal: AbortSignal,
): AsyncIterable<ProjectResultsRecord> {
  const query = reader.select({
    samplingId: samplings.samplingId,
    projectId: samplings.projectId,
    projectSampleId: samplings.projectSampleId,
    samplingFacts: sql`${samplings.facts}`.as("sampling_facts"),
    evaluationId: evaluations.evaluationId,
    evaluationFacts: sql`${evaluations.facts}`.as("evaluation_facts"),
  }).from(samplings)
    .leftJoin(evaluations, and(eq(evaluations.ownerUserId, samplings.ownerUserId), eq(evaluations.samplingId, samplings.samplingId)))
    .where(and(eq(samplings.projectId, projectId), eq(samplings.ownerUserId, ownerUserId))).toSQL();
  signal.throwIfAborted();
  await client.query(`DECLARE project_results NO SCROLL CURSOR FOR ${query.sql}`, query.params);
  for (;;) {
    signal.throwIfAborted();
    const [row] = (await client.query<ResultRow>("FETCH 1 FROM project_results")).rows;
    signal.throwIfAborted();
    if (row === undefined) return;
    yield {
      sampling: samplingFromRow({
        samplingId: row.sampling_id, projectId: row.project_id, projectSampleId: row.project_sample_id, facts: row.sampling_facts,
      }),
      evaluation: row.evaluation_id === null ? null : evaluationFromRow({
        evaluationId: row.evaluation_id, samplingId: row.sampling_id, facts: row.evaluation_facts!,
      }),
    };
  }
}

export function createPostgresProjectResultsSource(db: EvalDb, ownerUserId: string): ProjectResultsSource {
  const owner = requireOwnerUserId(ownerUserId);
  return async (projectId, signal) => {
    const client = await acquireClient(db, signal);
    let released = false;
    let closing: Promise<void> | undefined;
    const release = (destroy = false) => {
      if (released) return;
      released = true;
      signal.removeEventListener("abort", onAbort);
      client.release(destroy);
    };
    const onAbort = () => release(true);
    signal.addEventListener("abort", onAbort, { once: true });
    const close = (failed = false): Promise<void> => {
      closing ??= (async () => {
        if (released) return;
        try {
          await client.query(failed ? "ROLLBACK" : "COMMIT");
        } catch (error) {
          release(true);
          throw error;
        } finally {
          release();
        }
      })();
      return closing;
    };
    try {
      signal.throwIfAborted();
      await client.query(`BEGIN ISOLATION LEVEL ${READ_SNAPSHOT.isolationLevel} ${READ_SNAPSHOT.accessMode}`);
      const reader = drizzle(client);
      const plan = await readProjectPlan(reader, projectId, owner);
      signal.throwIfAborted();
      if (!plan) throw new RuntimeEntityNotFoundError("project", projectId);
      const outputSchema = await readEvaluationOutputSchema(reader, projectId, owner);
      signal.throwIfAborted();
      return {
        plan, outputSchema,
        samples: samples(reader, projectId, planProjectSampleIds(plan), signal),
        records: records(reader, client, projectId, owner, signal),
        close,
      };
    } catch (error) {
      await close(true).catch(() => {});
      throw error;
    }
  };
}
