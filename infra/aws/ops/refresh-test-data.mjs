import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { seedDemoData } from "../../../fixtures/eval-demo/seed.mjs";

const catalogs = {
  projects: { path: "/api/projects", id: "projectId" },
  datasets: { path: "/api/datasets", id: "datasetId" },
  data: { path: "/api/data", id: "dataId" },
  materialBundles: { path: "/api/material-bundles", id: "bundleId" },
  sessionBundles: { path: "/api/session-bundles", id: "bundleId" },
  outputSchemas: { path: "/api/evaluation-output-schemas", id: "outputSchemaId" },
};

const identities = (snapshot) => Object.fromEntries(Object.entries(catalogs).map(([name, { id }]) =>
  [name, snapshot[name].map((record) => record[id]).sort()]));
const counts = (snapshot) => Object.fromEntries(Object.keys(catalogs).map((name) => [name, snapshot[name].length]));

/** One authorized operation over the existing service-account HTTP API; no SQL writes or SP storage access. */
export function createTestDataRefresh({ origin, token, writeOrigin, ownerUserId, fetcher = fetch, log = console.log }) {
  assert.ok(token && writeOrigin && ownerUserId, "The existing Eval service account and Web credentials are required");
  const request = async (path, { method = "GET", body } = {}) => {
    const response = await fetcher(`${origin}${path}`, {
      method,
      headers: { "X-Eval-Web-Token": token, Origin: writeOrigin,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 204) return;
    const result = await response.json();
    assert.ok(response.ok && result.success === true,
      `Refresh request failed: ${method} ${path} (${response.status}) ${result.code ?? ""} ${result.errMsg ?? ""}`);
    return result.msg;
  };
  const inventory = async () => {
    assert.equal((await request("/api/me")).id, ownerUserId, "The API must be scoped to the configured Eval account");
    return Object.fromEntries(await Promise.all(Object.entries(catalogs).map(async ([name, { path }]) => {
      const records = await request(path);
      assert.ok(Array.isArray(records), `Expected a complete catalog array: ${path}`);
      return [name, records];
    })));
  };
  return {
    inventory,
    async verify(receipt) {
      assert.equal(receipt.ownerUserId, ownerUserId);
      const active = await inventory();
      assert.deepEqual(counts(active), receipt.after);
      assert.equal(active.materialBundles[0].bundleId, receipt.materialBundleId);
      assert.equal(active.sessionBundles[0].bundleId, receipt.sessionBundleId);
      assert.equal(active.outputSchemas[0].outputSchemaId, receipt.outputSchemaId);
      assert.deepEqual(active.datasets.map(({ datasetId }) => datasetId).sort(), [...receipt.datasetIds].sort());
      let checkedFiles = 0;
      for (const [kind, bundleId, count] of [["materials", receipt.materialBundleId, receipt.materials], ["sessions", receipt.sessionBundleId, receipt.sessions]]) {
        const base = `/api/${kind === "materials" ? "material" : "session"}-bundles/${bundleId}/${kind}`;
        const resources = await request(base);
        assert.equal(resources.length, count);
        for (const record of resources) {
          const path = `${base}/${record.materialId ?? record.sessionId}`;
          for (const file of await request(`${path}/files`)) {
            const response = await fetcher(`${origin}${path}/file?${new URLSearchParams({ path: file.path })}`, {
              headers: { "X-Eval-Web-Token": token }, signal: AbortSignal.timeout(30_000),
            });
            assert.ok(response.ok, `Refreshed file read failed: ${path} ${response.status}`);
            assert.equal((await response.arrayBuffer()).byteLength, file.byteSize);
            checkedFiles++;
          }
        }
      }
      assert.equal(checkedFiles, receipt.checkedFiles);
      log("Verified current HTTP catalogs and file reads:", JSON.stringify({ ...counts(active), checkedFiles }));
    },
    async quiesce() {
      const before = await inventory();
      log("Existing test data:", JSON.stringify(counts(before)));
      for (const project of before.projects) {
        const path = `/api/projects/${encodeURIComponent(project.projectId)}`;
        let view = await request(path);
        if (view.currentRun) {
          log("Stopping active test Run:", view.currentRun.runId);
          await request(`${path}/runs/${encodeURIComponent(view.currentRun.runId)}/stop`, { method: "POST" });
          const deadline = Date.now() + 240_000;
          do {
            assert.ok(Date.now() < deadline, `Run stop did not finalize for ${project.projectId}; no data was deleted`);
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            view = await request(path);
          } while (view.currentRun);
        }
      }
      const after = await inventory();
      assert.deepEqual(identities(after), identities(before), "Catalog membership changed while stopping Runs");
      return { ownerUserId, capturedAt: new Date().toISOString(), ...after };
    },
    async apply(snapshot) {
      assert.equal(snapshot.ownerUserId, ownerUserId);
      assert.deepEqual(identities(await inventory()), identities(snapshot),
        "Catalog membership changed after backup; refusing to delete a different data set");
      for (const [name, { path, id }] of Object.entries(catalogs)) {
        for (const record of snapshot[name]) await request(`${path}/${encodeURIComponent(record[id])}`, { method: "DELETE" });
        log("Removed old test catalog entries:", name, snapshot[name].length);
      }
      assert.deepEqual(counts(await inventory()), Object.fromEntries(Object.keys(catalogs).map((name) => [name, 0])));
      const input = { origin, token, writeOrigin, fetcher };
      const seeded = await seedDemoData(input);
      assert.deepEqual(await seedDemoData(input), seeded, "Repeated upload must verify the same resources");
      const after = await inventory();
      assert.deepEqual(counts(after), { projects: 0, datasets: 2, data: 5, materialBundles: 1, sessionBundles: 1, outputSchemas: 1 });
      for (const [name, ids] of Object.entries(identities(after))) {
        assert.ok(ids.every((id) => !identities(snapshot)[name].includes(id)), `Old identities remain active in ${name}`);
      }
      const receipt = { ownerUserId, before: counts(snapshot), after: counts(after), ...seeded };
      log("Verified refreshed test data:", JSON.stringify(receipt));
      return receipt;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.env.EVAL_TEST_DATA_REFRESH, "all-test-data-authorized");
  const [mode, snapshotPath, receiptPath] = process.argv.slice(2);
  const refresh = createTestDataRefresh({ origin: "http://127.0.0.1:8788", token: process.env.EVAL_WEB_API_TOKEN,
    writeOrigin: process.env.EVAL_WEB_ORIGIN, ownerUserId: process.env.EVAL_SP_SERVICE_USER_ID });
  if (mode === "--quiesce") {
    await writeFile(snapshotPath, JSON.stringify(await refresh.quiesce()), { mode: 0o600, flag: "wx" });
  } else if (mode === "--apply") {
    const receipt = await refresh.apply(JSON.parse(await readFile(snapshotPath, "utf8")));
    await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600, flag: "wx" });
  } else if (mode === "--verify") {
    await refresh.verify(JSON.parse(await readFile(snapshotPath, "utf8")));
  } else throw new Error("Expected --quiesce, --apply or --verify");
}
