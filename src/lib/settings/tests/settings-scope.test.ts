// Settings scope round-trip tests (spec 0011, issue #23).
//
// Covers:
//   - User-scope round-trips (theme, mode, fontSize, lineWidth, bindings)
//   - Library-scope round-trips (primaryDateProp, assetFolder)
//   - primaryDateProp() function reads library store with "due" default
//   - Unknown keys preserved (spec 0011 §Edge cases)

import { describe, it, expect, beforeEach } from "vitest";
import {
  MemorySettingsStore,
  MemoryLibrarySettingsStore,
  setSettingsStore,
  setLibrarySettingsStore,
  settings_get_user,
  settings_set_user,
  settings_get_library,
  settings_set_library,
  getPrimaryDateProp,
} from "../../../lib/commands/settings.js";

beforeEach(() => {
  // Fresh stores for every test — avoids cross-test bleed.
  setSettingsStore(new MemorySettingsStore());
  setLibrarySettingsStore(new MemoryLibrarySettingsStore());
});

// ── User scope ──────────────────────────────────────────────────────────────────

describe("User-scope settings", () => {
  it("returns undefined for unset keys", () => {
    expect(settings_get_user("theme")).toBeUndefined();
    expect(settings_get_user("fontSize")).toBeUndefined();
    expect(settings_get_user("mode")).toBeUndefined();
  });

  it("round-trips theme", () => {
    settings_set_user("theme", "fog");
    expect(settings_get_user("theme")).toBe("fog");
  });

  it("round-trips mode", () => {
    settings_set_user("mode", "dark");
    expect(settings_get_user("mode")).toBe("dark");
  });

  it("round-trips system mode", () => {
    settings_set_user("mode", "system");
    expect(settings_get_user("mode")).toBe("system");
  });

  it("round-trips fontSize", () => {
    settings_set_user("fontSize", 16);
    expect(settings_get_user("fontSize")).toBe(16);
  });

  it("round-trips lineWidth", () => {
    settings_set_user("lineWidth", 80);
    expect(settings_get_user("lineWidth")).toBe(80);
  });

  it("merges individual keys without wiping others", () => {
    settings_set_user("theme", "mono");
    settings_set_user("fontSize", 18);
    expect(settings_get_user("theme")).toBe("mono");
    expect(settings_get_user("fontSize")).toBe(18);
  });

  it("overwrites a previously set key", () => {
    settings_set_user("theme", "paper");
    settings_set_user("theme", "editorial");
    expect(settings_get_user("theme")).toBe("editorial");
  });

  it("round-trips unknown keys (spec 0011 edge case)", () => {
    // Directly use the underlying store for the unknown-key test.
    const store = new MemorySettingsStore();
    setSettingsStore(store);
    store.save({ bindings: {}, unknownField: "preserved" });
    expect(store.load().unknownField).toBe("preserved");
    // Setting via facade should not wipe unknown keys.
    settings_set_user("theme", "soft");
    expect(store.load().unknownField).toBe("preserved");
    expect(store.load().theme).toBe("soft");
  });
});

// ── Library scope ───────────────────────────────────────────────────────────────

describe("Library-scope settings", () => {
  it("returns undefined for unset keys", () => {
    expect(settings_get_library("primaryDateProp")).toBeUndefined();
    expect(settings_get_library("assetFolder")).toBeUndefined();
  });

  it("round-trips primaryDateProp", () => {
    settings_set_library("primaryDateProp", "scheduled");
    expect(settings_get_library("primaryDateProp")).toBe("scheduled");
  });

  it("round-trips assetFolder", () => {
    settings_set_library("assetFolder", "_media");
    expect(settings_get_library("assetFolder")).toBe("_media");
  });

  it("merges individual keys without wiping others", () => {
    settings_set_library("primaryDateProp", "scheduled");
    settings_set_library("assetFolder", "_media");
    expect(settings_get_library("primaryDateProp")).toBe("scheduled");
    expect(settings_get_library("assetFolder")).toBe("_media");
  });

  it("round-trips unknown keys (spec 0011 edge case)", () => {
    const store = new MemoryLibrarySettingsStore();
    setLibrarySettingsStore(store);
    store.save({ primaryDateProp: "due", someUnknownKey: 42 });
    expect(store.load().someUnknownKey).toBe(42);
    settings_set_library("assetFolder", "_files");
    expect(store.load().someUnknownKey).toBe(42);
  });
});

// ── getPrimaryDateProp ──────────────────────────────────────────────────────────

describe("getPrimaryDateProp()", () => {
  it("defaults to 'due' when nothing is set", () => {
    expect(getPrimaryDateProp()).toBe("due");
  });

  it("returns the configured primaryDateProp", () => {
    settings_set_library("primaryDateProp", "scheduled");
    expect(getPrimaryDateProp()).toBe("scheduled");
  });

  it("reflects subsequent changes immediately", () => {
    settings_set_library("primaryDateProp", "start");
    expect(getPrimaryDateProp()).toBe("start");
    settings_set_library("primaryDateProp", "due");
    expect(getPrimaryDateProp()).toBe("due");
  });

  it("returns 'due' after reset to empty store", () => {
    setLibrarySettingsStore(new MemoryLibrarySettingsStore());
    expect(getPrimaryDateProp()).toBe("due");
  });
});
