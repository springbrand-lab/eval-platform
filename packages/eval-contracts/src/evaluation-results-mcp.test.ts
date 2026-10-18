import { describe, expect, it } from "vitest";
import { EVALUATION_RESULTS_MCP_PATH, isEvaluationResultsMcpUrl } from "./evaluation-results-mcp.js";

describe("evaluation result MCP contract", () => {
  it("matches only the canonical public path", () => {
    expect(EVALUATION_RESULTS_MCP_PATH).toBe("/mcp/evaluation-results");
    expect(isEvaluationResultsMcpUrl("https://eval.example/mcp/evaluation-results")).toBe(true);
    expect(isEvaluationResultsMcpUrl("https://eval.example/mcp/evaluation-results/")).toBe(true);
    expect(isEvaluationResultsMcpUrl("https://eval.example/mcp/evaluation-results?token=secret")).toBe(true);
    expect(isEvaluationResultsMcpUrl("https://eval.example/tools/evaluation-results")).toBe(false);
    expect(isEvaluationResultsMcpUrl("not a URL")).toBe(false);
  });
});
