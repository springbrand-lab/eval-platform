import { act, useState } from "react";
import { expect, it, vi } from "vitest";
import { click, render, type } from "@/test/render";
import { MetadataDialog } from "./metadata-dialog";

it("keeps metadata drafts on background changes, saves platform labels and resets on the next opening", async () => {
  const save = vi.fn();
  let refresh!: () => void;
  function Form() {
    const [open, setOpen] = useState(true);
    const [initial, setInitial] = useState({ name: "原名称", description: "原描述" });
    refresh = () => setInitial({ name: "远端新名称", description: "远端新描述" });
    return <><button onClick={() => setOpen(true)}>再次编辑</button><MetadataDialog open={open} onClose={() => setOpen(false)} title="编辑素材" initial={initial} onSubmit={save} /></>;
  }
  const view = await render(<Form />);
  try {
    const control = (label: string) => {
      const node = [...document.querySelectorAll("label")].find((item) => item.textContent === label)!;
      return document.getElementById(node.htmlFor) as HTMLInputElement;
    };
    expect(control("名称").required).toBe(true);
    expect(control("说明").required).toBe(true);
    await type(control("名称"), "本地名称"); await type(control("说明"), "本地描述");
    await act(async () => refresh());
    expect(control("名称").value).toBe("本地名称");
    await click([...document.querySelectorAll("button")].find((item) => item.textContent === "保存"));
    expect(save).toHaveBeenCalledExactlyOnceWith({ name: "本地名称", description: "本地描述" });
    await click([...document.querySelectorAll("button")].find((item) => item.textContent === "取消"));
    await click([...document.querySelectorAll("button")].find((item) => item.textContent === "再次编辑"));
    expect(control("名称").value).toBe("远端新名称");
  } finally { await view.unmount(); }
});
