// Shell-level theme store (phase 4, issue #18).
//
// Moves the data-tnd-theme / data-tnd-mode attribute management out of DevPage
// and into a shared store so AppShell owns it.  Issue #23 (settings) will
// formalise persistence; for now we keep the same in-memory logic.

export type ThemeMode = "light" | "dark" | "system";

export interface ThemeState {
  theme: string;
  mode: ThemeMode;
}

// ── Reactive state (exported as plain objects for SSR compatibility) ──────────

let _theme = $state("paper");
let _mode = $state<ThemeMode>("light");
let _mq: MediaQueryList | undefined;

function handleMqChange(e: MediaQueryListEvent): void {
  if (_mode === "system") {
    document.documentElement.setAttribute("data-tnd-mode", e.matches ? "dark" : "light");
  }
}

function applyNow(): void {
  const html = document.documentElement;
  html.setAttribute("data-tnd-theme", _theme);
  if (_mode === "system") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    html.setAttribute("data-tnd-mode", prefersDark ? "dark" : "light");
  } else {
    html.setAttribute("data-tnd-mode", _mode);
  }
}

export const themeStore = {
  get theme() {
    return _theme;
  },
  get mode() {
    return _mode;
  },
  setTheme(t: string) {
    _theme = t;
    applyNow();
  },
  setMode(m: ThemeMode) {
    // Detach old system listener if any.
    if (_mq) {
      _mq.removeEventListener("change", handleMqChange);
      _mq = undefined;
    }
    _mode = m;
    applyNow();
    if (m === "system") {
      _mq = window.matchMedia("(prefers-color-scheme: dark)");
      _mq.addEventListener("change", handleMqChange);
    }
  },
  /** Call once on mount to apply the initial state. */
  init() {
    applyNow();
    if (_mode === "system") {
      _mq = window.matchMedia("(prefers-color-scheme: dark)");
      _mq.addEventListener("change", handleMqChange);
    }
  },
  /** Call on unmount to detach media-query listener. */
  destroy() {
    if (_mq) {
      _mq.removeEventListener("change", handleMqChange);
      _mq = undefined;
    }
  },
};
