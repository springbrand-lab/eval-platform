import { describe, expect, it } from "vitest";
import { buildDataInput } from "./datasets/data-editor-page";
import { eventSummary } from "./observation/trajectory-tab";
import { isTextFile } from "./observation/workspace-tab";
import { checkMaterialFiles } from "./resources/bundle-detail-page";
import { buildSelector } from "./runs/new-run-page";
import { normalizePaths } from "@/components/ui/file-dropzone";

describe("Run selector", () => {
  it("builds each scope and rejects empty choices", () => {
    expect(buildSelector("all", new Set(), new Set(), "")).toEqual({ all: true });
    expect(buildSelector("datasets", new Set(["d"]), new Set(), "")).toEqual({ datasetIds: ["d"] });
    expect(buildSelector("samples", new Set(), new Set(), "")).toEqual(expect.stringContaining("用例"));
    expect(buildSelector("samplings", new Set(), new Set(), "s1, s2\ns1")).toEqual({ samplingIds: ["s1", "s2"] });
  });
});

describe("Data editor", () => {
  const base = { userPrompt: "Build", evalPrompt: "", extra: '{"name":"Hello"}', initialMaterials: [], evalInitialMaterials: [], initialSession: null };

  it("keeps business fields and maps resource choices to references", () => {
    expect(buildDataInput({ ...base, evalPrompt: "Judge", initialMaterials: [{ bundleId: "b", id: "m" }], initialSession: { bundleId: "b", id: "s" } }))
      .toEqual({ name: "Hello", userPrompt: "Build", evalPrompt: "Judge", initialMaterials: [{ bundleId: "b", materialId: "m" }], initialSession: { bundleId: "b", sessionId: "s" } });
  });

  it.each([
    [{ userPrompt: " " }, "userPrompt"],
    [{ extra: "{" }, "JSON 格式错误"],
    [{ extra: "[]" }, "JSON 对象"],
    [{ extra: '{"userPrompt":"x"}' }, "不能包含 userPrompt"],
    [{ initialMaterials: [{ bundleId: "b", id: "" }] }, "请选择素材"],
  ])("explains %j", (patch, message) => {
    expect(buildDataInput({ ...base, ...patch })).toEqual(expect.stringContaining(message));
  });
});

describe("Material upload", () => {
  it("enforces count, size and unique paths", () => {
    expect(checkMaterialFiles([])).toContain("至少");
    expect(checkMaterialFiles([{ path: "/a", size: 6_000_000 }])).toContain("单个文件");
    expect(checkMaterialFiles([{ path: "/a", size: 1 }, { path: "/a", size: 1 }])).toContain("重复");
    expect(checkMaterialFiles([{ path: "/a", size: 1 }])).toBeNull();
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
  it("recognizes previewable text files", () => {
    expect(isTextFile("/index.html", "")).toBe(true);
    expect(isTextFile("/data.bin", "application/json")).toBe(true);
    expect(isTextFile("/logo.png", "image/png")).toBe(false);
  });

  it("summarizes a trajectory event", () => {
    expect(eventSummary({ eventId: "e", occurredAt: "t", type: "tool.started", payload: { toolName: "write_file" } })).toBe("工具 write_file");
    expect(eventSummary({ eventId: "e", occurredAt: "t", type: "x" })).toBe("");
  });
});
