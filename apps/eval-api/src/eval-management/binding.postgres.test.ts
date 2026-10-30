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
import { bundleMaterials, data as dataTable, managementOperations } from "../db/schema.js";
import { createTestDatabase } from "../db/test-database.js";
import { seedProject } from "../db/test-fixtures.js";
import { createInitialResourceApi, patchedInitialResources } from "../initial-resources.js";
import type { ApiRuntime } from "../lib/types.js";
import { createOwnerServices } from "../owner-services.js";
import { openBundleDirectory, type BundleDirectory } from "../sp/bundle-directory.js";
import type { EvalSpClient } from "../sp/client.js";
import type { SpObservationClient } from "../sp/observation.js";
import { requestApp, WEB_ORIGIN } from "../test-support.js";
import { batchBindingFingerprint, batchBindingReceipt, type BatchBindingPlan } from "./binding-plan.js";
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

  async function rowVersion(dataId: string): Promise<string> {
    const { rows } = await database.db.execute<{ version: string }>(
      sql`SELECT xmin::text AS version FROM eval_data WHERE data_id = ${dataId}`);
    if (!rows[0]) throw new Error("Missing Data version");
    return rows[0].version;
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
      category: "approval_dataset", datasetId: dataset.datasetId, dataIds: [original.dataId], page: 1, pageSize: 5,
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

  it("atomically binds three owned Data, with whole-row CAS, Session ownership and unchanged frozen Project samples", async () => {
    const { datasets, dataset, original, material, session, materialBundles, sessionBundles } = await seeded();
    const second = await datasets.createData({ userPrompt: "PRIVATE_SECOND", name: "Second" },
      { datasetId: dataset.datasetId });
    const third = await datasets.createData({ userPrompt: "PRIVATE_THIRD", name: "Third" },
      { datasetId: dataset.datasetId });
    const frozen = await seedProject(database.db, OWNER, {
      datasets: [{ datasetId: dataset.datasetId, data: [original, second, third] }],
    });
    const store = createPostgresManagementStore(database.db);
    const app = setupManagement();
    Object.assign(app.runtime.evalManagement!, { store });
    Object.assign(app.services, {
      initialResources: createInitialResourceApi(database.db, OWNER), materialBundles, sessionBundles,
    });
    const bindings = [
      { dataId: third.dataId, expectedContentDigest: await digestJson(third), initialSession: session },
      { dataId: original.dataId, expectedContentDigest: await digestJson(original), initialMaterials: [material] },
      { dataId: second.dataId, expectedContentDigest: await digestJson(second), evalInitialMaterials: [material] },
    ];
    const input = { operationKey: "pg-v4-three", datasetId: dataset.datasetId, bindings };
    const receipt = await toolValue(await app.call("bind_data_resources", input));
    expect(receipt).toEqual({ operationKey: input.operationKey, kind: "bind", status: "completed",
      datasetId: dataset.datasetId,
      bindings: await Promise.all(bindings.map(async ({ dataId }) => ({
        dataId, contentDigest: await digestJson(await datasets.getData(dataId)),
      }))) });
    expect(await toolValue(await app.call("get_preparation", { operationKey: input.operationKey, pageSize: 2 })))
      .toMatchObject({ kind: "bind", status: "completed", datasetId: dataset.datasetId,
        totalBindings: 3, page: 1, pageSize: 2,
        bindings: [{ dataId: third.dataId, binding: "confirmed" },
          { dataId: original.dataId, binding: "confirmed" }] });
    expect((await store.get(OWNER, input.operationKey))?.stages.batch?.status).toBe("confirmed");
    expect((await createPostgresProjectStore(database.db, OWNER).get(frozen.projectId))!.projectSamples
      .map(({ data: snapshot }) => snapshot)).toEqual([original, second, third]);
    expect(await toolValue(await app.call("bind_data_resources", input))).toEqual(receipt);
    const other = createInitialResourceApi(database.db, OTHER);
    await expect(other.inspectBindTargets(dataset.datasetId, bindings.map(({ dataId, expectedContentDigest }) =>
      ({ dataId, expectedContentDigest, contentDigest: expectedContentDigest }))))
      .rejects.toBeInstanceOf(DatasetEntityNotFoundError);
  });

  it("commits one already-satisfied Data and two changed Data in a single v4 MCP request, then accepts all-no-op", async () => {
    const { datasets, dataset, original, material, materialBundles, sessionBundles } = await seeded();
    const extra = await materialBundles.createResource(material.bundleId, { ...labels, files: materialFiles });
    const second = await datasets.createData({ userPrompt: "PRIVATE_SECOND" }, { datasetId: dataset.datasetId });
    const third = await datasets.createData({ userPrompt: "PRIVATE_THIRD" }, { datasetId: dataset.datasetId });
    const { dataId: _originalId, ...originalContent } = original;
    await datasets.updateData(original.dataId, {
      ...originalContent, initialMaterials: [material], evalInitialMaterials: [material],
    });
    const first = (await datasets.getData(original.dataId))!;
    const originalVersions = await Promise.all([first, second, third].map(({ dataId }) => rowVersion(dataId)));
    const store = createPostgresManagementStore(database.db);
    const api = createInitialResourceApi(database.db, OWNER);
    const app = setupManagement();
    let preflights = 0, transactions = 0;
    Object.assign(app.runtime.evalManagement!, { store });
    Object.assign(app.services, { materialBundles, sessionBundles, initialResources: {
      ...api,
      async preflightBindMaterialBytes(...args: Parameters<typeof api.preflightBindMaterialBytes>) {
        preflights++;
        return api.preflightBindMaterialBytes(...args);
      },
      async bindDataBatch(...args: Parameters<typeof api.bindDataBatch>) {
        transactions++;
        return api.bindDataBatch(...args);
      },
    } });
    const extraRef = { bundleId: extra.bundleId, materialId: extra.materialId };
    const bindings = [
      { dataId: first.dataId, expectedContentDigest: await digestJson(first),
        initialMaterials: [material], evalInitialMaterials: [material] },
      { dataId: second.dataId, expectedContentDigest: await digestJson(second),
        initialMaterials: [material], evalInitialMaterials: [material] },
      { dataId: third.dataId, expectedContentDigest: await digestJson(third),
        initialMaterials: [material, extraRef], evalInitialMaterials: [material] },
    ];
    const input = { operationKey: "pg-v4-mixed", datasetId: dataset.datasetId, bindings };
    const receipt = await toolValue(await app.call("bind_data_resources", input));
    expect(receipt).toEqual({ operationKey: input.operationKey, kind: "bind", status: "completed",
      datasetId: dataset.datasetId, bindings: await Promise.all(bindings.map(async ({ dataId }) => ({
        dataId, contentDigest: await digestJson(await datasets.getData(dataId)),
      }))) });
    expect(preflights).toBe(3);
    expect(transactions).toBe(1);
    expect((await store.get(OWNER, input.operationKey))?.stages.batch?.status).toBe("confirmed");
    expect(await datasets.getData(first.dataId)).toEqual(first);
    expect(await datasets.getData(second.dataId)).toMatchObject({
      initialMaterials: [material], evalInitialMaterials: [material],
    });
    expect(await datasets.getData(third.dataId)).toMatchObject({
      initialMaterials: [material, extraRef], evalInitialMaterials: [material],
    });
    const updatedVersions = await Promise.all(bindings.map(({ dataId }) => rowVersion(dataId)));
    expect(updatedVersions[0]).toBe(originalVersions[0]); // No redundant SQL UPDATE of the first Data.
    expect(updatedVersions[1]).not.toBe(originalVersions[1]);
    expect(updatedVersions[2]).not.toBe(originalVersions[2]);
    expect(await toolValue(await app.call("bind_data_resources", input))).toEqual(receipt);
    expect(transactions).toBe(1);

    const allSatisfied = { operationKey: "pg-v4-all-satisfied", datasetId: dataset.datasetId,
      bindings: await Promise.all(bindings.map(async ({ dataId, initialMaterials, evalInitialMaterials }) => ({
        dataId, expectedContentDigest: await digestJson(await datasets.getData(dataId)),
        initialMaterials, evalInitialMaterials,
      }))) };
    expect(await toolValue(await app.call("bind_data_resources", allSatisfied)))
      .toMatchObject({ status: "completed", bindings: [
        { dataId: first.dataId }, { dataId: second.dataId }, { dataId: third.dataId },
      ] });
    expect(preflights).toBe(6);
    expect(transactions).toBe(2); // Even an all-no-op batch performs its atomic locked validation.
    expect(await Promise.all(bindings.map(({ dataId }) => rowVersion(dataId)))).toEqual(updatedVersions);
    expect((await store.get(OWNER, allSatisfied.operationKey))?.status).toBe("completed");
    await expect(store.assertReadyDatasets(OWNER, [dataset.datasetId])).resolves.toBeUndefined();
  });

  it("replays a lost mixed-batch reply only after reading every no-op/original and changed/target Data digest", async () => {
    const { datasets, dataset, original, material, materialBundles, sessionBundles } = await seeded();
    const second = await datasets.createData({ userPrompt: "PRIVATE_SECOND" }, { datasetId: dataset.datasetId });
    const third = await datasets.createData({ userPrompt: "PRIVATE_THIRD" }, { datasetId: dataset.datasetId });
    const { dataId: _originalId, ...originalContent } = original;
    await datasets.updateData(original.dataId, { ...originalContent, initialMaterials: [material] });
    const first = (await datasets.getData(original.dataId))!;
    const store = createPostgresManagementStore(database.db);
    const api = createInitialResourceApi(database.db, OWNER);
    const app = setupManagement();
    let transactions = 0, loseReply = true;
    Object.assign(app.runtime.evalManagement!, { store });
    Object.assign(app.services, { materialBundles, sessionBundles, initialResources: {
      ...api,
      async bindDataBatch(...args: Parameters<typeof api.bindDataBatch>) {
        transactions++;
        const result = await api.bindDataBatch(...args);
        if (loseReply) { loseReply = false; throw new Error("private reply lost after commit"); }
        return result;
      },
    } });
    const input = { operationKey: "pg-v4-mixed-lost", datasetId: dataset.datasetId, bindings: [
      { dataId: first.dataId, expectedContentDigest: await digestJson(first), initialMaterials: [material] },
      { dataId: second.dataId, expectedContentDigest: await digestJson(second), evalInitialMaterials: [material] },
      { dataId: third.dataId, expectedContentDigest: await digestJson(third), initialMaterials: [material] },
    ] };
    const lost = await (await app.call("bind_data_resources", input)).json() as {
      result: { isError?: boolean; content: [{ text: string }] };
    };
    expect(lost.result.isError).toBe(true);
    expect(lost.result.content[0].text).not.toContain("private reply");
    expect((await store.get(OWNER, input.operationKey))?.stages.batch?.status).toBe("attempted");
    const versions = await Promise.all(input.bindings.map(({ dataId }) => rowVersion(dataId)));
    expect(await datasets.getData(first.dataId)).toEqual(first);
    expect(await datasets.getData(second.dataId)).toMatchObject({ evalInitialMaterials: [material] });
    expect(await datasets.getData(third.dataId)).toMatchObject({ initialMaterials: [material] });
    expect(await toolValue(await app.call("bind_data_resources", input))).toMatchObject({
      status: "completed", bindings: [{ dataId: first.dataId }, { dataId: second.dataId }, { dataId: third.dataId }],
    });
    expect(transactions).toBe(1); // A lost response never repeats the atomic batch.
    expect(await Promise.all(input.bindings.map(({ dataId }) => rowVersion(dataId)))).toEqual(versions);
    await datasets.updateData(first.dataId, { ...originalContent, initialMaterials: [material],
      userPrompt: "PRIVATE_EDIT_AFTER_COMPLETION" });
    const replay = await (await app.call("bind_data_resources", input)).json() as {
      result: { isError?: boolean; content: [{ text: string }] };
    };
    expect(replay.result.content[0].text).toContain("EVAL_SP_CONFLICT");
    expect(transactions).toBe(1);
  });

  it.each([0, 1, 2])("rolls back a mixed batch when member %i changes another field after trusted preflight", async (index) => {
    const { datasets, dataset, original, material, materialBundles, sessionBundles } = await seeded();
    const second = await datasets.createData({ userPrompt: "PRIVATE_SECOND" }, { datasetId: dataset.datasetId });
    const third = await datasets.createData({ userPrompt: "PRIVATE_THIRD" }, { datasetId: dataset.datasetId });
    const { dataId: _originalId, ...originalContent } = original;
    await datasets.updateData(original.dataId, { ...originalContent,
      initialMaterials: [material], evalInitialMaterials: [material] });
    const rows = [(await datasets.getData(original.dataId))!, second, third];
    const versions = await Promise.all(rows.map(({ dataId }) => rowVersion(dataId)));
    const store = createPostgresManagementStore(database.db);
    const api = createInitialResourceApi(database.db, OWNER);
    const app = setupManagement();
    let attempts = 0;
    Object.assign(app.runtime.evalManagement!, { store });
    Object.assign(app.services, { materialBundles, sessionBundles, initialResources: {
      ...api,
      async bindDataBatch(...args: Parameters<typeof api.bindDataBatch>) {
        attempts++;
        const { dataId: _id, ...content } = rows[index]!;
        await datasets.updateData(rows[index]!.dataId, {
          ...content, userPrompt: "PRIVATE_EDIT_AFTER_PREFLIGHT",
        });
        return api.bindDataBatch(...args);
      },
    } });
    const input = { operationKey: `pg-v4-mixed-stale-${index}`, datasetId: dataset.datasetId, bindings: [
      { dataId: rows[0]!.dataId, expectedContentDigest: await digestJson(rows[0]),
        initialMaterials: [material], evalInitialMaterials: [material] },
      { dataId: second.dataId, expectedContentDigest: await digestJson(second), evalInitialMaterials: [material] },
      { dataId: third.dataId, expectedContentDigest: await digestJson(third), initialMaterials: [material] },
    ] };
    const rpc = await (await app.call("bind_data_resources", input)).json() as {
      result: { isError?: boolean; content: [{ text: string }] };
    };
    expect(rpc.result.isError).toBe(true);
    expect(rpc.result.content[0].text).toContain("EVAL_SP_CONFLICT");
    expect(attempts).toBe(1);
    for (const [position, row] of rows.entries()) {
      expect(await datasets.getData(row.dataId)).toEqual(position === index
        ? { ...row, userPrompt: "PRIVATE_EDIT_AFTER_PREFLIGHT" } : row);
      if (position === index) expect(await rowVersion(row.dataId)).not.toBe(versions[position]);
      else expect(await rowVersion(row.dataId)).toBe(versions[position]);
    }
    expect((await store.get(OWNER, input.operationKey))?.status).toBe("pending");
    expect((await store.get(OWNER, input.operationKey))?.stages.batch?.status).toBe("attempted");
  });

  it("rejects a new soft-deleted reference in a mixed batch without updating the no-op or either changing Data", async () => {
    const { datasets, dataset, original, material, materialBundles, sessionBundles } = await seeded();
    const second = await datasets.createData({ userPrompt: "PRIVATE_SECOND" }, { datasetId: dataset.datasetId });
    const third = await datasets.createData({ userPrompt: "PRIVATE_THIRD" }, { datasetId: dataset.datasetId });
    const { dataId: _originalId, ...originalContent } = original;
    await datasets.updateData(original.dataId, { ...originalContent, initialMaterials: [material] });
    const first = (await datasets.getData(original.dataId))!;
    const doomed = await materialBundles.createResource(material.bundleId, { ...labels, files: materialFiles });
    const versions = await Promise.all([first, second, third].map(({ dataId }) => rowVersion(dataId)));
    const store = createPostgresManagementStore(database.db);
    const api = createInitialResourceApi(database.db, OWNER);
    const app = setupManagement();
    Object.assign(app.runtime.evalManagement!, { store });
    Object.assign(app.services, { materialBundles, sessionBundles, initialResources: {
      ...api,
      async bindDataBatch(...args: Parameters<typeof api.bindDataBatch>) {
        await materialBundles.deleteResource(doomed.bundleId, doomed.materialId);
        return api.bindDataBatch(...args);
      },
    } });
    const input = { operationKey: "pg-v4-mixed-deleted", datasetId: dataset.datasetId, bindings: [
      { dataId: first.dataId, expectedContentDigest: await digestJson(first), initialMaterials: [material] },
      { dataId: second.dataId, expectedContentDigest: await digestJson(second), initialMaterials: [material] },
      { dataId: third.dataId, expectedContentDigest: await digestJson(third),
        initialMaterials: [{ bundleId: doomed.bundleId, materialId: doomed.materialId }] },
    ] };
    const rpc = await (await app.call("bind_data_resources", input)).json() as {
      result: { isError?: boolean; content: [{ text: string }] };
    };
    expect(rpc.result.isError).toBe(true);
    expect(rpc.result.content[0].text).toContain("BUNDLE_RESOURCE_NOT_FOUND");
    for (const [position, row] of [first, second, third].entries()) {
      expect(await datasets.getData(row.dataId)).toEqual(row);
      expect(await rowVersion(row.dataId)).toBe(versions[position]);
    }
    expect((await store.get(OWNER, input.operationKey))?.status).toBe("pending");
  });

  it("cannot claim an all-no-op batch succeeded when catalog bytes change after preflight, even with a forged confirmed stage", async () => {
    const { datasets, dataset, original, material, materialBundles, sessionBundles } = await seeded();
    const { dataId: _originalId, ...originalContent } = original;
    await datasets.updateData(original.dataId, { ...originalContent, initialMaterials: [material] });
    const first = (await datasets.getData(original.dataId))!;
    const version = await rowVersion(first.dataId);
    const store = createPostgresManagementStore(database.db);
    const api = createInitialResourceApi(database.db, OWNER);
    const app = setupManagement();
    Object.assign(app.runtime.evalManagement!, { store });
    Object.assign(app.services, { materialBundles, sessionBundles, initialResources: {
      ...api,
      async bindDataBatch(...args: Parameters<typeof api.bindDataBatch>) {
        await database.db.update(bundleMaterials).set({ byteSize: EVAL_INITIALIZATION_MAX_BYTES + 1 })
          .where(eq(bundleMaterials.materialId, material.materialId));
        return api.bindDataBatch(...args);
      },
    } });
    const input = { operationKey: "pg-v4-all-noop-budget", datasetId: dataset.datasetId,
      bindings: [{ dataId: first.dataId, expectedContentDigest: await digestJson(first), initialMaterials: [material] }] };
    const rpc = await (await app.call("bind_data_resources", input)).json() as {
      result: { isError?: boolean; content: [{ text: string }] };
    };
    expect(rpc.result.isError).toBe(true);
    expect(rpc.result.content[0].text).toContain("BUNDLE_FILE_TOO_LARGE");
    expect(await rowVersion(first.dataId)).toBe(version);
    expect((await store.get(OWNER, input.operationKey))?.status).toBe("pending");
    const plan = (await store.get(OWNER, input.operationKey))!.plan as unknown as BatchBindingPlan;
    await store.confirm(OWNER, input.operationKey, "batch", batchBindingReceipt(plan));
    await expect(store.complete(OWNER, input.operationKey)).rejects.toThrow();
    expect((await store.get(OWNER, input.operationKey))?.status).toBe("pending");
    expect((await (await app.call("bind_data_resources", input)).json() as {
      result: { isError?: boolean; content: [{ text: string }] };
    }).result.content[0].text).toContain("BUNDLE_FILE_TOO_LARGE"); // Attempted replay still validates.
  });

  it("rejects a foreign existing reference in an all-no-op Data and refuses to complete a forged receipt", async () => {
    const { datasets, dataset, original, materialBundles, sessionBundles } = await seeded();
    const foreign = await createBundleCatalogs(database.db, OTHER, directory).materialBundles.create(labels,
      [{ ...labels, files: materialFiles }]);
    const badRef = { bundleId: foreign.bundle.bundleId, materialId: foreign.imported[0]!.materialId };
    const { dataId: _originalId, ...content } = { ...original, initialMaterials: [badRef] };
    await database.db.update(dataTable).set({ content }).where(eq(dataTable.dataId, original.dataId));
    const current = (await datasets.getData(original.dataId))!;
    const version = await rowVersion(original.dataId);
    const store = createPostgresManagementStore(database.db);
    const app = setupManagement();
    Object.assign(app.runtime.evalManagement!, { store });
    Object.assign(app.services, { materialBundles, sessionBundles,
      initialResources: createInitialResourceApi(database.db, OWNER) });
    const input = { operationKey: "pg-v4-noop-foreign", datasetId: dataset.datasetId,
      bindings: [{ dataId: original.dataId, expectedContentDigest: await digestJson(current), initialSession: null }] };
    const rpc = await (await app.call("bind_data_resources", input)).json() as {
      result: { isError?: boolean; content: [{ text: string }] };
    };
    expect(rpc.result.content[0].text).toContain("BUNDLE_RESOURCE_NOT_FOUND");
    expect(await datasets.getData(original.dataId)).toEqual(current);
    expect(await rowVersion(original.dataId)).toBe(version);
    const plan = (await store.get(OWNER, input.operationKey))!.plan as unknown as BatchBindingPlan;
    await store.confirm(OWNER, input.operationKey, "batch", batchBindingReceipt(plan));
    await expect(store.complete(OWNER, input.operationKey)).rejects.toBeInstanceOf(BundleResourceNotFoundError);
    expect((await store.get(OWNER, input.operationKey))?.status).toBe("pending");
  });

  it("does not complete a forged no-op plan whose patch would actually change the Data", async () => {
    const { datasets, dataset, original, material, materialBundles, sessionBundles } = await seeded();
    const request = { operationKey: "pg-v4-false-noop", datasetId: dataset.datasetId, bindings: [{
      dataId: original.dataId, expectedContentDigest: await digestJson(original), initialMaterials: [material],
    }] };
    const plan: BatchBindingPlan = { version: 4, request, datasetId: dataset.datasetId, bindings: [{
      dataId: original.dataId, expectedContentDigest: request.bindings[0]!.expectedContentDigest,
      contentDigest: request.bindings[0]!.expectedContentDigest, patch: { initialMaterials: [material] },
    }] };
    const store = createPostgresManagementStore(database.db);
    await store.begin(OWNER, request.operationKey, "bind", batchBindingFingerprint(OWNER, request),
      plan as unknown as Record<string, unknown>);
    await store.attempt(OWNER, request.operationKey, "batch");
    await store.confirm(OWNER, request.operationKey, "batch", batchBindingReceipt(plan));
    await expect(store.complete(OWNER, request.operationKey)).rejects.toThrow();
    const app = setupManagement();
    Object.assign(app.runtime.evalManagement!, { store });
    Object.assign(app.services, { materialBundles, sessionBundles,
      initialResources: createInitialResourceApi(database.db, OWNER) });
    const replay = await (await app.call("bind_data_resources", request)).json() as {
      result: { isError?: boolean; content: [{ text: string }] };
    };
    expect(replay.result.content[0].text).toContain("EVAL_SP_CONFLICT");
    expect((await store.get(OWNER, request.operationKey))?.status).toBe("pending");
    expect(await datasets.getData(original.dataId)).toEqual(original);
  });

  it.each(["stale", "detached"] as const)("checks every original no-op Data again before completing a %s batch", async (scenario) => {
    const { datasets, dataset, original, material } = await seeded();
    const second = await datasets.createData({ userPrompt: "PRIVATE_SECOND" }, { datasetId: dataset.datasetId });
    const { dataId: _originalId, ...content } = original;
    await datasets.updateData(original.dataId, { ...content, initialMaterials: [material] });
    const first = (await datasets.getData(original.dataId))!;
    const request = { operationKey: `pg-v4-completion-${scenario}`, datasetId: dataset.datasetId,
      bindings: await Promise.all([first, second].map(async (row) => ({
        dataId: row.dataId, expectedContentDigest: await digestJson(row), initialSession: null,
      }))) };
    const plan: BatchBindingPlan = { version: 4, request, datasetId: dataset.datasetId,
      bindings: request.bindings.map(({ dataId, expectedContentDigest }) => ({
        dataId, expectedContentDigest, contentDigest: expectedContentDigest, patch: { initialSession: null },
      })) };
    const store = createPostgresManagementStore(database.db);
    await store.begin(OWNER, request.operationKey, "bind", batchBindingFingerprint(OWNER, request),
      plan as unknown as Record<string, unknown>);
    await store.attempt(OWNER, request.operationKey, "batch");
    await store.confirm(OWNER, request.operationKey, "batch", batchBindingReceipt(plan));
    if (scenario === "stale") {
      await datasets.updateData(second.dataId, { userPrompt: "PRIVATE_EDIT_AFTER_PREFLIGHT" });
    } else {
      await datasets.detachData(dataset.datasetId, [second.dataId]);
    }
    await expect(store.complete(OWNER, request.operationKey)).rejects.toThrow();
    expect((await store.get(OWNER, request.operationKey))?.status).toBe("pending");
    expect(await datasets.getData(first.dataId)).toEqual(first);
  });

  it("rolls back every Data if a later selected Material soft-deletes after preflight; attempted replay cannot rewrite", async () => {
    const { datasets, dataset, original, material, materialBundles, sessionBundles } = await seeded();
    const second = await datasets.createData({ userPrompt: "PRIVATE_SECOND" }, { datasetId: dataset.datasetId });
    const third = await datasets.createData({ userPrompt: "PRIVATE_THIRD" }, { datasetId: dataset.datasetId });
    const doomed = await materialBundles.createResource(material.bundleId, { ...labels, files: materialFiles });
    const store = createPostgresManagementStore(database.db);
    const api = createInitialResourceApi(database.db, OWNER);
    const app = setupManagement();
    let attempts = 0;
    Object.assign(app.runtime.evalManagement!, { store });
    Object.assign(app.services, {
      materialBundles, sessionBundles, initialResources: {
        ...api,
        async bindDataBatch(...args: Parameters<typeof api.bindDataBatch>) {
          attempts++;
          // The first row was valid at planning; make a later member invalid only
          // AFTER store.begin/attempt, so the final transaction must revalidate all.
          await materialBundles.deleteResource(doomed.bundleId, doomed.materialId);
          return api.bindDataBatch(...args);
        },
      },
    });
    const input = {
      operationKey: "pg-v4-rollback", datasetId: dataset.datasetId,
      bindings: [
        { dataId: original.dataId, expectedContentDigest: await digestJson(original),
          initialMaterials: [material] },
        { dataId: second.dataId, expectedContentDigest: await digestJson(second),
          initialMaterials: [{ bundleId: doomed.bundleId, materialId: doomed.materialId }] },
        { dataId: third.dataId, expectedContentDigest: await digestJson(third), evalInitialMaterials: [material] },
      ],
    };
    const rpc = await (await app.call("bind_data_resources", input)).json() as {
      result: { isError?: boolean; content: [{ text: string }] };
    };
    expect(rpc.result.isError).toBe(true);
    expect(attempts).toBe(1);
    expect(await datasets.getData(original.dataId)).toEqual(original);
    expect(await datasets.getData(second.dataId)).toEqual(second);
    expect(await datasets.getData(third.dataId)).toEqual(third);
    expect(await toolValue(await app.call("get_preparation", { operationKey: input.operationKey })))
      .toMatchObject({ kind: "bind", status: "outcome_unknown",
        bindings: [{ binding: "attempted" }, { binding: "attempted" }, { binding: "attempted" }] });
    const replay = await (await app.call("bind_data_resources", input)).json() as {
      result: { isError?: boolean; content: [{ text: string }] };
    };
    expect(replay.result.content[0].text).toContain("OPERATION_OUTCOME_UNKNOWN");
    expect(attempts).toBe(1);
    await expect(store.assertReadyDatasets(OWNER, [dataset.datasetId])).rejects.toThrow();
  });

  it("rolls back an earlier SQL update if a later Data update fails (not just a pre-write validation)", async () => {
    const { datasets, dataset, original, material } = await seeded();
    const second = await datasets.createData({ userPrompt: "PRIVATE_SECOND" }, { datasetId: dataset.datasetId });
    const ordered = [original, second].sort((a, b) => a.dataId < b.dataId ? -1 : a.dataId > b.dataId ? 1 : 0);
    const api = createInitialResourceApi(database.db, OWNER);
    const patch = { initialMaterials: [material] };
    const bindings = await Promise.all([...ordered].reverse().map(async (row) => ({
      dataId: row.dataId, expectedContentDigest: await digestJson(row),
      contentDigest: await digestJson(patchedInitialResources(row, patch)), patch,
    })));
    // NOT VALID leaves the existing last row in place, but rejects its later
    // UPDATE. The sorted first UPDATE must be rolled back with it.
    const rejectLast = ordered[1]!.dataId === original.dataId
      ? sql`CHECK (content->>'userPrompt' <> 'PRIVATE_PROMPT') NOT VALID`
      : sql`CHECK (content->>'userPrompt' <> 'PRIVATE_SECOND') NOT VALID`;
    await database.db.execute(sql`ALTER TABLE eval_data ADD CONSTRAINT eval_batch_rollback_test_ck ${rejectLast}`);
    try {
      await expect(api.bindDataBatch(dataset.datasetId, bindings)).rejects.toThrow();
    } finally {
      await database.db.execute(sql`ALTER TABLE eval_data DROP CONSTRAINT eval_batch_rollback_test_ck`);
    }
    expect(await datasets.getData(original.dataId)).toEqual(original);
    expect(await datasets.getData(second.dataId)).toEqual(second);
  });

  it("recovers a committed v4 batch after a lost DB response only by reading back all Data, fencing another v4", async () => {
    const { datasets, dataset, original, material, materialBundles, sessionBundles } = await seeded();
    const second = await datasets.createData({ userPrompt: "PRIVATE_SECOND" }, { datasetId: dataset.datasetId });
    const store = createPostgresManagementStore(database.db);
    const api = createInitialResourceApi(database.db, OWNER);
    const app = setupManagement();
    let writes = 0, loseReply = true;
    Object.assign(app.runtime.evalManagement!, { store });
    Object.assign(app.services, {
      materialBundles, sessionBundles, initialResources: {
        ...api,
        async bindDataBatch(...args: Parameters<typeof api.bindDataBatch>) {
          writes++;
          const result = await api.bindDataBatch(...args);
          if (loseReply) { loseReply = false; throw Error("Private DB response lost after commit"); }
          return result;
        },
      },
    });
    const input = { operationKey: "pg-v4-lost-reply", datasetId: dataset.datasetId, bindings: [
      { dataId: original.dataId, expectedContentDigest: await digestJson(original), initialMaterials: [material] },
      { dataId: second.dataId, expectedContentDigest: await digestJson(second), evalInitialMaterials: [material] },
    ] };
    const lost = await (await app.call("bind_data_resources", input)).json() as {
      result: { isError?: boolean; content: [{ text: string }] };
    };
    expect(lost.result.isError).toBe(true);
    expect(lost.result.content[0].text).not.toContain("Private DB");
    expect((await store.get(OWNER, input.operationKey))?.stages.batch?.status).toBe("attempted");
    const overlapping = await (await app.call("bind_data_resources", {
      operationKey: "pg-v4-other", datasetId: dataset.datasetId,
      bindings: [{ dataId: second.dataId, expectedContentDigest: await digestJson(await datasets.getData(second.dataId)),
        initialMaterials: [material] }],
    })).json() as { result: { content: [{ text: string }] } };
    expect(overlapping.result.content[0].text).toContain("EVAL_SP_CONFLICT");
    expect(await store.get(OWNER, "pg-v4-other")).toBeNull();
    const receipt = await toolValue(await app.call("bind_data_resources", input));
    expect(receipt).toMatchObject({ kind: "bind", status: "completed", bindings: [
      { dataId: original.dataId }, { dataId: second.dataId },
    ] });
    expect(writes).toBe(1);
    expect((await store.get(OWNER, input.operationKey))?.status).toBe("completed");
    expect(await toolValue(await app.call("bind_data_resources", input))).toEqual(receipt);
    expect(writes).toBe(1);
  });

  it("fences overlapping v3 and v4 bind keys across Datasets, but not a disjoint new Data", async () => {
    const { datasets, dataset, original, material } = await seeded();
    const otherDataset = await datasets.createDataset({ name: "Shared Data" });
    await datasets.attachData(otherDataset.datasetId, [original.dataId]);
    const unrelated = await datasets.createData({ userPrompt: "UNRELATED" }, { datasetId: dataset.datasetId });
    const store = createPostgresManagementStore(database.db);
    const originalDigest = await digestJson(original);
    await store.begin(OWNER, "pg-v3-pending", "bind", "a".repeat(64),
      { version: 3, datasetId: otherDataset.datasetId, dataId: original.dataId,
        expectedContentDigest: originalDigest, contentDigest: "b".repeat(64), patch: { initialMaterials: [material] } });
    const app = setupManagement();
    Object.assign(app.runtime.evalManagement!, { store });
    Object.assign(app.services, {
      initialResources: createInitialResourceApi(database.db, OWNER),
      ...createBundleCatalogs(database.db, OWNER, directory),
    });
    const overlap = { operationKey: "pg-v4-overlap", datasetId: dataset.datasetId,
      bindings: [{ dataId: original.dataId, expectedContentDigest: originalDigest, initialMaterials: [material] },
        { dataId: unrelated.dataId, expectedContentDigest: await digestJson(unrelated), initialMaterials: [material] }] };
    const failed = await (await app.call("bind_data_resources", overlap)).json() as {
      result: { content: [{ text: string }] };
    };
    expect(failed.result.content[0].text).toContain("EVAL_SP_CONFLICT");
    expect(await store.get(OWNER, overlap.operationKey)).toBeNull();
    expect(await toolValue(await app.call("bind_data_resources", {
      operationKey: "pg-v4-disjoint", datasetId: dataset.datasetId,
      bindings: [{ dataId: unrelated.dataId, expectedContentDigest: await digestJson(unrelated),
        initialMaterials: [material] }],
    }))).toMatchObject({ kind: "bind", status: "completed" });
    expect((await store.get(OWNER, "pg-v3-pending"))?.status).toBe("pending"); // v3 plan untouched
  });

  it("uses the existing locked catalog validation for v4 retained soft-deletes, foreign refs and full rollback", async () => {
    const { datasets, dataset, original, material, session, materialBundles } = await seeded();
    const second = await datasets.createData({ userPrompt: "OTHER_MEMBER" }, { datasetId: dataset.datasetId });
    const { dataId: _id, ...content } = original;
    await datasets.updateData(original.dataId, { ...content, initialMaterials: [material] });
    const retained = (await datasets.getData(original.dataId))!;
    await materialBundles.deleteResource(material.bundleId, material.materialId);
    const api = createInitialResourceApi(database.db, OWNER);
    const firstPatch = { initialMaterials: [material], initialSession: session };
    const secondPatch = { initialSession: session };
    const batch = [
      { dataId: retained.dataId, expectedContentDigest: await digestJson(retained),
        contentDigest: await digestJson(patchedInitialResources(retained, firstPatch)), patch: firstPatch },
      { dataId: second.dataId, expectedContentDigest: await digestJson(second),
        contentDigest: await digestJson(patchedInitialResources(second, secondPatch)), patch: secondPatch },
    ];
    expect(await api.bindDataBatch(dataset.datasetId, batch)).toMatchObject([
      { dataId: original.dataId, initialMaterials: [material], initialSession: session },
      { dataId: second.dataId, initialSession: session },
    ]);
    const before = await api.inspectBindTargets(dataset.datasetId, batch);
    const clear = { initialSession: null };
    const invalid = { evalInitialMaterials: [material] }; // Deleted in this *other* field, never retained.
    await expect(api.bindDataBatch(dataset.datasetId, [
      { dataId: before[0]!.dataId, expectedContentDigest: await digestJson(before[0]),
        contentDigest: await digestJson(patchedInitialResources(before[0]!, clear)), patch: clear },
      { dataId: before[1]!.dataId, expectedContentDigest: await digestJson(before[1]),
        contentDigest: await digestJson(patchedInitialResources(before[1]!, invalid)), patch: invalid },
    ])).rejects.toBeInstanceOf(BundleResourceNotFoundError);
    expect(await api.inspectBindTargets(dataset.datasetId, batch)).toEqual(before);
    const wrongKind = { initialSession: { bundleId: material.bundleId, sessionId: session.sessionId } };
    await expect(api.bindDataBatch(dataset.datasetId, [
      { dataId: before[0]!.dataId, expectedContentDigest: await digestJson(before[0]),
        contentDigest: await digestJson(patchedInitialResources(before[0]!, clear)), patch: clear },
      { dataId: before[1]!.dataId, expectedContentDigest: await digestJson(before[1]),
        contentDigest: await digestJson(patchedInitialResources(before[1]!, wrongKind)), patch: wrongKind },
    ])).rejects.toBeInstanceOf(BundleResourceNotFoundError);
    expect(await api.inspectBindTargets(dataset.datasetId, batch)).toEqual(before);
  });

  it("a confirmed stage cannot complete v4 until the actual batch is committed", async () => {
    const { datasets, dataset, original, material } = await seeded();
    const second = await datasets.createData({ userPrompt: "Second" }, { datasetId: dataset.datasetId });
    const store = createPostgresManagementStore(database.db);
    const api = createInitialResourceApi(database.db, OWNER);
    const request = { operationKey: "pg-confirm-before-write", datasetId: dataset.datasetId,
      bindings: await Promise.all([original, second].map(async (row) => ({
        dataId: row.dataId, expectedContentDigest: await digestJson(row), initialMaterials: [material],
      }))) };
    const plan = { version: 4 as const, request, datasetId: dataset.datasetId,
      bindings: await Promise.all([original, second].map(async (row, index) => {
        const patch = { initialMaterials: [material] };
        return { dataId: row.dataId, expectedContentDigest: request.bindings[index]!.expectedContentDigest,
          contentDigest: await digestJson(patchedInitialResources(row, patch)), patch };
      })) };
    await store.begin(OWNER, request.operationKey, "bind", batchBindingFingerprint(OWNER, request), plan);
    await store.attempt(OWNER, request.operationKey, "batch");
    await store.confirm(OWNER, request.operationKey, "batch", batchBindingReceipt(plan));
    await expect(store.complete(OWNER, request.operationKey)).rejects.toThrow();
    expect((await store.get(OWNER, request.operationKey))?.status).toBe("pending");
    expect(await datasets.getData(original.dataId)).toEqual(original);
    expect(await datasets.getData(second.dataId)).toEqual(second);
    await api.bindDataBatch(dataset.datasetId, plan.bindings);
    await store.complete(OWNER, request.operationKey);
    expect((await store.get(OWNER, request.operationKey))?.status).toBe("completed");
  });

  it("serializes concurrent v4 begin reservations and pages all 20 Dataset members without dropping identities", async () => {
    const { datasets, dataset, original, material } = await seeded();
    const members = [original];
    for (let index = 0; index < 21; index++) members.push(await datasets.createData({
      userPrompt: `PRIVATE_PROMPT_${index}`, name: `Case ${index}`,
    }, { datasetId: dataset.datasetId }));
    const store = createPostgresManagementStore(database.db);
    const first = await store.listDatasetData(OWNER, dataset.datasetId, 1, 20);
    expect(first).toMatchObject({ total: 22, order: "upload" });
    expect(first.items.map(({ dataId }) => dataId)).toEqual(members.slice(0, 20).map(({ dataId }) => dataId));
    expect((await store.listDatasetData(OWNER, dataset.datasetId, 2, 20)).items.map(({ dataId }) => dataId))
      .toEqual(members.slice(20).map(({ dataId }) => dataId));
    await expect(store.listDatasetData(OWNER, dataset.datasetId, 1, 21)).rejects.toThrow();

    const reserve = async (key: string, ids: readonly string[]) => {
      const request = { operationKey: key, datasetId: dataset.datasetId,
        bindings: await Promise.all(ids.map(async (dataId) => ({
          dataId, expectedContentDigest: await digestJson(members.find((row) => row.dataId === dataId)!),
          initialMaterials: [material],
        }))) };
      const bindings = await Promise.all(request.bindings.map(async ({ dataId, expectedContentDigest }) => {
        const patch = { initialMaterials: [material] };
        return { dataId, expectedContentDigest,
          contentDigest: await digestJson(patchedInitialResources(members.find((row) => row.dataId === dataId)!, patch)),
          patch };
      }));
      return store.begin(OWNER, key, "bind", batchBindingFingerprint(OWNER, request),
        { version: 4, request, datasetId: dataset.datasetId, bindings });
    };
    const concurrent = await Promise.allSettled([
      reserve("concurrent-one", [members[0]!.dataId, members[1]!.dataId]),
      reserve("concurrent-two", [members[1]!.dataId, members[2]!.dataId]),
    ]);
    expect(concurrent.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
    expect([await store.get(OWNER, "concurrent-one"), await store.get(OWNER, "concurrent-two")]
      .filter((row) => row?.status === "pending")).toHaveLength(1);
  });
});
