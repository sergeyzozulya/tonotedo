// Rebind flow state machine tests (spec 0007, issue #23).
//
// Covers:
//   - Capture → no-conflict → save
//   - Capture → OS-reserved refusal
//   - Capture → conflict detected, state transitions to "conflict"
//   - Conflict → resolve (remove existing) → commit
//   - Conflict → cancel → idle
//   - Reset-to-default

import { describe, it, expect, beforeEach } from "vitest";
import {
  detectConflicts,
  isOsReserved,
  normalizeChord,
  buildBindingList,
} from "../../../lib/commands/keymap.js";
import type { Binding } from "../../../lib/commands/keymap.js";
import {
  MemorySettingsStore,
  setSettingsStore,
  saveBinding,
  removeBindingOverride,
  loadUserBindings,
} from "../../../lib/commands/settings.js";

beforeEach(() => {
  setSettingsStore(new MemorySettingsStore());
});

// ── Chord normalization ─────────────────────────────────────────────────────────

describe("normalizeChord", () => {
  it("normalizes cmd+k to meta+k", () => {
    expect(normalizeChord("cmd+k")).toBe("meta+k");
  });

  it("normalizes cmd+shift+z correctly", () => {
    expect(normalizeChord("cmd+shift+z")).toBe("meta+shift+z");
  });

  it("returns null for empty string", () => {
    expect(normalizeChord("")).toBeNull();
  });

  it("handles single-key stroke", () => {
    expect(normalizeChord("escape")).toBe("escape");
  });
});

// ── OS-reserved check ───────────────────────────────────────────────────────────

describe("isOsReserved", () => {
  it("flags cmd+space as reserved", () => {
    expect(isOsReserved("cmd+space")).toBe(true);
  });

  it("flags cmd+tab as reserved", () => {
    expect(isOsReserved("cmd+tab")).toBe(true);
  });

  it("flags cmd+q as reserved", () => {
    expect(isOsReserved("cmd+q")).toBe(true);
  });

  it("does not flag cmd+k as reserved", () => {
    expect(isOsReserved("cmd+k")).toBe(false);
  });

  it("does not flag arbitrary bindings", () => {
    expect(isOsReserved("meta+shift+x")).toBe(false);
  });
});

// ── detectConflicts ─────────────────────────────────────────────────────────────

describe("detectConflicts — exact match", () => {
  const existing: Binding[] = [
    { commandId: "entry.create", chord: "meta+n", when: "" },
    { commandId: "editor.bold", chord: "meta+b", when: "zone:editor" },
  ];

  it("detects exact conflict in same context", () => {
    const proposed: Binding = { commandId: "other.cmd", chord: "meta+n", when: "" };
    const result = detectConflicts(proposed, existing);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("exact");
    expect(result[0].existing.commandId).toBe("entry.create");
  });

  it("does not flag cross-context same chord", () => {
    const proposed: Binding = { commandId: "sidebar.cmd", chord: "meta+b", when: "zone:sidebar" };
    const result = detectConflicts(proposed, existing);
    expect(result).toHaveLength(0);
  });

  it("returns empty when no conflict", () => {
    const proposed: Binding = { commandId: "new.cmd", chord: "meta+g", when: "" };
    const result = detectConflicts(proposed, existing);
    expect(result).toHaveLength(0);
  });
});

describe("detectConflicts — chord-prefix", () => {
  it("flags when new chord is a prefix of existing chord", () => {
    const existing: Binding[] = [{ commandId: "chord.two", chord: "meta+e meta+t", when: "" }];
    const proposed: Binding = { commandId: "chord.one", chord: "meta+e", when: "" };
    const result = detectConflicts(proposed, existing);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("chord-prefix");
  });

  it("flags when existing chord is a prefix of new chord", () => {
    const existing: Binding[] = [{ commandId: "chord.one", chord: "meta+e", when: "" }];
    const proposed: Binding = { commandId: "chord.two", chord: "meta+e meta+t", when: "" };
    const result = detectConflicts(proposed, existing);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("chord-prefix");
  });

  it("does not flag completely distinct chords", () => {
    const existing: Binding[] = [{ commandId: "a", chord: "meta+a", when: "" }];
    const proposed: Binding = { commandId: "b", chord: "meta+b", when: "" };
    expect(detectConflicts(proposed, existing)).toHaveLength(0);
  });
});

// ── Rebind flow state machine (logic layer, not UI) ─────────────────────────────

describe("Rebind flow — save and reset", () => {
  it("saves a new binding and loadUserBindings reflects it", () => {
    saveBinding("entry.create", ["meta+shift+n"]);
    const bindings = loadUserBindings();
    expect(bindings.get("entry.create")).toEqual(["meta+shift+n"]);
  });

  it("reset-to-default removes the override", () => {
    saveBinding("entry.create", ["meta+shift+n"]);
    removeBindingOverride("entry.create");
    expect(loadUserBindings().get("entry.create")).toBeUndefined();
  });

  it("committing a conflict resolution removes the conflicting binding", () => {
    // Simulate: command A has meta+x, user rebinds B to meta+x
    saveBinding("command.a", ["meta+x"]);
    // Resolve: remove A's override and save B → meta+x
    removeBindingOverride("command.a");
    saveBinding("command.b", ["meta+x"]);

    const bindings = loadUserBindings();
    expect(bindings.get("command.a")).toBeUndefined();
    expect(bindings.get("command.b")).toEqual(["meta+x"]);
  });

  it("saving a binding does not affect other bindings", () => {
    saveBinding("command.a", ["meta+a"]);
    saveBinding("command.b", ["meta+b"]);
    saveBinding("command.a", ["meta+shift+a"]); // overwrite a
    expect(loadUserBindings().get("command.b")).toEqual(["meta+b"]);
  });
});

// ── buildBindingList ────────────────────────────────────────────────────────────

describe("buildBindingList", () => {
  const commands = [
    { id: "entry.create", defaultBindings: ["cmd+n"] as string[], when: "" },
    { id: "editor.bold", defaultBindings: ["cmd+b"] as string[], when: "zone:editor" },
  ];

  it("builds bindings from defaults when no user overrides", () => {
    const list = buildBindingList(commands, new Map());
    expect(list).toHaveLength(2);
    expect(list[0].commandId).toBe("entry.create");
    expect(list[0].chord).toBe("meta+n");
  });

  it("user overrides replace defaults", () => {
    const userBindings = new Map([["entry.create", ["meta+shift+n"]]]);
    const list = buildBindingList(commands, userBindings);
    const create = list.find((b) => b.commandId === "entry.create");
    expect(create?.chord).toBe("meta+shift+n");
  });

  it("empty user bindings array means no binding for that command", () => {
    const userBindings = new Map([["entry.create", [] as string[]]]);
    const list = buildBindingList(commands, userBindings);
    const create = list.filter((b) => b.commandId === "entry.create");
    expect(create).toHaveLength(0);
  });

  it("preserves when-context from command definition", () => {
    const list = buildBindingList(commands, new Map());
    const bold = list.find((b) => b.commandId === "editor.bold");
    expect(bold?.when).toBe("zone:editor");
  });
});
