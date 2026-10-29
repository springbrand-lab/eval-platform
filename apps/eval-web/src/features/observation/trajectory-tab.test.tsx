import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JsonValue, NativeTrajectoryEntry, SpPiTrajectoryRecordReference } from "@eval-platform/eval-contracts";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrajectoryPage } from "@/api-sdk/observations-api";
import { click, render } from "@/test/render";
import { TrajectoryTab } from "./trajectory-tab";
import { TooltipProvider } from "@/components/ui/tooltip";

const get = vi.hoisted(() => vi.fn<() => Promise<TrajectoryPage>>());
vi.mock("@/api-sdk/observations-api", async (original) => ({ ...await original<object>(), getTrajectoryPage: get }));
const stored = (seq: number, kind: string, value: Record<string, JsonValue> = {}): NativeTrajectoryEntry => ({
  ingestSeq: seq, record: {
    format: "pi-trajectory/v1", resource: { agentId: "agent", sessionId: "chat" },
    submissionId: "submission", projection: { kind: "safe", policyId: "test", policyVersion: 1 },
    record: { type: "entry", value: { id: seq + 10, conversationId: 1, kind, ...value } },
  },
});
const conversation = (seq: number): NativeTrajectoryEntry => ({
  ingestSeq: seq, record: {
    format: "pi-trajectory/v1", resource: { agentId: "agent", sessionId: "chat" },
    submissionId: "submission", projection: { kind: "safe", policyId: "test", policyVersion: 1 },
    record: { type: "conversation", value: { id: seq + 10 } },
  },
});
const reference = (seq: number, throughSeq = 8): SpPiTrajectoryRecordReference => ({
  ingestSeq: seq, reference: { format: "sp-pi-trajectory-record/v1", throughSeq,
    identity: JSON.stringify(["agent", "chat", "entry", seq + 10]), byteLength: 5_500_000, sha256: "a".repeat(64) },
});
const page: TrajectoryPage = { format: "sp-pi-trajectory/v1", cursor: { throughSeq: 8 }, records: [
  stored(3, "springbrand.trajectory"), stored(4, "pi.user", {
    model: [{ role: "user", content: "original native evidence", timestamp: 1_700_000_000_000 }],
  }), conversation(5), stored(6, "new.entry"),
], nextAfterSeq: 6 };

async function choose(select: Element | null, value: string) {
  await act(async () => { (select as HTMLSelectElement).value = value; select!.dispatchEvent(new Event("change", { bubbles: true })); });
}
const settle = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

