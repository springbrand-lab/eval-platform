import { describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import type { SortingState } from "@tanstack/react-table";
import { click, render, type } from "@/test/render";
import { StatusBadge } from "./badge";
import { Button } from "./button";
import { DataTable } from "./data-table";

describe("StatusBadge", () => {
  it("shows the status as text, not colour alone", async () => {
    const view = await render(<StatusBadge status="failed" />);
    expect(view.container.textContent).toBe("失败");
    await view.unmount();
  });
});

describe("Button links", () => {
  it("applies the unchanged button appearance to its link without nesting interactive elements", async () => {
    const view = await render(<>
      <Button icon={<span aria-hidden="true">图标</span>}>普通操作</Button>
      <Button asChild icon={<span aria-hidden="true">图标</span>}><a href="/next">导航</a></Button>
    </>);
    try {
      const anchor = view.container.querySelector("a")!;
      expect(view.container.querySelectorAll("button")).toHaveLength(1);
      expect(anchor.closest("button")).toBeNull();
      expect(anchor.className).toBe(view.container.querySelector("button")?.className);
      expect(anchor.textContent).toBe("图标导航");
    } finally { await view.unmount(); }
  });

  it.each([{ disabled: true }, { loading: true }])("prevents activating a disabled link: %j", async (state) => {
    const follow = vi.fn();
    const view = await render(<Button asChild {...state}><a href="/next" onClick={follow}>导航</a></Button>);
    try {
      const anchor = view.container.querySelector<HTMLAnchorElement>("a")!;
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      await act(async () => { anchor.dispatchEvent(event); });
      expect(follow).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(true);
      expect(anchor.getAttribute("aria-disabled")).toBe("true");
      expect(anchor.tabIndex).toBe(-1);
    } finally { await view.unmount(); }
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

  it("leaves nested links and buttons in charge of clicks while retaining row click and keyboard shortcuts", async () => {
    const open = vi.fn();
    const follow = vi.fn();
    const copy = vi.fn();
    const view = await render(<DataTable rows={rows} columns={[
      { key: "name", header: "名称", cell: (row) => <a href={`/details/${row.id}`} onClick={follow}><span>{row.name}</span></a> },
      { key: "score", header: "分数", cell: (row) => <span>{row.score}</span> },
      { key: "copy", header: "操作", cell: () => <button type="button" onClick={copy}>复制</button> },
    ]} rowKey={(row) => row.id} onRowClick={open} />);
    const preventNavigation = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("click", preventNavigation);
    try {
      const row = view.container.querySelector("tbody tr")!;
      const link = row.querySelector("a span")!;
      for (const options of [{}, { ctrlKey: true }, { metaKey: true }, { detail: 0 }]) {
        await act(async () => { link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...options })); });
        expect(open).not.toHaveBeenCalled();
      }
      expect(follow).toHaveBeenCalledTimes(4);
      await click(row.querySelector("button"));
      expect(copy).toHaveBeenCalledOnce();
      expect(open).not.toHaveBeenCalled();
      await click(row.querySelectorAll("td")[1].querySelector("span"));
      expect(open).toHaveBeenCalledExactlyOnceWith(rows[0]);
      await act(async () => { row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
      await act(async () => { row.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })); });
      expect(open.mock.calls).toEqual([[rows[0]], [rows[0]], [rows[0]]]);
    } finally {
      document.removeEventListener("click", preventNavigation);
      await view.unmount();
    }
  });

  it("keeps controlled sorting authoritative and lets its caller reset the page atomically", async () => {
    const many = Array.from({ length: 45 }, (_, index) => ({ id: String(index), name: `n${index}`, score: index })).toReversed();
    const sorted = vi.fn();
    const paged = vi.fn();
    function Controlled() {
      const [state, setState] = useState<{ sorting: SortingState; pageIndex: number }>({ sorting: [], pageIndex: 1 });
      return <DataTable rows={many} columns={columns} rowKey={(row) => row.id}
        sorting={{ value: state.sorting, onChange: (next) => {
          sorted();
          setState((previous) => ({ sorting: typeof next === "function" ? next(previous.sorting) : next, pageIndex: 0 }));
        } }}
        pagination={{ pageIndex: state.pageIndex, onPageChange: (pageIndex) => {
          paged(pageIndex);
          setState((previous) => ({ ...previous, pageIndex }));
        } }} />;
    }
    const view = await render(<Controlled />);
    try {
      expect(view.container.querySelector("tbody td")?.textContent).toBe("n24");
      await click([...view.container.querySelectorAll("thead button")].find((node) => node.textContent === "分数"));
      expect(view.container.querySelector("tbody td")?.textContent).toBe("n0");
      expect(view.container.querySelector('th[aria-sort="ascending"]')?.textContent).toBe("分数");
      expect(sorted).toHaveBeenCalledOnce();
      expect(paged).not.toHaveBeenCalled();
      await click([...view.container.querySelectorAll("nav button")].find((node) => node.textContent === "下一页"));
      expect(view.container.querySelector("tbody td")?.textContent).toBe("n20");
      expect(paged).toHaveBeenCalledExactlyOnceWith(1);
      await click([...view.container.querySelectorAll("thead button")].find((node) => node.textContent === "分数"));
      expect(view.container.querySelector("tbody td")?.textContent).toBe("n44");
      expect(view.container.querySelector('th[aria-sort="descending"]')?.textContent).toBe("分数");
      expect(sorted).toHaveBeenCalledTimes(2);
      expect(paged).toHaveBeenCalledTimes(1);
    } finally { await view.unmount(); }
  });
});
