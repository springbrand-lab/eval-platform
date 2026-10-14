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
import { BundleResourceInUseError, createResourceCatalog } from "./db/resource-catalog.js";
import { createInitialResourceApi } from "./initial-resources.js";
import { createInitialResourceHttpHandler } from "./initial-resources.http.js";
import { openBundleDirectory } from "./sp/bundle-directory.js";

const connection = process.env.DATABASE_URL;
const owner = "11111111-1111-4111-8111-111111111111";
const otherOwner = "22222222-2222-4222-8222-222222222222";

function request(path: string, method: string, body?: unknown): Request {
  return new Request(`http://eval.test${path}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe.skipIf(!connection)("Dataset resource catalog", () => {
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

  it("creates, edits, lists and soft-deletes individual resources while existing Data keeps its refs", async () => {
    const db = createEvalDb(pool);
    const dataset = createDatasetService(createPostgresDatasetStore(db, owner));
    const original = await dataset.createData({ userPrompt: "Build page", metadata: { priority: 3 } });
    const bundles = await openBundleDirectory(bundleRoot);
    const handle = createInitialResourceHttpHandler(db, bundles);
    const created = await handle(request("/api/bundles", "POST", {
      name: "Assets", description: "Seed assets",
    }), owner);
    expect(created?.status).toBe(201);
    const bundle = await created!.json() as { bundleId: string };
    expect(bundle.bundleId).toMatch(/^[0-9a-f-]{36}$/u);
    const root = `/api/bundles/${bundle.bundleId}`;
    expect((await handle(request(root, "PATCH", { description: "Updated assets" }), owner))?.status).toBe(200);
    expect(await (await handle(request("/api/bundles", "GET"), owner))!.json())
      .toContainEqual(expect.objectContaining({ bundleId: bundle.bundleId, description: "Updated assets" }));

    const materialResponse = await handle(request(`${root}/materials`, "POST", {
      name: "Brief", description: "Execution input", files: [
        { path: "/brief/brief.txt", mediaType: "text/plain", contentBase64: "SGVsbG8=" },
      ],
    }), owner);
    expect(materialResponse?.status).toBe(201);
    const uploadedMaterial = await materialResponse!.json() as { bundleId: string; materialId: string };
    const material = { bundleId: uploadedMaterial.bundleId, materialId: uploadedMaterial.materialId };
    const evalResponse = await handle(request(`${root}/materials`, "POST", {
      name: "Rubric", description: "Evaluation input", files: [
        { path: "/rubric.md", mediaType: "text/markdown", contentBase64: "UnVicmlj" },
      ],
    }), owner);
    const uploadedEvalMaterial = await evalResponse!.json() as { bundleId: string; materialId: string };
    const evalMaterial = { bundleId: uploadedEvalMaterial.bundleId, materialId: uploadedEvalMaterial.materialId };
    const sessionResponse = await handle(request(`${root}/sessions`, "POST", {
      name: "Prior chat", description: "Execution history", format: "json", content: JSON.stringify({
        entries: [{ id: "m1", message: { role: "user", content: "Earlier task" }, createdAt: 1 }],
      }),
    }), owner);
    expect(sessionResponse?.status).toBe(201);
    const uploadedSession = await sessionResponse!.json() as { bundleId: string; sessionId: string };
    const session = { bundleId: uploadedSession.bundleId, sessionId: uploadedSession.sessionId };
    expect((await handle(request(`${root}/materials/${material.materialId}`, "PATCH", {
      name: "Updated brief",
    }), owner))?.status).toBe(200);
    expect((await handle(request(`${root}/sessions/${session.sessionId}`, "PATCH", {
      description: "Updated history",
    }), owner))?.status).toBe(200);
    expect(await (await handle(request(`${root}/materials`, "GET"), owner))!.json()).toHaveLength(2);
    expect(await (await handle(request(`${root}/sessions`, "GET"), owner))!.json()).toHaveLength(1);

    const api = createInitialResourceApi(db, owner, bundles);
    const bound = await api.bindData(original.dataId, {
      initialMaterials: material, evalInitialMaterials: evalMaterial, initialSession: session,
    });
    expect(bound).toMatchObject({ initialMaterials: material, evalInitialMaterials: evalMaterial,
      initialSession: session });
    await expect(createInitialResourceApi(db, otherOwner, bundles)
      .bindData(original.dataId, { initialMaterials: null })).rejects.toThrow(/Unknown data/u);
    await expect(handle(request(`${root}/materials/${material.materialId}`, "DELETE"), owner))
      .rejects.toThrow(/still bound to Data/u);
    await expect(handle(request(`${root}/sessions/${session.sessionId}`, "DELETE"), owner))
      .rejects.toThrow(/still bound to Data/u);
    await expect(handle(request(root, "DELETE"), owner)).rejects.toThrow(/still bound to Data/u);
    expect(await dataset.getData(original.dataId)).toMatchObject({ initialMaterials: material });
    await api.bindData(original.dataId, {
      initialMaterials: null, evalInitialMaterials: null, initialSession: null,
    });
    const genericBound = await dataset.createData({ userPrompt: "Generic", initialMaterials: material });
    await expect(handle(request(`${root}/materials/${material.materialId}`, "DELETE"), owner))
      .rejects.toThrow(/still bound to Data/u);
    await dataset.updateData(genericBound.dataId, { userPrompt: "Generic" });
    expect((await handle(request(`${root}/materials/${material.materialId}`, "DELETE"), owner))?.status).toBe(204);
    expect(await (await handle(request(`${root}/materials`, "GET"), owner))!.json()).toHaveLength(1);
    await expect(api.bindData(original.dataId, { initialMaterials: material })).rejects.toThrow(/Unknown Material/u);
    await expect(bundles.resolveInitialMaterials(owner, material)).resolves.toHaveLength(1);
    expect((await handle(request(root, "DELETE"), owner))?.status).toBe(204);
    expect(await (await handle(request("/api/bundles", "GET"), owner))!.json()).toEqual([]);
    await expect(api.bindData(original.dataId, { initialSession: session })).rejects.toThrow(/Unknown Session/u);
    await expect(bundles.resolveInitialSession(owner, session)).resolves.toBeDefined();
    await expect(dataset.createData({ userPrompt: "New", initialMaterials: material }))
      .rejects.toThrow(/Unknown Material/u);
    await expect(dataset.updateData(original.dataId, { userPrompt: "Build page", initialSession: session }))
      .rejects.toThrow(/Unknown Session/u);
    const datasetsBefore = await dataset.listDatasets();
    await expect(dataset.importDataset(JSON.stringify({
      dataset: { name: "Invalid refs" }, data: [{ userPrompt: "New", initialMaterials: material }],
    }), "json")).rejects.toThrow(/Unknown Material/u);
    expect(await dataset.listDatasets()).toEqual(datasetsBefore);
  });

  it("keeps UUID resource bindings effective when the client uses uppercase IDs", async () => {
    const db = createEvalDb(pool);
    const directory = await openBundleDirectory(bundleRoot);
    const catalog = createResourceCatalog(db, owner, directory);
    const dataset = createDatasetService(createPostgresDatasetStore(db, owner));
    const bundle = await catalog.createBundle({ name: "Case bundle", description: "UUID case test" });
    const material = await catalog.createMaterial(bundle.bundleId, {
      name: "Case material", description: "One file",
      files: [{ path: "/case.txt", mediaType: "text/plain", contentBase64: "Y2FzZQ==" }],
    });
    const session = await catalog.createSession(bundle.bundleId, {
      name: "Case session", description: "One history", format: "json",
      content: JSON.stringify({ entries: [{
        id: "m1", message: { role: "user", content: "Earlier task" }, createdAt: 1,
      }] }),
    });
    const upperRef = {
      bundleId: bundle.bundleId.toUpperCase(), materialId: material.materialId.toUpperCase(),
    };
    const upperSession = {
      bundleId: bundle.bundleId.toUpperCase(), sessionId: session.sessionId.toUpperCase(),
    };
    const row = await dataset.createData({
      userPrompt: "Test case", initialMaterials: upperRef, initialSession: upperSession,
    });

    await expect(catalog.deleteMaterial(bundle.bundleId, material.materialId))
      .rejects.toBeInstanceOf(BundleResourceInUseError);
    await expect(catalog.deleteSession(bundle.bundleId, session.sessionId))
      .rejects.toBeInstanceOf(BundleResourceInUseError);
    await expect(catalog.deleteBundle(bundle.bundleId))
      .rejects.toBeInstanceOf(BundleResourceInUseError);
    expect(await dataset.getData(row.dataId)).toMatchObject({
      initialMaterials: { bundleId: bundle.bundleId, materialId: material.materialId },
      initialSession: { bundleId: bundle.bundleId, sessionId: session.sessionId },
    });

    const second = await dataset.createData({ userPrompt: "Bind later" });
    const bound = await createInitialResourceApi(db, owner, directory)
      .bindData(second.dataId, { evalInitialMaterials: upperRef });
    expect(bound.evalInitialMaterials).toEqual({
      bundleId: bundle.bundleId, materialId: material.materialId,
    });
    const imported = await dataset.importDataset(JSON.stringify({
      dataset: { name: "Imported case" },
      data: [{ userPrompt: "Import later", initialMaterials: upperRef }],
    }), "json");
    expect(imported.data[0]?.initialMaterials).toEqual({
      bundleId: bundle.bundleId, materialId: material.materialId,
    });
    const updated = await dataset.createData({ userPrompt: "Update later" });
    await dataset.updateData(updated.dataId, { userPrompt: "Update later", initialSession: upperSession });
    expect((await dataset.getData(updated.dataId))?.initialSession).toEqual({
      bundleId: bundle.bundleId, sessionId: session.sessionId,
    });
    await dataset.updateData(row.dataId, { userPrompt: "Test case" });
    await dataset.updateData(second.dataId, { userPrompt: "Bind later" });
    await dataset.updateData(imported.data[0]!.dataId, { userPrompt: "Import later" });
    await dataset.updateData(updated.dataId, { userPrompt: "Update later" });
    await catalog.deleteMaterial(bundle.bundleId, material.materialId);
    await catalog.deleteSession(bundle.bundleId, session.sessionId);
    await catalog.deleteBundle(bundle.bundleId);
  });

  it("uploads a standalone output format and binds only its ID to Project", async () => {
    const db = createEvalDb(pool);
    const catalog = createPostgresProjectCatalog(db, owner, {
      sourceBranch: "release-2.0.0", sourceCommit: "a".repeat(40),
    });
    const project = await catalog.createProject({ name: "Schema project" });
    const handle = createInitialResourceHttpHandler(db, await openBundleDirectory(bundleRoot));
    const schema = { type: "object", required: ["score"], properties: { score: { type: "number" } } };
    const upload = await handle(request("/api/evaluation-output-schemas", "POST", {
      name: "Score format", description: "Evaluator result", content: JSON.stringify(schema),
    }), owner);
    expect(upload?.status).toBe(201);
    const output = await upload!.json() as { outputSchemaId: string };
    expect(output.outputSchemaId).toMatch(/^[0-9a-f-]{36}$/u);
    const item = `/api/evaluation-output-schemas/${output.outputSchemaId}`;
    expect((await handle(request(item, "PATCH", { name: "Score v1" }), owner))?.status).toBe(200);
    expect(await (await handle(request(item, "GET"), owner))!.json()).toMatchObject({
      name: "Score v1", description: "Evaluator result", schema,
    });
    await expect(handle(request(item, "PATCH", { content: '{"type":"string"}' }), owner))
      .rejects.toThrow(/Metadata patch/u);
    const binding = `/api/projects/${project.projectId}/evaluation-output-schema`;
    const result = await handle(request(binding, "PUT", { outputSchemaId: output.outputSchemaId }), owner);
    expect(await result?.json()).toMatchObject({ evaluationOutputSchemaId: output.outputSchemaId });
    expect(await catalog.listProjects()).toContainEqual(expect.objectContaining({
      projectId: project.projectId, evaluationOutputSchemaId: output.outputSchemaId,
    }));
    expect(await catalog.getProject(project.projectId)).toMatchObject({
      evaluationOutputSchemaId: output.outputSchemaId, evaluationOutputSchema: schema,
    });
    await expect(handle(request(item, "DELETE"), owner)).rejects.toThrow(/still bound to a Project/u);
    expect((await handle(request(binding, "PUT", { outputSchemaId: null }), owner))?.status).toBe(200);
    expect(await catalog.getProject(project.projectId)).not.toHaveProperty("evaluationOutputSchemaId");
    expect((await handle(request(item, "DELETE"), owner))?.status).toBe(204);
    expect(await (await handle(request("/api/evaluation-output-schemas", "GET"), owner))!.json()).toEqual([]);
    const another = await catalog.createProject({ name: "Another" });
    await expect(handle(request(`/api/projects/${another.projectId}/evaluation-output-schema`, "PUT", {
      outputSchemaId: output.outputSchemaId,
    }), owner)).rejects.toThrow(/Unknown output format/u);
    await expect(handle(request(binding, "PUT", { outputSchemaId: output.outputSchemaId }), otherOwner))
      .rejects.toThrow(/Unknown Project/u);
  });
});
