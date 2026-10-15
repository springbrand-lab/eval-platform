import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDatasetService } from "@eval-platform/eval-dataset";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEvalDb } from "./db/client.js";
import { createPostgresDatasetStore } from "./db/dataset.js";
import { createPostgresProjectPlanReader } from "./db/project-plans.js";
import { seedProject } from "./db/test-fixtures.js";
import { BundleResourceInUseError, BundleResourceNotFoundError } from "./db/errors.js";
import { createResourceCatalog } from "./db/resource-catalog.js";
import { createInitialResourceApi } from "./initial-resources.js";
import { createOwnerServices } from "./owner-services.js";
import { openBundleDirectory, type BundleDirectory } from "./sp/bundle-directory.js";
import type { EvalSpClient } from "./sp/client.js";
import { authorized, jsonRequest, requestApp, WEB_ORIGIN } from "./test-support.js";

const connection = process.env.DATABASE_URL;
const owner = "11111111-1111-4111-8111-111111111111";
const otherOwner = "22222222-2222-4222-8222-222222222222";

const release = { sourceBranch: "release-2.0.0", sourceCommit: "a".repeat(40) };
const sp = {
  async getAgentConfig(_token: string, id: string) { return { id, user_id: owner, name: id }; },
} as EvalSpClient;

/** One full HTTP stack per service account over PostgreSQL; `token` picks the account. */
function httpClient(db: ReturnType<typeof createEvalDb>, bundles: BundleDirectory) {
  const ownerServices = createOwnerServices({ db, sp, bundles, release, runQueue: { async enqueue() {} } });
  const send = (token: string) => requestApp({
    webOrigin: WEB_ORIGIN, sp, ownerServices,
    spAdminToken: "admin-token",
    observation: {} as never,
    serviceAccount: { user: { id: token === "other" ? otherOwner : owner, role: "user" }, email: `${token}@test`, sessionToken: token },
  });
  const apps = { owner: send("owner"), other: send("other") };
  return async (path: string, method: string, body?: unknown, token: "owner" | "other" = "owner") => apps[token](path,
    body === undefined ? authorized(token, { method }) : jsonRequest(method, body, token));
}

async function msg<T>(response: Response): Promise<T> {
  return (await response.json() as { msg: T }).msg;
}

