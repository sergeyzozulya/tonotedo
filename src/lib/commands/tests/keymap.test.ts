import { describe, it, expect } from "vitest";
import {
  parseStroke,
  parseChord,
  normalizeChord,
  isOsReserved,
  detectConflicts,
  ChordStateMachine,
  buildBindingList,
  resolveBindings,
  type Binding,
} from "../keymap.js";

// ── parseStroke ────────────────────────────────────────────────────────────────

describe("parseStroke — basic parsing", () => {
  it("parses a simple keystroke", () => {
    const s = parseStroke("cmd+k");
    expect(s).not.toBeNull();
    expect(s!.key).toBe("k");
    expect(s!.modifiers).toEqual(["meta"]);
    expect(s!.canonical).toBe("meta+k");
  });

  it("normalizes cmd alias to meta", () => {
    expect(parseStroke("cmd+k")!.canonical).toBe("meta+k");
  });

  it("normalizes ctrl alias", () => {
    expect(parseStroke("ctl+z")!.canonical).toBe("ctrl+z");
  });

  it("normalizes option alias to alt", () => {
    expect(parseStroke("option+f")!.canonical).toBe("alt+f");
  });

  it("handles uppercase input", () => {
    expect(parseStroke("CMD+K")!.canonical).toBe("meta+k");
  });

  it("orders modifiers: meta > ctrl > alt > shift", () => {
    expect(parseStroke("shift+cmd+k")!.canonical).toBe("meta+shift+k");
  });

  it("handles shift+cmd+z (redo)", () => {
    expect(parseStroke("cmd+shift+z")!.canonical).toBe("meta+shift+z");
  });

  it("handles bare key (no modifier)", () => {
    const s = parseStroke("enter");
    expect(s!.key).toBe("enter");
    expect(s!.modifiers).toEqual([]);
    expect(s!.canonical).toBe("enter");
  });

  it("handles ? key", () => {
    const s = parseStroke("?");
    expect(s!.canonical).toBe("?");
  });

  it("returns null for empty string", () => {
    expect(parseStroke("")).toBeNull();
  });

  it("returns null for multiple non-modifier keys", () => {
    expect(parseStroke("a+b")).toBeNull();
  });

  it("returns null for modifier-only (no key)", () => {
    expect(parseStroke("cmd")).toBeNull();
  });

  it("returns null for null-like input", () => {
    expect(parseStroke(null as unknown as string)).toBeNull();
  });
});

// ── parseChord ─────────────────────────────────────────────────────────────────

describe("parseChord — multi-stroke chords", () => {
  it("parses single stroke chord", () => {
    const c = parseChord("cmd+k");
    expect(c).not.toBeNull();
    expect(c!.strokes).toHaveLength(1);
    expect(c!.canonical).toBe("meta+k");
  });

  it("parses two-stroke chord", () => {
    const c = parseChord("cmd+e cmd+t");
    expect(c).not.toBeNull();
    expect(c!.strokes).toHaveLength(2);
    expect(c!.canonical).toBe("meta+e meta+t");
  });

  it("parses three-stroke chord", () => {
    const c = parseChord("ctrl+x ctrl+n ctrl+e");
    expect(c!.strokes).toHaveLength(3);
    expect(c!.canonical).toBe("ctrl+x ctrl+n ctrl+e");
  });

  it("returns null when any stroke is malformed", () => {
    expect(parseChord("cmd+e bad+stroke")).toBeNull();
  });

  it("normalizes each stroke", () => {
    expect(parseChord("CMD+K")!.canonical).toBe("meta+k");
  });
});

// ── normalizeChord ─────────────────────────────────────────────────────────────

describe("normalizeChord", () => {
  it("normalizes a chord string", () => {
    expect(normalizeChord("cmd+shift+k")).toBe("meta+shift+k");
  });

  it("normalizes a multi-stroke chord", () => {
    expect(normalizeChord("ctrl+x ctrl+s")).toBe("ctrl+x ctrl+s");
  });

  it("returns null for malformed chord (multiple non-modifier keys in one stroke)", () => {
    // "a+b" in a single stroke: two non-modifier keys → malformed stroke
    expect(normalizeChord("a+b")).toBeNull();
  });
});

// ── isOsReserved ───────────────────────────────────────────────────────────────

