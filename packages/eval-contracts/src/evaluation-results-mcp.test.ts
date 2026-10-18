import { describe, expect, it } from "vitest";
import { EVALUATION_RESULTS_MCP_PATH, isEvaluationResultsMcpUrl, resolveEvaluationResultsMcp } from "./evaluation-results-mcp.js";

describe("evaluation result MCP contract", () => {
  it("matches only the canonical public path", () => {
    expect(EVALUATION_RESULTS_MCP_PATH).toBe("/mcp/evaluation-results");
    expect(isEvaluationResultsMcpUrl("https://eval.example/mcp/evaluation-results")).toBe(true);
    expect(isEvaluationResultsMcpUrl("https://eval.example/mcp/evaluation-results/")).toBe(true);
    expect(isEvaluationResultsMcpUrl("https://eval.example/mcp/evaluation-results?token=secret")).toBe(true);
    expect(isEvaluationResultsMcpUrl("https://eval.example/tools/evaluation-results")).toBe(false);
    expect(isEvaluationResultsMcpUrl("not a URL")).toBe(false);
  });

  it("requires one active Bearer server before exposing the result MCP", () => {
    const base = { id: "result-mcp", source: "user", status: "active", url: "https://eval.example/mcp/evaluation-results", authType: "bearer" } as const;
    expect(resolveEvaluationResultsMcp([base])).toEqual({ kind: "available", server: base });
    expect(resolveEvaluationResultsMcp([base, { ...base, id: "result-mcp-2" }])).toMatchObject({ kind: "multiple" });
    expect(resolveEvaluationResultsMcp([{ ...base, status: "disabled" }])).toMatchObject({ kind: "disabled" });
    expect(resolveEvaluationResultsMcp([{ ...base, authType: "none" }])).toMatchObject({ kind: "invalid-auth" });
  });
});
