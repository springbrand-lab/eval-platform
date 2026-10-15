import { describe, expect, it } from "vitest";
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
};

describe("API configuration", () => {
  it("normalizes origins, applies listen defaults and validates the SP release once", () => {
    expect(loadApiConfig(environment)).toEqual({
      DATABASE_URL: environment.DATABASE_URL,
      EVAL_SP_API_ORIGIN: "https://sp-api.test",
      EVAL_SP_SERVICE_USER_ID: "d2a9754b-5427-4301-bf16-0c81a189a5da",
      EVAL_SP_SERVICE_SESSION_TOKEN: "service-session",
      EVAL_SP_ADMIN_TOKEN: "admin-token",
      EVAL_WEB_ORIGIN: "https://eval-web.test",
      EVAL_BUNDLE_DIR: "/var/eval/bundles",
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
  ])("rejects invalid configuration %o", (override) => {
    expect(() => loadApiConfig({ ...environment, ...override })).toThrow();
  });
});
