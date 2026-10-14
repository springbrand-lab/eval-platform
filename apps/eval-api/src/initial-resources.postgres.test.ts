import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDatasetService } from "@eval-platform/eval-dataset";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEvalDb } from "./db/client.js";
import { createPostgresProjectCatalog } from "./db/catalog.js";
import { createPostgresDatasetStore } from "./db/dataset.js";
import { createInitialResourceApi } from "./initial-resources.js";
import { createInitialResourceHttpHandler } from "./initial-resources.http.js";
import { openBundleDirectory } from "./sp/bundle-directory.js";

const connection = process.env.DATABASE_URL;
const owner = "11111111-1111-4111-8111-111111111111";
const otherOwner = "22222222-2222-4222-8222-222222222222";
const materials = { bundleId: "project-assets", materialId: "brief" };
const evalMaterials = { bundleId: "project-assets", materialId: "judge-rubric" };
const session = { bundleId: "old-sessions", sessionId: "seed" };

describe.skipIf(!connection)("Data initial resource association", () => {
  let pool: Pool;
  let databaseName: string;
  let bundleRoot: string;

  beforeAll(async () => {
    databaseName = `eval_resources_${crypto.randomUUID().replaceAll("-", "")}`;
    const adminUrl = new URL(connection!);
    adminUrl.pathname = "/postgres";
    const admin = new Pool({ connectionString: adminUrl.toString() });
    try { await admin.query(`CREATE DATABASE "${databaseName}"`); }
    finally { await admin.end(); }
    const target = new URL(connection!);
    target.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: target.toString() });
    await migrate(createEvalDb(pool), { migrationsFolder: resolve("migrations-postgres") });
    bundleRoot = await mkdtemp(join(tmpdir(), "eval-resources-"));
  }, 30_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (bundleRoot) await rm(bundleRoot, { recursive: true, force: true });
    if (databaseName) {
      const adminUrl = new URL(connection!);
      adminUrl.pathname = "/postgres";
      const admin = new Pool({ connectionString: adminUrl.toString() });
      try { await admin.query(`DROP DATABASE "${databaseName}"`); }
      finally { await admin.end(); }
    }
  });

  it("uploads resources without editing Data and binds only existing owned references", async () => {
    const db = createEvalDb(pool);
    const dataset = createDatasetService(createPostgresDatasetStore(db, owner));
    const original = await dataset.createData({ userPrompt: "Build page", metadata: { priority: 3 } });
    const bundles = await openBundleDirectory(bundleRoot);
    const api = createInitialResourceApi(db, owner, bundles);
    const handle = createInitialResourceHttpHandler(db, bundles);
    await expect(handle(new Request(
      `http://eval.test/api/bundles/${materials.bundleId}/materials/${materials.materialId}`, {
        method: "PUT", body: JSON.stringify({ files: [], ownerUserId: otherOwner }),
      }), owner)).rejects.toThrow(/only a files array/u);
    const materialResponse = await handle(new Request(
      `http://eval.test/api/bundles/${materials.bundleId}/materials/${materials.materialId}`, {
        method: "PUT", body: JSON.stringify({ files: [
          { path: "/brief.txt", mediaType: "text/plain", contentBase64: "SGVsbG8=" },
        ] }),
      }), owner);
    expect(materialResponse?.status).toBe(200);
    await api.uploadMaterials(evalMaterials, [
      { path: "/rubric.md", mediaType: "text/markdown", contentBase64: "UnVicmlj" },
    ]);
    const sessionResponse = await handle(new Request(
      `http://eval.test/api/bundles/${session.bundleId}/sessions/${session.sessionId}`, {
        method: "PUT", body: JSON.stringify({ format: "json", content: JSON.stringify({
      entries: [{ id: "m1", message: { role: "user", content: "Earlier task" }, createdAt: 1 }],
    }) }),
      }), owner);
    expect(sessionResponse?.status).toBe(200);
    expect(await dataset.getData(original.dataId)).toEqual(original);

    await expect(handle(new Request(`http://eval.test/api/data/${original.dataId}/initial-resources`, {
      method: "PATCH", body: JSON.stringify({ initialMaterials: materials, ownerUserId: otherOwner }),
    }), owner)).rejects.toThrow(/must specify materials or Session/u);
    expect(await dataset.getData(original.dataId)).toEqual(original);

    const bindResponse = await handle(new Request(
      `http://eval.test/api/data/${original.dataId}/initial-resources`, {
        method: "PATCH", body: JSON.stringify({ initialMaterials: materials,
          evalInitialMaterials: evalMaterials, initialSession: session }),
      }), owner);
    expect(bindResponse?.status).toBe(200);
    const bound = await dataset.getData(original.dataId);
    expect(bound).toMatchObject({ metadata: { priority: 3 }, initialMaterials: materials,
      evalInitialMaterials: evalMaterials, initialSession: session });
    const cleared = await api.bindData(original.dataId, { initialMaterials: null });
    expect(cleared).not.toHaveProperty("initialMaterials");
    expect(cleared.initialSession).toEqual(session);
    expect(cleared.evalInitialMaterials).toEqual(evalMaterials);

    await expect(api.bindData(original.dataId, {
      initialMaterials: { bundleId: "missing", materialId: "file" },
    })).rejects.toThrow(/missing/u);
    expect(await dataset.getData(original.dataId)).toEqual(cleared);
    const referenceOnlySession = { bundleId: "old-sessions", sessionId: "no-context-file" };
    const referenceResponse = await handle(new Request(`http://eval.test/api/data/${original.dataId}/initial-resources`, {
      method: "PATCH", body: JSON.stringify({ initialSession: referenceOnlySession }),
    }), owner);
    expect(referenceResponse?.status).toBe(200);
    expect(await dataset.getData(original.dataId)).toMatchObject({ initialSession: referenceOnlySession });
    await expect(bundles.resolveInitialSession(owner, referenceOnlySession)).resolves.toBeUndefined();
    await expect(createInitialResourceApi(db, otherOwner, bundles)
      .bindData(original.dataId, { initialMaterials: null })).rejects.toThrow(/Unknown data/u);
  });

  it("binds an uploaded Project JSON Schema once and scopes it to its owner", async () => {
    const db = createEvalDb(pool);
    const catalog = createPostgresProjectCatalog(db, owner, {
      sourceBranch: "release-2.0.0", sourceCommit: "a".repeat(40),
    });
    const project = await catalog.createProject({ name: "Schema project" });
    const handle = createInitialResourceHttpHandler(db, await openBundleDirectory(bundleRoot));
    const url = `http://eval.test/api/projects/${project.projectId}/evaluation-output-schema`;
    const schema = { type: "object", required: ["score"], properties: { score: { type: "number" } } };
    const request = () => new Request(url, { method: "PUT", body: JSON.stringify(schema) });
    const response = await handle(request(), owner);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ evaluationOutputSchema: schema });
    expect(await catalog.getProject(project.projectId)).toMatchObject({ evaluationOutputSchema: schema });
    expect((await handle(request(), owner))?.status).toBe(200);
    await expect(handle(new Request(url, { method: "PUT", body: JSON.stringify({ type: "string" }) }), owner))
      .rejects.toThrow(/cannot change after binding/u);
    await expect(handle(request(), otherOwner)).rejects.toThrow(/Unknown Project/u);
  });
});
