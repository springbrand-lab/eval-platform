import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act } from "react";
import { expect, it, vi } from "vitest";
import { projectKeys } from "@/api-sdk/projects-api";
import { render } from "@/test/render";
import { useProject } from "./use-project";

const mocks = vi.hoisted(() => ({ project: vi.fn() }));
vi.mock("@/api-sdk/projects-api", async (original) => ({ ...await original<object>(), getProject: mocks.project }));

it.each([true, false])("refreshes every result level after a Run, even when its active state was observed: %s", async (observed) => {
  mocks.project.mockResolvedValue({ project: { name: "项目" }, runSequence: 1, currentRun: observed ? { runId: "run" } : null });
  const keys = [
    ["metrics", "p", "project"], ["metrics", "p", "dataset", "dataset"], ["metrics", "p", "sample", "sample"],
    ["metrics", "p", "sampling", "sampling"], ["evaluations", "p", "sampling", "sampling"], ["observation", "p", "messages"],
    ["runs", "detail", "p", "old-run"],
  ];
  const reads = keys.map(() => vi.fn().mockResolvedValue("running"));
  function Probe() {
    useProject("p");
    return <>{keys.map((key, index) => <Result key={index} queryKey={key} read={reads[index]!} />)}</>;
  }
  function Result({ queryKey, read }: { queryKey: string[]; read: () => Promise<string> }) {
    const query = useQuery({ queryKey, queryFn: read });
    return <span>{query.data}</span>;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
  try {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    reads.forEach((read) => read.mockResolvedValue("final"));
    mocks.project.mockResolvedValue({ project: { name: "项目" }, runSequence: observed ? 1 : 2, currentRun: null });
    await act(async () => { await client.invalidateQueries({ queryKey: projectKeys.detail("p") }); await new Promise((resolve) => setTimeout(resolve, 10)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(reads.every((read) => read.mock.calls.length === 2)).toBe(true);
    expect(view.container.textContent).toBe("final".repeat(keys.length));
  } finally { await view.unmount(); client.clear(); }
});

it("replaces an uncached in-flight snapshot when a Run completes and ignores its late reply", async () => {
  mocks.project.mockResolvedValue({ project: { name: "项目" }, runSequence: 1, currentRun: { runId: "run" } });
  let finishOld!: (value: string) => void;
  const read = vi.fn().mockImplementationOnce(() => new Promise<string>((resolve) => { finishOld = resolve; })).mockResolvedValue("final");
  function Probe() {
    const project = useProject("p");
    const result = useQuery({ queryKey: ["metrics", "p", "sample"], queryFn: read, enabled: !!project.data });
    return <span>{result.data}</span>;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
  try {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(read).toHaveBeenCalledTimes(1);
    mocks.project.mockResolvedValue({ project: { name: "项目" }, runSequence: 1, currentRun: null });
    await act(async () => { await client.invalidateQueries({ queryKey: projectKeys.detail("p") }); await new Promise((resolve) => setTimeout(resolve, 10)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(view.container.textContent).toBe("final");
    await act(async () => finishOld("old"));
    expect(view.container.textContent).toBe("final");
  } finally { await view.unmount(); client.clear(); }
});