async function code(response: Response): Promise<string> {
  return (await response.json() as { code: string }).code;
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
    const send = httpClient(db, bundles);
    const created = await send("/api/bundles", "POST", { name: "Assets", description: "Seed assets" });
    expect(created.status).toBe(201);
    const bundle = await msg<{ bundleId: string }>(created);
    expect(bundle.bundleId).toMatch(/^[0-9a-f-]{36}$/u);
    const root = `/api/bundles/${bundle.bundleId}`;
    expect((await send(root, "PATCH", { description: "Updated assets" })).status).toBe(200);
    expect(await msg(await send("/api/bundles", "GET")))
      .toContainEqual(expect.objectContaining({ bundleId: bundle.bundleId, description: "Updated assets" }));
    expect(await msg(await send("/api/bundles", "GET", undefined, "other"))).toEqual([]);

    const materialResponse = await send(`${root}/materials`, "POST", {
      name: "Brief", description: "Execution input", files: [
        { path: "/brief/brief.txt", mediaType: "text/plain", contentBase64: "SGVsbG8=" },
      ],
    });
    expect(materialResponse.status).toBe(201);
    const uploadedMaterial = await msg<{ bundleId: string; materialId: string }>(materialResponse);
    const material = { bundleId: uploadedMaterial.bundleId, materialId: uploadedMaterial.materialId };
    const evalResponse = await send(`${root}/materials`, "POST", {
      name: "Rubric", description: "Evaluation input", files: [
        { path: "/rubric.md", mediaType: "text/markdown", contentBase64: "UnVicmlj" },
      ],
    });
    const uploadedEvalMaterial = await msg<{ bundleId: string; materialId: string }>(evalResponse);
    const evalMaterial = { bundleId: uploadedEvalMaterial.bundleId, materialId: uploadedEvalMaterial.materialId };
    const sessionResponse = await send(`${root}/sessions`, "POST", {
      name: "Prior chat", description: "Execution history", format: "json", content: JSON.stringify({
        entries: [{ id: "m1", message: { role: "user", content: "Earlier task" }, createdAt: 1 }],
      }),
    });
    expect(sessionResponse.status).toBe(201);
    const uploadedSession = await msg<{ bundleId: string; sessionId: string }>(sessionResponse);
    const session = { bundleId: uploadedSession.bundleId, sessionId: uploadedSession.sessionId };
    expect((await send(`${root}/materials/${material.materialId}`, "PATCH", { name: "Updated brief" })).status).toBe(200);
    expect((await send(`${root}/sessions/${session.sessionId}`, "PATCH", { description: "Updated history" })).status).toBe(200);
    expect(await msg(await send(`${root}/materials`, "GET"))).toHaveLength(2);
    expect(await msg(await send(`${root}/sessions`, "GET"))).toHaveLength(1);

    const bindingPath = `/api/data/${original.dataId}/initial-resources`;
    const bound = await send(bindingPath, "PATCH", {
      initialMaterials: material, evalInitialMaterials: evalMaterial, initialSession: session,
    });
    expect(await msg(bound)).toMatchObject({ initialMaterials: material, evalInitialMaterials: evalMaterial,
      initialSession: session });
    expect(await code(await send(bindingPath, "PATCH", {}))).toBe("REQUEST_VALIDATION_FAILED");
    expect(await code(await send(bindingPath, "PATCH", { initialMaterials: null }, "other"))).toBe("DATA_NOT_FOUND");
    for (const path of [`${root}/materials/${material.materialId}`, `${root}/sessions/${session.sessionId}`, root]) {
      const response = await send(path, "DELETE");
      expect(response.status).toBe(409);
      expect(await code(response)).toBe("BUNDLE_RESOURCE_IN_USE");
    }
    expect(await dataset.getData(original.dataId)).toMatchObject({ initialMaterials: material });
    const api = createInitialResourceApi(db, owner, bundles);
    await api.bindData(original.dataId, {
      initialMaterials: null, evalInitialMaterials: null, initialSession: null,
    });
    const genericBound = await dataset.createData({ userPrompt: "Generic", initialMaterials: material });
    expect((await send(`${root}/materials/${material.materialId}`, "DELETE")).status).toBe(409);
    await dataset.updateData(genericBound.dataId, { userPrompt: "Generic" });
    expect((await send(`${root}/materials/${material.materialId}`, "DELETE")).status).toBe(204);
    expect(await msg(await send(`${root}/materials`, "GET"))).toHaveLength(1);
    expect(await code(await send(bindingPath, "PATCH", { initialMaterials: material }))).toBe("BUNDLE_RESOURCE_NOT_FOUND");
    await expect(bundles.resolveInitialMaterials(owner, material)).resolves.toHaveLength(1);
    expect((await send(root, "DELETE")).status).toBe(204);
    expect(await msg(await send("/api/bundles", "GET"))).toEqual([]);
    await expect(api.bindData(original.dataId, { initialSession: session })).rejects.toBeInstanceOf(BundleResourceNotFoundError);
    await expect(bundles.resolveInitialSession(owner, session)).resolves.toBeDefined();
    await expect(dataset.createData({ userPrompt: "New", initialMaterials: material }))
      .rejects.toBeInstanceOf(BundleResourceNotFoundError);
    await expect(dataset.updateData(original.dataId, { userPrompt: "Build page", initialSession: session }))
      .rejects.toBeInstanceOf(BundleResourceNotFoundError);
    const datasetsBefore = await dataset.listDatasets();
    await expect(dataset.importDataset(JSON.stringify({
      dataset: { name: "Invalid refs" }, data: [{ userPrompt: "New", initialMaterials: material }],
    }), "json")).rejects.toBeInstanceOf(BundleResourceNotFoundError);
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

  it("uploads standalone output formats that evaluation plans keep reading after a soft delete", async () => {
    const db = createEvalDb(pool);
    const send = httpClient(db, await openBundleDirectory(bundleRoot));
    const schema = { type: "object", required: ["score"], properties: { score: { type: "number" } } };
    const upload = await send("/api/evaluation-output-schemas", "POST", {
      name: "Score format", description: "Evaluator result", content: JSON.stringify(schema),
    });
    expect(upload.status).toBe(201);
    const output = await msg<{ outputSchemaId: string }>(upload);
    expect(output.outputSchemaId).toMatch(/^[0-9a-f-]{36}$/u);
    const invalid = await send("/api/evaluation-output-schemas", "POST", {
      name: "Broken", description: "Not a Schema", content: JSON.stringify({ type: 42 }),
    });
    expect(invalid.status).toBe(400);
    expect(await code(invalid)).toBe("CATALOG_INPUT_INVALID");
    const item = `/api/evaluation-output-schemas/${output.outputSchemaId}`;
    expect((await send(item, "PATCH", { name: "Score v1" })).status).toBe(200);
    expect(await msg(await send(item, "GET"))).toMatchObject({ name: "Score v1", description: "Evaluator result", schema });
    expect(await code(await send(item, "PATCH", { content: '{"type":"string"}' }))).toBe("REQUEST_VALIDATION_FAILED");
    expect((await send(item, "DELETE")).status).toBe(204);
    expect(await code(await send(item, "DELETE"))).toBe("OUTPUT_SCHEMA_NOT_FOUND");

    const project = await seedProject(db, owner, { datasets: [{ data: [{ dataId: crypto.randomUUID(), userPrompt: "task" }] }], evaluation: true });
    const plans = createPostgresProjectPlanReader(db, owner);
    const bound = (await plans.getProjectPlan(project.projectId))!.evaluation!.plan.outputSchema.outputSchemaId;
    expect((await send(`/api/evaluation-output-schemas/${bound}`, "DELETE")).status).toBe(204);
    expect(await msg(await send("/api/evaluation-output-schemas", "GET"))).toEqual([]);
    expect(await plans.getEvaluationOutputSchema(project.projectId)).toMatchObject({ type: "object" });
    const replaced = await send(`/api/projects/${project.projectId}/evaluation-plan`, "PUT", {
      userAgentId: crypto.randomUUID(), evaluationConcurrency: 1, outputSchemaId: bound,
    });
    expect(await code(replaced)).toBe("OUTPUT_SCHEMA_NOT_FOUND");
  });
});
