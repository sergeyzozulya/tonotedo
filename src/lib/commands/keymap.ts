// Keymap engine — spec 0007 §Keymap.
//
// Responsibilities:
//   1. Parse + normalize chord strings (VS Code notation).
//   2. Conflict detection: same binding × same when-context, plus chord-prefix rule.
//   3. OS-reserved shortcut refusal list.
//   4. Chord-dispatch state machine with timeout.

import { type ChordString, type WhenContext } from "./registry.js";

// ── Modifier normalization ─────────────────────────────────────────────────────

/** Canonical order for modifier display: Meta > Ctrl > Alt > Shift */
const MOD_ORDER = ["meta", "ctrl", "alt", "shift"] as const;
type Modifier = (typeof MOD_ORDER)[number];

/** Aliases → canonical modifier name. */
const MOD_ALIASES: Record<string, Modifier> = {
  cmd: "meta",
  command: "meta",
  win: "meta",
  super: "meta",
  ctl: "ctrl",
  control: "ctrl",
  option: "alt",
  opt: "alt",
};

// ── OS-reserved shortcuts ──────────────────────────────────────────────────────
// Normalized forms (result of parseStroke). User binding attempts that match
// any entry are refused.

const OS_RESERVED: ReadonlySet<string> = new Set([
  // macOS system
  "meta+space",
  "meta+tab",
  "meta+shift+tab",
  "ctrl+space",
  "meta+h", // hide app
  "meta+m", // minimize
  "meta+q", // quit
  "meta+alt+esc", // force quit
  "ctrl+alt+del",
  "ctrl+shift+esc",
  // Platform window management
  "meta+shift+3", // screenshot
  "meta+shift+4",
  "meta+shift+5",
  "meta+ctrl+f", // fullscreen
  "ctrl+f4", // close tab (Win)
  "alt+f4", // close app (Win)
]);

// ── Stroke parsing ─────────────────────────────────────────────────────────────

export interface ParsedStroke {
  key: string; // lowercased non-modifier key
  modifiers: Modifier[];
  /** Canonical normalized form, e.g. "meta+shift+k" */
  canonical: string;
}

export interface ParsedChord {
  strokes: ParsedStroke[];
  /** Full canonical form, strokes joined by " ". */
  canonical: string;
}

/**
 * Parse a single stroke like "cmd+k" or "shift+enter".
 * Returns null if the stroke is malformed.
 */
export function parseStroke(raw: string): ParsedStroke | null {
  if (!raw || typeof raw !== "string") return null;
  const parts = raw
    .trim()
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const mods = new Set<Modifier>();
  let key = "";

  for (const part of parts) {
    if (part in MOD_ALIASES) {
      mods.add(MOD_ALIASES[part]);
    } else if ((MOD_ORDER as readonly string[]).includes(part)) {
      mods.add(part as Modifier);
    } else {
      // Last non-modifier segment is the key. Multiple keys = malformed.
      if (key) return null;
      key = part;
    }
  }

  if (!key) return null;

  // Canonical: modifiers in fixed order + key
  const sortedMods = MOD_ORDER.filter((m) => mods.has(m));
  const canonical = [...sortedMods, key].join("+");

  return { key, modifiers: sortedMods, canonical };
}

/**
 * Parse a full chord string (one or more strokes separated by spaces).
 * Returns null if any stroke is malformed.
 */
export function parseChord(raw: ChordString): ParsedChord | null {
  if (!raw || typeof raw !== "string") return null;
  const strokeStrings = raw.trim().split(/\s+/);
  const strokes: ParsedStroke[] = [];
  for (const s of strokeStrings) {
    const parsed = parseStroke(s);
    if (!parsed) return null;
    strokes.push(parsed);
  }
  if (strokes.length === 0) return null;
  return { strokes, canonical: strokes.map((s) => s.canonical).join(" ") };
}

/** Normalize a chord string to canonical form. Returns null on parse error. */
export function normalizeChord(raw: ChordString): string | null {
  return parseChord(raw)?.canonical ?? null;
}

// ── OS-reserved check ──────────────────────────────────────────────────────────

/**
 * Returns true when the chord (any stroke thereof) would override an OS-reserved
 * shortcut. Checks only the first stroke; a chord that starts with an OS key is
 * also blocked because the OS consumes the first stroke before we see it.
 */
export function isOsReserved(chord: ChordString): boolean {
  const parsed = parseChord(chord);
  if (!parsed) return false;
  // Check if the first stroke is reserved (OS intercepts before app sees chord).
  return OS_RESERVED.has(parsed.strokes[0].canonical);
}

// ── Conflict detection ─────────────────────────────────────────────────────────

export interface Binding {
  commandId: string;
  chord: string; // canonical
  when: WhenContext;
}

export type ConflictKind =
  | "exact" // same chord, same context
  | "chord-prefix"; // existing binding is a prefix of the new chord, or vice versa

export interface ConflictResult {
  kind: ConflictKind;
  existing: Binding;
}