describe("read-only native Chat trajectory", () => {
  beforeEach(() => { get.mockReset(); get.mockResolvedValue(page); });

  it("renders an empty native Chat trajectory page without an ingestSeq error", async () => {
    // The public SP Chat route returns `records`, not the old `events` page.
    get.mockResolvedValueOnce({ format: "sp-pi-trajectory/v1", cursor: { throughSeq: 0 }, records: [], nextAfterSeq: null });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(<QueryClientProvider client={client}><TrajectoryTab projectId="p" kind="samplings" id="s" /></QueryClientProvider>);
    try {
      await settle();
      expect(view.container.textContent).toContain("还没有轨迹记录");
      expect(view.container.textContent).not.toContain("Cannot read properties of undefined (reading 'ingestSeq')");
    } finally { await view.unmount(); client.clear(); }
  });

  it("renders an inline SAFE Pi record from the Chat page without inventing an event", async () => {
    get.mockResolvedValueOnce({ format: "sp-pi-trajectory/v1", cursor: { throughSeq: 3 }, records: [stored(3, "pi.user", {
      model: [{ role: "user", content: "original native evidence", timestamp: 1_700_000_000_000 }],
    })], nextAfterSeq: null });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(<TooltipProvider><QueryClientProvider client={client}><TrajectoryTab projectId="p" kind="evaluations" id="e" /></QueryClientProvider></TooltipProvider>);
    try {
      await settle();
      expect(view.container.querySelectorAll("ol > li")).toHaveLength(1);
      expect(view.container.querySelector("ol > li")?.textContent).toContain("#3");
      expect(view.container.querySelector("ol > li")?.textContent).toContain("pi.user");
      await click(view.container.querySelector("ol button"));
      expect(view.container.querySelector("ol")?.textContent).toContain("original native evidence");
      expect(view.container.querySelector("ol")?.textContent).toContain("pi-trajectory/v1");
    } finally { await view.unmount(); client.clear(); }
  });

  it("keeps an oversized record reference visible with a bounded missing-body diagnostic", async () => {
    get.mockResolvedValueOnce({ format: "sp-pi-trajectory/v1", cursor: { throughSeq: 8 },
      records: [stored(3, "pi.user"), reference(4), stored(5, "pi.assistant")], nextAfterSeq: null });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(<TooltipProvider><QueryClientProvider client={client}><TrajectoryTab projectId="p" kind="samplings" id="s" /></QueryClientProvider></TooltipProvider>);
    try {
      await settle();
      expect(view.container.querySelectorAll("ol > li")).toHaveLength(3);
      const row = [...view.container.querySelectorAll("ol > li")].find((item) => item.textContent?.includes("#4"));
      expect(row?.textContent).toContain("大记录引用");
      expect(row?.textContent).toContain("5,500,000 B · 当前接口仅有引用");
      await click(row?.querySelector("button"));
      expect(row?.textContent).toContain("无法在此读取完整原文");
      expect(row?.textContent).toContain("a".repeat(64));
      await choose(view.container.querySelector("select"), "reference");
      expect(view.container.querySelectorAll("ol > li")).toHaveLength(1);
    } finally { await view.unmount(); client.clear(); }
  });

  it("reports an obsolete event-only response instead of disguising it as native Pi", async () => {
    get.mockResolvedValueOnce({ events: [{ ingestSeq: 1, event: { type: "turn.started" } }],
      beforeSeq: null, hasOlder: false } as unknown as TrajectoryPage);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(<QueryClientProvider client={client}><TrajectoryTab projectId="p" kind="samplings" id="s" /></QueryClientProvider>);
    try {
      await settle();
      expect(view.container.textContent).toContain("轨迹响应不是 SAFE Pi 原生 records 页");
      expect(view.container.textContent).not.toContain("Cannot read properties of undefined (reading 'ingestSeq')");
    } finally { await view.unmount(); client.clear(); }
  });

  it("filters native record types and entry kinds, preserves unknown kinds and expands unchanged raw evidence", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(<TooltipProvider><QueryClientProvider client={client}><TrajectoryTab projectId="p" kind="samplings" id="s" /></QueryClientProvider></TooltipProvider>);
    try {
      await settle();
      expect(view.container.querySelectorAll("ol > li")).toHaveLength(4);
      const selectors = () => [...view.container.querySelectorAll("select")];
      await choose(selectors()[0]!, "entry");
      await choose(selectors()[1]!, "pi.user");
      expect(view.container.querySelectorAll("ol > li")).toHaveLength(1);
      expect(view.container.querySelector("ol")?.textContent).toContain("原生条目 · pi.user");
      await click(view.container.querySelector("ol button"));
      expect(view.container.querySelector("ol button")?.getAttribute("aria-expanded")).toBe("true");
      expect(view.container.querySelector("ol")?.textContent).toContain("original native evidence");
      await choose(selectors()[1]!, "new.entry");
      expect(view.container.querySelector("ol")?.textContent).toContain("new.entry");
      await choose(selectors()[0]!, "conversation");
      expect(view.container.querySelector("ol")?.textContent).toContain("会话");
      expect(view.container.textContent).toContain("筛选仅限已加载记录");
    } finally { await view.unmount(); client.clear(); }
  });

  it("pages forward under a fixed cutoff and retains loaded records after a failed read", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(<QueryClientProvider client={client}><TrajectoryTab projectId="p" kind="evaluations" id="e" /></QueryClientProvider>);
    try {
      await settle();
      get.mockRejectedValueOnce(new Error("temporary failure"));
      await click([...view.container.querySelectorAll("button")].find((item) => item.textContent === "加载更多记录"));
      await settle();
      expect(view.container.querySelectorAll("ol > li")).toHaveLength(4);
      expect(view.container.textContent).toContain("temporary failure");
      get.mockResolvedValueOnce({ format: "sp-pi-trajectory/v1", cursor: { throughSeq: 8 },
        records: [stored(7, "pi.user"), stored(8, "pi.toolResult")], nextAfterSeq: null });
      await click([...view.container.querySelectorAll("button")].find((item) => item.textContent === "加载更多记录"));
      await settle();
      expect(view.container.querySelectorAll("ol > li")).toHaveLength(6);
      expect([...view.container.querySelectorAll("ol > li")].map((item) =>
        item.textContent?.match(/#\d+/u)?.[0])).toEqual(["#3", "#4", "#5", "#6", "#7", "#8"]);
      expect(get).toHaveBeenLastCalledWith("p", "evaluations", "e", 6, 8, undefined);
      expect(view.container.textContent).not.toContain("加载更多记录");
    } finally { await view.unmount(); client.clear(); }
  });

  it("refreshes the current trajectory while the Project is running", async () => {
    get.mockResolvedValueOnce({ ...page, cursor: { throughSeq: 6 }, nextAfterSeq: null })
      .mockResolvedValue({ format: "sp-pi-trajectory/v1", cursor: { throughSeq: 6 }, records: [], nextAfterSeq: null });
    vi.useFakeTimers();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(<QueryClientProvider client={client}><TrajectoryTab projectId="p" kind="samplings" id="s" running /></QueryClientProvider>);
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      const initialCalls = get.mock.calls.length;
      expect(initialCalls).toBeGreaterThan(0);
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(get.mock.calls.length).toBeGreaterThan(initialCalls);
      expect(get).toHaveBeenLastCalledWith("p", "samplings", "s", 6, undefined, expect.any(AbortSignal));
    } finally { await view.unmount(); client.clear(); vi.useRealTimers(); }
  });

  it("refuses nonascending native rows instead of silently reordering an invalid SP page", async () => {
    get.mockResolvedValueOnce({ format: "sp-pi-trajectory/v1", cursor: { throughSeq: 5 },
      records: [stored(5, "pi.assistant"), stored(4, "pi.user")], nextAfterSeq: null });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(<QueryClientProvider client={client}><TrajectoryTab projectId="p" kind="samplings" id="s" /></QueryClientProvider>);
    try {
      await settle();
      expect(view.container.textContent).toContain("轨迹响应不是 SAFE Pi 原生 records 页");
      expect(view.container.querySelectorAll("ol > li")).toHaveLength(0);
    } finally { await view.unmount(); client.clear(); }
  });

  it("retains a complete prefix and finishes the frozen new tail before polling again", async () => {
    get.mockResolvedValueOnce({ format: "sp-pi-trajectory/v1", cursor: { throughSeq: 2 },
      records: [stored(1, "pi.user"), stored(2, "pi.toolResult")], nextAfterSeq: null });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(<QueryClientProvider client={client}><TrajectoryTab projectId="p" kind="samplings" id="s" /></QueryClientProvider>);
    try {
      await settle();
      get.mockResolvedValueOnce({ format: "sp-pi-trajectory/v1", cursor: { throughSeq: 6 },
        records: [stored(3, "springbrand.trajectory"), stored(4, "pi.assistant")], nextAfterSeq: 4 });
      await act(async () => { await client.invalidateQueries({ queryKey: ["observation", "p"] }); });
      await settle();
      expect(get).toHaveBeenLastCalledWith("p", "samplings", "s", 2, undefined, expect.any(AbortSignal));
      get.mockResolvedValueOnce({ format: "sp-pi-trajectory/v1", cursor: { throughSeq: 6 },
        records: [stored(5, "pi.assistant"), stored(6, "pi.user")], nextAfterSeq: null });
      await click([...view.container.querySelectorAll("button")].find((item) => item.textContent === "加载更多记录"));
      await settle();
      expect(get).toHaveBeenLastCalledWith("p", "samplings", "s", 4, 6, undefined);
      expect(view.container.querySelectorAll("ol > li")).toHaveLength(6);
      expect(view.container.querySelector("ol > li")?.textContent).toContain("#1");
      expect(view.container.querySelector("ol > li:last-child")?.textContent).toContain("#6");
      expect(view.container.textContent).not.toContain("加载更多记录");
    } finally { await view.unmount(); client.clear(); }
  });

  it("retries forward paging when an initially empty Chat grows", async () => {
    get.mockResolvedValueOnce({ format: "sp-pi-trajectory/v1", cursor: { throughSeq: 0 },
      records: [], nextAfterSeq: null });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(<QueryClientProvider client={client}><TrajectoryTab projectId="p" kind="samplings" id="s" /></QueryClientProvider>);
    try {
      await settle();
      expect(view.container.textContent).toContain("还没有轨迹记录");
      await act(async () => { await client.invalidateQueries({ queryKey: ["observation", "p"] }); });
      await settle();
      expect(view.container.querySelectorAll("ol > li")).toHaveLength(4);
      expect(view.container.textContent).toContain("加载更多记录");
    } finally { await view.unmount(); client.clear(); }
  });

  it("continues an unfinished frozen page on refresh instead of rebasing to a moving cutoff", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(<QueryClientProvider client={client}><TrajectoryTab projectId="p" kind="samplings" id="s" /></QueryClientProvider>);
    try {
      await settle();
      const calls = get.mock.calls.length;
      get.mockResolvedValueOnce({ format: "sp-pi-trajectory/v1", cursor: { throughSeq: 8 },
        records: [stored(7, "pi.user"), stored(8, "pi.assistant")], nextAfterSeq: null });
      await act(async () => { await client.invalidateQueries({ queryKey: ["observation", "p"] }); });
      await settle();
      expect(get).toHaveBeenCalledTimes(calls + 1);
      expect(get).toHaveBeenLastCalledWith("p", "samplings", "s", 6, 8, expect.any(AbortSignal));
      expect(view.container.querySelectorAll("ol > li")).toHaveLength(6);
      expect(view.container.querySelector("ol > li:last-child")?.textContent).toContain("#8");
      expect(view.container.textContent).not.toContain("加载更多记录");
    } finally { await view.unmount(); client.clear(); }
  });
});
