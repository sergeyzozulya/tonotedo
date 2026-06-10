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

  it("real.ts returns io_error for commands when Tauri is absent (first-wave commands are implemented, ref #30)", async () => {
    // First-wave IPC commands are now implemented (issue #30 done).
    // In Node/vitest without a Tauri runtime, invoke() throws; we wrap that
    // as io_error rather than not_implemented.
    const { real } = await import("../lib/ipc/real.js");
    const result = await real.read_entry("any-entry");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // io_error: Tauri invoke not available in Node environment.
      expect(result.error.code).toBe("io_error");
    }
  });
});

// ── Item 1: PersonMeta color + avatarPath ─────────────────────────────────────

describe("PersonMeta color + avatarPath (issue #31 item 1)", () => {
  it("people_index returns PersonMeta with color for declared people", async () => {
    const { mock } = await import("../lib/ipc/mock.js");
    const result = await mock.people_index();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // anna has color: violet in PEOPLE_COLORS
    const anna = result.value.find((p) => p.slug === "anna");
    expect(anna).toBeDefined();
    expect(anna?.color).toBe("violet");
  });

  it("people_index returns PersonMeta with avatarPath for anna", async () => {
    const { mock } = await import("../lib/ipc/mock.js");
    const result = await mock.people_index();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const anna = result.value.find((p) => p.slug === "anna");
    expect(anna?.avatarPath).toMatch(/blueprint-cover\.png$/);
  });

  it("people_index returns PersonMeta without color for undeclared people", async () => {
    const { mock } = await import("../lib/ipc/mock.js");
    const result = await mock.people_index();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // sergey has no color entry
    const sergey = result.value.find((p) => p.slug === "sergey");
    expect(sergey).toBeDefined();
    expect(sergey?.color).toBeUndefined();
  });

  it("anna's avatarPath references a mock asset that exists", async () => {
    const { mock } = await import("../lib/ipc/mock.js");
    const peopleResult = await mock.people_index();
    expect(peopleResult.ok).toBe(true);
    if (!peopleResult.ok) return;
    const anna = peopleResult.value.find((p) => p.slug === "anna");
    expect(anna?.avatarPath).toBeDefined();
    const existsResult = await mock.asset_exists(anna!.avatarPath!);
    expect(existsResult.ok).toBe(true);
    if (existsResult.ok) expect(existsResult.value).toBe(true);
  });
});

// ── Item 3: search modifiedAt via entries.updated ─────────────────────────────

describe("search EntrySummary.modifiedAt (issue #31 item 3)", () => {
  it("mock search returns non-empty modifiedAt on matching entries", async () => {
    const { mock } = await import("../lib/ipc/mock.js");
    const result = await mock.search({ text: "atlas" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const item of result.value.items) {
      expect(typeof item.modifiedAt).toBe("string");
      expect(item.modifiedAt.length).toBeGreaterThan(0);
    }
  });

  it("mock search returns ISO-8601 modifiedAt", async () => {
    const { mock } = await import("../lib/ipc/mock.js");
    const result = await mock.search({ text: "" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.length).toBeGreaterThan(0);
    for (const item of result.value.items) {
      // ISO-8601 date strings contain 'T' separator
      expect(item.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});

// ── Item 4: entry_titles facade ───────────────────────────────────────────────

describe("entry_titles facade (issue #31 item 4)", () => {
  it("returns a non-empty record of id → title", async () => {
    const { mock } = await import("../lib/ipc/mock.js");
    const result = await mock.entry_titles();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const titles = result.value;
    expect(Object.keys(titles).length).toBeGreaterThan(0);
  });

  it("contains the known entry ids", async () => {
    const { mock } = await import("../lib/ipc/mock.js");
    const result = await mock.entry_titles();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value["work/atlas/project-overview"]).toBe("Project Atlas — Overview");
    expect(result.value["books/deep-work"]).toBe("Deep Work — Cal Newport");
  });

  it("all values are non-empty strings", async () => {
    const { mock } = await import("../lib/ipc/mock.js");
    const result = await mock.entry_titles();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const [id, title] of Object.entries(result.value)) {
      expect(typeof id).toBe("string");
      expect(title.length).toBeGreaterThan(0);
    }
  });
});

// ── Plugins facade (issue #25) ────────────────────────────────────────────────

describe("plugins facade (issue #25)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("plugins_list returns 2 mock plugins, one permissions-pending", async () => {
    const { mock } = await import("../lib/ipc/mock.js");
    const result = await mock.plugins_list();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBe(2);
    const pending = result.value.filter((p) => p.status === "permissions-pending");
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe("com.example.gcal");
    // The active one is the Mermaid processor.
    const active = result.value.find((p) => p.status === "active");
    expect(active?.id).toBe("com.example.mermaid");
  });

  it("granting the last missing permission activates the plugin", async () => {
    const { mock } = await import("../lib/ipc/mock.js");
    // gcal is pending: read-entries granted, write-entries + network missing.
    await mock.plugins_set_grant("com.example.gcal", "write-entries", true);
    await mock.plugins_set_grant("com.example.gcal", "network:www.googleapis.com", true);
    const result = await mock.plugins_list();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const gcal = result.value.find((p) => p.id === "com.example.gcal");
    expect(gcal?.status).toBe("active");
    expect(gcal?.granted).toContain("write-entries");
  });

  it("plugins_set_grant rejects an undeclared permission", async () => {
    const { mock } = await import("../lib/ipc/mock.js");
    const result = await mock.plugins_set_grant("com.example.mermaid", "network", true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_argument");
  });

  it("plugins_invoke_command errors for a non-active plugin", async () => {
    const { mock } = await import("../lib/ipc/mock.js");
    // gcal starts pending in a fresh module → not active.
    const result = await mock.plugins_invoke_command(
      "com.example.gcal",
      "com.example.gcal.sync",
      "{}",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_argument");
  });

  it("real.ts plugins_list returns io_error when Tauri is absent", async () => {
    const { real } = await import("../lib/ipc/real.js");
    const result = await real.plugins_list();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("io_error");
  });

  it("plugins_reload returns the refreshed inventory (mock)", async () => {
    const { mock } = await import("../lib/ipc/mock.js");
    const result = await mock.plugins_reload();
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Same shape as plugins_list: a PluginInfo[] with the known mock plugins.
      const listed = await mock.plugins_list();
      expect(listed.ok).toBe(true);
      if (listed.ok) expect(result.value.length).toBe(listed.value.length);
    }
  });

  it("real.ts plugins_reload returns io_error when Tauri is absent", async () => {
    const { real } = await import("../lib/ipc/real.js");
    const result = await real.plugins_reload();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("io_error");
  });
});

// ── Item 2: IndexChangedKind 'created' ────────────────────────────────────────

describe("IndexChangedKind 'created' in types (issue #31 item 2)", () => {
  it("mock write_entry emits 'modified' (not 'created') for index_changed event", async () => {
    const { mock } = await import("../lib/ipc/mock.js");
    const events: unknown[] = [];
    const unsub = mock.on("index_changed", (e) => events.push(e));
    await mock.write_entry("work/atlas/tech-decisions", "# Updated\n", "tok");
    unsub();
    expect(events.length).toBeGreaterThan(0);
    // write_entry emits modified (existing entry)
    const ev = events[0] as { kinds: string[] };
    expect(ev.kinds).toContain("modified");
  });
});
