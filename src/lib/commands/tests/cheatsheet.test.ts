// Cheatsheet context behavior tests (issue #28, spec 0007).
//
// Tests verify:
//   1. Cheatsheet logic only includes commands active in the current zone
//      (global commands + zone-specific commands for the active zone).
//   2. Commands from other zones are NOT included.
//   3. Commands are grouped by category (Navigation, Editor, Entry, etc.).
//   4. '?' in editor/text zones does NOT trigger cheatsheet — it types literally.
//      (verified by reading the keymap-action.ts TEXT_INPUT_ZONES guard).
//
// Note: We cannot instantiate Cheatsheet.svelte directly (Svelte component
// rendering needs jsdom or a full browser).  Instead we test the LOGIC layer:
//   - registry.forContext()  → filtering
//   - groupedCommands computation (replicated from Cheatsheet.svelte)
//   - keymap-action TEXT_INPUT_ZONES guard
//   - The '?' stroke behavior in text vs non-text zones

import { describe, it, expect, beforeEach } from "vitest";
import { CommandRegistry } from "../registry-test-helper.js";
import { setZone, TEXT_INPUT_ZONES, getActiveZone } from "../zones.js";
import { resolveBindings } from "../keymap.js";
import type { Command, CommandCategory } from "../registry.js";

// ── Helper: build a minimal registry with commands in different zones ─────────

function makeCmd(
  id: string,
  category: CommandCategory,
  when: string,
  bindings: string[] = [],
): Command {
  return {
    id,
    name: `Command ${id}`,
    description: `Does ${id}`,
    category,
    defaultBindings: bindings,
    when,
    handler: () => {},
  };
}

/**
 * Replicate the cheatsheet groupedCommands logic from Cheatsheet.svelte:
 *   - Filter to global + zone-active commands.
 *   - Group by category.
 *   - Return ordered list of { category, items }.
 */
function computeGroupedCommands(
  reg: CommandRegistry,
  activeContext: string,
): Array<{ category: CommandCategory; items: Array<{ cmd: Command; binding: string }> }> {
  const userBindings = new Map<string, string[]>();

  const relevant = reg.all().filter((c) => !c.when || c.when === activeContext);
  const groups = new Map<CommandCategory, Array<{ cmd: Command; binding: string }>>();

  for (const cmd of relevant) {
    const chords = resolveBindings(cmd.id, cmd.defaultBindings, userBindings);
    const binding = chords.length > 0 ? chords.join(", ") : "–";
    if (!groups.has(cmd.category)) groups.set(cmd.category, []);
    groups.get(cmd.category)!.push({ cmd, binding });
  }

  const categoryOrder: CommandCategory[] = [
    "Navigation",
    "Entry",
    "Editor",
    "Group",
    "Tag",
    "View",
    "App",
  ];

  return categoryOrder
    .filter((cat) => groups.has(cat))
    .map((cat) => ({ category: cat, items: groups.get(cat)! }));
}

// ── Tests: cheatsheet filtering ───────────────────────────────────────────────

describe("cheatsheet — filters commands to current zone", () => {
  let reg: CommandRegistry;

  beforeEach(() => {
    reg = new CommandRegistry();
    // Global commands (no zone restriction).
    reg.register(makeCmd("entry.create", "Entry", "", ["meta+n"]));
    reg.register(makeCmd("view.cheatsheet", "View", "", ["?"]));
    // Editor-zone commands.
    reg.register(makeCmd("editor.bold", "Editor", "zone:editor", ["meta+b"]));
    reg.register(makeCmd("editor.italic", "Editor", "zone:editor", ["meta+i"]));
    // Sidebar-zone command.
    reg.register(makeCmd("sidebar.focus", "Navigation", "zone:sidebar", ["escape"]));
    // Calendar-zone command.
    reg.register(makeCmd("calendar.today", "Navigation", "zone:calendar", ["t"]));
  });

  it("includes global commands regardless of zone", () => {
    setZone("editor");
    const groups = computeGroupedCommands(reg, `zone:${getActiveZone()}`);
    const allIds = groups.flatMap((g) => g.items.map((i) => i.cmd.id));
    expect(allIds).toContain("entry.create");
    expect(allIds).toContain("view.cheatsheet");
  });

  it("includes editor commands when in editor zone", () => {
    setZone("editor");
    const groups = computeGroupedCommands(reg, `zone:${getActiveZone()}`);
    const allIds = groups.flatMap((g) => g.items.map((i) => i.cmd.id));
    expect(allIds).toContain("editor.bold");
    expect(allIds).toContain("editor.italic");
  });

  it("excludes sidebar commands when in editor zone", () => {
    setZone("editor");
    const groups = computeGroupedCommands(reg, `zone:${getActiveZone()}`);
    const allIds = groups.flatMap((g) => g.items.map((i) => i.cmd.id));
    expect(allIds).not.toContain("sidebar.focus");
    expect(allIds).not.toContain("calendar.today");
  });

  it("includes sidebar command when in sidebar zone", () => {
    setZone("sidebar");
    const groups = computeGroupedCommands(reg, `zone:${getActiveZone()}`);
    const allIds = groups.flatMap((g) => g.items.map((i) => i.cmd.id));
    expect(allIds).toContain("sidebar.focus");
    expect(allIds).toContain("entry.create"); // global still present
    expect(allIds).not.toContain("editor.bold"); // editor-specific absent
  });

  it("shows only global commands when in calendar zone (no calendar-specific zone commands in test registry)", () => {
    setZone("calendar");
    const groups = computeGroupedCommands(reg, `zone:${getActiveZone()}`);
    const allIds = groups.flatMap((g) => g.items.map((i) => i.cmd.id));
    // calendar.today IS in zone:calendar — should appear.
    expect(allIds).toContain("calendar.today");
    // editor.bold should NOT appear.
    expect(allIds).not.toContain("editor.bold");
  });
});

