import type {
  AgentRole,
  EvaluationPlan,
  EvaluationOutputSchemaDocument,
  ExecutionPlan,
  Project,
  ProjectDatasetSnapshot,
} from "@eval-platform/eval-contracts";
import { DatasetEntityNotFoundError, dataSchema, type Data } from "@eval-platform/eval-dataset";
import {
  RuntimeEntityNotFoundError,
  RuntimeInputError,
  RuntimeProjectBusyError,
  RuntimeRunIdentityConflictError,
  type ProjectSample,
  type ProjectView,
  type RuntimeRunRecord,
} from "@eval-platform/eval-runtime";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { addToGroup, sqlBatches } from "./batch.js";
import type { FrozenCopy } from "../agent-configs.js";
import type { DatasetSelection } from "../projects/schemas.js";
import { constraintViolation, READ_SNAPSHOT, type EvalDb } from "./client.js";
import { ProjectCreationKeyTakenError, ProjectEvaluationPlanLockedError } from "./errors.js";
import { requireOwnerUserId } from "./owner.js";
import {
  projectExists,
  projectFromRow,
  readAllProjectSamples,
  readEvaluationOutputSchemaDocument,
  readProjectPlan,
  visibleProject,
} from "./project-plans.js";
import { projectHasRun, readRunRecords, runActive } from "./run-records.js";
import { readProjectRunState } from "./runtime.js";
import {
  data,
  datasetData,
  datasets,
  projectAgentConfigs,
  projectDatasets,
  projectEvaluationPlans,
  projectExecutionPlans,
  PROJECT_CREATION_KEY_UQ,
  projects,
  projectSampleDatasets,
  projectSamples,
  runs,
} from "./schema.js";

type Writer = Parameters<Parameters<EvalDb["transaction"]>[0]>[0];

/** One selected source Dataset with its selected members in the Dataset's member order. */
export interface SelectedDataset {
  readonly dataset: Omit<ProjectDatasetSnapshot, "projectSampleIds">;
  readonly data: readonly Data[];
}

export type FrozenAgentConfig = FrozenCopy & { readonly role: AgentRole };

export interface ProjectSnapshot {
  readonly project: Project;
  readonly datasets: readonly ProjectDatasetSnapshot[];
  readonly samples: readonly ProjectSample[];
  readonly execution: { readonly plan: ExecutionPlan; readonly digest: string };
  readonly evaluation: { readonly plan: EvaluationPlan; readonly digest: string } | null;
  readonly agentConfigs: readonly FrozenAgentConfig[];
  /** The creation request's idempotency key and body fingerprint. */
  readonly creation: { readonly key: string; readonly fingerprint: string };
}

/** A Project found by its creation key, deleted or not, with the stored first-Run identity for verification. */
export interface StoredProjectCreation {
  readonly project: Project;
  readonly deleted: boolean;
  readonly fingerprint: string;
  /** Full immutable Run identity and its admission order; current memberships alone cannot prove creation. */
  readonly run: (RuntimeRunRecord & { readonly sequence: number }) | null;
  /** All frozen ProjectSample targets, in the same Dataset/member binding order as an initial `{all:true}` preview. */
  readonly firstRunProjectSampleIds: readonly string[];
  /** No Run was admitted under the creation key, but the Project already has other Runs. */
  readonly superseded: boolean;
  /** Current persisted plan digests; used to keep an approved first Run bound to its original plan. */
  readonly planDigests: { readonly execution: string; readonly evaluation?: string };
  /** A retired Evaluator copy proves the pre-first-Run evaluation plan was replaced. */
  readonly evaluationReplaced: boolean;
}

/** The single definition of an editable evaluation plan: absent, or not yet locked by an evaluating Run. */
async function requireEvaluationPlanUnlocked(reader: Pick<EvalDb, "select">, projectId: string): Promise<void> {
  const [plan] = await reader.select({ lockedAt: projectEvaluationPlans.lockedAt })
    .from(projectEvaluationPlans).where(eq(projectEvaluationPlans.projectId, projectId));
  if (plan?.lockedAt) throw new ProjectEvaluationPlanLockedError(projectId);
}

/** Locks the visible Project row; false when it is gone or soft-deleted. */
async function tryLockProject(transaction: Writer, owner: string, projectId: string): Promise<boolean> {
  const [row] = await transaction.select({ projectId: projects.projectId }).from(projects)
    .where(visibleProject(projectId, owner)).for("update");
  return row !== undefined;
}

