// Regression tests for keystroke normalization (spec 0007 §Cheatsheet).
//
// The "?" key (Shift+/ on a US layout) emits e.key "?" with shiftKey true.
// For the cheatsheet acceptance criterion — "? in the editor types a literal
// question mark; the cheatsheet there is cmd+?" — the normalization must:
//   - produce a bare "?" stroke for a plain "?" press (so it matches the
//     non-text-zone "?" binding and the text-zone literal-type guard), NOT
//     "shift+?" (which would match neither).
//   - produce "meta+shift+/" for cmd+? (== shift+cmd+/, the platform Help
//     convention) so it matches the cheatsheet binding stored on disk.

import { describe, it, expect } from "vitest";
import { eventToStroke, type StrokeEvent } from "../keymap-action.js";

function ev(key: string, mods: Partial<StrokeEvent> = {}): StrokeEvent {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  };
}

describe("eventToStroke — shifted punctuation", () => {
  it("a plain '?' press normalizes to a bare '?' (not 'shift+?')", () => {
    expect(eventToStroke(ev("?", { shiftKey: true }))).toBe("?");
  });

  it("cmd+? normalizes to meta+shift+/ (matches the cheatsheet binding)", () => {
    expect(eventToStroke(ev("?", { shiftKey: true, metaKey: true }))).toBe("meta+shift+/");
  });

  it("a plain ':' press normalizes to a bare ':'", () => {
    expect(eventToStroke(ev(":", { shiftKey: true }))).toBe(":");
  });
});

describe("eventToStroke — letters and digits keep shift", () => {
  it("shift+a stays shift+a", () => {
    // Browsers send e.key "A" for shift+a; we lowercase the key.
    expect(eventToStroke(ev("A", { shiftKey: true }))).toBe("shift+a");
  });

  it("plain letter has no modifiers", () => {
    expect(eventToStroke(ev("a"))).toBe("a");
  });

  it("cmd+s normalizes to meta+s", () => {
    expect(eventToStroke(ev("s", { metaKey: true }))).toBe("meta+s");
  });
});

describe("eventToStroke — non-bindable", () => {
  it("bare modifier presses return null", () => {
    expect(eventToStroke(ev("Shift", { shiftKey: true }))).toBeNull();
    expect(eventToStroke(ev("Meta", { metaKey: true }))).toBeNull();
  });
});
