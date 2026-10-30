import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createDatasetService, DatasetEntityNotFoundError } from "@eval-platform/eval-dataset";
import { digestJson } from "@eval-platform/eval-runtime";
import { EVAL_INITIAL_FILE_MAX_BYTES, EVAL_INITIALIZATION_MAX_BYTES } from "@springbrand/eval-harness";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openImportStaging } from "../agent-imports/bytes.js";
import { BundleResourceNotFoundError } from "../db/errors.js";
import { createPostgresDatasetStore } from "../db/dataset.js";
import { createPostgresProjectStore } from "../db/project-store.js";
import { createBundleCatalogs } from "../db/resource-catalog.js";
import { data as dataTable, managementOperations } from "../db/schema.js";
import { createTestDatabase } from "../db/test-database.js";
import { seedProject } from "../db/test-fixtures.js";
import { createInitialResourceApi, patchedInitialResources } from "../initial-resources.js";
import type { ApiRuntime } from "../lib/types.js";
import { createOwnerServices } from "../owner-services.js";
import { openBundleDirectory, type BundleDirectory } from "../sp/bundle-directory.js";
import type { EvalSpClient } from "../sp/client.js";
import type { SpObservationClient } from "../sp/observation.js";
import { requestApp, WEB_ORIGIN } from "../test-support.js";
import { createManagementFiles } from "./files.js";
import { EVAL_MANAGEMENT_MCP_PATH } from "./mcp.js";
import { createPostgresManagementStore } from "./store.js";
import { MANAGEMENT_TOKEN, OWNER, setupManagement, toolValue } from "./test-fixture.js";
import { MANAGEMENT_UPLOAD_PATH } from "./upload-route.js";

