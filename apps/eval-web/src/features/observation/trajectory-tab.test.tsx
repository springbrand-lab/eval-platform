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
const reference = (seq: number): SpPiTrajectoryRecordReference => ({
  ingestSeq: seq, reference: { format: "sp-pi-trajectory-record/v1", throughSeq: 50,
    identity: JSON.stringify(["agent", "chat", "entry", seq + 10]), byteLength: 5_500_000, sha256: "a".repeat(64) },
});
const page: TrajectoryPage = { records: [
  stored(3, "springbrand.trajectory"), stored(4, "pi.user", {
    model: [{ role: "user", content: "original native evidence", timestamp: 1_700_000_000_000 }],
  }), conversation(5), stored(6, "new.entry"),
], beforeSeq: 3, hasOlder: true };

async function choose(select: Element | null, value: string) {
  await act(async () => { (select as HTMLSelectElement).value = value; select!.dispatchEvent(new Event("change", { bubbles: true })); });
}
const settle = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

describe("read-only native Chat trajectory", () => {
  beforeEach(() => { get.mockReset(); get.mockResolvedValue(page); });

  it("renders an empty native Chat trajectory page without an ingestSeq error", async () => {
    // The public SP Chat route returns `records`, not the old `events` page.
    get.mockResolvedValueOnce({ records: [], beforeSeq: null, hasOlder: false });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(<QueryClientProvider client={client}><TrajectoryTab projectId="p" kind="samplings" id="s" /></QueryClientProvider>);
    try {
      await settle();
      expect(view.container.textContent).toContain("还没有轨迹记录");
      expect(view.container.textContent).not.toContain("Cannot read properties of undefined (reading 'ingestSeq')");
    } finally { await view.unmount(); client.clear(); }
  });

  it("renders an inline SAFE Pi record from the Chat page without inventing an event", async () => {
    get.mockResolvedValueOnce({ records: [stored(3, "pi.user", {
      model: [{ role: "user", content: "original native evidence", timestamp: 1_700_000_000_000 }],
    })], beforeSeq: 3, hasOlder: false });
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
    get.mockResolvedValueOnce({ records: [stored(3, "pi.user"), reference(4), stored(5, "pi.assistant")], beforeSeq: 3, hasOlder: false });
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

  it("paginates in order, removes overlap and retains loaded evidence when a later request fails", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(<QueryClientProvider client={client}><TrajectoryTab projectId="p" kind="evaluations" id="e" /></QueryClientProvider>);
    try {
      await settle();
      get.mockRejectedValueOnce(new Error("temporary failure"));
      await click([...view.container.querySelectorAll("button")].find((item) => item.textContent === "加载更早的记录"));
      await settle();
      expect(view.container.querySelectorAll("ol > li")).toHaveLength(4);
      expect(view.container.textContent).toContain("temporary failure");
      get.mockResolvedValueOnce({ records: [stored(1, "pi.user"), stored(2, "pi.toolResult"), page.records[0]!], beforeSeq: null, hasOlder: false });
      await click([...view.container.querySelectorAll("button")].find((item) => item.textContent === "加载更早的记录"));
      await settle();
      expect(view.container.querySelectorAll("ol > li")).toHaveLength(6);
      expect([...view.container.querySelectorAll("ol > li")].map((item) => [...item.querySelectorAll("span")].find((span) => /^#\d+$/.test(span.textContent ?? ""))?.textContent)).toEqual(["#1", "#2", "#3", "#4", "#5", "#6"]);
      expect(get).toHaveBeenLastCalledWith("p", "evaluations", "e", 3, undefined);
    } finally { await view.unmount(); client.clear(); }
  });

  it("refreshes the current trajectory while the Project is running", async () => {
    vi.useFakeTimers();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(<QueryClientProvider client={client}><TrajectoryTab projectId="p" kind="samplings" id="s" running /></QueryClientProvider>);
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      const initialCalls = get.mock.calls.length;
      expect(initialCalls).toBeGreaterThan(0);
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(get.mock.calls.length).toBeGreaterThan(initialCalls);
    } finally { await view.unmount(); client.clear(); vi.useRealTimers(); }
  });

  it("sorts newest-first Chat rows before using the last loaded ingestSeq for refresh", async () => {
    get.mockResolvedValueOnce({ records: [stored(5, "pi.assistant"), stored(4, "pi.user"), stored(3, "springbrand.trajectory")],
      beforeSeq: 3, hasOlder: true });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(<QueryClientProvider client={client}><TrajectoryTab projectId="p" kind="samplings" id="s" /></QueryClientProvider>);
    try {
      await settle();
      expect([...view.container.querySelectorAll("ol > li")].map((item) => item.textContent?.match(/#\d+/u)?.[0]))
        .toEqual(["#3", "#4", "#5"]);
      get.mockResolvedValueOnce({ records: [stored(6, "pi.assistant"), stored(5, "pi.assistant")], beforeSeq: 5, hasOlder: true });
      const requestsBeforeRefresh = get.mock.calls.length;
      await act(async () => { await client.invalidateQueries({ queryKey: ["observation", "p"] }); });
      await settle();
      expect(get.mock.calls.length - requestsBeforeRefresh).toBe(1);
      expect(view.container.querySelectorAll("ol > li")).toHaveLength(4);
      expect(view.container.querySelector("ol > li:last-child")?.textContent).toContain("#6");
    } finally { await view.unmount(); client.clear(); }
  });

  it("preserves loaded history and fills a multi-page gap when the tail advances", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(<QueryClientProvider client={client}><TrajectoryTab projectId="p" kind="samplings" id="s" running /></QueryClientProvider>);
    try {
      await settle();
      get.mockResolvedValueOnce({ records: [stored(1, "pi.user"), stored(2, "pi.toolResult")], beforeSeq: null, hasOlder: false });
      await click([...view.container.querySelectorAll("button")].find((item) => item.textContent === "加载更早的记录"));
      await settle();
      get.mockResolvedValueOnce({ records: [stored(10, "springbrand.trajectory"), stored(11, "pi.user")], beforeSeq: 10, hasOlder: true });
      get.mockResolvedValueOnce({ records: [stored(7, "pi.assistant"), stored(8, "pi.toolResult"), stored(9, "pi.user")], beforeSeq: 7, hasOlder: true });
      get.mockResolvedValueOnce({ records: [page.records[3]!, stored(7, "pi.assistant")], beforeSeq: 6, hasOlder: true });
      await act(async () => { await client.invalidateQueries({ queryKey: ["observation", "p"] }); });
      await settle();
      expect(view.container.querySelectorAll("ol > li")).toHaveLength(11);
      expect(view.container.querySelector("ol > li")?.textContent).toContain("#1");
      expect(view.container.querySelector("ol > li:last-child")?.textContent).toContain("#11");
      expect(view.container.textContent).not.toContain("加载更早的记录");
    } finally { await view.unmount(); client.clear(); }
  });

  it("opens history paging when the first empty tail grows past a page", async () => {
    get.mockResolvedValueOnce({ records: [], beforeSeq: null, hasOlder: false });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(<QueryClientProvider client={client}><TrajectoryTab projectId="p" kind="samplings" id="s" /></QueryClientProvider>);
    try {
      await settle();
      expect(view.container.textContent).toContain("还没有轨迹记录");
      await act(async () => { await client.invalidateQueries({ queryKey: ["observation", "p"] }); });
      await settle();
      expect(view.container.querySelectorAll("ol > li")).toHaveLength(4);
      expect(view.container.textContent).toContain("加载更早的记录");
    } finally { await view.unmount(); client.clear(); }
  });

  it.each(["history-first", "tail-first"])("merges concurrent refresh and history reads atomically (%s)", async (order) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(<QueryClientProvider client={client}><TrajectoryTab projectId="p" kind="samplings" id="s" /></QueryClientProvider>);
    try {
      await settle();
      let finishTail!: (value: TrajectoryPage) => void;
      let finishHistory!: (value: TrajectoryPage) => void;
      get.mockImplementationOnce(() => new Promise((resolve) => { finishTail = resolve; }));
      let refresh!: Promise<void>;
      await act(async () => { refresh = client.invalidateQueries({ queryKey: ["observation", "p"] }); });
      get.mockImplementationOnce(() => new Promise((resolve) => { finishHistory = resolve; }));
      await click([...view.container.querySelectorAll("button")].find((item) => item.textContent === "加载更早的记录"));
      const tail = () => finishTail({ records: [page.records[3]!, stored(7, "springbrand.trajectory")], beforeSeq: 6, hasOlder: true });
      const history = () => finishHistory({ records: [stored(1, "pi.user"), stored(2, "pi.toolResult")], beforeSeq: null, hasOlder: false });
      await act(async () => { if (order === "history-first") history(); else tail(); });
      await settle();
      await act(async () => { if (order === "history-first") tail(); else history(); await refresh; });
      await settle();
      expect(view.container.querySelectorAll("ol > li")).toHaveLength(7);
      expect(view.container.querySelector("ol > li")?.textContent).toContain("#1");
      expect(view.container.querySelector("ol > li:last-child")?.textContent).toContain("#7");
      expect(view.container.textContent).not.toContain("加载更早的记录");
    } finally { await view.unmount(); client.clear(); }
  });
});
