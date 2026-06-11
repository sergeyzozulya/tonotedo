// Global keydown action — spec 0007 §Edge cases (IME guard) + chord dispatch.
//
// Use as a Svelte action on the root element:
//   <div use:keymapAction>
//
// Or call attachKeymapListener(element) imperatively.
//
// Responsibilities:
//   1. IME composition guard: ignore keydowns during active composition.
//   2. Build the current binding list from registry + user overrides.
//   3. Run the chord state machine.
//   4. Execute matched commands whose when-context is currently active.
//   5. Provide a "no-op hint" when a command's context is inactive.
//   6. Wire palette.open and view.cheatsheet at the document level.

import { ChordStateMachine, buildBindingList, type Binding } from "./keymap.js";
import { registry } from "./registry.js";
import { evaluateContext, getActiveZone, TEXT_INPUT_ZONES } from "./zones.js";
import { loadUserBindings } from "./settings.js";
import { recordRecent } from "./recents.js";
import { parseStroke } from "./keymap.js";

// ── Hint callback ──────────────────────────────────────────────────────────────

/** Optional callback to display an "inactive context" hint to the user. */
let _hintCallback: ((message: string) => void) | null = null;

export function setHintCallback(cb: (message: string) => void): void {
  _hintCallback = cb;
}

function showHint(message: string): void {
  _hintCallback?.(message);
}

// ── Palette / Cheatsheet callbacks ─────────────────────────────────────────────

let _openPalette: (() => void) | null = null;
let _openCheatsheet: (() => void) | null = null;

export function setPaletteOpener(fn: () => void): void {
  _openPalette = fn;
}

export function setCheatsheetOpener(fn: () => void): void {
  _openCheatsheet = fn;
}

// ── Keystroke normalization ────────────────────────────────────────────────────

/**
 * Shifted US punctuation glyph → its unshifted base key. Used only to keep the
 * canonical stroke aligned with the binding-table notation when other modifiers
 * are present (e.g. cmd+shift+/ emits e.key "?" — we re-form it as meta+shift+/
 * so it matches the stored binding). Layout-dependent but covers the only
 * spec-relevant case (cmd+? == shift+cmd+/, spec 0007 §Cheatsheet).
 */
const SHIFTED_PUNCT_BASE: Record<string, string> = {
  "?": "/",
  ":": ";",
  "<": ",",
  ">": ".",
  '"': "'",
  "{": "[",
  "}": "]",
  "|": "\\",
  "+": "=",
  _: "-",
  "~": "`",
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
};

/** The subset of KeyboardEvent fields eventToStroke reads (lets tests pass a
 *  plain object without a DOM KeyboardEvent constructor). */
export interface StrokeEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Convert a KeyboardEvent to a canonical stroke string. Returns null if
 *  the event is not a bindable keystroke (e.g. bare modifier key press).
 *  Exported for unit testing of the `?`/`cmd+?` normalization (spec 0007). */
