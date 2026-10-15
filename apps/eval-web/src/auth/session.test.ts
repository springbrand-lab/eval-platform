import { afterEach, describe, expect, it, vi } from "vitest";
import { currentToken, getAuthState, readTaktToken, resetAuthForTest, startAuth } from "./session";

afterEach(() => resetAuthForTest());

describe("takt token handoff", () => {
  it("accepts only takt:token messages from the takt origin", () => {
    expect(readTaktToken({ origin: "https://takt.test", data: { type: "takt:token", token: "t1" } }, "https://takt.test")).toBe("t1");
    expect(readTaktToken({ origin: "https://evil.test", data: { type: "takt:token", token: "t1" } }, "https://takt.test")).toBeUndefined();
    expect(readTaktToken({ origin: "https://takt.test", data: { type: "other" } }, "https://takt.test")).toBeUndefined();
    expect(readTaktToken({ origin: "https://takt.test", data: { type: "takt:token", token: null } }, "https://takt.test")).toBeNull();
  });

  it("reports standalone outside an iframe", () => {
    startAuth(window, false);
    expect(getAuthState()).toEqual({ status: "standalone" });
    expect(currentToken()).toBeNull();
  });

  it("asks the parent for the token in an iframe and keeps it in memory", () => {
    const listeners: ((event: MessageEvent) => void)[] = [];
    const parent = { postMessage: vi.fn() };
    const frame = {
      self: {}, top: {}, parent,
      addEventListener: (_: string, listener: (event: MessageEvent) => void) => listeners.push(listener),
      removeEventListener: vi.fn(),
    } as unknown as Window;
    startAuth(frame, false);
    expect(parent.postMessage).toHaveBeenCalledWith({ type: "eval:ready" }, expect.any(String));
    const origin = (parent.postMessage.mock.calls[0] as unknown as [unknown, string])[1];
    listeners[0]!({ origin, data: { type: "takt:token", token: "abc" } } as MessageEvent);
    expect(currentToken()).toBe("abc");
    listeners[0]!({ origin, data: { type: "takt:token", token: null } } as MessageEvent);
    expect(getAuthState()).toEqual({ status: "unauthorized" });
  });
});
