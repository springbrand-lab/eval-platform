// The takt login token, held only in memory. takt hands it to this iframe over postMessage.

export type AuthState =
  | { readonly status: "waiting" }
  | { readonly status: "ready"; readonly token: string }
  /** Opened outside takt: there is no token to receive. */
  | { readonly status: "standalone" }
  /** takt rejected the token; the user must sign in to takt again. */
  | { readonly status: "unauthorized" }
  /** The token is valid but its user lacks the Eval menu in takt. */
  | { readonly status: "forbidden" };

export const TAKT_ORIGIN: string = import.meta.env.VITE_TAKT_ORIGIN ?? "https://takt.cuecue.cc";
const DEV_AUTH = import.meta.env.DEV && import.meta.env.VITE_DEV_AUTH === "1";

let state: AuthState = { status: "waiting" };
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

export function currentToken(): string | null {
  return state.status === "ready" ? state.token : null;
}

export function markUnauthorized(): void {
  setState({ status: "unauthorized" });
}

export function markForbidden(): void {
  setState({ status: "forbidden" });
}

export function isEmbedded(win: Window = window): boolean {
  try {
    return win.self !== win.top;
  } catch {
    return true;
  }
}

/** A message from takt; anything else, or from another origin, is ignored. */
export function readTaktToken(event: Pick<MessageEvent, "origin" | "data">, taktOrigin = TAKT_ORIGIN): string | null | undefined {
  if (event.origin !== taktOrigin) return undefined;
  const data = event.data as { type?: unknown; token?: unknown } | null;
  if (!data || data.type !== "takt:token") return undefined;
  return typeof data.token === "string" && data.token.length > 0 ? data.token : null;
}

/** Start receiving the takt token. Returns a cleanup function. */
export function startAuth(win: Window = window, devAuth: boolean = DEV_AUTH): () => void {
  if (devAuth) {
    setState({ status: "ready", token: "local-dev" });
    return () => undefined;
  }
  if (!isEmbedded(win)) {
    setState({ status: "standalone" });
    return () => undefined;
  }
  const onMessage = (event: MessageEvent) => {
    const token = readTaktToken(event);
    if (token === undefined) return;
    setState(token === null ? { status: "unauthorized" } : { status: "ready", token });
  };
  win.addEventListener("message", onMessage);
  win.parent.postMessage({ type: "eval:ready" }, TAKT_ORIGIN);
  return () => win.removeEventListener("message", onMessage);
}

/** Ask takt again, for example after it reported an expired token. */
export function requestToken(win: Window = window): void {
  if (isEmbedded(win)) win.parent.postMessage({ type: "eval:ready" }, TAKT_ORIGIN);
}

/** For tests only. */
export function resetAuthForTest(next: AuthState = { status: "waiting" }): void {
  setState(next);
}
