import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("./render-secrets.py", import.meta.url);
const app = {
  EVAL_SP_API_ORIGIN: "https://eval-api.example.test",
  EVAL_SP_SERVICE_USER_ID: "eval-owner",
  EVAL_SP_SERVICE_SESSION_TOKEN: "target-session",
  EVAL_SP_ADMIN_TOKEN: "target-admin",
  EVAL_WEB_ORIGIN: "https://eval-web.example.test",
  EVAL_WEB_API_TOKEN: "browser-gateway",
  EVAL_SP_SOURCE_BRANCH: "eval",
  EVAL_SP_SOURCE_COMMIT: "a".repeat(40),
  EVAL_SP_AGENT_ORIGIN: "https://eval-agent.example.test",
  EVAL_SP_TRUSTED_ORIGIN: "https://eval-web.example.test",
  EVAL_SP_SERVICE_TOKEN: "target-harness",
};
const database = {
  dbname: "eval-platform",
  username: "eval_owner",
  password: "test-only@password",
  host: "database.example.test",
};
const source = {
  SP_PLATFORM_RESOURCE_ADMIN_TOKEN: "source-export",
};

function render(overrides = {}, db = database) {
  const directory = mkdtempSync(path.join(tmpdir(), "eval-import-env-test-"));
  try {
    writeFileSync(path.join(directory, "app.json"), JSON.stringify({ ...app, ...overrides }));
    writeFileSync(path.join(directory, "database.json"), JSON.stringify(db));
    return spawnSync("python3", [
      script.pathname, path.join(directory, "app.json"), path.join(directory, "database.json"),
    ], { encoding: "utf8" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("ordinary deployment needs no dev credentials or import consumer", () => {
  const result = render();
  assert.equal(result.status, 0, result.stderr);
  const overlay = JSON.parse(result.stdout);
  assert.equal(overlay["x-agent-imports-enabled"], false);
  assert.deepEqual(Object.keys(overlay.services).sort(), ["api", "run-worker"]);
});

test("dev credentials reach API and import consumer, never Run Worker", () => {
  const result = render(source);
  assert.equal(result.status, 0, result.stderr);
  const overlay = JSON.parse(result.stdout);
  assert.equal(overlay["x-agent-imports-enabled"], true);
  const api = overlay.services.api.environment;
  const importer = overlay.services["import-worker"].environment;
  const runner = overlay.services["run-worker"].environment;
  assert.equal(api.SP_PLATFORM_RESOURCE_ADMIN_TOKEN, "source-export");
  assert.equal(importer.SP_PLATFORM_RESOURCE_ADMIN_TOKEN, "source-export");
  assert.equal(api.EVAL_DEV_SP_API_ORIGIN, undefined);
  assert.equal(importer.EVAL_DEV_SP_API_ORIGIN, undefined);
  assert.equal(importer.EVAL_SP_SERVICE_SESSION_TOKEN, "target-session");
  assert.equal(runner.EVAL_SP_SERVICE_TOKEN, "target-harness");
  assert.equal(runner.EVAL_DEV_SP_API_ORIGIN, undefined);
  assert.equal(runner.SP_PLATFORM_RESOURCE_ADMIN_TOKEN, undefined);
  assert.equal(importer.EVAL_SP_SERVICE_TOKEN, undefined);
  assert.equal(importer.EVAL_SP_ADMIN_TOKEN, undefined);
  assert.equal(importer.EVAL_WEB_API_TOKEN, undefined);
});

test("a legacy source origin alone neither enables imports nor reaches any process", () => {
  const result = render({ EVAL_DEV_SP_API_ORIGIN: "https://other-dev.example.test" });
  assert.equal(result.status, 0, result.stderr);
  const overlay = JSON.parse(result.stdout);
  assert.equal(overlay["x-agent-imports-enabled"], false);
  assert.equal(overlay.services["import-worker"], undefined);
  for (const service of Object.values(overlay.services)) {
    assert.equal(service.environment.EVAL_DEV_SP_API_ORIGIN, undefined);
    assert.equal(service.environment.SP_PLATFORM_RESOURCE_ADMIN_TOKEN, undefined);
  }
});

test("source cannot resolve to the same HTTP origin as target", () => {
  const result = render({
    ...source,
    EVAL_SP_API_ORIGIN: "https://DEVRAPI.springbrand.ai:443/",
    EVAL_DEV_SP_API_ORIGIN: "https://other-dev.example.test",
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /different/u);
});

test("only Eval's dedicated database is accepted", () => {
  const result = render(source, { ...database, dbname: "springbrand-dev" });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Database secret must target eval-platform/u);
});

test("a legacy source origin cannot override the fixed source when imports are enabled", () => {
  const result = render({ ...source, EVAL_DEV_SP_API_ORIGIN: "https://other-dev.example.test" });
  assert.equal(result.status, 0, result.stderr);
  const overlay = JSON.parse(result.stdout);
  assert.equal(overlay["x-agent-imports-enabled"], true);
  assert.equal(overlay.services["import-worker"].environment.SP_PLATFORM_RESOURCE_ADMIN_TOKEN, "source-export");
  for (const service of Object.values(overlay.services)) {
    assert.equal(service.environment.EVAL_DEV_SP_API_ORIGIN, undefined);
  }
});

test("database credentials are escaped and the connection verifies TLS", () => {
  const result = render(source);
  assert.equal(result.status, 0, result.stderr);
  const url = new URL(JSON.parse(result.stdout).services["import-worker"].environment.DATABASE_URL);
  assert.equal(decodeURIComponent(url.password), "test-only@password");
  assert.equal(url.searchParams.get("sslmode"), "verify-full");
  assert.equal(url.searchParams.get("sslrootcert"), "/etc/ssl/certs/aws-rds-global-bundle.pem");
});

test("evidence and score credentials do not spread to import consumer", () => {
  const result = render({
    ...source,
    EVAL_EVIDENCE_R2_SECRET_ACCESS_KEY: "evidence-only",
    LANGFUSE_SECRET_KEY: "score-only",
    EVAL_RESULT_MCP_TOKEN: "result-only",
    EVAL_MANAGEMENT_MCP_TOKEN: "management-only",
  });
  assert.equal(result.status, 0, result.stderr);
  const services = JSON.parse(result.stdout).services;
  assert.equal(services["run-worker"].environment.EVAL_EVIDENCE_R2_SECRET_ACCESS_KEY, "evidence-only");
  assert.equal(services.api.environment.LANGFUSE_SECRET_KEY, "score-only");
  assert.equal(services.api.environment.EVAL_MANAGEMENT_MCP_TOKEN, "management-only");
  assert.equal(services["run-worker"].environment.EVAL_MANAGEMENT_MCP_TOKEN, undefined);
  assert.equal(services["import-worker"].environment.EVAL_MANAGEMENT_MCP_TOKEN, undefined);
  assert.equal(services["import-worker"].environment.EVAL_EVIDENCE_R2_SECRET_ACCESS_KEY, undefined);
  assert.equal(services["import-worker"].environment.LANGFUSE_SECRET_KEY, undefined);
  assert.equal(services["import-worker"].environment.EVAL_RESULT_MCP_TOKEN, undefined);
});