/**
 * Detect conflicts between a proposed new binding and a set of existing bindings.
 *
 * Rules (spec 0007):
 *  - Same chord, same when-context → "exact" conflict.
 *  - Cross-context same chord → no conflict (enter does different things in
 *    different zones).
 *  - Chord-prefix rule: if binding A is "cmd+e" and B is "cmd+e cmd+t" in the
 *    same context, A's stroke can never complete — conflict.
 *
 * @param proposed   The new binding being added.
 * @param existing   All current bindings to check against.
 */
export function detectConflicts(proposed: Binding, existing: Binding[]): ConflictResult[] {
  const conflicts: ConflictResult[] = [];

  for (const b of existing) {
    // Only check within the same when-context (cross-context is fine).
    if (b.when !== proposed.when) continue;

    if (b.chord === proposed.chord) {
      conflicts.push({ kind: "exact", existing: b });
      continue;
    }

    // Chord-prefix check: one chord is a prefix of the other.
    const bStrokes = b.chord.split(" ");
    const pStrokes = proposed.chord.split(" ");
    const shorter = bStrokes.length < pStrokes.length ? bStrokes : pStrokes;
    const longer = bStrokes.length < pStrokes.length ? pStrokes : bStrokes;

    // Check if shorter is a prefix of longer.
    const isPrefix = shorter.every((s, i) => s === longer[i]);
    if (isPrefix && shorter.length < longer.length) {
      conflicts.push({ kind: "chord-prefix", existing: b });
    }
  }

  return conflicts;
}

// ── Chord-dispatch state machine ───────────────────────────────────────────────

/** Duration in ms before a partial chord times out and resets. */
export const CHORD_TIMEOUT_MS = 1500;

export interface DispatchCandidate {
  commandId: string;
  chord: string;
}

export class ChordStateMachine {
  /** Strokes accumulated so far (canonical). */
  private _pending: string[] = [];
  private _timeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly _onTimeout: () => void = () => {}) {}

  /**
   * Feed a keystroke (canonical stroke string) and the set of active bindings.
   * Returns the commands to execute (may be 0 or 1 items), and whether a chord
   * is still in progress.
   */
  advance(
    stroke: string,
    bindings: Binding[],
  ): { execute: DispatchCandidate[]; inProgress: boolean } {
    this._clearTimeout();
    this._pending.push(stroke);
    const candidate = this._pending.join(" ");

    // Find exact matches.
    const exactMatches = bindings.filter((b) => b.chord === candidate);
    // Find prefix matches (candidate is a prefix of some binding).
    const prefixMatches = bindings.filter(
      (b) => b.chord !== candidate && b.chord.startsWith(candidate + " "),
    );

    if (exactMatches.length > 0 && prefixMatches.length === 0) {
      // Unambiguous match — execute and reset.
      this.reset();
      return {
        execute: exactMatches.map((b) => ({ commandId: b.commandId, chord: b.chord })),
        inProgress: false,
      };
    }

    if (exactMatches.length === 0 && prefixMatches.length === 0) {
      // No match at all — reset.
      this.reset();
      return { execute: [], inProgress: false };
    }

    // Ambiguous (exact + prefix, or prefix only) — wait for next stroke.
    this._timeoutId = setTimeout(() => {
      this.reset();
      this._onTimeout();
    }, CHORD_TIMEOUT_MS);

    return { execute: [], inProgress: true };
  }

  reset(): void {
    this._clearTimeout();
    this._pending = [];
  }

  get pending(): string[] {
    return [...this._pending];
  }

  private _clearTimeout(): void {
    if (this._timeoutId !== null) {
      clearTimeout(this._timeoutId);
      this._timeoutId = null;
    }
  }
}

// ── User binding store (settings-backed) ──────────────────────────────────────

/**
 * User-defined binding overrides. Keys are command ids; values are arrays of
 * canonical chord strings. Storing here supersedes (does not merge with) the
 * command's defaultBindings.
 *
 * Persistence is via the settings store (see settings.ts). This module is
 * stateless — callers maintain the map.
 */
export type UserBindings = Map<string, string[]>;

/**
 * Resolve effective bindings for a command: user overrides take precedence;
 * if no user override exists, fall back to the command's defaultBindings.
 */
export function resolveBindings(
  commandId: string,
  defaultBindings: readonly string[],
  userBindings: UserBindings,
): string[] {
  const user = userBindings.get(commandId);
  if (user !== undefined) return user;
  return [...defaultBindings];
}

/**
 * Build the flat list of Binding objects from all registered commands and user
 * overrides. Used by the dispatch engine to find matches for a keystroke.
 */
export function buildBindingList(
  commands: Array<{ id: string; defaultBindings: readonly string[]; when: WhenContext }>,
  userBindings: UserBindings,
): Binding[] {
  const result: Binding[] = [];
  for (const cmd of commands) {
    const chords = resolveBindings(cmd.id, cmd.defaultBindings, userBindings);
    for (const rawChord of chords) {
      const canonical = normalizeChord(rawChord);
      if (canonical) {
        result.push({ commandId: cmd.id, chord: canonical, when: cmd.when });
      }
    }
  }
  return result;
}
