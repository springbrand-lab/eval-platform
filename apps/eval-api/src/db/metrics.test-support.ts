import type { ExecutionPlan } from "@eval-platform/eval-contracts";
import { expect } from "vitest";
import { projectExecutionPlans, projects } from "./schema.js";
import { createTestDriver, driverRow } from "./test-driver.js";

export const metricsOwner = "metrics-owner";

export function metricsDriver(input: readonly {
  readonly projectId: string;
  readonly ownerUserId?: string;
  readonly deleted?: boolean;
}[] = [{ projectId: "first" }, { projectId: "second" }]) {
  const records = new Map(input.map(({ projectId, ownerUserId = metricsOwner, deleted = false }) => {
    const project: typeof projects.$inferSelect = {
      projectId, ownerUserId, name: projectId, description: null, sourceBranch: "release",
      creationKey: `create-${projectId}`, creationFingerprint: "fingerprint",
      createdAt: new Date("2026-01-01T00:00:00.000Z"), deletedAt: deleted ? new Date() : null,
    };
    const plan: ExecutionPlan = {
      harness: { kind: "sp", framework: "sp", agentConfig: { ownerUserId, userAgentId: `subject-${projectId}` } },
      subjectAgentConfig: { sourceUserAgentId: "source", name: "执行 Agent", body: { setting: { model: "model" } } },
      executionConcurrency: 1, retryPolicy: { maxRestarts: 0, initialBackoffMs: 250, maxBackoffMs: 10_000 },
    };
    const execution: typeof projectExecutionPlans.$inferSelect = { projectId, ownerUserId, plan, digest: "digest" };
    return [projectId, { project, execution }] as const;
  }));
  const driver = createTestDriver(({ text, params }) => {
    let rows: unknown[][] = [];
    if (/^(begin|commit|rollback)\b/u.test(text)) return rows;
    expect(text).toMatch(/^select /u);
    const table = / from "([^"]+)"/u.exec(text)?.[1];
    if (table === "eval_projects") {
      expect(text).toContain('"eval_projects"."project_id" = $1');
      expect(text).toContain('"eval_projects"."owner_user_id" = $2');
      expect(text).toContain('"eval_projects"."deleted_at" is null');
      const record = records.get(String(params[0]));
      if (record !== undefined && record.project.ownerUserId === params[1] && record.project.deletedAt === null) {
        rows = [[...driverRow(projects, record.project), ...driverRow(projectExecutionPlans, record.execution)]];
      }
    } else {
      expect([
        "eval_project_datasets", "eval_project_sample_datasets", "eval_project_evaluation_plans",
        "eval_project_samples", "eval_samplings", "eval_evaluations", "eval_run_samplings",
      ]).toContain(table);
    }
    return rows;
  });
  return { ...driver, records };
}
