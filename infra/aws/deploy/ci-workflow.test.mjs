import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Use the API workspace's declared parser, also installed by the CI deployment-test job.
const require = createRequire(new URL("../../../apps/eval-api/package.json", import.meta.url));
const { parse } = require("yaml");
const workflow = parse(readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8"));
const deployWeb = workflow.jobs["deploy-web"];

function allowsWeb({
  apiChanged = false, apiDeployment = "skipped", webChanged = true,
  web = "success", packages = "skipped", branch = "main", event = "push", cancelled = false,
} = {}) {
  // This job's guard uses boolean operators shared with JS; only its hyphenated job ID differs.
  return runInNewContext(deployWeb.if.replaceAll("needs.deploy-api", 'needs["deploy-api"]'), {
    github: { ref: `refs/heads/${branch}`, event_name: event },
    needs: {
      changes: { outputs: { api: String(apiChanged), web: String(webChanged) } },
      packages: { result: packages },
      web: { result: web },
      "deploy-api": { result: apiDeployment },
    },
    cancelled: () => cancelled,
  }, { timeout: 100 });
}

test("Web waits for the API deployment job, not just the API tests", () => {
  assert.ok(deployWeb.needs.includes("deploy-api"));
});

test("Web-only releases allow an unchanged API's skipped deployment", () => {
  // A status function is required to override Actions' implicit success() for skipped needs.
  assert.match(deployWeb.if, /!cancelled\(\)/u);
  assert.equal(allowsWeb(), true);
});

for (const apiDeployment of ["failure", "cancelled", "skipped"]) {
  test(`a changed API's ${apiDeployment} deployment blocks Web`, () => {
    assert.equal(allowsWeb({ apiChanged: true, apiDeployment }), false);
  });
}

test("Web can follow a successfully deployed changed API", () => {
  assert.equal(allowsWeb({ apiChanged: true, apiDeployment: "success", packages: "success" }), true);
});

test("Web still requires its affected tests and shared-package tests to pass", () => {
  for (const result of ["failure", "cancelled"]) {
    assert.equal(allowsWeb({ web: result }), false);
    assert.equal(allowsWeb({ packages: result }), false);
  }
  assert.equal(allowsWeb({ webChanged: false }), false);
  assert.equal(allowsWeb({ cancelled: true }), false);
});

test("deployment remains main-only and never runs for pull requests", () => {
  assert.equal(allowsWeb({ branch: "dev" }), false);
  assert.equal(allowsWeb({ event: "pull_request" }), false);
  assert.equal(allowsWeb({ event: "workflow_dispatch" }), true);
  assert.deepEqual(workflow.on.push.branches, ["main", "dev"]);
  assert.deepEqual(workflow.on.pull_request.branches, ["main", "dev"]);
});

test("AWS deployment credentials stay isolated from Web deployment and test jobs", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.jobs["deploy-api"].permissions["id-token"], "write");
  for (const job of ["changes", "packages", "api", "cli", "web", "deploy-web"]) {
    assert.equal(workflow.jobs[job].permissions?.["id-token"], undefined);
  }
  const cloudflareDeploy = deployWeb.steps.find((step) => step.name === "Deploy Worker");
  assert.equal(cloudflareDeploy.env.CLOUDFLARE_API_TOKEN, "${{ secrets.CLOUDFLARE_API_TOKEN }}");
  assert.equal(cloudflareDeploy.env.CLOUDFLARE_ACCOUNT_ID, "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
});