async function lockProject(transaction: Writer, owner: string, projectId: string): Promise<void> {
  if (!await tryLockProject(transaction, owner, projectId)) throw new RuntimeEntityNotFoundError("project", projectId);
}

/** Owner-scoped Project snapshot persistence; the plan is written once, only the evaluation plan is replaceable. */
export function createPostgresProjectStore(db: EvalDb, ownerUserId: string) {
  const owner = requireOwnerUserId(ownerUserId);
  return {
    /** Reads the selected owned, non-deleted Datasets and their current members in one consistent snapshot. */
    readSelection(selections: readonly DatasetSelection[]): Promise<SelectedDataset[]> {
      return db.transaction(async (transaction) => {
        const ids = selections.map((selection) => selection.datasetId);
        const rows = await transaction.select().from(datasets)
          .where(and(eq(datasets.ownerUserId, owner), inArray(datasets.datasetId, ids), isNull(datasets.deletedAt)));
        const members = await transaction
          .select({ datasetId: datasetData.datasetId, dataId: data.dataId, content: data.content }).from(datasetData)
          .innerJoin(data, and(eq(data.dataId, datasetData.dataId), eq(data.ownerUserId, datasetData.ownerUserId)))
          .where(and(eq(datasetData.ownerUserId, owner), inArray(datasetData.datasetId, ids), isNull(data.deletedAt)))
          .orderBy(datasetData.datasetId, data.dataId);
        const byId = new Map(rows.map((row) => [row.datasetId, row]));
        const membersOf = new Map<string, Data[]>();
        for (const member of members) {
          addToGroup(membersOf, member.datasetId, dataSchema.parse({ ...member.content, dataId: member.dataId }));
        }
        return selections.map((selection, index) => {
          const row = byId.get(selection.datasetId);
          if (!row) throw new DatasetEntityNotFoundError("dataset", selection.datasetId);
          const current = membersOf.get(row.datasetId) ?? [];
          let selected = current;
          if (selection.dataIds !== undefined) {
            const wanted = new Set(selection.dataIds);
            selected = current.filter((record) => wanted.delete(record.dataId));
            const [missing] = wanted;
            if (missing !== undefined) {
              throw new RuntimeInputError(`Data ${missing} is not a current member of Dataset ${row.datasetId}`, `datasets.${index}.dataIds`);
            }
          }
          return {
            dataset: {
              datasetId: row.datasetId, name: row.name, kind: row.kind,
              ...(row.description === null ? {} : { description: row.description }),
            },
            data: selected,
          };
        });
      }, READ_SNAPSHOT);
    },

    /** Persists metadata, Dataset/Data snapshots, both plans and frozen-copy rows in one transaction. */
    async create(snapshot: ProjectSnapshot): Promise<void> {
      const { project, execution, evaluation } = snapshot;
      const projectId = project.projectId;
      await db.transaction(async (transaction) => {
        await transaction.insert(projects).values({
          projectId, ownerUserId: owner, name: project.name, description: project.description ?? null,
          sourceBranch: project.sourceBranch, createdAt: new Date(project.createdAt),
          creationKey: snapshot.creation.key, creationFingerprint: snapshot.creation.fingerprint,
        }).catch((error: unknown) => {
          if (constraintViolation(error)?.constraint === PROJECT_CREATION_KEY_UQ) throw new ProjectCreationKeyTakenError();
          throw error;
        });
        const datasetRows = snapshot.datasets.map((dataset, position) => ({
          ownerUserId: owner, projectId, datasetId: dataset.datasetId, position,
          name: dataset.name, description: dataset.description ?? null, kind: dataset.kind,
        }));
        for (const batch of sqlBatches(datasetRows)) await transaction.insert(projectDatasets).values(batch);
        for (const batch of sqlBatches(snapshot.samples)) {
          await transaction.insert(projectSamples).values(batch.map((sample) => ({
            projectSampleId: sample.projectSampleId, ownerUserId: owner, projectId,
            dataId: sample.dataId, data: sample.data, samplingCount: sample.samplingCount,
          })));
        }
        const memberships = snapshot.datasets.flatMap((dataset) => dataset.projectSampleIds.map((projectSampleId, position) => ({
          ownerUserId: owner, projectId, datasetId: dataset.datasetId, projectSampleId, position,
        })));
        for (const batch of sqlBatches(memberships)) await transaction.insert(projectSampleDatasets).values(batch);
        await transaction.insert(projectExecutionPlans).values({ projectId, ownerUserId: owner, ...execution });
        if (evaluation) {
          await transaction.insert(projectEvaluationPlans).values({
            projectId, ownerUserId: owner, ...evaluation, outputSchemaId: evaluation.plan.outputSchema.outputSchemaId,
          });
        }
        await transaction.insert(projectAgentConfigs).values(snapshot.agentConfigs.map((config) => ({
          ...config, ownerUserId: owner, projectId, sourceUserAgentId: config.snapshot.sourceUserAgentId,
        })));
      });
    },

    /** One read-only snapshot of the Project and the stored creation-key Run's immutable identity. */
    findCreation(key: string): Promise<StoredProjectCreation | null> {
      return db.transaction(async (transaction) => {
        const [row] = await transaction.select().from(projects)
          .where(and(eq(projects.ownerUserId, owner), eq(projects.creationKey, key)));
        if (!row) return null;
        const [first] = await transaction.select({ runId: runs.runId, sequence: runs.sequence }).from(runs)
          .where(and(eq(runs.projectId, row.projectId), eq(runs.idempotencyKey, key))).limit(1);
        const [record] = first
          ? await readRunRecords(transaction, [first.runId], { kind: "project", ownerUserId: owner, projectId: row.projectId })
          : [];
        if (first && !record) throw new RuntimeRunIdentityConflictError("Project creation key has an unreadable Run");
        const bound = record ? await transaction.select({ projectSampleId: projectSampleDatasets.projectSampleId })
          .from(projectDatasets).innerJoin(projectSampleDatasets, and(
            eq(projectSampleDatasets.projectId, projectDatasets.projectId),
            eq(projectSampleDatasets.datasetId, projectDatasets.datasetId),
          ))
          .where(eq(projectDatasets.projectId, row.projectId))
          .orderBy(projectDatasets.position, projectSampleDatasets.position) : [];
        const [execution] = await transaction.select({ digest: projectExecutionPlans.digest }).from(projectExecutionPlans)
          .where(eq(projectExecutionPlans.projectId, row.projectId));
        if (!execution) throw new Error("Project has no stored execution plan");
        const [evaluation] = await transaction.select({ digest: projectEvaluationPlans.digest }).from(projectEvaluationPlans)
          .where(eq(projectEvaluationPlans.projectId, row.projectId));
        const [retiredEvaluator] = await transaction.select({ userAgentId: projectAgentConfigs.userAgentId }).from(projectAgentConfigs)
          .where(and(eq(projectAgentConfigs.projectId, row.projectId), eq(projectAgentConfigs.role, "evaluator"),
            isNotNull(projectAgentConfigs.retiredAt))).limit(1);
        return {
          project: projectFromRow(row),
          deleted: row.deletedAt !== null,
          fingerprint: row.creationFingerprint,
          run: record ? { ...record, sequence: first!.sequence } : null,
          firstRunProjectSampleIds: [...new Set(bound.map(({ projectSampleId }) => projectSampleId))],
          superseded: record === undefined && await projectHasRun(transaction, row.projectId),
          planDigests: { execution: execution.digest, ...(evaluation ? { evaluation: evaluation.digest } : {}) },
          evaluationReplaced: retiredEvaluator !== undefined,
        };
      }, READ_SNAPSHOT);
    },

    /**
     * Removes a non-deleted Project that never got a Run and returns its frozen-copy IDs for SP deletion;
     * anything else (gone, soft-deleted by the user, or with a Run) is kept and yields `[]`.
     */
    async deleteUnrun(projectId: string): Promise<string[]> {
      return db.transaction(async (transaction) => {
        if (!await tryLockProject(transaction, owner, projectId) || await projectHasRun(transaction, projectId)) return [];
        const copies = await transaction.select({ userAgentId: projectAgentConfigs.userAgentId }).from(projectAgentConfigs)
          .where(eq(projectAgentConfigs.projectId, projectId));
        for (const table of [projectAgentConfigs, projectEvaluationPlans, projectExecutionPlans, projectSampleDatasets,
          projectSamples, projectDatasets]) {
          await transaction.delete(table).where(eq(table.projectId, projectId));
        }
        await transaction.delete(projects).where(eq(projects.projectId, projectId));
        return copies.map((copy) => copy.userAgentId);
      });
    },

    /** Fails early, before any SP copy is made, when the evaluation plan can no longer be replaced. */
    async requireEvaluationPlanEditable(projectId: string): Promise<void> {
      if (!await projectExists(db, projectId, owner)) throw new RuntimeEntityNotFoundError("project", projectId);
      await requireEvaluationPlanUnlocked(db, projectId);
    },

    /**
     * Replaces the unlocked evaluation plan under the Project row lock that admission also takes,
     * retiring the previous Evaluator copy. Returns the retired copies' IDs.
     */
    async replaceEvaluationPlan(projectId: string, evaluation: {
      readonly plan: EvaluationPlan;
      readonly digest: string;
      readonly agentConfig: FrozenAgentConfig;
    }): Promise<string[]> {
      return db.transaction(async (transaction) => {
        await lockProject(transaction, owner, projectId);
        await requireEvaluationPlanUnlocked(transaction, projectId);
        const row = { plan: evaluation.plan, digest: evaluation.digest, outputSchemaId: evaluation.plan.outputSchema.outputSchemaId };
        await transaction.insert(projectEvaluationPlans).values({ projectId, ownerUserId: owner, ...row })
          .onConflictDoUpdate({ target: projectEvaluationPlans.projectId, set: row });
        const retired = await transaction.update(projectAgentConfigs).set({ retiredAt: new Date() })
          .where(and(eq(projectAgentConfigs.projectId, projectId), eq(projectAgentConfigs.role, "evaluator"),
            isNull(projectAgentConfigs.retiredAt)))
          .returning({ userAgentId: projectAgentConfigs.userAgentId });
        await transaction.insert(projectAgentConfigs).values({
          ...evaluation.agentConfig, ownerUserId: owner, projectId,
          sourceUserAgentId: evaluation.agentConfig.snapshot.sourceUserAgentId,
        });
        return retired.map((config) => config.userAgentId);
      });
    },

    /** Soft delete; refused while any Run is active. */
    async softDelete(projectId: string): Promise<void> {
      await db.transaction(async (transaction) => {
        await lockProject(transaction, owner, projectId);
        const [active] = await transaction.select({ runId: runs.runId }).from(runs)
          .where(and(eq(runs.projectId, projectId), runActive(transaction))).limit(1);
        if (active) throw new RuntimeProjectBusyError(projectId, active.runId);
        await transaction.update(projects).set({ deletedAt: new Date() }).where(eq(projects.projectId, projectId));
      });
    },

    async list(): Promise<Project[]> {
      const rows = await db.select().from(projects).where(and(eq(projects.ownerUserId, owner), isNull(projects.deletedAt)))
        .orderBy(desc(projects.createdAt), projects.projectId);
      return rows.map(projectFromRow);
    },

    exists(projectId: string): Promise<boolean> {
      return projectExists(db, projectId, owner);
    },

    getEvaluationOutputSchema(projectId: string): Promise<EvaluationOutputSchemaDocument | null> {
      return db.transaction(async (transaction) => {
        if (!await projectExists(transaction, projectId, owner)) throw new RuntimeEntityNotFoundError("project", projectId);
        return readEvaluationOutputSchemaDocument(transaction, projectId, owner);
      }, READ_SNAPSHOT);
    },

    get(projectId: string): Promise<ProjectView | null> {
      return db.transaction(async (transaction) => {
        const plan = await readProjectPlan(transaction, projectId, owner);
        if (!plan) return null;
        const samples = await readAllProjectSamples(transaction, plan);
        const runState = await readProjectRunState(transaction, owner, projectId);
        return { ...plan, projectSamples: samples, ...runState };
      }, READ_SNAPSHOT);
    },

    /** Which of these Agent Config IDs are this owner's frozen Project copies, current or retired. */
    async frozenAgentConfigIds(ids: readonly string[]): Promise<Set<string>> {
      if (ids.length === 0) return new Set();
      const rows = await db.select({ userAgentId: projectAgentConfigs.userAgentId }).from(projectAgentConfigs)
        .where(and(eq(projectAgentConfigs.ownerUserId, owner), inArray(projectAgentConfigs.userAgentId, [...ids])));
      return new Set(rows.map((row) => row.userAgentId));
    },
  };
}

export type PostgresProjectStore = ReturnType<typeof createPostgresProjectStore>;
