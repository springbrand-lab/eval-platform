import { SP_PI_TRAJECTORY_FORMAT, type EvidenceExportProgress as EvidenceExportProgressContract,
  type EvidenceExportState } from "@eval-platform/eval-contracts";
import { describe, expect, it } from "vitest";
import { render } from "@/test/render";
import { EvidenceExportProgress } from "./evidence-export-progress";

const sha = (char: string) => char.repeat(64);
const progress = {
  exportedAt: "2026-10-19T00:00:00.000Z",
  artifacts: [
    { path: "/a.html", size: 1, mediaType: "text/html", sha256: sha("a") },
    { path: "/b.json", size: 1, mediaType: "application/json" },
    { path: "/c.png", size: 1, mediaType: "image/png", sha256: sha("c") },
  ],
  subjectInputs: [{ path: "/in.txt", size: 1, mediaType: "text/plain", bundleId: "b", materialId: "m", sha256: sha("d") }],
  omitted: [{ path: "/huge.bin", reason: "too-large" as const }],
  trajectory: { format: SP_PI_TRAJECTORY_FORMAT, throughSeq: 400,
    afterSeq: 400, parts: [{ sha256: sha("e"), size: 10, records: 200 }, { sha256: sha("f"), size: 10, records: 200 }] },
} satisfies EvidenceExportProgressContract;

async function lines(state: EvidenceExportState | undefined, executionStatus: string) {
  const view = await render(<EvidenceExportProgress state={state} executionStatus={executionStatus} />);
  try { return [...view.container.querySelectorAll("p")].map((line) => line.textContent); }
  finally { await view.unmount(); }
}

describe("EvidenceExportProgress", () => {
  it("renders nothing without an export", async () => {
    expect(await lines(undefined, "succeeded")).toEqual([]);
  });

  it("summarizes stored files, trajectory parts, the pass budget and the last error", async () => {
    expect(await lines({ submissionId: "s", passes: 1, lastError: "R2 unavailable", progress }, "retrying")).toEqual([
      "证据导出中 · 第 2/5 轮",
      "产物 2/3 · 执行输入 1/1 · 轨迹 2 段（读取中） · 1 个文件未纳入证据",
      "最近错误：R2 unavailable",
    ]);
  });

  it("waits for the evidence listing before any pass stored progress", async () => {
    expect(await lines({ submissionId: "s", passes: 0 }, "retrying")).toEqual(["证据导出中 · 第 1/5 轮", "等待 SP 返回产物清单"]);
  });

  it("reports a finished trajectory without omitted files", async () => {
    const done = { ...progress, omitted: [], trajectory: { ...progress.trajectory, done: true as const } };
    expect((await lines({ submissionId: "s", passes: 2, progress: done }, "retrying"))[1]).toBe("产物 2/3 · 执行输入 1/1 · 轨迹 2 段（已完成）");
  });

  it("explains a failed export keeps its progress for recollection", async () => {
    expect((await lines({ submissionId: "s", passes: 5, lastError: "timeout", progress }, "failed"))[0])
      .toBe("证据导出失败（已用 5/5 轮），已保留进度，重新收集执行结果会从断点继续");
  });
});