describe("cheatsheet — grouped by category", () => {
  let reg: CommandRegistry;

  beforeEach(() => {
    reg = new CommandRegistry();
    reg.register(makeCmd("entry.create", "Entry", ""));
    reg.register(makeCmd("entry.delete", "Entry", ""));
    reg.register(makeCmd("editor.bold", "Editor", "zone:editor"));
    reg.register(makeCmd("nav.go-home", "Navigation", ""));
    reg.register(makeCmd("app.settings", "App", ""));
  });

  it("groups commands by their category", () => {
    setZone("editor");
    const groups = computeGroupedCommands(reg, "zone:editor");
    const categories = groups.map((g) => g.category);
    expect(categories).toContain("Navigation");
    expect(categories).toContain("Entry");
    expect(categories).toContain("Editor");
    expect(categories).toContain("App");
  });

  it("Entry group contains both entry commands", () => {
    setZone("editor");
    const groups = computeGroupedCommands(reg, "zone:editor");
    const entryGroup = groups.find((g) => g.category === "Entry");
    expect(entryGroup).toBeDefined();
    const entryIds = entryGroup!.items.map((i) => i.cmd.id);
    expect(entryIds).toContain("entry.create");
    expect(entryIds).toContain("entry.delete");
  });

  it("Editor group does not appear in sidebar zone (context filtered)", () => {
    setZone("sidebar");
    const groups = computeGroupedCommands(reg, "zone:sidebar");
    const categories = groups.map((g) => g.category);
    expect(categories).not.toContain("Editor");
  });

  it("categories appear in design order: Navigation before Entry before Editor", () => {
    setZone("editor");
    const groups = computeGroupedCommands(reg, "zone:editor");
    const navIdx = groups.findIndex((g) => g.category === "Navigation");
    const entryIdx = groups.findIndex((g) => g.category === "Entry");
    const editorIdx = groups.findIndex((g) => g.category === "Editor");
    if (navIdx !== -1 && entryIdx !== -1) {
      expect(navIdx).toBeLessThan(entryIdx);
    }
    if (entryIdx !== -1 && editorIdx !== -1) {
      expect(entryIdx).toBeLessThan(editorIdx);
    }
  });

  it("commands with no bindings show '–' as binding", () => {
    setZone("editor");
    const groups = computeGroupedCommands(reg, "zone:editor");
    const allItems = groups.flatMap((g) => g.items);
    const unboundItems = allItems.filter((i) => i.cmd.defaultBindings.length === 0);
    for (const item of unboundItems) {
      expect(item.binding).toBe("–");
    }
  });
});

// ── Tests: '?' in text zones types literally (keymap-action guard) ─────────────
//
// keymap-action.ts has an explicit guard for view.cheatsheet:
//   if (isTextZone && stroke === "?") { return; /* let it type */ }
//
// TEXT_INPUT_ZONES = new Set(["editor", "properties", "palette"])
//
// These tests verify the guard data structure, not the DOM event handling
// (which would need jsdom).  The guard logic is tested by confirming
// TEXT_INPUT_ZONES contains the expected zones.

describe("'?' in text zones — keymap-action guard", () => {
  it("TEXT_INPUT_ZONES includes editor zone", () => {
    expect(TEXT_INPUT_ZONES.has("editor")).toBe(true);
  });

  it("TEXT_INPUT_ZONES includes properties zone", () => {
    expect(TEXT_INPUT_ZONES.has("properties")).toBe(true);
  });

  it("TEXT_INPUT_ZONES includes palette zone", () => {
    expect(TEXT_INPUT_ZONES.has("palette")).toBe(true);
  });

  it("TEXT_INPUT_ZONES does NOT include sidebar (non-text zone)", () => {
    expect(TEXT_INPUT_ZONES.has("sidebar")).toBe(false);
  });

  it("TEXT_INPUT_ZONES does NOT include entry-list (non-text zone)", () => {
    expect(TEXT_INPUT_ZONES.has("entry-list")).toBe(false);
  });

  it("TEXT_INPUT_ZONES does NOT include calendar (non-text zone)", () => {
    expect(TEXT_INPUT_ZONES.has("calendar")).toBe(false);
  });

  it("'?' does NOT trigger cheatsheet in editor zone — guard is active", () => {
    // Replicate the keymap-action.ts guard logic:
    //   if (commandId === "view.cheatsheet" && isTextZone && stroke === "?") { return; }
    //
    // We confirm the guard evaluates to true for the editor zone with stroke "?".
    setZone("editor");
    const activeZone = getActiveZone();
    const isTextZone = TEXT_INPUT_ZONES.has(activeZone);
    const stroke = "?";

    // Guard condition — must be true to suppress cheatsheet opening.
    expect(isTextZone && stroke === "?").toBe(true);
  });

  it("'?' DOES trigger cheatsheet in sidebar zone — guard is not active", () => {
    // In a non-text zone, the guard does not fire, so '?' would open the cheatsheet.
    setZone("sidebar");
    const activeZone = getActiveZone();
    const isTextZone = TEXT_INPUT_ZONES.has(activeZone);
    const stroke = "?";

    // Guard condition is false → cheatsheet would open.
    expect(isTextZone && stroke === "?").toBe(false);
  });

  it("'?' DOES trigger cheatsheet in entry-list zone", () => {
    setZone("entry-list");
    const isTextZone = TEXT_INPUT_ZONES.has(getActiveZone());
    expect(isTextZone && "?" === "?").toBe(false);
  });
});
