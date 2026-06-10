// Command registry — spec 0007 §Commands.
//
// Every user-facing action registers here. The registry is the source of truth
// for the palette, keybindings, and menus.

// ── Types ──────────────────────────────────────────────────────────────────────

export type CommandCategory = "Navigation" | "Editor" | "Entry" | "Group" | "Tag" | "View" | "App";

/**
 * A "when" context string. Commands are only active when all their contexts
 * match the current focus zone evaluation. The empty string ("") means the
 * command is always active (global).
 *
 * Values follow the pattern used in zones.ts:
 *   "zone:editor"   — active when editor zone is focused
 *   "zone:sidebar"  — active when sidebar is focused
 *   etc.
 * Multiple conditions joined with " && " (future; not needed in v1).
 */
export type WhenContext = string;

/**
 * A single key-chord string in VS Code notation, e.g. "cmd+k" or "cmd+e cmd+t".
 * Spaces separate strokes in a multi-stroke chord.
 */
export type ChordString = string;

export interface Command {
  /** Stable identifier, dot-namespaced: "entry.create", "editor.toggle-checkbox". */
  readonly id: string;
  /** Human-readable name shown in palette and menus. */
  readonly name: string;
  /** One-line description shown in the palette. */
  readonly description: string;
  /** Grouping for palette and cheatsheet display. */
  readonly category: CommandCategory;
  /**
   * Default binding(s). May be empty. First entry is displayed as the primary
   * binding in menus / results.
   */
  readonly defaultBindings: readonly ChordString[];
  /**
   * When context — empty means always active. A zone-scoped command (e.g.
   * "editor.heading-1") should use "zone:editor".
   */
  readonly when: WhenContext;
  /**
   * The handler to invoke. Receives no args (commands are intent-only; state
   * is accessed via stores). May be async.
   */
  readonly handler: () => void | Promise<void>;
}

// ── Registry store ─────────────────────────────────────────────────────────────

/** Snapshot returned by queryCommands — never mutated after return. */
export type CommandSnapshot = Omit<Command, "handler"> & { handler: () => void | Promise<void> };

class CommandRegistry {
  private readonly _map = new Map<string, Command>();

  /** Register a command. Replaces any existing command with the same id. */
  register(cmd: Command): void {
    this._map.set(cmd.id, cmd);
  }

  /** Remove a command by id (used by plugins on teardown). */
  unregister(id: string): void {
    this._map.delete(id);
  }

  /** Look up a command by its stable id. */
  get(id: string): Command | undefined {
    return this._map.get(id);
  }

  /** All registered commands as an array. Order is insertion order. */
  all(): Command[] {
    return Array.from(this._map.values());
  }

  /**
   * Query commands by a partial match of name/description/id.
   * Returns commands whose name, description, or id includes the query
   * (case-insensitive). Empty query returns all.
   */
  query(text: string): Command[] {
    if (!text) return this.all();
    const q = text.toLowerCase();
    return this.all().filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q),
    );
  }

  /** Commands active in the given when-context (or globally-active ones). */
  forContext(context: WhenContext): Command[] {
    return this.all().filter((c) => !c.when || c.when === context);
  }
}

/** Singleton registry — import and call register() to add commands. */
export const registry = new CommandRegistry();
