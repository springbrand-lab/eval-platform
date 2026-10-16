import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import type { Dataset } from "@eval-platform/eval-dataset";
import { click, render, type } from "@/test/render";
import { datasetKeys } from "@/api-sdk/datasets-api";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DatasetsPage } from "./datasets-page";

const state = vi.hoisted(() => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal("fetch", fetch);
  return { fetch, records: [] as Dataset[], requests: [] as string[], outcome: "lost" as "lost" | "reject" | "success", navigate: vi.fn() };
});
vi.mock("@/auth/session", () => ({ currentToken: () => null, markForbidden: vi.fn(), markUnauthorized: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate, Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

function button(text: string) {
  const element = [...document.querySelectorAll("button")].find((item) => item.textContent === text);
  if (!element) throw new Error(`Missing button ${text}`);
  return element;
}

function nameInput() {
  const label = [...document.querySelectorAll("label")].find((item) => item.textContent === "名称")!;
  return document.getElementById(label.htmlFor) as HTMLInputElement;
}

const response = (msg: unknown) => new Response(JSON.stringify({ success: true, msg, errMsg: "", code: "" }), { headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  state.records = []; state.requests = []; state.outcome = "lost"; state.navigate.mockClear();
  state.fetch.mockReset();
  state.fetch.mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    state.requests.push(request.method);
    expect(new URL(request.url).pathname).toBe("/api/datasets");
    if (request.method === "GET") return response([...state.records]);
    if (state.outcome === "reject") return new Response(JSON.stringify({ code: "DATASET_INPUT_INVALID", errMsg: "invalid name" }), { status: 422, headers: { "Content-Type": "application/json" } });
    const record = { ...await request.json(), datasetId: "20000000-0000-4000-8000-000000000001" } as Dataset;
    state.records.push(record);
    if (state.outcome === "lost") throw new TypeError("ack lost after Dataset committed");
    return response(record);
  });
});

async function page() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = await render(<QueryClientProvider client={client}><TooltipProvider><DatasetsPage /></TooltipProvider></QueryClientProvider>);
  await vi.waitFor(() => expect(state.requests).toEqual(["GET"]));
  await click(button("新建测试集"));
  return { ...view, client, close: async () => { await view.unmount(); client.clear(); } };
}

it("rereads the Dataset catalog and blocks a duplicate after a lost creation acknowledgement", async () => {
  const view = await page();
  try {
    await type(nameInput(), "Committed Dataset");
    await click(button("创建"));
    await vi.waitFor(() => expect(document.body.textContent).toContain("提交结果尚未确认"));
    expect(state.requests).toEqual(["GET", "POST", "GET"]);
    expect(view.client.getQueryData(datasetKeys.list())).toEqual(state.records);
    expect(nameInput().matches(":disabled")).toBe(true);
    expect(button("创建").disabled).toBe(true);
    await click(button("创建"));
    expect(state.records).toHaveLength(1);
    expect(state.requests).toEqual(["GET", "POST", "GET"]);
    await click(button("取消"));
    expect(view.container.textContent).toContain("Committed Dataset");
    await click(button("新建测试集"));
    expect(nameInput().value).toBe("");
    expect(document.body.textContent).not.toContain("提交结果尚未确认");
  } finally { await view.close(); }
});

it("keeps a rejected creation editable and submits the corrected Dataset once", async () => {
  state.outcome = "reject";
  const view = await page();
  try {
    await type(nameInput(), "Rejected Dataset");
    await click(button("创建"));
    await vi.waitFor(() => expect(button("创建").disabled).toBe(false));
    expect(state.records).toEqual([]);
    expect(nameInput().matches(":disabled")).toBe(false);
    state.outcome = "success";
    await type(nameInput(), "Corrected Dataset");
    await click(button("创建"));
    await vi.waitFor(() => expect(state.navigate).toHaveBeenCalledWith({ to: "/datasets/$datasetId", params: { datasetId: "20000000-0000-4000-8000-000000000001" } }));
    expect(state.records).toEqual([{ datasetId: "20000000-0000-4000-8000-000000000001", name: "Corrected Dataset" }]);
  } finally { await view.close(); }
});