export function eventToStroke(e: StrokeEvent): string | null {
  const key = e.key;
  // Ignore bare modifier presses.
  if (["Meta", "Control", "Alt", "Shift", "CapsLock"].includes(key)) return null;

  const hasOtherMod = e.metaKey || e.ctrlKey || e.altKey;
  // A shifted printable punctuation glyph (e.g. "?", ":") already encodes the
  // shift in `e.key`. With no other modifier the keymap notation is the bare
  // glyph ("?", not "shift+?") — so a literal "?" matches the cheatsheet binding
  // and the text-zone guard. With another modifier present, we instead re-form
  // the canonical as shift + base key (cmd+? → meta+shift+/) to match how the
  // binding is written on disk.
  const isShiftedPunct = key in SHIFTED_PUNCT_BASE && e.shiftKey;

  const parts: string[] = [];
  if (e.metaKey) parts.push("meta");
  if (e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");

  let normalizedKey: string;
  if (isShiftedPunct && !hasOtherMod) {
    // Bare shifted glyph → drop the shift, emit the glyph itself.
    normalizedKey = key;
  } else if (isShiftedPunct) {
    // Shifted glyph + another modifier → shift + base key.
    parts.push("shift");
    normalizedKey = SHIFTED_PUNCT_BASE[key];
  } else {
    if (e.shiftKey) parts.push("shift");
    normalizedKey = key.toLowerCase();
    // Browser sends " " for spacebar.
    if (normalizedKey === " ") normalizedKey = "space";
  }

  parts.push(normalizedKey);
  const raw = parts.join("+");
  return parseStroke(raw)?.canonical ?? null;
}

// ── State machine ──────────────────────────────────────────────────────────────

const chordMachine = new ChordStateMachine(() => {
  // Timeout: show brief hint if desired.
  showHint("Chord timed out");
});

let _composing = false;

// ── Main handler ───────────────────────────────────────────────────────────────

function handleKeydown(e: KeyboardEvent): void {
  // IME composition guard (spec 0007 §Edge cases).
  if (_composing) return;

  const stroke = eventToStroke(e);
  if (!stroke) return;

  // Build fresh binding list from registry + user overrides each time.
  // This is cheap (< 100 commands) and ensures live rebinding takes effect.
  const userBindings = loadUserBindings();
  const allBindings: Binding[] = buildBindingList(
    registry.all().map((c) => ({
      id: c.id,
      defaultBindings: c.defaultBindings,
      when: c.when,
    })),
    userBindings,
  );

  // Filter to bindings relevant to the current context (active zone + global).
  const activeZone = getActiveZone();
  const activeContext = `zone:${activeZone}`;
  const relevantBindings = allBindings.filter((b) => !b.when || b.when === activeContext);

  const { execute, inProgress } = chordMachine.advance(stroke, relevantBindings);

  if (inProgress) {
    // Chord in progress — consume the event.
    e.preventDefault();
    return;
  }

  if (execute.length === 0) {
    // No match in active context. Check if it matches a binding in SOME context
    // (to show a hint that it exists but is inactive).
    const inactiveMatch = allBindings.find(
      (b) => b.chord === stroke && b.when && b.when !== activeContext,
    );
    if (inactiveMatch) {
      const cmd = registry.get(inactiveMatch.commandId);
      if (cmd) {
        const zoneName = inactiveMatch.when.replace("zone:", "");
        showHint(`"${cmd.name}" is only active in the ${zoneName} zone`);
        e.preventDefault();
      }
    }
    return;
  }

  // Execute matched commands.
  for (const { commandId } of execute) {
    // Special wiring for palette and cheatsheet.
    if (commandId === "palette.open") {
      e.preventDefault();
      _openPalette?.();
      return;
    }

    if (commandId === "view.cheatsheet") {
      // In text zones, "?" must type literally — only cmd+? triggers cheatsheet.
      const isTextZone = TEXT_INPUT_ZONES.has(activeZone);
      if (isTextZone && stroke === "?") {
        // Let it type.
        return;
      }
      e.preventDefault();
      _openCheatsheet?.();
      return;
    }

    const cmd = registry.get(commandId);
    if (!cmd) continue;

    // Evaluate context one more time (belt-and-suspenders).
    if (!evaluateContext(cmd.when)) {
      const zoneName = cmd.when.replace("zone:", "");
      showHint(`"${cmd.name}" is only active in the ${zoneName} zone`);
      continue;
    }

    e.preventDefault();
    recordRecent(commandId);
    void cmd.handler();
  }
}

function handleCompositionStart(): void {
  _composing = true;
  chordMachine.reset();
}

function handleCompositionEnd(): void {
  _composing = false;
}

// ── Attachment helpers ─────────────────────────────────────────────────────────

/** Attach the keymap listener to a DOM element. Returns a cleanup function. */
export function attachKeymapListener(el: EventTarget): () => void {
  el.addEventListener("keydown", handleKeydown as EventListener);
  el.addEventListener("compositionstart", handleCompositionStart);
  el.addEventListener("compositionend", handleCompositionEnd);
  return () => {
    el.removeEventListener("keydown", handleKeydown as EventListener);
    el.removeEventListener("compositionstart", handleCompositionStart);
    el.removeEventListener("compositionend", handleCompositionEnd);
  };
}

/** Svelte action — use on the root element. */
export function keymapAction(node: HTMLElement): { destroy(): void } {
  const cleanup = attachKeymapListener(node);
  return { destroy: cleanup };
}

/** Attach to document (for use outside Svelte). */
export function attachToDocument(): () => void {
  return attachKeymapListener(document);
}
