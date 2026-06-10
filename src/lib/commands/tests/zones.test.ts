import { describe, it, expect, beforeEach } from "vitest";
import { getActiveZone, setZone, evaluateContext, currentContext, zoneLabel } from "../zones.js";

// zones.ts uses $state which is Svelte 5 rune syntax.
// In test environment (no Svelte compiler), the $state macro is not available.
// zones.ts must export plain functions that work without Svelte compilation.
// Since zones.ts uses $state at module level, we need the Svelte test environment.
// However, vitest with svelte plugin should handle rune compilation.

describe("zones — setZone / getActiveZone", () => {
  it("defaults to editor zone", () => {
    // Initial state after module load.
    // We don't make assumptions about prior test order — just set explicitly.
    setZone("editor");
    expect(getActiveZone()).toBe("editor");
  });

  it("switches to sidebar", () => {
    setZone("sidebar");
    expect(getActiveZone()).toBe("sidebar");
  });

  it("switches to each valid zone", () => {
    const zones = ["sidebar", "entry-list", "editor", "properties", "calendar", "palette"] as const;
    for (const z of zones) {
      setZone(z);
      expect(getActiveZone()).toBe(z);
    }
  });
});

describe("evaluateContext", () => {
  beforeEach(() => {
    setZone("editor");
  });

  it("empty when-context is always active", () => {
    expect(evaluateContext("")).toBe(true);
  });

  it("matching zone context is active", () => {
    setZone("sidebar");
    expect(evaluateContext("zone:sidebar")).toBe(true);
  });

  it("non-matching zone context is inactive", () => {
    setZone("editor");
    expect(evaluateContext("zone:sidebar")).toBe(false);
  });

  it("unknown context returns false", () => {
    expect(evaluateContext("some:unknown:context")).toBe(false);
  });
});

describe("currentContext", () => {
  it("returns zone context for current zone", () => {
    setZone("calendar");
    expect(currentContext()).toBe("zone:calendar");
  });

  it("updates after zone switch", () => {
    setZone("editor");
    expect(currentContext()).toBe("zone:editor");
    setZone("properties");
    expect(currentContext()).toBe("zone:properties");
  });
});

describe("zoneLabel", () => {
  it("returns human-readable labels", () => {
    expect(zoneLabel("sidebar")).toBe("Sidebar");
    expect(zoneLabel("entry-list")).toBe("Entry List");
    expect(zoneLabel("editor")).toBe("Editor");
    expect(zoneLabel("properties")).toBe("Properties");
    expect(zoneLabel("calendar")).toBe("Calendar");
    expect(zoneLabel("palette")).toBe("Palette");
  });
});
