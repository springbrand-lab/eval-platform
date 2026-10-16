import { describe, expect, it } from "vitest";
import { buildDataInput } from "./datasets/data-draft-fields";
import { eventSummary } from "./observation/trajectory-tab";
import { checkMaterialFiles } from "./resources/bundle-detail-page";
import { buildSelector } from "./runs/new-run-page";
import { normalizePaths } from "@/components/ui/file-dropzone";
import { inputLimits } from "@/test/input-limits";

describe("Run selector", () => {
  it("canonicalizes mixed hierarchy choices and rejects empty selection", () => {
    expect(buildSelector({ all: true, samplingIds: ["s"] })).toEqual({ all: true });
    expect(buildSelector({ datasetIds: ["d"], projectSampleIds: [] })).toEqual({ datasetIds: ["d"] });
    expect(buildSelector({ samplingIds: [] })).toEqual(expect.stringContaining("用例"));
    expect(buildSelector({ datasetIds: ["d"], samplingIds: ["s2", "s1", "s1"] })).toEqual({ datasetIds: ["d"], samplingIds: ["s1", "s2"] });
  });
});

describe("Data editor", () => {
  const bundleId = "10000000-0000-4000-8000-000000000001";
  const materialId = "10000000-0000-4000-8000-000000000002";
  const sessionId = "10000000-0000-4000-8000-000000000003";
  const base = { name: "Hello", description: "A page", userPrompt: "Build", evalPrompt: "Judge", extra: '{"custom":[1,true,null]}', initialMaterials: [], evalInitialMaterials: [], initialSession: null };

  it("keeps all four required fields, business JSON and resource references", () => {
    expect(buildDataInput({ ...base, initialMaterials: [{ bundleId, id: materialId }], initialSession: { bundleId, id: sessionId } }))
      .toEqual({ name: "Hello", description: "A page", custom: [1, true, null], userPrompt: "Build", evalPrompt: "Judge", initialMaterials: [{ bundleId, materialId }], initialSession: { bundleId, sessionId } });
  });

  it.each([
    [{ name: " " }, "名称"],
    [{ description: " " }, "说明"],
    [{ userPrompt: " " }, "执行任务"],
    [{ evalPrompt: " " }, "评估要求"],
    [{ extra: "{" }, "JSON 格式错误"],
    [{ extra: "[]" }, "JSON 对象"],
    [{ extra: '{"custom":1,"custom":2}' }, "JSON 格式错误"],
    [{ extra: '{"userPrompt":"x"}' }, "不能包含 userPrompt"],
    [{ initialMaterials: [{ bundleId: "b", id: "" }] }, "请选择素材"],
  ])("explains %j", (patch, message) => {
    expect(buildDataInput({ ...base, ...patch })).toEqual(expect.stringContaining(message));
  });
});

describe("Material upload", () => {
  it("enforces count, size and unique paths", () => {
    expect(checkMaterialFiles([], inputLimits)).toContain("至少");
    expect(checkMaterialFiles([{ path: "/a", size: 6_000_000 }], inputLimits)).toContain("单个文件");
    expect(checkMaterialFiles([{ path: "/a", size: 1 }, { path: "/a", size: 1 }], inputLimits)).toContain("重复");
    expect(checkMaterialFiles([{ path: "/a", size: 1 }], inputLimits)).toBeNull();
    expect(checkMaterialFiles([{ path: "/a", size: 10 }], { ...inputLimits, materialFileBytes: 9 })).toContain("9 B");
  });

  it("drops one shared top-level folder", () => {
    const file = new File(["x"], "x");
    expect(normalizePaths([{ path: "/site/index.html", file }, { path: "/site/css/a.css", file }]).map((item) => item.path))
      .toEqual(["/index.html", "/css/a.css"]);
    expect(normalizePaths([{ path: "/index.html", file }, { path: "/site/a.css", file }]).map((item) => item.path))
      .toEqual(["/index.html", "/site/a.css"]);
  });
});

describe("Observation helpers", () => {
  it("summarizes a trajectory event", () => {
    expect(eventSummary({ eventId: "e", occurredAt: 0, type: "tool.started", payload: { toolName: "write_file" } })).toBe("工具 write_file");
    expect(eventSummary({ eventId: "e", occurredAt: 0, type: "x" })).toBe("");
  });
});
