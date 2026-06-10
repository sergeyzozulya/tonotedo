// Focus zones — spec 0007 §Focus zones.
//
// Named zones: sidebar | entry-list | editor | properties | calendar.
// Switching focus is itself a command (focus.*). Zone state is a writable
// Svelte 5 rune-based store so UI and the keymap engine both react to it.

import { type WhenContext } from "./registry.js";

// ── Zone definitions ───────────────────────────────────────────────────────────

export type ZoneId = "sidebar" | "entry-list" | "editor" | "properties" | "calendar" | "palette";

/** Map zone → the when-context string it activates. */
export const ZONE_CONTEXTS: Record<ZoneId, WhenContext> = {
  sidebar: "zone:sidebar",
  "entry-list": "zone:entry-list",
  editor: "zone:editor",
  properties: "zone:properties",
  calendar: "zone:calendar",
  palette: "zone:palette",
};

/** Text-input zones where "?" must type a literal character. */
export const TEXT_INPUT_ZONES: ReadonlySet<ZoneId> = new Set<ZoneId>([
  "editor",
  "properties",
  "palette",
]);

// ── Zone store ─────────────────────────────────────────────────────────────────

/**
 * Currently active zone. Plain mutable variable — readable and writable via
 * the exported functions. In Svelte components, use `getActiveZone()` inside
 * a `$derived` or effect to react to changes; the variable itself is not a
 * Svelte rune so it is test-safe (no Svelte compiler required).
 */
let _activeZone: ZoneId = "editor";

export function getActiveZone(): ZoneId {
  return _activeZone;
}

export function setZone(zone: ZoneId): void {
  _activeZone = zone;
}

// ── Context evaluation ─────────────────────────────────────────────────────────

/**
 * Return the WhenContext string for the current active zone. Used by the
 * keymap engine to filter which commands are candidates for a given keystroke.
 */
export function currentContext(): WhenContext {
  return ZONE_CONTEXTS[_activeZone];
}

/**
 * Evaluate whether a when-context is active.
 * "" (empty) → always active.
 * "zone:X"  → active when the current zone matches X.
 */
export function evaluateContext(when: WhenContext): boolean {
  if (!when) return true;
  if (when.startsWith("zone:")) {
    const zoneId = when.slice(5) as ZoneId;
    return _activeZone === zoneId;
  }
  // Unknown context expressions default to false (safe).
  return false;
}

/**
 * Return the human-readable name of a zone for hint messages.
 */
export function zoneLabel(zone: ZoneId): string {
  const labels: Record<ZoneId, string> = {
    sidebar: "Sidebar",
    "entry-list": "Entry List",
    editor: "Editor",
    properties: "Properties",
    calendar: "Calendar",
    palette: "Palette",
  };
  return labels[zone] ?? zone;
}
