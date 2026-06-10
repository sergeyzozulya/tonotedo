import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Runtime detection ─────────────────────────────────────────────────────────
// Tests run in Node (no jsdom). We use `globalThis` instead of `window`, which
// is what ipc/index.ts checks at runtime in the browser via `'__TAURI_INTERNALS__' in window`.
// The Node-side analogue is the same `in globalThis` check.

describe("IPC runtime detection", () => {
  it("selects mock when __TAURI_INTERNALS__ is absent (Node env = no Tauri)", async () => {
    // In Node/vitest, __TAURI_INTERNALS__ is not present
    expect("__TAURI_INTERNALS__" in globalThis).toBe(false);

    const { mock } = await import("../lib/ipc/mock.js");
    const result = await mock.core_version();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("mock-0.0.0");
    }
  });

  it("mock sentinel differs from any real Tauri version string", async () => {
    // The detection logic: mock returns 'mock-0.0.0'; a real Tauri call would
    // return a semver like '0.1.0'. This test verifies the sentinel is
    // recognisable as mock output.
    const { mock } = await import("../lib/ipc/mock.js");
    const result = await mock.core_version();
    if (result.ok) {
      expect(result.value).toMatch(/^mock-/);
    }
  });

  it("real.ts core_version returns io_error when Tauri is absent", async () => {
    // Calling real.core_version() in Node (no Tauri runtime) must fail with
    // io_error — it must NOT return the mock sentinel.
    const { real } = await import("../lib/ipc/real.js");
    const result = await real.core_version();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("io_error");
    }
  });
});

// ── Mock data integrity ───────────────────────────────────────────────────────

describe("mock data integrity", () => {
  it("every wikilink target resolves to an existing entry id", async () => {
    const { ENTRIES } = await import("../lib/ipc/mock.js");

    // Build a set of all known IDs
    const ids = new Set(ENTRIES.map((e) => e.id));

    // Extract all wikilink targets from entry texts
    const wikilinkRe = /\[\[([^\]|]+)(?:\|[^\]]*)?]]/g;
    const broken: string[] = [];

    for (const entry of ENTRIES) {
      let m: RegExpExecArray | null;
      while ((m = wikilinkRe.exec(entry.text)) !== null) {
        const target = m[1].trim();
        if (!ids.has(target)) {
          broken.push(`${entry.id} → [[${target}]]`);
        }
      }
    }

    expect(broken, `Broken wikilinks:\n${broken.join("\n")}`).toHaveLength(0);
  });

  it("all tag colors reference the 8-token chip palette", async () => {
    const { mock } = await import("../lib/ipc/mock.js");
    const VALID_COLORS = new Set([
      "slate",
      "red",
      "amber",
      "green",
      "teal",
      "blue",
      "violet",
      "pink",
    ]);

    const result = await mock.tag_index();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const tag of result.value) {
      expect(
        VALID_COLORS.has(tag.color),
        `Tag "${tag.name}" has invalid color "${tag.color}"`,
      ).toBe(true);
    }
  });

  it("mock has ~15 entries across 3-4 groups", async () => {
    const { ENTRIES } = await import("../lib/ipc/mock.js");
    const groups = new Set(ENTRIES.map((e) => e.group));
    expect(ENTRIES.length).toBeGreaterThanOrEqual(12);
    expect(ENTRIES.length).toBeLessThanOrEqual(20);
    expect(groups.size).toBeGreaterThanOrEqual(3);
    expect(groups.size).toBeLessThanOrEqual(5);
  });

  it("mock has 4-5 people", async () => {
    const { mock } = await import("../lib/ipc/mock.js");
    const result = await mock.people_index();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThanOrEqual(4);
    expect(result.value.length).toBeLessThanOrEqual(6);
  });

  it("entries_in_group returns only entries in that group", async () => {
    const { mock } = await import("../lib/ipc/mock.js");
    const result = await mock.entries_in_group("journal");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const entry of result.value.items) {
      expect(entry.group).toBe("journal");
    }
  });

  it("backlinks for an entry points to correct sources", async () => {
    const { mock } = await import("../lib/ipc/mock.js");
    const result = await mock.backlinks("work/atlas/project-overview");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // At least the meeting and roadmap entries link to the overview
    expect(result.value.length).toBeGreaterThan(0);
    const sourceIds = result.value.map((b) => b.sourceId);
    expect(sourceIds).toContain("work/atlas/meeting-2026-05");
  });

  it("write_entry updates the stored text", async () => {
    const { mock } = await import("../lib/ipc/mock.js");
    const newText = "# Updated\n\nHello world.\n";
    const writeResult = await mock.write_entry("work/atlas/tech-decisions", newText, "self-tok");
    expect(writeResult.ok).toBe(true);

    const readResult = await mock.read_entry("work/atlas/tech-decisions");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value.text).toBe(newText);
    }
  });
});

