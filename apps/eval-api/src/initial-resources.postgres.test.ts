import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatasetService } from "@eval-platform/eval-dataset";
import { EVAL_INITIAL_FILE_MAX_BYTES, EVAL_INITIALIZATION_MAX_BYTES, EVAL_MATERIAL_MAX_FILES } from "@springbrand/eval-harness";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EvalDb } from "./db/client.js";
import { createPostgresDatasetStore } from "./db/dataset.js";
import { createPostgresProjectPlanReader } from "./db/project-plans.js";
import { seedProject } from "./db/test-fixtures.js";
import { createTestDatabase } from "./db/test-database.js";
import { BundleResourceInUseError, BundleResourceNotFoundError } from "./db/errors.js";
import { createBundleCatalogs } from "./db/resource-catalog.js";
import { bundleMaterials } from "./db/schema.js";
import { createInitialResourceApi } from "./initial-resources.js";
import { createOwnerServices } from "./owner-services.js";
import { openBundleDirectory, type BundleDirectory } from "./sp/bundle-directory.js";
import { BundleFileError } from "./sp/bundle-errors.js";
import type { InitialResourceFile } from "@eval-platform/eval-contracts";
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
function httpClient(db: EvalDb, bundles: BundleDirectory) {
  const ownerServices = createOwnerServices({ db, sp, bundles, release, runQueue: { async enqueue() {} } });
  const send = (token: string) => requestApp({
    webOrigin: WEB_ORIGIN, sp, ownerServices,
    spAdminToken: "admin-token",
    observation: {} as never,
    serviceAccount: { user: { id: token === "other" ? otherOwner : owner, role: "user" }, email: `${token}@test`, sessionToken: token },
  });
  const apps = { owner: send("owner"), other: send("other") };
  return async (path: string, method: string, body?: unknown, token: "owner" | "other" = "owner") => apps[token](path,
    body === undefined ? authorized(token, { method })
      : body instanceof FormData ? authorized(token, { method, body }) : jsonRequest(method, body, token));
}

/** A multipart body; byte values become the uploaded file of their field. */
function form(fields: Record<string, string | Buffer>): FormData {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    body.append(name, typeof value === "string" ? value : new File([new Uint8Array(value)], `${name}.zip`));
  }
  return body;
}

async function zip(...entries: readonly (readonly [name: string, content: string])[]): Promise<Buffer> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const [name, content] of entries) await writer.add(name, new TextReader(content));
  return Buffer.from(await writer.close());
}

