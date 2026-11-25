// Sign-in state. The session itself is the Worker's HttpOnly cookie, sent with every same-origin request;
// the page only learns from API answers whether it is signed in and allowed to use Eval.

export type AuthState =
  | { readonly status: "ready" }
  /** Sending the browser to sign in through IAM. */
  | { readonly status: "signing-in" }
  /** Signing in did not finish; `reason` comes from the Worker's `?auth_error=`. */
  | { readonly status: "failed"; readonly reason: string }
  /** Signed in, but IAM does not let this person use Eval. */
  | { readonly status: "forbidden" };

function initialState(win: Window | undefined): AuthState {
  const reason = win ? new URL(win.location.href).searchParams.get("auth_error") : null;
  return reason ? { status: "failed", reason } : { status: "ready" };
}

let state: AuthState = initialState(typeof window === "undefined" ? undefined : window);
const listeners = new Set<() => void>();

function setState(next: AuthState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function getAuthState(): AuthState {
  return state;
}

export function subscribeAuth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isEmbedded(win: Window = window): boolean {
  try {
    return win.self !== win.top;
  } catch {
    return true;
  }
}

/** Go through IAM and come back to the current page. */
export function signIn(win: Window = window): void {
  const here = new URL(win.location.href);
  here.searchParams.delete("auth_error");
  setState({ status: "signing-in" });
  win.location.assign(`/api/auth/login?redirect=${encodeURIComponent(here.pathname + here.search + here.hash)}`);
}

/** The session is missing or expired: sign in again, unless the last attempt just failed. */
export function markUnauthorized(win: Window = window): void {
  if (state.status === "ready") signIn(win);
}

export function markForbidden(): void {
  setState({ status: "forbidden" });
}

/** For tests only. */
export function resetAuthForTest(next: AuthState = { status: "ready" }): void {
  setState(next);
}
