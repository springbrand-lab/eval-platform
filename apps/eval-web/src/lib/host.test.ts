import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  delete (window as unknown as Record<string, unknown>).__POWERED_BY_WUJIE__;
  delete (window as unknown as Record<string, unknown>).$wujie;
});

describe("inside the main App", () => {
  it("shows the main App's appearance and follows its changes", async () => {
    const handlers = new Map<string, (value: string) => void>();
    Object.assign(window, {
      __POWERED_BY_WUJIE__: true,
      $wujie: {
        props: { theme: () => "dark", accessToken: async () => null, navigate: () => undefined, openCommandMenu: () => undefined },
        bus: { $on: (event: string, fn: (value: string) => void) => handlers.set(event, fn), $off: (event: string) => handlers.delete(event) },
      },
    });
    const host = await import("./host");
    expect(host.hosted).toBe(true);
    const applied: boolean[] = [];
    const stop = host.followHostTheme((dark) => applied.push(dark));
    handlers.get("springbrand:theme")!("light");
    expect(applied).toEqual([true, false]);
    stop();
    expect(handlers.has("springbrand:theme")).toBe(false);
  });

  it("is not hosted on its own", async () => {
    expect((await import("./host")).hosted).toBe(false);
  });
});