const connection = process.env.DATABASE_URL;
const OTHER = "22222222-2222-4222-8222-222222222222";
const labels = { name: "Existing resource", description: "Owned Material" };
const materialFiles = [{ path: "/brief.txt", mediaType: "text/plain", contentBase64: "YnJpZWY=" }];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe.skipIf(!connection)("PostgreSQL existing Data binding and active resource choices", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let directory: BundleDirectory;
  let root: string;

  beforeAll(async () => {
    database = await createTestDatabase(connection!);
    root = await mkdtemp(path.join(tmpdir(), "eval-binding-postgres-"));
    directory = await openBundleDirectory(root);
  }, 30_000);

  beforeEach(async () => {
    await database.db.execute(sql`TRUNCATE TABLE
      eval_management_operations, eval_management_uploads, eval_projects, eval_datasets,
      eval_data, eval_material_bundles, eval_session_bundles CASCADE`);
  });

  afterAll(async () => {
    try {
      if (root) await rm(root, { recursive: true, force: true });
    } finally {
      if (database) await database.destroy();
    }
  }, 30_000);

  async function seeded() {
    const datasets = createDatasetService(createPostgresDatasetStore(database.db, OWNER));
    const dataset = await datasets.createDataset({ name: "Existing Dataset" });
    const original = await datasets.createData({
      name: "PRIVATE_CASE", userPrompt: "PRIVATE_PROMPT", evalPrompt: "PRIVATE_EVAL_PROMPT",
      metadata: { nested: { answer: 7 } },
    }, { datasetId: dataset.datasetId });
    const { materialBundles, sessionBundles } = createBundleCatalogs(database.db, OWNER, directory);
    const { bundle } = await materialBundles.create(labels);
    const material = await materialBundles.createResource(bundle.bundleId, { ...labels, files: materialFiles });
    const { bundle: sessionBundle } = await sessionBundles.create({ name: "History", description: "History" });
    const session = await sessionBundles.createResource(sessionBundle.bundleId, {
      name: "Old context", description: "Earlier session",
      format: "json", content: JSON.stringify({ entries: [
        { id: "m1", message: { role: "user", content: "Earlier prompt", timestamp: 1 }, createdAt: 1 },
      ] }),
    });
    return {
      datasets, dataset, original, materialBundles, sessionBundles,
      material: { bundleId: material.bundleId, materialId: material.materialId },
      session: { bundleId: session.bundleId, sessionId: session.sessionId },
    };
  }

  it("locks owner, active membership, upstream readiness and full Data digest; leaves frozen Project copies unchanged", async () => {
    const { datasets, dataset, original, material } = await seeded();
    const api = createInitialResourceApi(database.db, OWNER);
    const other = createInitialResourceApi(database.db, OTHER);
    const management = createPostgresManagementStore(database.db);
    const digest = await digestJson(original);
    const patch = { initialMaterials: [material] };
    const nextDigest = await digestJson(patchedInitialResources(original, patch));
    const frozen = await seedProject(database.db, OWNER, { datasets: [{ datasetId: dataset.datasetId, data: [original] }] });

    await expect(other.inspectBindTarget(dataset.datasetId, original.dataId, digest))
      .rejects.toBeInstanceOf(DatasetEntityNotFoundError);
    const unbound = await datasets.createData({ userPrompt: "Other Data" });
    await expect(api.inspectBindTarget(dataset.datasetId, unbound.dataId, await digestJson(unbound)))
      .rejects.toBeInstanceOf(DatasetEntityNotFoundError);
    await expect(api.inspectBindTarget(dataset.datasetId, original.dataId, "0".repeat(64)))
      .rejects.toThrow();

    const key = crypto.randomUUID();
    const plan = { version: 3, datasetId: dataset.datasetId, dataId: original.dataId,
      expectedContentDigest: digest, contentDigest: nextDigest, patch };
    await management.begin(OWNER, key, "bind", "a".repeat(64), plan);
    await expect(management.assertReadyDatasets(OWNER, [dataset.datasetId])).rejects.toThrow();
    await expect(management.listDatasetData(OWNER, dataset.datasetId, 1, 5)).rejects.toThrow();
    await expect(management.begin(OWNER, "other-pending-key", "bind", "c".repeat(64), plan))
      .rejects.toThrow();
    expect(await management.get(OWNER, "other-pending-key")).toBeNull();
    // Another bind may preflight while this key is pending; the locked full-row digest (not a
    // cross-key wait that could strand both pending operations) still prevents a lost update.
    expect(await api.inspectBindTarget(dataset.datasetId, original.dataId, digest)).toEqual(original);
    await management.attempt(OWNER, key, `data:${original.dataId}`);
    const updated = await api.bindData(original.dataId, patch, {
      datasetId: dataset.datasetId, expectedContentDigest: digest, resultContentDigest: nextDigest,
    });
    expect(await digestJson(updated)).toBe(nextDigest);
    expect(updated).toMatchObject({ metadata: original.metadata, initialMaterials: [material] });
    await expect(api.bindData(original.dataId, patch, {
      datasetId: dataset.datasetId, expectedContentDigest: digest, resultContentDigest: nextDigest,
    })).rejects.toThrow(); // a new intent cannot treat someone else's result as its own lost response
    expect(await api.bindData(original.dataId, patch, {
      datasetId: dataset.datasetId, expectedContentDigest: digest, resultContentDigest: nextDigest, replay: true,
    })).toEqual(updated); // lost HTTP response: same planned result, not a second mutation
    await management.confirm(OWNER, key, `data:${original.dataId}`, {
      datasetId: dataset.datasetId, dataId: original.dataId, contentDigest: nextDigest,
    });
    await management.complete(OWNER, key);
    await expect(management.assertReadyDatasets(OWNER, [dataset.datasetId])).resolves.toBeUndefined();
    expect((await management.listDatasetData(OWNER, dataset.datasetId, 1, 5)).items[0]?.dataId).toBe(original.dataId);
    expect((await createPostgresProjectStore(database.db, OWNER).get(frozen.projectId))!.projectSamples[0]?.data)
      .toEqual(original);
    expect(await datasets.getData(original.dataId)).toEqual(updated);

    // Reusing the old approval digest after another edit cannot restore the previous Data.
    const { dataId: _updatedId, ...updatedInput } = updated;
    await datasets.updateData(original.dataId, { ...updatedInput, name: "Changed after binding" });
    await expect(api.bindData(original.dataId, patch, {
      datasetId: dataset.datasetId, expectedContentDigest: digest, resultContentDigest: nextDigest,
    })).rejects.toThrow();
    await expect(management.begin(OWNER, "stale-key", "bind", "d".repeat(64), plan))
      .rejects.toThrow();
    expect(await management.get(OWNER, "stale-key")).toBeNull();
    expect((await datasets.getData(original.dataId))!.name).toBe("Changed after binding");
  });

  it("retains existing soft-deleted refs in their original field but rejects new deleted, wrong-kind and foreign refs", async () => {
    const { datasets, dataset, original, material, session, materialBundles } = await seeded();
    const api = createInitialResourceApi(database.db, OWNER);
    const { dataId: _originalId, ...originalInput } = original;
    await datasets.updateData(original.dataId, { ...originalInput, initialMaterials: [material] });
    await materialBundles.deleteResource(material.bundleId, material.materialId);
    const retained = await api.bindData(original.dataId, {
      initialMaterials: [material], initialSession: session,
    });
    expect(retained).toMatchObject({ initialMaterials: [material], initialSession: session });
    await expect(api.bindData(original.dataId, { evalInitialMaterials: [material] }))
      .rejects.toBeInstanceOf(BundleResourceNotFoundError);
    await expect(api.bindData(original.dataId, {
      initialMaterials: [{ bundleId: session.bundleId, materialId: material.materialId }],
    })).rejects.toBeInstanceOf(BundleResourceNotFoundError);
    await expect(api.bindData(original.dataId, {
      initialSession: { bundleId: material.bundleId, sessionId: session.sessionId },
    })).rejects.toBeInstanceOf(BundleResourceNotFoundError);
    const foreign = await createBundleCatalogs(database.db, OTHER, directory).materialBundles.create(labels,
      [{ ...labels, files: materialFiles }]);
    await expect(api.bindData(original.dataId, { evalInitialMaterials: [{
      bundleId: foreign.bundle.bundleId, materialId: foreign.imported[0]!.materialId,
    }] })).rejects.toBeInstanceOf(BundleResourceNotFoundError);
    expect(await datasets.getData(original.dataId)).toEqual(retained);

    // Even a currently owned Data member cannot bind while its Dataset has an upstream preparation.
    await database.db.insert(managementOperations).values({
      ownerUserId: OWNER, operationKey: "pending-preparation", kind: "prepare",
      fingerprint: "b".repeat(64), status: "pending", plan: { version: 1, datasetId: dataset.datasetId,
        dataIds: [original.dataId], cases: [{}], assets: [] }, stages: {},
    });
    await expect(api.inspectBindTarget(dataset.datasetId, original.dataId, await digestJson(retained)))
      .rejects.toThrow();
    await database.db.delete(managementOperations).where(eq(managementOperations.operationKey, "pending-preparation"));
    await materialBundles.delete(material.bundleId);
    expect((await api.bindData(original.dataId, { initialMaterials: [material] })).initialMaterials).toEqual([material]);
  });

  it.each([{ deleted: false, label: "active" }, { deleted: true, label: "soft-deleted" }])(
    "rejects a new owned reference beside an already full $label field before binding",
    async ({ deleted }) => {
      const { datasets, dataset, original, materialBundles, sessionBundles, material } = await seeded();
      const large = Buffer.alloc(EVAL_INITIAL_FILE_MAX_BYTES).toString("base64");
      const refs: Array<{ bundleId: string; materialId: string }> = [];
      for (let index = 0; index < 4; index++) {
        const { bundleId, materialId } = await materialBundles.createResource(material.bundleId, {
          name: `Full ${index}`, description: "Owner catalog size",
          files: [{ path: `/full-${index}.bin`, mediaType: "application/octet-stream", contentBase64: large }],
        });
        refs.push({ bundleId, materialId });
      }
      const { dataId: _dataId, ...content } = original;
      await datasets.updateData(original.dataId, { ...content, initialMaterials: refs });
      const current = (await datasets.getData(original.dataId))!;
      if (deleted) await materialBundles.deleteResource(refs[0]!.bundleId, refs[0]!.materialId);
      const app = setupManagement();
      Object.assign(app.services, {
        initialResources: createInitialResourceApi(database.db, OWNER), materialBundles, sessionBundles,
      });
      const oneByte = await materialBundles.createResource(material.bundleId, { ...labels,
        files: [{ path: "/one-byte.txt", mediaType: "text/plain", contentBase64: "eA==" }] });
      const existingBundles = await materialBundles.list();
      const response = await (await app.call("bind_data_resources", {
        operationKey: `preflight-${deleted ? "deleted" : "active"}`,
        datasetId: dataset.datasetId, dataId: original.dataId, expectedContentDigest: await digestJson(current),
        initialMaterials: [...refs, { bundleId: oneByte.bundleId, materialId: oneByte.materialId }],
      })).json() as { result: { isError?: boolean; content: [{ text: string }] } };
      expect(response.result.isError).toBe(true);
      expect(response.result.content[0].text).toContain("BUNDLE_FILE_TOO_LARGE");
      expect(await materialBundles.list()).toEqual(existingBundles);
      expect(app.managed.operations.size).toBe(0);
      expect(await datasets.getData(original.dataId)).toEqual(current);
    }, 60_000,
  );

  it("preflights retained Materials independently per role at the exact byte budget", async () => {
    const { datasets, dataset, original, materialBundles, sessionBundles, material } = await seeded();
    const refs: Array<{ bundleId: string; materialId: string }> = [];
    for (const [index, byteSize] of [EVAL_INITIAL_FILE_MAX_BYTES, EVAL_INITIAL_FILE_MAX_BYTES,
      EVAL_INITIAL_FILE_MAX_BYTES, EVAL_INITIAL_FILE_MAX_BYTES - 1].entries()) {
      const { bundleId, materialId } = await materialBundles.createResource(material.bundleId, {
        name: `Role ${index}`, description: "Owner catalog size",
        files: [{ path: `/role-${index}.bin`, mediaType: "application/octet-stream",
          contentBase64: Buffer.alloc(byteSize).toString("base64") }],
      });
      refs.push({ bundleId, materialId });
    }
    const { dataId: _dataId, ...content } = original;
    await datasets.updateData(original.dataId, {
      ...content, initialMaterials: refs, evalInitialMaterials: refs,
    });
    const current = (await datasets.getData(original.dataId))!;
    const app = setupManagement();
    Object.assign(app.services, {
      initialResources: createInitialResourceApi(database.db, OWNER), materialBundles, sessionBundles,
    });
    const lastByte = await materialBundles.createResource(material.bundleId, { ...labels,
      files: [{ path: "/last-byte.txt", mediaType: "text/plain", contentBase64: "eA==" }] });
    const oneByte = { bundleId: lastByte.bundleId, materialId: lastByte.materialId };
    const result = await toolValue(await app.call("bind_data_resources", {
      operationKey: "separate-full-roles", datasetId: dataset.datasetId, dataId: original.dataId,
      expectedContentDigest: await digestJson(current),
      initialMaterials: [...refs, oneByte], evalInitialMaterials: [...refs, oneByte],
    }));
    expect(result).toMatchObject({ status: "completed" });
    expect(result).not.toHaveProperty("resources");
    const updated = (await datasets.getData(original.dataId))!;
    expect(updated.initialMaterials).toHaveLength(5);
    expect(updated.initialMaterials).toEqual(updated.evalInitialMaterials);
  }, 60_000);

  it("checks the sum of unchanged and newly selected Material bytes in each role under the Data lock", async () => {
    const { datasets, original, materialBundles, material } = await seeded();
    const api = createInitialResourceApi(database.db, OWNER);
    const large = Buffer.alloc(EVAL_INITIAL_FILE_MAX_BYTES).toString("base64");
    const records = await Promise.all(Array.from({ length: 5 }, (_, index) =>
      materialBundles.createResource(material.bundleId, {
        name: `Large ${index}`, description: "Bounded", files: [{
          path: `/large-${index}.bin`, mediaType: "application/octet-stream", contentBase64: large,
        }],
      })));
    const refs = records.map(({ bundleId, materialId }) => ({ bundleId, materialId }));
    expect(refs.length * EVAL_INITIAL_FILE_MAX_BYTES).toBeGreaterThan(EVAL_INITIALIZATION_MAX_BYTES);
    const saved = await api.bindData(original.dataId, { initialMaterials: refs.slice(0, 4) });
    await expect(api.bindData(original.dataId, {
      // This replacement does not mention the Data's other fields, but the full next list exceeds 20 MiB.
      initialMaterials: [refs[0]!, refs[1]!, refs[2]!, refs[3]!, refs[4]!],
    })).rejects.toThrow();
    expect(await datasets.getData(original.dataId)).toEqual(saved);
    expect((await api.bindData(original.dataId, {
      evalInitialMaterials: refs.slice(0, 4), // separate role budget, never added to Subject's 20 MiB.
    })).evalInitialMaterials).toEqual(refs.slice(0, 4));
  }, 60_000);

  it("rejects an intervening Data edit after the bind begins waiting for its row lock", async () => {
    const { datasets, dataset, original, material } = await seeded();
    const api = createInitialResourceApi(database.db, OWNER);
    const originalDigest = await digestJson(original);
    const resultDigest = await digestJson(patchedInitialResources(original, { initialMaterials: [material] }));
    const waiting = deferred();
    const unlock = deferred();
    const blocker = database.db.transaction(async (transaction) => {
      await transaction.select({ dataId: dataTable.dataId }).from(dataTable)
        .where(eq(dataTable.dataId, original.dataId)).for("update");
      waiting.resolve();
      await unlock.promise;
      const { dataId: _dataId, ...content } = { ...original, userPrompt: "Changed while binding waited" };
      await transaction.update(dataTable).set({ content }).where(eq(dataTable.dataId, original.dataId));
    });
    await waiting.promise;
    const bind = api.bindData(original.dataId, { initialMaterials: [material] }, {
      datasetId: dataset.datasetId, expectedContentDigest: originalDigest,
      resultContentDigest: resultDigest,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    unlock.resolve();
    await blocker;
    await expect(bind).rejects.toThrow();
    expect(await datasets.getData(original.dataId)).toMatchObject({ userPrompt: "Changed while binding waited" });
    expect(await datasets.getData(original.dataId)).not.toHaveProperty("initialMaterials");
  });

  it("uses real byte ingress, standalone saves, active discovery, Prompt import and guarded binding with PostgreSQL replay", async () => {
    const { datasets, dataset, original, material } = await seeded();
    const store = createPostgresManagementStore(database.db);
    const files = createManagementFiles(store, await openImportStaging(root, "management-uploads"));
    const sp = {} as EvalSpClient; // No SP or network request is part of Dataset binding.
    const ownerServices = createOwnerServices({
      db: database.db, sp, bundles: directory,
      release: { sourceBranch: "no-network", sourceCommit: "a".repeat(40) },
      runQueue: { async enqueue() {} },
    });
    let loseBindingReply = true;
    const runtime: ApiRuntime = {
      webOrigin: WEB_ORIGIN, spAdminToken: "unused", sp, observation: {} as SpObservationClient,
      serviceAccount: { user: { id: OWNER, role: "user" }, email: "fixed@example.test", sessionToken: "session" },
      ownerServices: (user, token) => {
        const lease = ownerServices(user, token);
        return { ...lease, services: { ...lease.services, initialResources: {
          ...lease.services.initialResources,
          async bindData(...args: Parameters<typeof lease.services.initialResources.bindData>) {
            const data = await lease.services.initialResources.bindData(...args);
            if (args[2] && loseBindingReply) { loseBindingReply = false; throw new Error("the committed reply was lost"); }
            return data;
          },
        } } };
      },
      evalManagement: { token: MANAGEMENT_TOKEN, store, files, spOrigin: "https://no-network.invalid" },
    };
    const request = requestApp(runtime);
    const call = async (name: string, args: unknown) => request(EVAL_MANAGEMENT_MCP_PATH, {
      method: "POST", headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const upload = async (kind: "material" | "session" | "prompt", name: string,
      bytes: Uint8Array, mediaType: string) => {
      const uploadId = crypto.randomUUID();
      const response = await request(MANAGEMENT_UPLOAD_PATH, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${MANAGEMENT_TOKEN}`, "Content-Type": "application/octet-stream",
          "X-Upload-Id": uploadId, "X-Upload-Kind": kind, "X-Upload-Name": name,
          "X-Upload-Media-Type": mediaType, "X-Upload-Size": String(bytes.length),
          "X-Upload-Sha256": createHash("sha256").update(bytes).digest("hex"),
        },
        body: new Uint8Array(bytes),
      });
      expect(response.status).toBe(201);
      expect((await response.json() as { uploadRef: string }).uploadRef).toBe(uploadId);
      return uploadId;
    };
    const approval = await toolValue(await call("list_options", {
      category: "approval_dataset", datasetId: dataset.datasetId, dataIds: [original.dataId],
    }));
    const originalDigest = (approval.items as Array<{ contentDigest: string }>)[0]!.contentDigest;
    expect(originalDigest).toBe(await digestJson(original));
    const materialUpload = await upload("material", "new.txt",
      new TextEncoder().encode("uploaded private bytes"), "text/plain");
    const contextUpload = await upload("session", "history.json", new TextEncoder().encode(JSON.stringify({
      entries: [{ id: "m1", message: { role: "user", content: "Previous private context", timestamp: 1 }, createdAt: 1 }],
    })), "application/json");
    const savedMaterial = await toolValue(await call("save_initial_resource", {
      operationKey: "postgres-material", kind: "material", uploadRef: materialUpload,
    }));
    const savedSession = await toolValue(await call("save_initial_resource", {
      operationKey: "postgres-session", kind: "session", uploadRef: contextUpload, format: "json",
    }));
    const materialChoice = { bundleId: savedMaterial.bundleId as string, materialId: savedMaterial.materialId as string };
    const sessionChoice = { bundleId: savedSession.bundleId as string, sessionId: savedSession.sessionId as string };
    expect(savedMaterial).toEqual({ operationKey: "postgres-material", kind: "initial_resource",
      resourceKind: "material", status: "completed", ...materialChoice });
    expect(savedSession).toEqual({ operationKey: "postgres-session", kind: "initial_resource",
      resourceKind: "session", status: "completed", ...sessionChoice });
    expect((await store.get(OWNER, "postgres-material"))?.plan).toMatchObject({
      asset: { kind: "material", bundleId: materialChoice.bundleId, resourceId: materialChoice.materialId },
    });
    expect(await store.get(OTHER, "postgres-material")).toBeNull();
    expect(await toolValue(await call("list_options", { category: "materials", bundleId: materialChoice.bundleId })))
      .toMatchObject({ total: 1, items: [{ materialId: materialChoice.materialId }] });
    expect(await toolValue(await call("list_options", { category: "sessions", bundleId: sessionChoice.bundleId })))
      .toMatchObject({ total: 1, items: [{ sessionId: sessionChoice.sessionId, format: "json" }] });
    const promptUpload = await upload("prompt", "new-data.jsonl", new TextEncoder().encode(`${JSON.stringify({
      name: "New case", description: "Existing independent resources",
      userPrompt: "PRIVATE_NEW_PROMPT", evalPrompt: "PRIVATE_NEW_EVAL_PROMPT",
    })}\n`), "application/x-ndjson");
    const prepared = await toolValue(await call("prepare_inputs", {
      operationKey: "postgres-new-data", promptUploadRef: promptUpload,
      name: "New Prompt Dataset", description: "Independent initial resources", format: "jsonl",
      cases: [{ initialMaterials: [materialChoice], evalInitialMaterials: [materialChoice],
        initialSession: sessionChoice }],
    }));
    expect(prepared).toMatchObject({ kind: "prepare", status: "completed", totalCases: 1 });
    const preparedDetail = await toolValue(await call("get_preparation", { operationKey: "postgres-new-data" }));
    expect(preparedDetail).toMatchObject({ cases: [{
      binding: "confirmed", initialMaterials: [materialChoice], evalInitialMaterials: [materialChoice],
      initialSession: sessionChoice,
    }] });
    expect(await datasets.getData((preparedDetail.cases as Array<{ dataId: string }>)[0]!.dataId))
      .toMatchObject({ initialMaterials: [materialChoice], initialSession: sessionChoice });
    const input = {
      operationKey: "postgres-lost-bind", datasetId: dataset.datasetId, dataId: original.dataId,
      expectedContentDigest: originalDigest, initialMaterials: [material, materialChoice],
      evalInitialMaterials: [materialChoice], initialSession: sessionChoice,
    };
    const lost = await (await call("bind_data_resources", input)).json() as { result: { isError?: boolean; content: [{ text: string }] } };
    expect(lost.result.isError).toBe(true);
    expect(lost.result.content[0].text).not.toContain("committed reply was lost");
    const pending = await toolValue(await call("get_preparation", { operationKey: input.operationKey }));
    expect(pending).toMatchObject({ kind: "bind", status: "outcome_unknown", binding: "attempted",
      initialSession: sessionChoice });
    await expect(store.assertReadyDatasets(OWNER, [dataset.datasetId])).rejects.toThrow();
    expect((await datasets.getData(original.dataId))!.initialMaterials).toHaveLength(2);
    const active = createBundleCatalogs(database.db, OWNER, directory).materialBundles;
    expect((await active.list()).length).toBe(2); // The original and exactly one saved Material Bundle.

    const receipt = await toolValue(await call("bind_data_resources", input));
    expect(receipt).toMatchObject({ kind: "bind", status: "completed", contentDigest: await digestJson(
      (await datasets.getData(original.dataId))!) });
    expect((await active.list()).length).toBe(2);
    expect((await store.get(OWNER, input.operationKey))?.status).toBe("completed");
    await expect(store.assertReadyDatasets(OWNER, [dataset.datasetId])).resolves.toBeUndefined();
    expect(JSON.stringify(receipt)).not.toMatch(/uploaded private bytes|PRIVATE_PROMPT|uploadRef|https?:\/\//u);
    expect(await toolValue(await call("bind_data_resources", input))).toEqual(receipt);
    expect((await active.list()).length).toBe(2);
  }, 60_000);

  it("fences an uncertain standalone catalog commit in PostgreSQL and read-only reconciles only its original key", async () => {
    const store = createPostgresManagementStore(database.db);
    const files = createManagementFiles(store, await openImportStaging(root, "management-uploads"));
    const sp = {} as EvalSpClient;
    const ownerServices = createOwnerServices({
      db: database.db, sp, bundles: directory,
      release: { sourceBranch: "no-network", sourceCommit: "a".repeat(40) },
      runQueue: { async enqueue() {} },
    });
    let loseReply = true;
    let writes = 0;
    const runtime: ApiRuntime = {
      webOrigin: WEB_ORIGIN, spAdminToken: "unused", sp, observation: {} as SpObservationClient,
      serviceAccount: { user: { id: OWNER, role: "user" }, email: "fixed@example.test", sessionToken: "session" },
      ownerServices: (user, token) => {
        const lease = ownerServices(user, token);
        return { ...lease, services: { ...lease.services, materialBundles: {
          ...lease.services.materialBundles,
          async create(...args: Parameters<typeof lease.services.materialBundles.create>) {
            writes++;
            const result = await lease.services.materialBundles.create(...args);
            if (loseReply) { loseReply = false; throw Error("catalog committed but reply was lost"); }
            return result;
          },
        } } };
      },
      evalManagement: { token: MANAGEMENT_TOKEN, store, files, spOrigin: "https://no-network.invalid" },
    };
    const request = requestApp(runtime);
    const call = async (name: string, args: unknown) => request(EVAL_MANAGEMENT_MCP_PATH, {
      method: "POST", headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const bytes = new TextEncoder().encode("private PostgreSQL resource");
    const uploadId = crypto.randomUUID();
    const upload = await request(MANAGEMENT_UPLOAD_PATH, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MANAGEMENT_TOKEN}`, "Content-Type": "application/octet-stream",
        "X-Upload-Id": uploadId, "X-Upload-Kind": "material", "X-Upload-Name": "lost.txt",
        "X-Upload-Media-Type": "text/plain", "X-Upload-Size": String(bytes.length),
        "X-Upload-Sha256": createHash("sha256").update(bytes).digest("hex"),
      },
      body: bytes,
    });
    expect(upload.status).toBe(201);
    const input = { operationKey: "pg-uncertain-material", kind: "material", uploadRef: uploadId };
    const lost = await (await call("save_initial_resource", input)).json() as {
      result: { isError?: boolean; content: [{ text: string }] };
    };
    expect(lost.result.isError).toBe(true);
    expect(lost.result.content[0].text).not.toContain("catalog committed");
    const pending = await toolValue(await call("get_preparation", { operationKey: input.operationKey }));
    expect(pending).toMatchObject({ kind: "initial_resource", resourceKind: "material",
      status: "outcome_unknown", stage: "attempted", bundleId: expect.any(String), materialId: expect.any(String) });
    expect(await store.get(OTHER, input.operationKey)).toBeNull();
    await expect(files.info(OTHER, uploadId, "material")).rejects.toThrow();
    const another = await (await call("save_initial_resource", { ...input, operationKey: "pg-new-key" })).json() as {
      result: { isError?: boolean; content: [{ text: string }] };
    };
    expect(another.result.content[0].text).toContain("EVAL_SP_CONFLICT");
    expect(await store.get(OWNER, "pg-new-key")).toBeNull();
    const recovered = await toolValue(await call("save_initial_resource", input));
    expect(recovered).toEqual({ operationKey: input.operationKey, kind: "initial_resource",
      resourceKind: "material", status: "completed",
      bundleId: pending.bundleId, materialId: pending.materialId });
    expect(writes).toBe(1);
    const catalog = createBundleCatalogs(database.db, OWNER, directory).materialBundles;
    await catalog.delete(recovered.bundleId as string);
    expect(await toolValue(await call("list_options", { category: "material_bundles" })))
      .toMatchObject({ total: 0, items: [] });
    expect(await toolValue(await call("get_preparation", { operationKey: input.operationKey })))
      .toEqual({ ...recovered, stage: "confirmed" });
    const deleted = await (await call("save_initial_resource", input)).json() as {
      result: { isError?: boolean; content: [{ text: string }] };
    };
    expect(deleted.result.isError).toBe(true);
    expect(writes).toBe(1);
  }, 60_000);

  it("lists only active resources for the owner, matching Bundle kind and selected child", async () => {
    const { materialBundles, sessionBundles, material, session } = await seeded();
    const foreign = createBundleCatalogs(database.db, OTHER, directory);
    const { bundle: foreignBundle } = await foreign.materialBundles.create({ name: "Foreign", description: "Must not list" },
      [{ ...labels, files: materialFiles }]);
    const extra = await materialBundles.createResource(material.bundleId, { name: "Deleted", description: "Hidden", files: materialFiles });
    await materialBundles.deleteResource(material.bundleId, extra.materialId);
    const app = setupManagement();
    Object.assign(app.services, { materialBundles, sessionBundles });
    expect(await toolValue(await app.call("list_options", { category: "material_bundles" })))
      .toMatchObject({ total: 1, items: [{ bundleId: material.bundleId }] });
    expect(await toolValue(await app.call("list_options", { category: "session_bundles" })))
      .toMatchObject({ total: 1, items: [{ bundleId: session.bundleId }] });
    expect(await toolValue(await app.call("list_options", { category: "materials", bundleId: material.bundleId })))
      .toMatchObject({ total: 1, items: [{ materialId: material.materialId, byteSize: 5 }] });
    expect(await toolValue(await app.call("list_options", {
      category: "material_files", bundleId: material.bundleId, materialId: material.materialId,
    }))).toMatchObject({ total: 1, items: [{ path: "/brief.txt", byteSize: 5, mediaType: "text/plain" }] });
    expect(await toolValue(await app.call("list_options", {
      category: "sessions", bundleId: session.bundleId,
    }))).toMatchObject({ total: 1, items: [{ sessionId: session.sessionId, format: "json" }] });
    for (const input of [
      { category: "materials", bundleId: foreignBundle.bundleId },
      { category: "materials", bundleId: session.bundleId },
      { category: "session_files", bundleId: material.bundleId, sessionId: session.sessionId },
      { category: "material_files", bundleId: material.bundleId, materialId: extra.materialId },
    ]) {
      const result = await (await app.call("list_options", input)).json() as {
        result: { isError?: boolean; content: [{ text: string }] };
      };
      expect(result.result.isError).toBe(true);
      expect(result.result.content[0].text).toContain("BUNDLE_RESOURCE_NOT_FOUND");
    }
    await materialBundles.delete(material.bundleId);
    expect(await toolValue(await app.call("list_options", { category: "material_bundles" })))
      .toMatchObject({ total: 0, items: [] });
  });
});
