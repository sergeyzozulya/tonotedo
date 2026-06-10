// Command seed — registers all commands that exist today (spec 0007 §Commands).
//
// Keep this honest: only register commands that have a real or near-real handler.
// Stubs are marked with a comment. The registry grows with features.
//
// Call seedCommands() once at app startup (before mounting the shell).
// Call seedThemeCommands(themeStore) from AppShell/settings init to wire
// view.theme-* and view.mode-* handlers through themeStore, fixing the gap
// where direct DOM setAttribute bypassed the store (issue #23).

import { registry, type Command } from "./registry.js";
import { setZone } from "./zones.js";
import type { themeStore as ThemeStoreType } from "../shell/theme-store.js";

// ── palette / app ──────────────────────────────────────────────────────────────

// palette.open is handled by the keymap action directly; the registry entry
// exists so it appears in the cheatsheet and gets a binding.
const noop = () => {};

const COMMANDS: Command[] = [
  // ── App ────────────────────────────────────────────────────────────────────

  {
    id: "palette.open",
    name: "Open Command Palette",
    description: "Open the command palette to search and run commands",
    category: "App",
    defaultBindings: ["cmd+k"],
    when: "",
    handler: noop, // wired by the keymap action directly
  },
  {
    id: "app.settings",
    name: "Open Settings",
    description: "Open the settings panel",
    category: "App",
    defaultBindings: ["cmd+,"],
    when: "",
    handler: noop, // stub — settings UI not yet built
  },
  {
    id: "bench.open",
    name: "Open Component Bench",
    description: "Open the developer component bench (dev only)",
    category: "App",
    defaultBindings: [],
    when: "",
    handler: () => {
      window.location.hash = "#/bench";
    },
  },

  // ── Entry ──────────────────────────────────────────────────────────────────

  {
    id: "entry.create",
    name: "New Entry",
    description: "Create a new entry in the current group",
    category: "Entry",
    defaultBindings: ["cmd+n"],
    when: "",
    // experimental stub — entry list not yet wired
    handler: noop,
  },
  {
    id: "entry.save",
    name: "Save Entry",
    description: "Force an immediate save of the current entry",
    category: "Entry",
    defaultBindings: ["cmd+s"],
    when: "",
    handler: noop, // stub — saving is otherwise automatic (spec 0006)
  },
  {
    id: "entry.search",
    name: "Search Entries",
    description: "Open global entry search",
    category: "Entry",
    defaultBindings: ["cmd+p"],
    when: "",
    handler: noop, // stub — search panel not yet built
  },

  // ── Editor ─────────────────────────────────────────────────────────────────

  {
    id: "editor.find",
    name: "Find in Entry",
    description: "Find text within the open entry",
    category: "Editor",
    defaultBindings: ["cmd+f"],
    when: "zone:editor",
    handler: noop, // stub
  },
  {
    id: "editor.toggle-checkbox",
    name: "Toggle Checkbox",
    description: "Toggle the checkbox on the current task item",
    category: "Editor",
    defaultBindings: ["cmd+shift+c"],
    when: "zone:editor",
    // Delegates to the blocks plugin's toggleCheckbox; wired at the Editor level.
    handler: noop,
  },
  {
    id: "editor.heading-1",
    name: "Heading 1",
    description: "Format current line as Heading 1",
    category: "Editor",
    defaultBindings: ["cmd+1"],
    when: "zone:editor",
    handler: noop, // stub
  },
  {
    id: "editor.heading-2",
    name: "Heading 2",
    description: "Format current line as Heading 2",
    category: "Editor",
    defaultBindings: ["cmd+2"],
    when: "zone:editor",
    handler: noop, // stub
  },
  {
    id: "editor.heading-3",
    name: "Heading 3",
    description: "Format current line as Heading 3",
    category: "Editor",
    defaultBindings: ["cmd+3"],
    when: "zone:editor",
    handler: noop, // stub
  },
  {
    id: "editor.bold",
    name: "Bold",
    description: "Toggle bold formatting on selection",
    category: "Editor",
    defaultBindings: ["cmd+b"],
    when: "zone:editor",
    handler: noop, // stub
  },
  {
    id: "editor.italic",
    name: "Italic",
    description: "Toggle italic formatting on selection",
    category: "Editor",
    defaultBindings: ["cmd+i"],
    when: "zone:editor",
    handler: noop, // stub
  },
  {
    id: "editor.code",
    name: "Inline Code",
    description: "Toggle inline code formatting on selection",
    category: "Editor",
    defaultBindings: ["cmd+e"],
    when: "zone:editor",
    handler: noop, // stub
  },
  {
    id: "editor.undo",
    name: "Undo",
    description: "Undo last edit",
    category: "Editor",
    defaultBindings: ["cmd+z"],
    when: "zone:editor",
    handler: noop, // native browser undo
  },
  {
    id: "editor.redo",
    name: "Redo",
    description: "Redo last undone edit",
    category: "Editor",
    defaultBindings: ["cmd+shift+z"],
    when: "zone:editor",
    handler: noop, // native browser redo
  },

  // ── View ───────────────────────────────────────────────────────────────────

  {
    id: "view.cheatsheet",
    name: "Show Cheatsheet",
    description: "Show the keyboard shortcuts cheatsheet for the current zone",
    category: "View",
    defaultBindings: ["cmd+shift+/"],
    when: "",
    handler: noop, // wired by Cheatsheet.svelte
  },
  // Theme commands — handlers are stubs here; seedThemeCommands() re-registers
  // them through themeStore so command + UI stay in sync (issue #23 theme sync fix).
  {
    id: "view.theme-paper",
    name: "Theme: Paper",
    description: "Switch to the Paper theme",
    category: "View",
    defaultBindings: [],
    when: "",
    handler: noop,
  },
  {
    id: "view.theme-fog",
    name: "Theme: Fog",
    description: "Switch to the Fog theme",
    category: "View",
    defaultBindings: [],
    when: "",
    handler: noop,
  },
  {
    id: "view.theme-mono",
    name: "Theme: Mono",
    description: "Switch to the Mono theme",
    category: "View",
    defaultBindings: [],
    when: "",
    handler: noop,
  },
  {
    id: "view.theme-editorial",
    name: "Theme: Editorial",
    description: "Switch to the Editorial theme",
    category: "View",
    defaultBindings: [],
    when: "",
    handler: noop,
  },
  {
    id: "view.theme-soft",
    name: "Theme: Soft",
    description: "Switch to the Soft theme",
    category: "View",
    defaultBindings: [],
    when: "",
    handler: noop,
  },
  {
    id: "view.mode-light",
    name: "Mode: Light",
    description: "Switch to light mode",
    category: "View",
    defaultBindings: [],
    when: "",
    handler: noop,
  },
  {
    id: "view.mode-dark",
    name: "Mode: Dark",
    description: "Switch to dark mode",
    category: "View",
    defaultBindings: [],
    when: "",
    handler: noop,
  },
  {
    id: "view.mode-system",
    name: "Mode: System",
    description: "Follow the OS appearance preference",
    category: "View",
    defaultBindings: [],
    when: "",
    handler: noop,
  },

  // ── Navigation / Focus ─────────────────────────────────────────────────────

  {
    id: "focus.sidebar",
    name: "Focus Sidebar",
    description: "Move keyboard focus to the sidebar",
    category: "Navigation",
    defaultBindings: ["cmd+shift+s"],
    when: "",
    handler: () => setZone("sidebar"),
  },
  {
    id: "focus.entry-list",
    name: "Focus Entry List",
    description: "Move keyboard focus to the entry list",
    category: "Navigation",
    defaultBindings: ["cmd+shift+l"],
    when: "",
    handler: () => setZone("entry-list"),
  },
  {
    id: "focus.editor",
    name: "Focus Editor",
    description: "Move keyboard focus to the editor",
    category: "Navigation",
    defaultBindings: ["cmd+shift+e"],
    when: "",
    handler: () => setZone("editor"),
  },
  {
    id: "focus.properties",
    name: "Focus Properties",
    description: "Move keyboard focus to the properties panel",
    category: "Navigation",
    defaultBindings: ["cmd+shift+p"],
    when: "",
    handler: () => setZone("properties"),
  },
  {
    id: "focus.calendar",
    name: "Focus Calendar",
    description: "Move keyboard focus to the calendar",
    category: "Navigation",
    defaultBindings: ["cmd+shift+d"],
    when: "",
    handler: () => setZone("calendar"),
  },
];