describe("isOsReserved", () => {
  it("refuses cmd+space (Spotlight)", () => {
    expect(isOsReserved("cmd+space")).toBe(true);
  });

  it("refuses cmd+tab (app switcher)", () => {
    expect(isOsReserved("cmd+tab")).toBe(true);
  });

  it("refuses cmd+q (quit)", () => {
    expect(isOsReserved("cmd+q")).toBe(true);
  });

  it("allows cmd+k (palette)", () => {
    expect(isOsReserved("cmd+k")).toBe(false);
  });

  it("allows arbitrary app shortcut", () => {
    expect(isOsReserved("cmd+shift+n")).toBe(false);
  });

  it("blocks chord whose first stroke is reserved", () => {
    // cmd+space cmd+something — first stroke consumed by OS
    expect(isOsReserved("cmd+space cmd+k")).toBe(true);
  });

  it("allows chord whose first stroke is not reserved", () => {
    expect(isOsReserved("cmd+k cmd+t")).toBe(false);
  });
});

// ── detectConflicts ────────────────────────────────────────────────────────────

describe("detectConflicts — exact conflicts", () => {
  const existing: Binding[] = [{ commandId: "entry.create", chord: "meta+n", when: "" }];

  it("detects exact binding conflict in same context", () => {
    const proposed: Binding = { commandId: "editor.new-file", chord: "meta+n", when: "" };
    const conflicts = detectConflicts(proposed, existing);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("exact");
    expect(conflicts[0].existing.commandId).toBe("entry.create");
  });

  it("no conflict for different context (cross-context ok)", () => {
    const proposed: Binding = { commandId: "other.cmd", chord: "meta+n", when: "zone:editor" };
    const conflicts = detectConflicts(proposed, existing);
    expect(conflicts).toHaveLength(0);
  });

  it("no conflict for different chord same context", () => {
    const proposed: Binding = { commandId: "other.cmd", chord: "meta+m", when: "" };
    expect(detectConflicts(proposed, existing)).toHaveLength(0);
  });
});

describe("detectConflicts — chord-prefix rule", () => {
  it("prefix conflict: existing is prefix of proposed", () => {
    const existing: Binding[] = [{ commandId: "editor.code", chord: "meta+e", when: "" }];
    const proposed: Binding = { commandId: "editor.code-block", chord: "meta+e meta+b", when: "" };
    const conflicts = detectConflicts(proposed, existing);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("chord-prefix");
  });

  it("prefix conflict: proposed is prefix of existing", () => {
    const existing: Binding[] = [
      { commandId: "editor.code-block", chord: "meta+e meta+b", when: "" },
    ];
    const proposed: Binding = { commandId: "editor.code", chord: "meta+e", when: "" };
    const conflicts = detectConflicts(proposed, existing);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("chord-prefix");
  });

  it("no prefix conflict across contexts", () => {
    const existing: Binding[] = [
      { commandId: "editor.code", chord: "meta+e", when: "zone:editor" },
    ];
    const proposed: Binding = {
      commandId: "entry.code",
      chord: "meta+e meta+b",
      when: "zone:sidebar",
    };
    expect(detectConflicts(proposed, existing)).toHaveLength(0);
  });

  it("no conflict when chords share only partial prefix but differ", () => {
    const existing: Binding[] = [{ commandId: "a", chord: "meta+e ctrl+k", when: "" }];
    const proposed: Binding = { commandId: "b", chord: "meta+e ctrl+j", when: "" };
    // Neither is a prefix of the other.
    expect(detectConflicts(proposed, existing)).toHaveLength(0);
  });
});

// ── ChordStateMachine ──────────────────────────────────────────────────────────

describe("ChordStateMachine — single stroke dispatch", () => {
  it("executes a single-stroke match", () => {
    const bindings: Binding[] = [{ commandId: "entry.create", chord: "meta+n", when: "" }];
    const machine = new ChordStateMachine();
    const result = machine.advance("meta+n", bindings);
    expect(result.inProgress).toBe(false);
    expect(result.execute).toHaveLength(1);
    expect(result.execute[0].commandId).toBe("entry.create");
  });

  it("returns empty execute on no match", () => {
    const bindings: Binding[] = [{ commandId: "entry.create", chord: "meta+n", when: "" }];
    const machine = new ChordStateMachine();
    const result = machine.advance("meta+x", bindings);
    expect(result.inProgress).toBe(false);
    expect(result.execute).toHaveLength(0);
  });
});

