import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "./worker.js";

const required = {
  DATABASE_URL: "postgres://eval:eval@127.0.0.1:55432/eval",
  EVAL_SP_AGENT_ORIGIN: "https://agent.eval-sp.test/",
  EVAL_SP_SERVICE_TOKEN: "service-token",
  EVAL_BUNDLE_DIR: "/var/eval/bundles",
};

describe("Run worker configuration", () => {
  it("normalizes the SP Agent origin and defaults the Run concurrency", () => {
    expect(loadWorkerConfig(required)).toEqual({
      ...required,
      EVAL_SP_AGENT_ORIGIN: "https://agent.eval-sp.test",
      EVAL_RUN_WORKER_CONCURRENCY: 8,
    });
  });

  it("groups the Langfuse score settings only when all are set", () => {
    const langfuse = {
      LANGFUSE_BASE_URL: "https://us.cloud.langfuse.com/",
      LANGFUSE_PUBLIC_KEY: "pk-lf",
      LANGFUSE_SECRET_KEY: "sk-lf",
      LANGFUSE_ENVIRONMENT: "dev",
    };
    expect(loadWorkerConfig({ ...required, ...langfuse }).langfuse).toEqual({
      baseUrl: "https://us.cloud.langfuse.com", publicKey: "pk-lf", secretKey: "sk-lf", environment: "dev",
    });
    expect(loadWorkerConfig({ ...required, LANGFUSE_ENVIRONMENT: "dev" })).not.toHaveProperty("langfuse");
    expect(() => loadWorkerConfig({ ...required, LANGFUSE_PUBLIC_KEY: "pk-lf" })).toThrow("must be set together");
  });

  it("selects the R2 evidence bucket only when all its settings are set", () => {
    const r2 = {
      EVAL_EVIDENCE_R2_ENDPOINT: "https://account.r2.cloudflarestorage.com/",
      EVAL_EVIDENCE_R2_BUCKET: "eval-evidence",
      EVAL_EVIDENCE_R2_ACCESS_KEY_ID: "key-id",
      EVAL_EVIDENCE_R2_SECRET_ACCESS_KEY: "secret",
    };
    const config = loadWorkerConfig({ ...required, ...r2 });
    expect(config.evidenceR2).toEqual({
      endpoint: "https://account.r2.cloudflarestorage.com", bucket: "eval-evidence", accessKeyId: "key-id", secretAccessKey: "secret",
    });
    expect(config).not.toHaveProperty("EVAL_EVIDENCE_R2_SECRET_ACCESS_KEY");
    expect(loadWorkerConfig(required)).not.toHaveProperty("evidenceR2");
    expect(() => loadWorkerConfig({ ...required, EVAL_EVIDENCE_R2_BUCKET: "eval-evidence" })).toThrow("must be set together");
  });

  it("parses an explicit Run concurrency", () => {
    expect(loadWorkerConfig({ ...required, EVAL_RUN_WORKER_CONCURRENCY: "3" }).EVAL_RUN_WORKER_CONCURRENCY).toBe(3);
  });

  it.each([
    ["DATABASE_URL", undefined],
    ["EVAL_SP_AGENT_ORIGIN", "https://agent.eval-sp.test/internal"],
    ["EVAL_SP_SERVICE_TOKEN", " "],
    ["EVAL_BUNDLE_DIR", "relative/bundles"],
    ["EVAL_RUN_WORKER_CONCURRENCY", "0"],
  ])("rejects an invalid %s", (name, value) => {
    expect(() => loadWorkerConfig({ ...required, [name]: value })).toThrow(name);
  });
});
