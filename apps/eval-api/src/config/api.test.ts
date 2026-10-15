import { describe, expect, it } from "vitest";
import { loadApiConfig } from "./api.js";

const environment = {
  DATABASE_URL: "postgres://eval@127.0.0.1/eval",
  EVAL_SP_API_ORIGIN: "https://sp-api.test/",
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
  ])("rejects invalid configuration %o", (override) => {
    expect(() => loadApiConfig({ ...environment, ...override })).toThrow();
  });
});
