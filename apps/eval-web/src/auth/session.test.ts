import { afterEach, describe, expect, it, vi } from "vitest";
import { getAuthState, markForbidden, markUnauthorized, resetAuthForTest, signIn } from "./session";

afterEach(() => resetAuthForTest());

function fakeWindow(href: string) {
  return { location: { href, assign: vi.fn() } } as unknown as Window & { location: { assign: ReturnType<typeof vi.fn> } };
}

describe("sign-in state", () => {
  it("goes through IAM and returns to the current page without the old failure", () => {
    const win = fakeWindow("https://eval.test/projects/p1?tab=runs&auth_error=expired#top");
    signIn(win);
    expect(getAuthState()).toEqual({ status: "signing-in" });
    expect(win.location.assign).toHaveBeenCalledExactlyOnceWith("/api/auth/login?redirect=%2Fprojects%2Fp1%3Ftab%3Druns%23top");
  });

  it("signs in again on a missing session, but not right after a failed attempt", () => {
    const win = fakeWindow("https://eval.test/");
    markUnauthorized(win);
    expect(win.location.assign).toHaveBeenCalledOnce();
    resetAuthForTest({ status: "failed", reason: "not_permitted" });
    const again = fakeWindow("https://eval.test/");
    markUnauthorized(again);
    expect(again.location.assign).not.toHaveBeenCalled();
    expect(getAuthState()).toEqual({ status: "failed", reason: "not_permitted" });
  });

  it("reports a person IAM does not let use Eval", () => {
    markForbidden();
    expect(getAuthState()).toEqual({ status: "forbidden" });
  });
});