/** Register all built-in commands. Safe to call multiple times (idempotent). */
export function seedCommands(): void {
  for (const cmd of COMMANDS) {
    registry.register(cmd);
  }
}

/**
 * Wire theme/mode command handlers through themeStore so that invoking a
 * view.theme-* or view.mode-* command from the palette (or a keybinding) updates
 * the store — keeping command + UI in sync (issue #23 fix).
 *
 * Call once after themeStore is initialised (in AppShell $effect or settings init).
 * Safe to call multiple times; re-registers the same commands.
 */
export function seedThemeCommands(store: typeof ThemeStoreType): void {
  const themeIds: Array<[string, string]> = [
    ["view.theme-paper", "paper"],
    ["view.theme-fog", "fog"],
    ["view.theme-mono", "mono"],
    ["view.theme-editorial", "editorial"],
    ["view.theme-soft", "soft"],
  ];
  for (const [id, key] of themeIds) {
    const existing = registry.get(id);
    if (existing) {
      registry.register({ ...existing, handler: () => store.setTheme(key) });
    }
  }

  const modeIds: Array<[string, "light" | "dark" | "system"]> = [
    ["view.mode-light", "light"],
    ["view.mode-dark", "dark"],
    ["view.mode-system", "system"],
  ];
  for (const [id, mode] of modeIds) {
    const existing = registry.get(id);
    if (existing) {
      registry.register({ ...existing, handler: () => store.setMode(mode) });
    }
  }
}