describe("ChordStateMachine — multi-stroke chords", () => {
  it("enters in-progress state after first stroke of chord", () => {
    const bindings: Binding[] = [{ commandId: "entry.create", chord: "meta+e meta+n", when: "" }];
    const machine = new ChordStateMachine();
    const r1 = machine.advance("meta+e", bindings);
    expect(r1.inProgress).toBe(true);
    expect(r1.execute).toHaveLength(0);
  });

  it("executes after completing multi-stroke chord", () => {
    const bindings: Binding[] = [{ commandId: "entry.create", chord: "meta+e meta+n", when: "" }];
    const machine = new ChordStateMachine();
    machine.advance("meta+e", bindings);
    const r2 = machine.advance("meta+n", bindings);
    expect(r2.inProgress).toBe(false);
    expect(r2.execute[0].commandId).toBe("entry.create");
  });

  it("resets after no match in chord sequence", () => {
    const bindings: Binding[] = [{ commandId: "entry.create", chord: "meta+e meta+n", when: "" }];
    const machine = new ChordStateMachine();
    machine.advance("meta+e", bindings);
    const r2 = machine.advance("meta+x", bindings); // wrong second stroke
    expect(r2.inProgress).toBe(false);
    expect(r2.execute).toHaveLength(0);
    // After reset, a fresh single-stroke should work.
  });

  it("exact match wins over prefix match on exact-only stroke", () => {
    // "meta+e" is exact; "meta+e meta+b" is a chord starting with "meta+e".
    // After hitting "meta+e", we are in-progress.
    const bindings: Binding[] = [
      { commandId: "code-inline", chord: "meta+e", when: "" },
      { commandId: "code-block", chord: "meta+e meta+b", when: "" },
    ];
    const machine = new ChordStateMachine();
    const r1 = machine.advance("meta+e", bindings);
    // Both exact and prefix match → stay in progress for disambiguation.
    expect(r1.inProgress).toBe(true);
  });

  it("reset() clears pending state", () => {
    const bindings: Binding[] = [{ commandId: "a", chord: "meta+e meta+n", when: "" }];
    const machine = new ChordStateMachine();
    machine.advance("meta+e", bindings);
    expect(machine.pending).toHaveLength(1);
    machine.reset();
    expect(machine.pending).toHaveLength(0);
  });
});

// ── resolveBindings ────────────────────────────────────────────────────────────

describe("resolveBindings", () => {
  it("returns command defaults when no user override", () => {
    const result = resolveBindings("entry.create", ["meta+n"], new Map());
    expect(result).toEqual(["meta+n"]);
  });

  it("returns user bindings when present", () => {
    const userBindings = new Map([["entry.create", ["meta+shift+n"]]]);
    const result = resolveBindings("entry.create", ["meta+n"], userBindings);
    expect(result).toEqual(["meta+shift+n"]);
  });

  it("returns empty array when user explicitly clears bindings", () => {
    const userBindings = new Map([["entry.create", []]]);
    const result = resolveBindings("entry.create", ["meta+n"], userBindings);
    expect(result).toEqual([]);
  });
});

// ── buildBindingList ───────────────────────────────────────────────────────────

describe("buildBindingList", () => {
  it("builds canonical binding list from commands", () => {
    const commands = [
      { id: "entry.create", defaultBindings: ["cmd+n"], when: "" },
      { id: "editor.bold", defaultBindings: ["cmd+b"], when: "zone:editor" },
    ];
    const list = buildBindingList(commands, new Map());
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({ commandId: "entry.create", chord: "meta+n", when: "" });
    expect(list[1]).toEqual({ commandId: "editor.bold", chord: "meta+b", when: "zone:editor" });
  });

  it("applies user overrides", () => {
    const commands = [{ id: "entry.create", defaultBindings: ["cmd+n"], when: "" }];
    const userBindings = new Map([["entry.create", ["cmd+shift+n"]]]);
    const list = buildBindingList(commands, userBindings);
    expect(list[0].chord).toBe("meta+shift+n");
  });

  it("skips commands with no bindings", () => {
    const commands = [{ id: "bench.open", defaultBindings: [], when: "" }];
    const list = buildBindingList(commands, new Map());
    expect(list).toHaveLength(0);
  });

  it("normalizes all chord strings", () => {
    const commands = [{ id: "x", defaultBindings: ["CMD+SHIFT+K"], when: "" }];
    const list = buildBindingList(commands, new Map());
    expect(list[0].chord).toBe("meta+shift+k");
  });
});
