import { describe, it, expect, beforeEach } from "vitest";
import { CommandRegistry } from "../registry-test-helper.js";
import type { Command } from "../registry.js";

// We test a fresh CommandRegistry instance to avoid cross-test pollution.
// The singleton `registry` is tested via integration.

const makeCmd = (id: string, overrides: Partial<Command> = {}): Command => ({
  id,
  name: `Command ${id}`,
  description: `Does ${id}`,
  category: "App",
  defaultBindings: [],
  when: "",
  handler: () => {},
  ...overrides,
});

let reg: CommandRegistry;

beforeEach(() => {
  // Create a fresh registry per test via the test helper export.
  reg = new CommandRegistry();
});

describe("CommandRegistry — register / get / unregister", () => {
  it("registers a command and retrieves it by id", () => {
    const cmd = makeCmd("test.action");
    reg.register(cmd);
    expect(reg.get("test.action")).toBe(cmd);
  });

  it("replaces an existing command on re-register", () => {
    reg.register(makeCmd("test.action", { name: "Old" }));
    reg.register(makeCmd("test.action", { name: "New" }));
    expect(reg.get("test.action")!.name).toBe("New");
  });

  it("returns undefined for unknown id", () => {
    expect(reg.get("does.not.exist")).toBeUndefined();
  });

  it("unregisters a command", () => {
    reg.register(makeCmd("test.action"));
    reg.unregister("test.action");
    expect(reg.get("test.action")).toBeUndefined();
  });

  it("unregister on unknown id is a no-op", () => {
    expect(() => reg.unregister("nonexistent")).not.toThrow();
  });
});

describe("CommandRegistry — all()", () => {
  it("returns empty array when no commands registered", () => {
    expect(reg.all()).toHaveLength(0);
  });

  it("returns all registered commands", () => {
    reg.register(makeCmd("a"));
    reg.register(makeCmd("b"));
    reg.register(makeCmd("c"));
    expect(reg.all()).toHaveLength(3);
  });

  it("preserves insertion order", () => {
    reg.register(makeCmd("first"));
    reg.register(makeCmd("second"));
    const ids = reg.all().map((c) => c.id);
    expect(ids).toEqual(["first", "second"]);
  });
});

describe("CommandRegistry — query()", () => {
  beforeEach(() => {
    reg.register(makeCmd("entry.create", { name: "New Entry", description: "Create an entry" }));
    reg.register(makeCmd("entry.delete", { name: "Delete Entry", description: "Remove an entry" }));
    reg.register(makeCmd("editor.bold", { name: "Bold", description: "Make text bold" }));
  });

  it("empty query returns all commands", () => {
    expect(reg.query("")).toHaveLength(3);
  });

  it("matches by name (case-insensitive)", () => {
    const results = reg.query("entry");
    expect(results).toHaveLength(2);
  });

  it("matches by description", () => {
    const results = reg.query("bold");
    expect(results.map((c) => c.id)).toContain("editor.bold");
  });

  it("matches by id", () => {
    const results = reg.query("editor.bold");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("editor.bold");
  });

  it("returns empty for no matches", () => {
    expect(reg.query("xyzzy")).toHaveLength(0);
  });
});

describe("CommandRegistry — forContext()", () => {
  beforeEach(() => {
    reg.register(makeCmd("global.cmd", { when: "" }));
    reg.register(makeCmd("editor.cmd", { when: "zone:editor" }));
    reg.register(makeCmd("sidebar.cmd", { when: "zone:sidebar" }));
  });

  it("returns global + matching context commands", () => {
    const cmds = reg.forContext("zone:editor");
    const ids = cmds.map((c) => c.id);
    expect(ids).toContain("global.cmd");
    expect(ids).toContain("editor.cmd");
    expect(ids).not.toContain("sidebar.cmd");
  });

  it("returns only global commands when context has no zone commands", () => {
    const cmds = reg.forContext("zone:calendar");
    expect(cmds.map((c) => c.id)).toEqual(["global.cmd"]);
  });
});
