import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrajectoryPage } from "@/api-sdk/observations-api";
import { click, render } from "@/test/render";
import { TrajectoryTab } from "./trajectory-tab";
import { TooltipProvider } from "@/components/ui/tooltip";

const get = vi.hoisted(() => vi.fn<() => Promise<TrajectoryPage>>());
vi.mock("@/api-sdk/observations-api", async (original) => ({ ...await original<object>(), getTrajectoryPage: get }));
const stored = (seq: number, type: string, payload: Record<string, unknown> = {}) => ({ ingestSeq: seq, event: {
  eventId: `event-${seq}`, occurredAt: 1_700_000_000_000 + seq, type, payload,
} });
const page: TrajectoryPage = { events: [
  stored(3, "tool.finished", { toolName: "write_file", outcome: "failed", input: "original evidence" }),
  stored(4, "generation.finished", { model: "model" }), stored(5, "context.compacted"), stored(6, "new.event"),
], beforeSeq: 3, hasOlder: true };

async function choose(select: Element | null, value: string) {
  await act(async () => { (select as HTMLSelectElement).value = value; select!.dispatchEvent(new Event("change", { bubbles: true })); });
}
const settle = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

describe("read-only raw trajectory categories", () => {
  beforeEach(() => { get.mockReset(); get.mockResolvedValue(page); });

  it("filters loaded categories and tool types, preserves unknown events and expands unchanged raw evidence", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(<TooltipProvider><QueryClientProvider client={client}><TrajectoryTab projectId="p" kind="samplings" id="s" /></QueryClientProvider></TooltipProvider>);
    try {
      await settle();
      expect(view.container.querySelectorAll("ol > li")).toHaveLength(4);
      const selectors = () => [...view.container.querySelectorAll("select")];
      await choose(selectors()[0]!, "tool");
      await choose(selectors()[1]!, "write_file");
      expect(view.container.querySelectorAll("ol > li")).toHaveLength(1);
      expect(view.container.querySelector("ol")?.textContent).toContain("工具调用 · tool.finished");
      await click(view.container.querySelector("ol button"));
      expect(view.container.querySelector("ol button")?.getAttribute("aria-expanded")).toBe("true");
      expect(view.container.querySelector("ol")?.textContent).toContain("original evidence");
      await choose(selectors()[0]!, "other");
      expect(view.container.querySelector("ol")?.textContent).toContain("new.event");
      expect(view.container.textContent).toContain("筛选仅限已加载事件");
    } finally { await view.unmount(); client.clear(); }
  });

  it("paginates in order, removes overlap and retains loaded evidence when a later request fails", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(<QueryClientProvider client={client}><TrajectoryTab projectId="p" kind="evaluations" id="e" /></QueryClientProvider>);
    try {
      await settle();
      get.mockRejectedValueOnce(new Error("temporary failure"));
      await click([...view.container.querySelectorAll("button")].find((item) => item.textContent === "加载更早的事件"));
      await settle();
      expect(view.container.querySelectorAll("ol > li")).toHaveLength(4);
      expect(view.container.textContent).toContain("temporary failure");
      get.mockResolvedValueOnce({ events: [stored(1, "turn.started"), stored(2, "tool.started", { toolName: "read_file" }), page.events[0]!], beforeSeq: null, hasOlder: false });
      await click([...view.container.querySelectorAll("button")].find((item) => item.textContent === "加载更早的事件"));
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

  it("preserves loaded history and fills a multi-page gap when the tail advances", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(<QueryClientProvider client={client}><TrajectoryTab projectId="p" kind="samplings" id="s" running /></QueryClientProvider>);
    try {
      await settle();
      get.mockResolvedValueOnce({ events: [stored(1, "turn.started"), stored(2, "tool.started")], beforeSeq: null, hasOlder: false });
      await click([...view.container.querySelectorAll("button")].find((item) => item.textContent === "加载更早的事件"));
      await settle();
      get.mockResolvedValueOnce({ events: [stored(10, "turn.finished"), stored(11, "turn.started")], beforeSeq: 10, hasOlder: true });
      get.mockResolvedValueOnce({ events: [stored(7, "generation.started"), stored(8, "generation.finished"), stored(9, "tool.started")], beforeSeq: 7, hasOlder: true });
      get.mockResolvedValueOnce({ events: [page.events[3]!, stored(7, "generation.started")], beforeSeq: 6, hasOlder: true });
      await act(async () => { await client.invalidateQueries({ queryKey: ["observation", "p"] }); });
      await settle();
      expect(view.container.querySelectorAll("ol > li")).toHaveLength(11);
      expect(view.container.querySelector("ol > li")?.textContent).toContain("#1");
      expect(view.container.querySelector("ol > li:last-child")?.textContent).toContain("#11");
      expect(view.container.textContent).not.toContain("加载更早的事件");
    } finally { await view.unmount(); client.clear(); }
  });

  it("opens history paging when the first empty tail grows past a page", async () => {
    get.mockResolvedValueOnce({ events: [], beforeSeq: null, hasOlder: false });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(<QueryClientProvider client={client}><TrajectoryTab projectId="p" kind="samplings" id="s" /></QueryClientProvider>);
    try {
      await settle();
      expect(view.container.textContent).toContain("还没有轨迹事件");
      await act(async () => { await client.invalidateQueries({ queryKey: ["observation", "p"] }); });
      await settle();
      expect(view.container.querySelectorAll("ol > li")).toHaveLength(4);
      expect(view.container.textContent).toContain("加载更早的事件");
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
      await click([...view.container.querySelectorAll("button")].find((item) => item.textContent === "加载更早的事件"));
      const tail = () => finishTail({ events: [page.events[3]!, stored(7, "turn.finished")], beforeSeq: 6, hasOlder: true });
      const history = () => finishHistory({ events: [stored(1, "turn.started"), stored(2, "tool.started")], beforeSeq: null, hasOlder: false });
      await act(async () => { if (order === "history-first") history(); else tail(); });
      await settle();
      await act(async () => { if (order === "history-first") tail(); else history(); await refresh; });
      await settle();
      expect(view.container.querySelectorAll("ol > li")).toHaveLength(7);
      expect(view.container.querySelector("ol > li")?.textContent).toContain("#1");
      expect(view.container.querySelector("ol > li:last-child")?.textContent).toContain("#7");
      expect(view.container.textContent).not.toContain("加载更早的事件");
    } finally { await view.unmount(); client.clear(); }
  });
});
