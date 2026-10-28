import { describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { click, render, type } from "@/test/render";
import { StatusBadge } from "./badge";
import { DataTable } from "./data-table";

describe("StatusBadge", () => {
  it("shows the status as text, not colour alone", async () => {
    const view = await render(<StatusBadge status="failed" />);
    expect(view.container.textContent).toBe("失败");
    await view.unmount();
  });
});

describe("DataTable", () => {
  const rows = [{ id: "a", name: "Beta", score: 2 }, { id: "b", name: "Alpha", score: 9 }, { id: "c", name: "Gamma", score: 5 }];
  const columns = [
    { key: "name", header: "名称", cell: (row: typeof rows[number]) => row.name, sortValue: (row: typeof rows[number]) => row.name },
    { key: "score", header: "分数", cell: (row: typeof rows[number]) => String(row.score), sortValue: (row: typeof rows[number]) => row.score },
  ];
  const names = (container: HTMLElement) => [...container.querySelectorAll("tbody tr")].map((row) => row.querySelectorAll("td")[1]?.textContent ?? row.textContent);

  it("filters, sorts and selects rows", async () => {
    const onSelectedChange = vi.fn();
    const view = await render(
      <DataTable rows={rows} columns={columns} rowKey={(row) => row.id} searchText={(row) => row.name}
        selectable selected={new Set()} onSelectedChange={onSelectedChange} />,
    );
    const sortBy = (label: string) => [...view.container.querySelectorAll("thead button")].find((button) => button.textContent === label);
    await click(sortBy("分数"));
    expect(names(view.container)).toEqual(["2", "5", "9"].map((score) => rows.find((row) => String(row.score) === score)!.name));
    await click(sortBy("分数"));
    expect(names(view.container)[0]).toBe("Alpha");
    await type(view.container.querySelector("input[aria-label='搜索']"), "gam");
    expect(names(view.container)).toEqual(["Gamma"]);
    await click(view.container.querySelector("[aria-label='全选']"));
    expect(onSelectedChange).toHaveBeenCalledWith(new Set(["c"]));
    await view.unmount();
  });

  it("pages after sorting and filtering with 20 records per page", async () => {
    const many = Array.from({ length: 45 }, (_, index) => ({ id: String(index), name: `n${index}`, score: index }));
    const view = await render(<DataTable rows={many} columns={columns} rowKey={(row) => row.id} searchText={(row) => row.name} />);
    const page = (label: string) => [...view.container.querySelectorAll('nav[aria-label="表格分页"] button')].find((button) => button.textContent === label);
    try {
      expect(view.container.querySelectorAll("tbody tr")).toHaveLength(20);
      expect(page("上一页")).toHaveProperty("disabled", true);
      await click(page("下一页"));
      expect(view.container.querySelector("tbody td")?.textContent).toBe("n20");
      await click(page("下一页"));
      expect(view.container.querySelectorAll("tbody tr")).toHaveLength(5);
      expect(page("下一页")).toHaveProperty("disabled", true);
      await click([...view.container.querySelectorAll("thead button")].find((button) => button.textContent === "分数"));
      expect(view.container.querySelector("tbody td")?.textContent).toBe("n0");
      await click(page("下一页"));
      await type(view.container.querySelector('input[aria-label="搜索"]'), "n44");
      expect(view.container.querySelectorAll("tbody tr")).toHaveLength(1);
      expect(view.container.querySelector("tbody td")?.textContent).toBe("n44");
      expect(page("上一页")).toHaveProperty("disabled", true);
    } finally { await view.unmount(); }
  });

  it("selects only the current page while retaining selections on other pages", async () => {
    const many = Array.from({ length: 45 }, (_, index) => ({ id: String(index), name: `n${index}`, score: index }));
    function Selectable() {
      const [selected, setSelected] = useState(new Set<string>());
      return <><output>{selected.size}</output><DataTable rows={many} columns={columns} rowKey={(row) => row.id}
        selectable selected={selected} onSelectedChange={setSelected} /></>;
    }
    const view = await render(<Selectable />);
    const page = (label: string) => [...view.container.querySelectorAll("nav button")].find((button) => button.textContent === label);
    try {
      await click(view.container.querySelector('[aria-label="全选"]'));
      expect(view.container.querySelector("output")?.textContent).toBe("20");
      await click(page("下一页"));
      expect(view.container.querySelector('[aria-label="全选"]')?.getAttribute("aria-checked")).toBe("false");
      await click(view.container.querySelector('[aria-label="全选"]'));
      expect(view.container.querySelector("output")?.textContent).toBe("40");
      await click(page("上一页"));
      await click(view.container.querySelector('[aria-label="全选"]'));
      expect(view.container.querySelector("output")?.textContent).toBe("20");
      await click(page("下一页"));
      expect(view.container.querySelector('[aria-label="全选"]')?.getAttribute("aria-checked")).toBe("true");
    } finally { await view.unmount(); }
  });

  it("distinguishes an unmatched search from an empty catalog and can clear it", async () => {
    const view = await render(<DataTable rows={rows} columns={columns} rowKey={(row) => row.id}
      searchText={(row) => row.name} empty={<p>创建第一条记录</p>} />);
    try {
      await type(view.container.querySelector("input"), "missing");
      expect(view.container.textContent).toContain("没有匹配的结果");
      expect(view.container.textContent).not.toContain("创建第一条记录");
      expect(view.container.textContent).toContain("0 / 3");
      await click([...view.container.querySelectorAll("button")].find((button) => button.textContent === "清空搜索"));
      expect(view.container.querySelectorAll("tbody tr")).toHaveLength(3);
    } finally { await view.unmount(); }
  });

  it("opens a row from the keyboard without hijacking controls inside it", async () => {
    const open = vi.fn();
    const view = await render(<DataTable rows={rows} columns={[
      ...columns, { key: "action", header: "操作", cell: () => <button type="button">复制</button> },
    ]} rowKey={(row) => row.id} onRowClick={open} />);
    try {
      const row = view.container.querySelector("tbody tr")!;
      expect(row.getAttribute("tabindex")).toBe("0");
      await act(async () => { row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
      expect(open).toHaveBeenCalledWith(rows[0]);
      open.mockClear();
      await act(async () => { row.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
      expect(open).not.toHaveBeenCalled();
    } finally { await view.unmount(); }
  });
});
