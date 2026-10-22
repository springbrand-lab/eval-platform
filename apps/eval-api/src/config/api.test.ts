import { describe, expect, it } from "vitest";
import { loadAgentImportWorkerConfig } from "./agent-imports.js";
import { loadApiConfig } from "./api.js";

const environment = {
  DATABASE_URL: "postgres://eval@127.0.0.1/eval",
  EVAL_SP_API_ORIGIN: "https://sp-api.test/",
  EVAL_SP_SERVICE_USER_ID: "D2A9754B-5427-4301-BF16-0C81A189A5DA",
  EVAL_SP_SERVICE_SESSION_TOKEN: "service-session",
  EVAL_SP_ADMIN_TOKEN: "admin-token",
  EVAL_WEB_ORIGIN: "https://eval-web.test",
  EVAL_SP_SOURCE_BRANCH: "release-2.0.0",
  EVAL_SP_SOURCE_COMMIT: "a".repeat(40),
  EVAL_BUNDLE_DIR: "/var/eval/bundles",
  EVAL_SP_AGENT_ORIGIN: "https://sp-agent.test",
  EVAL_SP_TRUSTED_ORIGIN: "https://sp-web.test",
};

const importConfigurations = [
  { name: "API", load: loadApiConfig },
  { name: "import worker", load: loadAgentImportWorkerConfig },
];

describe("API configuration", () => {
  it.each(importConfigurations)("uses the fixed Dev source with only Takt's credential for $name", ({ load }) => {
    expect(load({
      ...environment, SP_PLATFORM_RESOURCE_ADMIN_TOKEN: "existing-takt-sp-token",
    })).toMatchObject({
      EVAL_DEV_SP_API_ORIGIN: "https://devrapi.springbrand.ai",
      SP_PLATFORM_RESOURCE_ADMIN_TOKEN: "existing-takt-sp-token",
    });
  });

  it("normalizes origins, applies listen defaults and validates the SP release once", () => {
    expect(loadApiConfig(environment)).toEqual({
      DATABASE_URL: environment.DATABASE_URL,
      EVAL_SP_API_ORIGIN: "https://sp-api.test",
      EVAL_SP_SERVICE_USER_ID: "d2a9754b-5427-4301-bf16-0c81a189a5da",
      EVAL_SP_SERVICE_SESSION_TOKEN: "service-session",
      EVAL_SP_ADMIN_TOKEN: "admin-token",
      EVAL_WEB_ORIGIN: "https://eval-web.test",
      EVAL_BUNDLE_DIR: "/var/eval/bundles",
      EVAL_SP_AGENT_ORIGIN: "https://sp-agent.test",
      EVAL_SP_TRUSTED_ORIGIN: "https://sp-web.test",
      EVAL_API_HOST: "127.0.0.1",
      EVAL_API_PORT: 8788,
      release: { sourceBranch: "release-2.0.0", sourceCommit: "a".repeat(40) },
    });
  });

  it.each([
    { EVAL_WEB_ORIGIN: undefined },
    { EVAL_WEB_ORIGIN: "https://eval-web.test/app" },
    { EVAL_BUNDLE_DIR: "bundles" },
    { EVAL_API_PORT: "70000" },
    { EVAL_SP_SOURCE_COMMIT: "main" },
    { EVAL_SP_SERVICE_USER_ID: "service" },
    { EVAL_SP_SERVICE_SESSION_TOKEN: undefined },
    { EVAL_SP_ADMIN_TOKEN: "" },
    { EVAL_SP_AGENT_ORIGIN: undefined },
    { EVAL_SP_TRUSTED_ORIGIN: "https://sp-web.test/path" },
    { EVAL_WEB_API_TOKEN: "too-short" },
  ])("rejects invalid configuration %o", (override) => {
    expect(() => loadApiConfig({ ...environment, ...override })).toThrow();
  });

  it.each(importConfigurations)("keeps imports optional without allowing source overrides or matching targets for $name", ({ load }) => {
    expect(load(environment)).not.toHaveProperty("EVAL_DEV_SP_API_ORIGIN");
    const legacyOrigin = { EVAL_DEV_SP_API_ORIGIN: "https://other-dev.test" };
    expect(load({ ...environment, ...legacyOrigin })).not.toHaveProperty("EVAL_DEV_SP_API_ORIGIN");
    expect(load({
      ...environment, ...legacyOrigin, SP_PLATFORM_RESOURCE_ADMIN_TOKEN: "takt-source-admin",
    })).toMatchObject({
      EVAL_DEV_SP_API_ORIGIN: "https://devrapi.springbrand.ai", SP_PLATFORM_RESOURCE_ADMIN_TOKEN: "takt-source-admin",
    });
    expect(() => load({ ...environment, SP_PLATFORM_RESOURCE_ADMIN_TOKEN: " " })).toThrow();
    expect(() => load({
      ...environment, EVAL_SP_API_ORIGIN: "https://DEVRAPI.springbrand.ai:443/",
      SP_PLATFORM_RESOURCE_ADMIN_TOKEN: "takt-source-admin",
    })).toThrow(/source and target SP origins must be different/u);
  });
});