async function storedFiles(root: string): Promise<readonly string[]> {
  return (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort();
}

const sessionEntry = (id: string) => JSON.stringify({ id, message: { role: "user", content: "Earlier task" }, createdAt: 1 });
const sessionFile = (id: string) => JSON.stringify({ entries: [JSON.parse(sessionEntry(id))] });

async function msg<T>(response: Response): Promise<T> {
  return (await response.json() as { msg: T }).msg;
}

async function code(response: Response): Promise<string> {
  return (await response.json() as { code: string }).code;
}

describe.skipIf(!connection)("Dataset resource catalog", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let bundleRoot: string;

  beforeAll(async () => {
    database = await createTestDatabase(connection!);
    bundleRoot = await mkdtemp(join(tmpdir(), "eval-resources-"));
  }, 30_000);

  afterAll(async () => {
    try {
      if (bundleRoot) await rm(bundleRoot, { recursive: true, force: true });
    } finally {
      if (database) await database.destroy();
    }
  }, 30_000);

  it("creates, edits, lists and soft-deletes individual resources while existing Data keeps its refs", async () => {
    const db = database.db;
    const dataset = createDatasetService(createPostgresDatasetStore(db, owner));
    const original = await dataset.createData({ userPrompt: "Build page", metadata: { priority: 3 } });
    const bundles = await openBundleDirectory(bundleRoot);
    const send = httpClient(db, bundles);
    const created = await send("/api/material-bundles", "POST", form({ name: "Assets", description: "Seed assets" }));
    expect(created.status).toBe(201);
    const { bundle: materialBundle } = await msg<{ bundle: { bundleId: string } }>(created);
    expect(materialBundle.bundleId).toMatch(/^[0-9a-f-]{36}$/u);
    const root = `/api/material-bundles/${materialBundle.bundleId}`;
    expect((await send(root, "PATCH", { description: "Updated assets" })).status).toBe(200);
    expect(await msg(await send("/api/material-bundles", "GET")))
      .toContainEqual(expect.objectContaining({ bundleId: materialBundle.bundleId, description: "Updated assets" }));
    expect(await msg(await send("/api/material-bundles", "GET", undefined, "other"))).toEqual([]);
    const { bundle: sessionBundle } = await msg<{ bundle: { bundleId: string } }>(
      await send("/api/session-bundles", "POST", form({ name: "Histories", description: "Seed sessions" })));
    const sessionRoot = `/api/session-bundles/${sessionBundle.bundleId}`;
    expect(await msg(await send("/api/session-bundles", "GET")))
      .toEqual([expect.objectContaining({ bundleId: sessionBundle.bundleId })]);
    expect(await code(await send(`/api/material-bundles/${sessionBundle.bundleId}`, "GET"))).toBe("BUNDLE_RESOURCE_NOT_FOUND");
    expect(await code(await send(`/api/session-bundles/${materialBundle.bundleId}`, "GET"))).toBe("BUNDLE_RESOURCE_NOT_FOUND");

    const materialResponse = await send(`${root}/materials`, "POST", {
      name: "Brief", description: "Execution input", files: [
        { path: "/brief/brief.txt", mediaType: "text/plain", contentBase64: "SGVsbG8=" },
      ],
    });
    expect(materialResponse.status).toBe(201);
    expect(await materialResponse.clone().json()).toMatchObject({ msg: { byteSize: 5 } });
    const emptyFile = await send(`${root}/materials`, "POST", {
      name: "Placeholder", description: "Empty file", files: [{ path: "/.keep", mediaType: "text/plain", contentBase64: "" }],
    });
    expect(emptyFile.status).toBe(201);
    expect(await emptyFile.json()).toMatchObject({ msg: { byteSize: 0 } });
    const uploadedMaterial = await msg<{ bundleId: string; materialId: string }>(materialResponse);
    const material = { bundleId: uploadedMaterial.bundleId, materialId: uploadedMaterial.materialId };
    const evalResponse = await send(`${root}/materials`, "POST", {
      name: "Rubric", description: "Evaluation input", files: [
        { path: "/rubric.md", mediaType: "text/markdown", contentBase64: "UnVicmlj" },
      ],
    });
    const uploadedEvalMaterial = await msg<{ bundleId: string; materialId: string }>(evalResponse);
    const evalMaterial = { bundleId: uploadedEvalMaterial.bundleId, materialId: uploadedEvalMaterial.materialId };
    const rejectedUpload = (path: string, bytes: number) => send(`${root}/materials`, "POST", {
      name: "Rejected", description: "Not stored",
      files: [{ path, mediaType: "application/octet-stream", contentBase64: Buffer.alloc(bytes).toString("base64") }],
    });
    const oversized = await rejectedUpload("/big.bin", EVAL_INITIAL_FILE_MAX_BYTES + 1);
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ code: "BUNDLE_FILE_TOO_LARGE", errors: [{ path: "files.0" }] });
    const misplaced = await rejectedUpload("/../escape.bin", 1);
    expect(misplaced.status).toBe(400);
    expect(await misplaced.json()).toMatchObject({ code: "BUNDLE_FILE_INVALID", errors: [{ path: "files.0" }] });
    const crowded = await send(`${root}/materials`, "POST", {
      name: "Rejected", description: "Not stored", files: Array.from({ length: EVAL_MATERIAL_MAX_FILES + 1 },
        (_, index) => ({ path: `/${index}.txt`, mediaType: "text/plain", contentBase64: "YQ==" })),
    });
    expect(crowded.status).toBe(413);
    expect(await crowded.json()).toMatchObject({ code: "BUNDLE_FILE_TOO_LARGE", errors: [{ path: "files" }] });
    const empty = await send(`${root}/materials`, "POST", { name: "Rejected", description: "Not stored", files: [] });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ code: "BUNDLE_FILE_INVALID", errors: [{ path: "files" }] });
    const shapeless = await send(`${root}/materials`, "POST", { name: "Rejected", description: "Not stored", files: [{ path: 1 }] });
    expect(shapeless.status).toBe(422);
    const sessionResponse = await send(`${sessionRoot}/sessions`, "POST", {
      name: "Prior chat", description: "Execution history", format: "json", content: JSON.stringify({
        entries: [{ id: "m1", message: { role: "user", content: "Earlier task" }, createdAt: 1 }],
      }),
    });
    expect(sessionResponse.status).toBe(201);
    const uploadedSession = await msg<{ bundleId: string; sessionId: string }>(sessionResponse);
    const session = { bundleId: uploadedSession.bundleId, sessionId: uploadedSession.sessionId };
    expect((await send(`${root}/materials/${material.materialId}`, "PATCH", { name: "Updated brief" })).status).toBe(200);
    expect((await send(`${sessionRoot}/sessions/${session.sessionId}`, "PATCH", { description: "Updated history" })).status).toBe(200);
    expect(await msg(await send(`${root}/materials`, "GET"))).toHaveLength(3);
    expect(await msg(await send(`${sessionRoot}/sessions`, "GET"))).toHaveLength(1);

    const bindingPath = `/api/data/${original.dataId}/initial-resources`;
    const sessionInMaterialBundle = { bundleId: material.bundleId, sessionId: session.sessionId };
    const materialInSessionBundle = { bundleId: session.bundleId, materialId: material.materialId };
    for (const patch of [
      { initialSession: sessionInMaterialBundle },
      { initialMaterials: [materialInSessionBundle] },
      { evalInitialMaterials: [materialInSessionBundle] },
    ]) {
      const response = await send(bindingPath, "PATCH", patch);
      expect(response.status).toBe(404);
      expect(await code(response)).toBe("BUNDLE_RESOURCE_NOT_FOUND");
      await expect(dataset.createData({ userPrompt: "Cross", ...patch })).rejects.toBeInstanceOf(BundleResourceNotFoundError);
      await expect(dataset.updateData(original.dataId, { userPrompt: "Build page", ...patch }))
        .rejects.toBeInstanceOf(BundleResourceNotFoundError);
      await expect(dataset.importDataset(JSON.stringify({
        dataset: { name: "Cross refs" }, data: [{ userPrompt: "Cross", ...patch }],
      }), "json")).rejects.toBeInstanceOf(BundleResourceNotFoundError);
    }

    const bound = await send(bindingPath, "PATCH", {
      initialMaterials: [material], evalInitialMaterials: [evalMaterial], initialSession: session,
    });
    expect(await msg(bound)).toMatchObject({ initialMaterials: [material], evalInitialMaterials: [evalMaterial],
      initialSession: session });
    for (const patch of [{}, { initialMaterials: [] }, { initialMaterials: [material, material] }, { initialSession: [session] }]) {
      expect(await code(await send(bindingPath, "PATCH", patch))).toBe("REQUEST_VALIDATION_FAILED");
    }
    expect(await code(await send(bindingPath, "PATCH", { initialMaterials: null }, "other"))).toBe("DATA_NOT_FOUND");
    for (const path of [`${root}/materials/${material.materialId}`, `${sessionRoot}/sessions/${session.sessionId}`, root, sessionRoot]) {
      const response = await send(path, "DELETE");
      expect(response.status).toBe(409);
      expect(await code(response)).toBe("BUNDLE_RESOURCE_IN_USE");
    }
    expect(await dataset.getData(original.dataId)).toMatchObject({ initialMaterials: [material] });
    const api = createInitialResourceApi(db, owner);
    await api.bindData(original.dataId, { initialMaterials: null, initialSession: null });
    const evalBlocked = await send(root, "DELETE");
    expect(evalBlocked.status).toBe(409);
    expect(await code(evalBlocked)).toBe("BUNDLE_RESOURCE_IN_USE");
    await api.bindData(original.dataId, { evalInitialMaterials: null });
    const genericBound = await dataset.createData({ userPrompt: "Generic", initialMaterials: [material] });
    expect((await send(`${root}/materials/${material.materialId}`, "DELETE")).status).toBe(409);
    await dataset.updateData(genericBound.dataId, { userPrompt: "Generic" });
    expect((await send(`${root}/materials/${material.materialId}`, "DELETE")).status).toBe(204);
    expect(await msg(await send(`${root}/materials`, "GET"))).toHaveLength(2);
    expect(await code(await send(bindingPath, "PATCH", { initialMaterials: [material] }))).toBe("BUNDLE_RESOURCE_NOT_FOUND");
    await expect(bundles.resolveInitialMaterials(owner, material)).resolves.toHaveLength(1);
    expect((await send(root, "DELETE")).status).toBe(204);
    expect((await send(sessionRoot, "DELETE")).status).toBe(204);
    expect(await msg(await send("/api/material-bundles", "GET"))).toEqual([]);
    expect(await msg(await send("/api/session-bundles", "GET"))).toEqual([]);
    await expect(api.bindData(original.dataId, { initialSession: session })).rejects.toBeInstanceOf(BundleResourceNotFoundError);
    await expect(bundles.resolveInitialSession(owner, session)).resolves.toBeDefined();
    await expect(dataset.createData({ userPrompt: "New", initialMaterials: [material] }))
      .rejects.toBeInstanceOf(BundleResourceNotFoundError);
    await expect(dataset.updateData(original.dataId, { userPrompt: "Build page", initialSession: session }))
      .rejects.toBeInstanceOf(BundleResourceNotFoundError);
    const datasetsBefore = await dataset.listDatasets();
    await expect(dataset.importDataset(JSON.stringify({
      dataset: { name: "Invalid refs" }, data: [{ userPrompt: "New", initialMaterials: [material] }],
    }), "json")).rejects.toBeInstanceOf(BundleResourceNotFoundError);
    expect(await dataset.listDatasets()).toEqual(datasetsBefore);
  });

  it("keeps UUID resource bindings effective when the client uses uppercase IDs", async () => {
    const db = database.db;
    const directory = await openBundleDirectory(bundleRoot);
    const { materialBundles, sessionBundles } = createBundleCatalogs(db, owner, directory);
    const dataset = createDatasetService(createPostgresDatasetStore(db, owner));
    const { bundle: materialBundle } = await materialBundles.create({ name: "Case materials", description: "UUID case test" });
    const { bundle: sessionBundle } = await sessionBundles.create({ name: "Case sessions", description: "UUID case test" });
    const material = await materialBundles.createResource(materialBundle.bundleId, {
      name: "Case material", description: "One file",
      files: [{ path: "/case.txt", mediaType: "text/plain", contentBase64: "Y2FzZQ==" }],
    });
    const session = await sessionBundles.createResource(sessionBundle.bundleId, {
      name: "Case session", description: "One history", format: "json",
      content: JSON.stringify({ entries: [{
        id: "m1", message: { role: "user", content: "Earlier task" }, createdAt: 1,
      }] }),
    });
    const upperRef = {
      bundleId: materialBundle.bundleId.toUpperCase(), materialId: material.materialId.toUpperCase(),
    };
    const upperSession = {
      bundleId: sessionBundle.bundleId.toUpperCase(), sessionId: session.sessionId.toUpperCase(),
    };
    const row = await dataset.createData({
      userPrompt: "Test case", initialMaterials: [upperRef], initialSession: upperSession,
    });

    await expect(materialBundles.deleteResource(materialBundle.bundleId, material.materialId))
      .rejects.toBeInstanceOf(BundleResourceInUseError);
    await expect(sessionBundles.deleteResource(sessionBundle.bundleId, session.sessionId))
      .rejects.toBeInstanceOf(BundleResourceInUseError);
    await expect(materialBundles.delete(materialBundle.bundleId))
      .rejects.toBeInstanceOf(BundleResourceInUseError);
    await expect(sessionBundles.delete(sessionBundle.bundleId))
      .rejects.toBeInstanceOf(BundleResourceInUseError);
    expect(await dataset.getData(row.dataId)).toMatchObject({
      initialMaterials: [{ bundleId: materialBundle.bundleId, materialId: material.materialId }],
      initialSession: { bundleId: sessionBundle.bundleId, sessionId: session.sessionId },
    });

    const second = await dataset.createData({ userPrompt: "Bind later" });
    const bound = await createInitialResourceApi(db, owner)
      .bindData(second.dataId, { evalInitialMaterials: [upperRef] });
    expect(bound.evalInitialMaterials).toEqual([{
      bundleId: materialBundle.bundleId, materialId: material.materialId,
    }]);
    const imported = await dataset.importDataset(JSON.stringify({
      dataset: { name: "Imported case" },
      data: [{ userPrompt: "Import later", initialMaterials: [upperRef] }],
    }), "json");
    expect(imported.data[0]?.initialMaterials).toEqual([{
      bundleId: materialBundle.bundleId, materialId: material.materialId,
    }]);
    const updated = await dataset.createData({ userPrompt: "Update later" });
    await dataset.updateData(updated.dataId, { userPrompt: "Update later", initialSession: upperSession });
    expect((await dataset.getData(updated.dataId))?.initialSession).toEqual({
      bundleId: sessionBundle.bundleId, sessionId: session.sessionId,
    });
    await dataset.updateData(row.dataId, { userPrompt: "Test case" });
    await dataset.updateData(second.dataId, { userPrompt: "Bind later" });
    await dataset.updateData(imported.data[0]!.dataId, { userPrompt: "Import later" });
    await dataset.updateData(updated.dataId, { userPrompt: "Update later" });
    await materialBundles.deleteResource(materialBundle.bundleId, material.materialId);
    await sessionBundles.deleteResource(sessionBundle.bundleId, session.sessionId);
    await materialBundles.delete(materialBundle.bundleId);
    await sessionBundles.delete(sessionBundle.bundleId);
  });

  it("rejects binding one field's Materials whose catalog sizes together exceed one SP initialization", async () => {
    const db = database.db;
    const bundles = await openBundleDirectory(bundleRoot);
    const send = httpClient(db, bundles);
    const { materialBundles } = createBundleCatalogs(db, owner, bundles);
    const dataset = createDatasetService(createPostgresDatasetStore(db, owner));
    const { bundle } = await materialBundles.create({ name: "Budget", description: "Combined size" });
    const small = await materialBundles.createResource(bundle.bundleId, {
      name: "Small", description: "One byte", files: [{ path: "/a.txt", mediaType: "text/plain", contentBase64: "YQ==" }],
    });
    expect(small.byteSize).toBe(1);
    // Binding reads only catalog sizes, so the full-budget Material needs no stored files.
    const large = { bundleId: bundle.bundleId, materialId: crypto.randomUUID() };
    await db.insert(bundleMaterials).values({
      ...large, ownerUserId: owner, name: "Large", description: "Full budget", byteSize: EVAL_INITIALIZATION_MAX_BYTES,
    });
    const smallRef = { bundleId: small.bundleId, materialId: small.materialId };
    const target = await dataset.createData({ userPrompt: "Budget" });
    const bindingPath = `/api/data/${target.dataId}/initial-resources`;
    expect((await send(bindingPath, "PATCH", { initialMaterials: [large], evalInitialMaterials: [smallRef] })).status)
      .toBe(200);
    expect((await send("/api/data", "POST", { userPrompt: "Within", initialMaterials: [large], evalInitialMaterials: [smallRef] }))
      .status).toBe(201);
    for (const field of ["initialMaterials", "evalInitialMaterials"]) {
      const tooLarge = { code: "BUNDLE_FILE_TOO_LARGE", errors: [{ path: field }] };
      const bound = await send(bindingPath, "PATCH", { [field]: [large, smallRef] });
      expect(bound.status).toBe(413);
      expect(await bound.json()).toMatchObject(tooLarge);
      const created = await send("/api/data", "POST", { userPrompt: "Generic", [field]: [smallRef, large] });
      expect(created.status).toBe(413);
      expect(await created.json()).toMatchObject(tooLarge);
      const replaced = await send(`/api/data/${target.dataId}`, "PUT", { userPrompt: "Budget", [field]: [smallRef, large] });
      expect(replaced.status).toBe(413);
      expect(await replaced.json()).toMatchObject(tooLarge);
      const imported = await send("/api/datasets/import?format=json", "POST", JSON.stringify({
        dataset: { name: "Over budget" }, data: [{ userPrompt: "Imported", [field]: [smallRef, large] }],
      }));
      expect(imported.status).toBe(413);
      expect(await imported.json()).toMatchObject(tooLarge);
    }
    expect(await dataset.getData(target.dataId)).toMatchObject({ initialMaterials: [large], evalInitialMaterials: [smallRef] });
  });

  it("blocks deleting a Material listed at any position of either material list", async () => {
    const db = database.db;
    const { materialBundles } = createBundleCatalogs(db, owner, await openBundleDirectory(bundleRoot));
    const dataset = createDatasetService(createPostgresDatasetStore(db, owner));
    const api = createInitialResourceApi(db, owner);
    const files = [{ path: "/note.txt", mediaType: "text/plain", contentBase64: "bm90ZQ==" }];
    const upload = async (bundleId: string, name: string) => {
      const { materialId } = await materialBundles.createResource(bundleId, { name, description: "Listed", files });
      return { bundleId, materialId };
    };
    const { bundle: first } = await materialBundles.create({ name: "First", description: "Lists" });
    const { bundle: second } = await materialBundles.create({ name: "Second", description: "Lists" });
    const a1 = await upload(first.bundleId, "a1");
    const a2 = await upload(first.bundleId, "a2");
    const b1 = await upload(second.bundleId, "b1");
    const b2 = await upload(second.bundleId, "b2");
    const subject = await dataset.createData({ userPrompt: "Subject" });
    expect((await api.bindData(subject.dataId, { initialMaterials: [b1, a1] })).initialMaterials).toEqual([b1, a1]);
    expect((await api.bindData(subject.dataId, { initialMaterials: [a1, b1] })).initialMaterials).toEqual([a1, b1]);
    const evaluator = await dataset.createData({ userPrompt: "Evaluator", evalInitialMaterials: [a1, a2] });

    await expect(materialBundles.deleteResource(second.bundleId, b1.materialId)).rejects.toBeInstanceOf(BundleResourceInUseError);
    await expect(materialBundles.delete(second.bundleId)).rejects.toBeInstanceOf(BundleResourceInUseError);
    await expect(materialBundles.deleteResource(first.bundleId, a2.materialId)).rejects.toBeInstanceOf(BundleResourceInUseError);
    await materialBundles.deleteResource(second.bundleId, b2.materialId);

    await api.bindData(subject.dataId, { initialMaterials: [a1] });
    await materialBundles.delete(second.bundleId);
    await expect(materialBundles.delete(first.bundleId)).rejects.toBeInstanceOf(BundleResourceInUseError);
    await api.bindData(subject.dataId, { initialMaterials: null });
    await expect(materialBundles.deleteResource(first.bundleId, a1.materialId)).rejects.toBeInstanceOf(BundleResourceInUseError);
    await dataset.updateData(evaluator.dataId, { userPrompt: "Evaluator" });
    await materialBundles.deleteResource(first.bundleId, a2.materialId);
    await materialBundles.delete(first.bundleId);
  });

  it("creates Bundles with their ZIP resources and imports more, all or nothing", async () => {
    const db = database.db;
    const bundles = await openBundleDirectory(bundleRoot);
    const send = httpClient(db, bundles);
    const jsonl = `${sessionEntry("m1")}\n${sessionEntry("m2")}\n`;
    const sessionsCreated = await send("/api/session-bundles", "POST", form({
      name: "Histories", description: "Seed sessions", zip: await zip(["a.json", sessionFile("m1")], ["b.jsonl", jsonl]),
    }));
    expect(sessionsCreated.status).toBe(201);
    const sessions = await msg<{ bundle: { bundleId: string }; imported: { source: string; session: { sessionId: string } }[] }>(sessionsCreated);
    const sessionRoot = `/api/session-bundles/${sessions.bundle.bundleId}`;
    const created = { bundleId: sessions.bundle.bundleId, description: "Seed sessions" };
    expect(sessions).toEqual({
      bundle: { bundleId: expect.any(String), name: "Histories", description: "Seed sessions" },
      imported: [
        { source: "a.json", session: { ...created, sessionId: expect.any(String), name: "a.json", format: "json" } },
        { source: "b.jsonl", session: { ...created, sessionId: expect.any(String), name: "b.jsonl", format: "jsonl" } },
      ],
    });
    expect(await msg(await send(`${sessionRoot}/sessions`, "GET"))).toHaveLength(2);
    const [, multiLine] = sessions.imported;
    await expect(bundles.resolveInitialSession(owner, { bundleId: sessions.bundle.bundleId, sessionId: multiLine!.session.sessionId }))
      .resolves.toEqual({ format: "jsonl", content: jsonl });

    const materialsCreated = await send("/api/material-bundles", "POST", form({
      name: "Assets", description: "Seed assets",
      zip: await zip(["brief.txt", "Brief"], ["case-a/input.md", "Input"], ["case-a/assets/logo.svg", "<svg/>"]),
    }));
    expect(materialsCreated.status).toBe(201);
    const materials = await msg<{ bundle: { bundleId: string }; imported: { source: string; material: { materialId: string } }[] }>(materialsCreated);
    const materialRoot = `/api/material-bundles/${materials.bundle.bundleId}`;
    expect(materials.imported.map(({ source }) => source)).toEqual(["brief.txt", "case-a"]);
    expect(materials.imported.map(({ material }) => material)).toEqual([
      expect.objectContaining({ name: "brief.txt", description: "Seed assets" }),
      expect.objectContaining({ name: "case-a", description: "Seed assets" }),
    ]);
    expect(await msg(await send(`${materialRoot}/materials`, "GET"))).toHaveLength(2);
    const [, caseA] = materials.imported;
    expect((await bundles.resolveInitialMaterials(owner, { bundleId: materials.bundle.bundleId, materialId: caseA!.material.materialId }))
      .map(({ path }) => path)).toEqual(["/assets/logo.svg", "/input.md"]);
    const emptyFiles = await send(`${materialRoot}/import`, "POST", form({ zip: await zip(["blank/.keep", ""]) }));
    expect(emptyFiles.status).toBe(201);
    expect(await msg(emptyFiles)).toMatchObject({ imported: [{ source: "blank", material: { byteSize: 0 } }] });

    const empty = await send("/api/material-bundles", "POST", form({ name: "Empty", description: "No archive" }));
    expect(empty.status).toBe(201);
    const emptyBundle = await msg<{ bundle: { bundleId: string }; imported: unknown[] }>(empty);
    expect(emptyBundle.imported).toEqual([]);
    expect(await msg(await send("/api/material-bundles", "GET"))).toContainEqual(emptyBundle.bundle);
    expect(await code(await send("/api/material-bundles", "POST", form({ name: " ", description: "Blank" }))))
      .toBe("REQUEST_VALIDATION_FAILED");

    const sessionBundlesBefore = await msg(await send("/api/session-bundles", "GET"));
    const filesBefore = await storedFiles(bundleRoot);
    const rejected = await send("/api/session-bundles", "POST", form({
      name: "Broken", description: "One bad file", zip: await zip(["good.json", sessionFile("m1")], ["bad.json", "{"]),
    }));
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: "BUNDLE_FILE_INVALID", errors: [{ path: "bad.json", errMsg: expect.any(String) }] });
    expect(await msg(await send("/api/session-bundles", "GET"))).toEqual(sessionBundlesBefore);
    expect(await storedFiles(bundleRoot)).toEqual(filesBefore);

    const appended = await send(`${sessionRoot}/import`, "POST", form({ zip: await zip(["c.json", sessionFile("m3")]) }));
    expect(appended.status).toBe(201);
    expect(await msg(appended)).toEqual({
      bundle: { bundleId: sessions.bundle.bundleId, name: "Histories", description: "Seed sessions" },
      imported: [{ source: "c.json", session: { ...created, sessionId: expect.any(String), name: "c.json", format: "json" } }],
    });
    const listed = await msg(await send(`${sessionRoot}/sessions`, "GET"));
    expect(listed).toHaveLength(3);
    const failedImport = await send(`${sessionRoot}/import`, "POST", form({
      zip: await zip(["d.json", sessionFile("m4")], ["e.json", "[]"]),
    }));
    expect(await code(failedImport)).toBe("BUNDLE_FILE_INVALID");
    expect(await msg(await send(`${sessionRoot}/sessions`, "GET"))).toEqual(listed);

    const filesBeforeMissing = await storedFiles(bundleRoot);
    const otherKind = await send(`/api/session-bundles/${materials.bundle.bundleId}/import`, "POST",
      form({ zip: await zip(["f.json", sessionFile("m5")]) }));
    expect(otherKind.status).toBe(404);
    expect(await code(otherKind)).toBe("BUNDLE_RESOURCE_NOT_FOUND");
    expect((await send(`/api/material-bundles/${emptyBundle.bundle.bundleId}`, "DELETE")).status).toBe(204);
    const deleted = await send(`/api/material-bundles/${emptyBundle.bundle.bundleId}/import`, "POST",
      form({ zip: await zip(["late.txt", "Late"]) }));
    expect(deleted.status).toBe(404);
    expect(await code(deleted)).toBe("BUNDLE_RESOURCE_NOT_FOUND");
    expect(await storedFiles(bundleRoot)).toEqual(filesBeforeMissing);
  });

  it("reads exact resource files without exposing another catalog, resource or owner", async () => {
    const bundles = await openBundleDirectory(bundleRoot);
    const send = httpClient(database.db, bundles);
    const { materialBundles, sessionBundles } = createBundleCatalogs(database.db, owner, bundles);
    const { bundle } = await materialBundles.create({ name: "Preview", description: "File inventory" });
    const html = "<h1>页面</h1><script>alert(1)</script>";
    const binary = Buffer.from([0, 255, 10, 128]);
    const multipart = "--AbC\r\nContent-Disposition: form-data; name=\"x\"\r\n\r\na\r\n--AbC--\r\n";
    const files = [
      { path: "/pages/index.html", mediaType: "text/html", contentBase64: Buffer.from(html).toString("base64") },
      { path: "/资料/图 #1?.bin", mediaType: "application/octet-stream", contentBase64: binary.toString("base64") },
      { path: "/empty.txt", mediaType: "text/plain", contentBase64: "" },
      { path: "/unicode-mime.txt", mediaType: "text/plain; charset=日本語", contentBase64: "YQ==" },
      { path: "/newline-mime.txt", mediaType: "text/plain\r\nx-header: injected", contentBase64: "YQ==" },
      { path: "/control-mime.txt", mediaType: "text/\u0001plain", contentBase64: "YQ==" },
      { path: "/del-mime.txt", mediaType: "text/\u007fplain", contentBase64: "YQ==" },
      { path: "/form.bin", mediaType: "multipart/form-data; boundary=AbC", contentBase64: Buffer.from(multipart).toString("base64") },
      { path: "/tab-form.bin", mediaType: "multipart/form-data;\tboundary=AbC", contentBase64: Buffer.from(multipart).toString("base64") },
    ];
    const resource = await materialBundles.createResource(bundle.bundleId, { name: "Page", description: "Read only", files });
    const base = `/api/material-bundles/${bundle.bundleId}/materials/${resource.materialId}`;
    const inventory = await send(`${base}/files`, "GET");
    expect(inventory.status).toBe(200);
    expect(await msg<InitialResourceFile[]>(inventory)).toEqual(files.map(({ path, mediaType, contentBase64 }) => ({
      path, mediaType, byteSize: Buffer.from(contentBase64, "base64").byteLength,
    })));
    const fileUrl = (path: string) => `${base}/file?${new URLSearchParams({ path })}`;
    const page = await send(fileUrl(files[0]!.path), "GET");
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toBe("text/html");
    expect(page.headers.get("Content-Length")).toBe(String(Buffer.byteLength(html)));
    expect(page.headers.get("Content-Disposition")).toBe("attachment");
    expect(page.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(page.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(page.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await page.text()).toBe(html);
    const attachment = await send(fileUrl(files[1]!.path), "GET");
    expect(Buffer.from(await attachment.arrayBuffer())).toEqual(binary);
    const empty = await send(fileUrl("/empty.txt"), "GET");
    expect(empty.status).toBe(200);
    expect(empty.headers.get("Content-Length")).toBe("0");
    expect(await empty.text()).toBe("");
    for (const path of ["/unicode-mime.txt", "/newline-mime.txt", "/control-mime.txt", "/del-mime.txt"]) {
      const response = await send(fileUrl(path), "GET");
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
      expect(response.headers.has("x-header")).toBe(false);
      expect(await response.text()).toBe("a");
    }
    for (const path of ["/form.bin", "/tab-form.bin"]) {
      const formResponse = await send(fileUrl(path), "GET");
      expect(formResponse.headers.get("Content-Type")).toBe(files.find((file) => file.path === path)!.mediaType);
      expect((await formResponse.formData()).get("x")).toBe("a");
    }

    // Labels are editable; path identities and content come only from the immutable manifest.
    await materialBundles.updateResource(bundle.bundleId, resource.materialId, { name: "Renamed" });
    expect(await (await send(fileUrl(files[0]!.path), "GET")).text()).toBe(html);
    expect((await send(fileUrl(files[0]!.path).replace(bundle.bundleId, bundle.bundleId.toUpperCase()), "GET")).status).toBe(200);
    for (const path of ["/../empty.txt", "/pages/../empty.txt", "/pages/%2e%2e/empty.txt", "empty.txt", "/missing.txt", "/資料/图 #1?.bin"]) {
      const missing = await send(fileUrl(path), "GET");
      expect(missing.status).toBe(404);
      expect(await code(missing)).toBe("BUNDLE_FILE_NOT_FOUND");
    }
    expect((await send(`${base}/file`, "GET")).status).toBe(422);
    for (const endpoint of [`${base}/files`, fileUrl(files[0]!.path)]) {
      const other = await send(endpoint, "GET", undefined, "other");
      expect(other.status).toBe(404);
      expect(await code(other)).toBe("BUNDLE_RESOURCE_NOT_FOUND");
    }
    const { bundle: second } = await materialBundles.create({ name: "Other", description: "Different resource" });
    const sibling = await materialBundles.createResource(second.bundleId, { name: "Sibling", description: "Other", files });
    expect((await send(base.replace(resource.materialId, sibling.materialId) + "/files", "GET")).status).toBe(404);
    expect((await send(base.replace("material-bundles", "session-bundles").replace("materials", "sessions") + "/files", "GET")).status).toBe(404);

    const { bundle: contexts } = await sessionBundles.create({ name: "Contexts", description: "Formats" });
    for (const format of ["json", "jsonl"] as const) {
      const content = format === "json" ? sessionFile("preview") + "\n" : sessionEntry("preview") + "\n\n";
      const session = await sessionBundles.createResource(contexts.bundleId, { name: "Editable label", description: "Context", format, content });
      const contextBase = `/api/session-bundles/${contexts.bundleId}/sessions/${session.sessionId}`;
      expect(await msg(await send(`${contextBase}/files`, "GET"))).toEqual([{
        path: `/context.${format}`, mediaType: format === "json" ? "application/json" : "application/x-ndjson", byteSize: Buffer.byteLength(content),
      }]);
      const read = await send(`${contextBase}/file?path=${encodeURIComponent(`/context.${format}`)}`, "GET");
      expect(read.status).toBe(200);
      expect(await read.text()).toBe(content);
    }
  });

  it("hides deleted resources from file reads while keeping their bytes for existing Projects", async () => {
    const bundles = await openBundleDirectory(bundleRoot);
    const send = httpClient(database.db, bundles);
    const { materialBundles, sessionBundles } = createBundleCatalogs(database.db, owner, bundles);
    const files = [{ path: "/keep.txt", mediaType: "text/plain", contentBase64: "a2VlcA==" }];
    const { bundle } = await materialBundles.create({ name: "Deleted preview", description: "Kept bytes" });
    const resource = await materialBundles.createResource(bundle.bundleId, { name: "File", description: "Kept", files });
    const base = `/api/material-bundles/${bundle.bundleId}/materials/${resource.materialId}`;
    await materialBundles.deleteResource(bundle.bundleId, resource.materialId);
    for (const suffix of ["/files", "/file?path=%2Fkeep.txt"]) {
      const missing = await send(base + suffix, "GET");
      expect(missing.status).toBe(404);
      expect(await code(missing)).toBe("BUNDLE_RESOURCE_NOT_FOUND");
    }
    expect(await bundles.resolveInitialMaterials(owner, resource)).toEqual(files);

    const { bundle: contexts } = await sessionBundles.create({ name: "Deleted context", description: "Kept bytes" });
    const content = { format: "json" as const, content: sessionFile("kept") };
    const session = await sessionBundles.createResource(contexts.bundleId, { name: "Context", description: "Kept", ...content });
    await sessionBundles.delete(contexts.bundleId);
    const contextBase = `/api/session-bundles/${contexts.bundleId}/sessions/${session.sessionId}`;
    for (const suffix of ["/files", "/file?path=%2Fcontext.json"]) expect((await send(contextBase + suffix, "GET")).status).toBe(404);
    expect(await bundles.resolveInitialSession(owner, session)).toEqual(content);
  });

  it("preserves Bundle read failures instead of disguising them as missing resources", async () => {
    const bundles = await openBundleDirectory(bundleRoot);
    const { materialBundles } = createBundleCatalogs(database.db, owner, bundles);
    const { bundle } = await materialBundles.create({ name: "Unavailable preview", description: "Read errors" });
    const material = await materialBundles.createResource(bundle.bundleId, {
      name: "Present", description: "Catalog record", files: [{ path: "/file.txt", mediaType: "text/plain", contentBase64: "YQ==" }],
    });
    const base = `/api/material-bundles/${bundle.bundleId}/materials/${material.materialId}`;
    const suffixes = ["/files", "/file?path=%2Ffile.txt"];
    const send = httpClient(database.db, bundles);
    const manifest = join(bundleRoot, owner, bundle.bundleId, "materials", `${material.materialId}.json`);
    for (const content of [
      "{broken JSON", JSON.stringify({ wrong: [] }),
      JSON.stringify({ files: [{ path: "/file.txt", mediaType: "text/plain", contentBase64: "not base64" }] }),
      JSON.stringify({ files: Array.from({ length: EVAL_MATERIAL_MAX_FILES + 1 }, (_, index) => ({
        path: `/${index}.txt`, mediaType: "text/plain", contentBase64: "YQ==",
      })) }),
    ]) {
      await writeFile(manifest, content);
      for (const suffix of suffixes) {
        const response = await send(base + suffix, "GET");
        expect(response.status).toBe(500);
        const body = await response.json();
        expect(body).toMatchObject({ code: "BUNDLE_FILE_CORRUPT", requestId: expect.any(String) });
        expect(body).not.toHaveProperty("errors");
        expect(JSON.stringify(body)).not.toContain("base64");
        expect(JSON.stringify(body)).not.toContain(bundleRoot);
      }
    }
    await rm(manifest);
    for (const suffix of suffixes) expect(await code(await send(base + suffix, "GET"))).toBe("BUNDLE_FILE_NOT_FOUND");
    const unavailable = httpClient(database.db, { ...bundles, async resolveInitialMaterials() {
      throw new BundleFileError("unavailable", "Read failed", { cause: new Error("private filesystem details") });
    } });
    for (const suffix of suffixes) {
      const response = await unavailable(base + suffix, "GET");
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "BUNDLE_FILE_UNAVAILABLE", requestId: expect.any(String) });
    }
  });

  it("removes every file a batch wrote when the batch cannot commit", async () => {
    const db = database.db;
    const directory = await openBundleDirectory(bundleRoot);
    const { sessionBundles } = createBundleCatalogs(db, owner, directory);
    const input = (name: string) => ({ name, description: "Batch", format: "json" as const, content: sessionFile("m1") });
    const rejected = { cause: expect.objectContaining({ message: "rejected by test" }) };
    const listed = await sessionBundles.list();
    const filesBefore = await storedFiles(bundleRoot);
    await database.db.$client.query(`CREATE FUNCTION eval_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.name = 'reject.json' THEN RAISE EXCEPTION 'rejected by test'; END IF; RETURN NEW; END $$`);
    await database.db.$client.query("CREATE TRIGGER eval_test_reject BEFORE INSERT ON eval_bundle_sessions FOR EACH ROW EXECUTE FUNCTION eval_test_reject()");
    try {
      await expect(sessionBundles.create({ name: "Rejected", description: "Batch" }, [input("ok.json"), input("reject.json")]))
        .rejects.toMatchObject(rejected);
      expect(await sessionBundles.list()).toEqual(listed);
      expect(await storedFiles(bundleRoot)).toEqual(filesBefore);

      const { bundle } = await sessionBundles.create({ name: "Kept", description: "Batch" }, [input("first.json")]);
      const kept = await storedFiles(bundleRoot);
      await expect(sessionBundles.import(bundle.bundleId, [input("second.json"), input("reject.json")])).rejects.toMatchObject(rejected);
      expect(await sessionBundles.listResources(bundle.bundleId)).toEqual([expect.objectContaining({ name: "first.json" })]);
      expect(await storedFiles(bundleRoot)).toEqual(kept);

      const stuck = createBundleCatalogs(db, owner, {
        ...directory, removeInitialSession: async () => { throw new Error("disk unavailable"); },
      }).sessionBundles;
      const failure = await stuck.import(bundle.bundleId, [input("reject.json")]).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([expect.objectContaining(rejected), new Error("disk unavailable")]);
    } finally {
      await database.db.$client.query("DROP TRIGGER eval_test_reject ON eval_bundle_sessions");
      await database.db.$client.query("DROP FUNCTION eval_test_reject()");
    }
  });

  it("uploads standalone output formats that evaluation plans keep reading after a soft delete", async () => {
    const db = database.db;
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
