// Eval runs either on its own (eval.cuecue.cc, signed in with its session cookie) or as a micro app
// inside the main App (saas-console, through wujie). As a micro app its scripts run on the main App's
// origin: it calls its own API at its own origin, with the person's IAM access token from the main App,
// and the main App shows the menu and follows its URL.

/** What the main App passes (`window.$wujie.props`); see saas-console `MicroAppProps`. */
interface HostProps {
  accessToken(refresh?: boolean): Promise<string | null>;
  navigate(path: string): void;
  openCommandMenu(): void;
  theme?(): "light" | "dark";
}

interface WujieWindow {
  __POWERED_BY_WUJIE__?: boolean;
  $wujie?: { props?: HostProps; bus?: { $on(event: string, fn: (value: string) => void): void; $off(event: string, fn: (value: string) => void): void } };
}

const wujie = typeof window === "undefined" ? undefined : (window as unknown as WujieWindow);

/** Inside the main App, as a micro app. */
export const hosted: boolean = Boolean(wujie?.__POWERED_BY_WUJIE__ && wujie.$wujie?.props);

/**
 * Where Eval's own API is: the origin Eval's scripts are served from, whatever page they run on (the
 * page's own origin when scripts are not served over http, as in tests).
 */
export const apiOrigin: string = (() => {
  const script = new URL(import.meta.url);
  if (script.protocol === "http:" || script.protocol === "https:") return script.origin;
  return typeof window === "undefined" ? "http://localhost" : window.location.origin;
})();

/** The app key the main App knows Eval by: its bus event for moving Eval is `springbrand:navigate:eval`. */
const APP_KEY = "eval";

/** The person's IAM access token from the main App; `refresh` asks for a new one after a 401. */
export function hostAccessToken(refresh = false): Promise<string | null> {
  return wujie?.$wujie?.props?.accessToken(refresh) ?? Promise.resolve(null);
}

/** Tell the main App Eval moved to `path`, so its URL and menu follow. */
export function reportPath(path: string): void {
  wujie?.$wujie?.props?.navigate(path);
}

/** Run `go` whenever the main App moves Eval (a menu click, back/forward). Returns the unsubscribe. */
export function onHostNavigate(go: (path: string) => void): () => void {
  const bus = wujie?.$wujie?.bus;
  if (!bus) return () => undefined;
  const event = `springbrand:navigate:${APP_KEY}`;
  bus.$on(event, go);
  return () => bus.$off(event, go);
}

/**
 * Inside the main App, Eval shows the main App's appearance instead of its own setting: now, and
 * whenever it changes (`springbrand:theme`). Returns the unsubscribe.
 */
export function followHostTheme(apply: (dark: boolean) => void): () => void {
  apply(wujie?.$wujie?.props?.theme?.() === "dark");
  const bus = wujie?.$wujie?.bus;
  if (!bus) return () => undefined;
  const onTheme = (theme: string) => apply(theme === "dark");
  bus.$on("springbrand:theme", onTheme);
  return () => bus.$off("springbrand:theme", onTheme);
}
