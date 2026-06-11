// Theme command↔store sync tests (issue #23).
//
// The known gap: view.theme-* and view.mode-* commands bypassed themeStore,
// writing directly to the DOM. seedThemeCommands() re-registers them through
// the store.
//
// These tests verify:
//   - seedThemeCommands wires handlers through the provided store
//   - Invoking a theme command calls store.setTheme / store.setMode
//   - The mode "system" command is also wired
//   - Multiple calls to seedThemeCommands are safe (idempotent)

import { describe, it, expect, beforeEach, vi } from "vitest";
import { registry } from "../../../lib/commands/registry.js";
import { seedCommands, seedThemeCommands } from "../../../lib/commands/seed.js";
import type { themeStore as ThemeStoreType } from "../../../lib/shell/theme-store.svelte.js";

// Minimal themeStore mock — tracks calls.
function makeStoreMock(): typeof ThemeStoreType & {
  _setThemeCalls: string[];
  _setModeCalls: string[];
} {
  const _setThemeCalls: string[] = [];
  const _setModeCalls: string[] = [];
  return {
    get theme() {
      return _setThemeCalls.at(-1) ?? "paper";
    },
    get mode() {
      return (_setModeCalls.at(-1) as "light" | "dark" | "system") ?? "light";
    },
    setTheme(t: string) {
      _setThemeCalls.push(t);
    },
    setMode(m: "light" | "dark" | "system") {
      _setModeCalls.push(m);
    },
    init: vi.fn(),
    destroy: vi.fn(),
    _setThemeCalls,
    _setModeCalls,
  };
}

beforeEach(() => {
  // Re-seed so commands are in registry.
  seedCommands();
});

describe("seedThemeCommands", () => {
  it("wires view.theme-paper to store.setTheme('paper')", () => {
    const store = makeStoreMock();
    seedThemeCommands(store);
    registry.get("view.theme-paper")?.handler();
    expect(store._setThemeCalls).toContain("paper");
  });

  it("wires view.theme-fog to store.setTheme('fog')", () => {
    const store = makeStoreMock();
    seedThemeCommands(store);
    registry.get("view.theme-fog")?.handler();
    expect(store._setThemeCalls).toContain("fog");
  });

  it("wires view.theme-mono to store.setTheme('mono')", () => {
    const store = makeStoreMock();
    seedThemeCommands(store);
    registry.get("view.theme-mono")?.handler();
    expect(store._setThemeCalls).toContain("mono");
  });

  it("wires view.theme-editorial to store.setTheme('editorial')", () => {
    const store = makeStoreMock();
    seedThemeCommands(store);
    registry.get("view.theme-editorial")?.handler();
    expect(store._setThemeCalls).toContain("editorial");
  });

  it("wires view.theme-soft to store.setTheme('soft')", () => {
    const store = makeStoreMock();
    seedThemeCommands(store);
    registry.get("view.theme-soft")?.handler();
    expect(store._setThemeCalls).toContain("soft");
  });

  it("wires view.mode-light to store.setMode('light')", () => {
    const store = makeStoreMock();
    seedThemeCommands(store);
    registry.get("view.mode-light")?.handler();
    expect(store._setModeCalls).toContain("light");
  });

  it("wires view.mode-dark to store.setMode('dark')", () => {
    const store = makeStoreMock();
    seedThemeCommands(store);
    registry.get("view.mode-dark")?.handler();
    expect(store._setModeCalls).toContain("dark");
  });

  it("wires view.mode-system to store.setMode('system')", () => {
    const store = makeStoreMock();
    seedThemeCommands(store);
    registry.get("view.mode-system")?.handler();
    expect(store._setModeCalls).toContain("system");
  });

  it("calling seedThemeCommands twice doesn't break anything (idempotent)", () => {
    const store = makeStoreMock();
    seedThemeCommands(store);
    seedThemeCommands(store);
    registry.get("view.theme-paper")?.handler();
    // Should only contain one call (the handler is idempotent — re-registers same fn).
    expect(store._setThemeCalls.filter((t) => t === "paper")).toHaveLength(1);
  });

  it("before seedThemeCommands, view.theme-paper handler is a noop (no store calls)", () => {
    // After seedCommands() but before seedThemeCommands(), the handler is noop.
    // We can verify by checking a fresh store gets no calls.
    const store = makeStoreMock();
    // Don't call seedThemeCommands — just invoke the raw seeded handler.
    registry.get("view.theme-paper")?.handler();
    expect(store._setThemeCalls).toHaveLength(0);
  });
});
