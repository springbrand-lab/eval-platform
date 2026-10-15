import { ApiError } from "@springbrand/http/client";
import { describe, expect, it } from "vitest";
import { describeError, fieldErrors } from "./errors";
import { formatBytes, formatDuration, formatNumber, formatPercent } from "./format";
import { langfuseScoreId, langfuseSessionUrl } from "./langfuse";

describe("errors", () => {
  it("maps known codes to Chinese, appends field errors and falls back to the server text", () => {
    expect(describeError(new ApiError({ status: 409, code: "PROJECT_BUSY", message: "busy" }))).toBe("Project 还有未结束的 Run");
    expect(describeError(new ApiError({
      status: 422, code: "REQUEST_VALIDATION_FAILED", message: "Validation failed",
      errors: [{ path: "name", errMsg: "Required" }],
    }))).toBe("填写的内容未通过校验：name Required");
    expect(describeError(new ApiError({ status: 503, code: "TAKT_UNAVAILABLE", message: "暂时无法连接 takt" }))).toBe("暂时无法连接 takt");
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  it("keys field errors by their first path segment", () => {
    expect(fieldErrors(new ApiError({
      status: 422, code: "REQUEST_VALIDATION_FAILED", message: "",
      errors: [{ path: "setting.model", errMsg: "bad" }, { path: "slug", errMsg: "taken" }],
    }))).toEqual({ setting: "bad", slug: "taken" });
    expect(fieldErrors(new Error("x"))).toEqual({});
  });
});

describe("format", () => {
  it("formats numbers, percentages, durations and sizes", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber(1.236, 2)).toBe("1.24");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(0.875)).toBe("87.5%");
    expect(formatDuration(850)).toBe("850 毫秒");
    expect(formatDuration(75_000)).toBe("1 分 15 秒");
    expect(formatBytes(2048)).toBe("2.0 KB");
  });
});

describe("Langfuse links", () => {
  it("points at the Subject Chat's session and names the fixed score ID", () => {
    expect(langfuseSessionUrl("chat-1", "https://lf.test/project/p1/")).toBe("https://lf.test/project/p1/sessions/chat-1");
    expect(langfuseSessionUrl("chat-1", "")).toBeNull();
    expect(langfuseSessionUrl(null, "https://lf.test/project/p1")).toBeNull();
    expect(langfuseScoreId("e-1")).toBe("eval-score:e-1");
  });
});
