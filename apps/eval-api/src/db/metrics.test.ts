import { describe, expect, it } from "vitest";
import { createPostgresMetricsSource, createPostgresProjectComparisonSource } from "./metrics.js";
import { metricsDriver, metricsOwner } from "./metrics.test-support.js";

describe("PostgreSQL Metrics source transaction seam", () => {
  it("reads every selected Project in order on one read-only repeatable-read connection", async () => {
    const f = metricsDriver();
    const facts = await createPostgresProjectComparisonSource(f.db, metricsOwner).read(["second", "first"]);
    expect(facts.map((value) => value.plan.project.projectId)).toEqual(["second", "first"]);
    expect(facts.map((value) => value.plan.project.ownerUserId)).toEqual([metricsOwner, metricsOwner]);
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(new Set(f.queries.map((query) => query.connection))).toEqual(new Set([0]));
    expect(f.queries[0]?.text).toBe("begin isolation level repeatable read read only");
    expect(f.queries.at(-1)?.text).toBe("commit");
    expect(f.releases[0]).toHaveBeenCalledTimes(1);
    expect(f.queries.filter((query) => query.text.includes(' from "eval_projects"')).map((query) => query.params))
      .toEqual([["second", metricsOwner], ["first", metricsOwner]]);
  });

  it("returns the same complete facts as the original single-Project source", async () => {
    const f = metricsDriver();
    const ids = ["first", "second"];
    const compared = await createPostgresProjectComparisonSource(f.db, metricsOwner).read(ids);
    const source = createPostgresMetricsSource(f.db, metricsOwner);
    const original = [];
    for (const projectId of ids) original.push(await source.read({ projectId }));
    expect(compared).toEqual(original);
  });

  it.each(["unknown", "foreign", "deleted"])("rejects the whole snapshot if either side is %s", async (inaccessible) => {
    for (const projectIds of [["first", inaccessible], [inaccessible, "first"]]) {
      const f = metricsDriver([
        { projectId: "first" }, { projectId: "foreign", ownerUserId: "other-owner" }, { projectId: "deleted", deleted: true },
      ]);
      await expect(createPostgresProjectComparisonSource(f.db, metricsOwner).read(projectIds)).rejects.toMatchObject({
        name: "MetricsEntityNotFoundError", entity: "project", id: inaccessible,
      });
      expect(f.connect).toHaveBeenCalledTimes(1);
      expect(f.queries.at(-1)?.text).toBe("rollback");
      expect(f.queries.some((query) => query.text === "commit")).toBe(false);
      expect(f.releases[0]).toHaveBeenCalledTimes(1);
    }
  });

  it("requires the same explicit owner for both Metrics sources", () => {
    const f = metricsDriver();
    expect(() => createPostgresProjectComparisonSource(f.db, "")).toThrow(TypeError);
    expect(() => createPostgresMetricsSource(f.db, "")).toThrow(TypeError);
    expect(f.connect).not.toHaveBeenCalled();
  });
});