// ── Theme switcher logic ──────────────────────────────────────────────────────

describe("theme switcher attribute logic", () => {
  // Pure function extracted from the DevPage effect — tests without DOM mounting.

  function applyTheme(
    theme: string,
    mode: "light" | "dark" | "system",
    prefersDark: boolean,
  ): { "data-tnd-theme": string; "data-tnd-mode": string } {
    return {
      "data-tnd-theme": theme,
      "data-tnd-mode": mode === "system" ? (prefersDark ? "dark" : "light") : mode,
    };
  }

  it("light mode sets data-tnd-mode=light", () => {
    const attrs = applyTheme("paper", "light", false);
    expect(attrs["data-tnd-mode"]).toBe("light");
    expect(attrs["data-tnd-theme"]).toBe("paper");
  });

  it("dark mode sets data-tnd-mode=dark regardless of OS preference", () => {
    const attrs = applyTheme("fog", "dark", false);
    expect(attrs["data-tnd-mode"]).toBe("dark");
  });

  it("system mode with prefersDark=true sets data-tnd-mode=dark", () => {
    const attrs = applyTheme("mono", "system", true);
    expect(attrs["data-tnd-mode"]).toBe("dark");
  });

  it("system mode with prefersDark=false sets data-tnd-mode=light", () => {
    const attrs = applyTheme("soft", "system", false);
    expect(attrs["data-tnd-mode"]).toBe("light");
  });

  it("all 5 themes are accepted", () => {
    for (const theme of ["paper", "fog", "mono", "editorial", "soft"]) {
      const attrs = applyTheme(theme, "light", false);
      expect(attrs["data-tnd-theme"]).toBe(theme);
    }
  });
});

// ── Mock IPC command surface ───────────────────────────────────────────────────

describe("mock IPC command surface", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("search returns matching entries", async () => {
    const { mock } = await import("../lib/ipc/mock.js");
    // Use a group filter to constrain to work/atlas group so all results are
    // atlas entries (full-text search matches body text too, which can bleed
    // into other groups).
    const result = await mock.search({ text: "atlas", filters: { group: "work/atlas" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.length).toBeGreaterThan(0);
    for (const item of result.value.items) {
      expect(item.group).toBe("work/atlas");
    }
  });

  it("search with group filter restricts results", async () => {
    const { mock } = await import("../lib/ipc/mock.js");
    const result = await mock.search({ text: "", filters: { group: "books" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const item of result.value.items) {
      expect(item.group).toBe("books");
    }
  });

  it("read_entry returns not_found for missing id", async () => {
    const { mock } = await import("../lib/ipc/mock.js");
    const result = await mock.read_entry("does-not-exist");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not_found");
    }
  });

  it("real.ts returns not_implemented for unimplemented commands (ref #30)", async () => {
    const { real } = await import("../lib/ipc/real.js");
    const result = await real.read_entry("any-entry");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not_implemented");
      expect(result.error.detail).toMatch(/#30/);
    }
  });
});
