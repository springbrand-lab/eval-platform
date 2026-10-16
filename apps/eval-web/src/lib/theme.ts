export type ThemePreference = "system" | "light" | "dark";
const KEY = "eval-web:theme";

export function readThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(preference: ThemePreference = readThemePreference()): void {
  const dark = preference === "dark"
    || (preference === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function saveThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(KEY, preference);
  } catch {
    // Storage may be blocked inside a third-party iframe; the choice then lasts for this page only.
  }
  applyTheme(preference);
}

/** Re-apply "system" when the OS switches between light and dark. */
export function watchSystemTheme(): () => void {
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  if (!media) return () => undefined;
  const onChange = () => { if (readThemePreference() === "system") applyTheme("system"); };
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
