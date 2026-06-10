import { describe, it, expect } from "vitest";
import { tagDisplayData, personDisplayData } from "../chip-popover-utils.js";
import type { TagMeta, PersonMeta } from "../../ipc/types.js";

// ── tagDisplayData ─────────────────────────────────────────────────────────────

describe("tagDisplayData", () => {
  it("formats name with # prefix", () => {
    const meta: TagMeta = { name: "design", color: "blue", count: 4 };
    const d = tagDisplayData(meta, "design");
    expect(d.displayName).toBe("#design");
  });

  it("prepends icon when present", () => {
    const meta: TagMeta = { name: "idea", color: "amber", count: 1, icon: "💡" };
    const d = tagDisplayData(meta, "idea");
    expect(d.displayName).toBe("💡 #idea");
  });

  it("uses fallback value when meta is null", () => {
    const d = tagDisplayData(null, "someTag");
    expect(d.displayName).toBe("#someTag");
  });

  it("uses fallback value when meta is undefined", () => {
    const d = tagDisplayData(undefined, "otherTag");
    expect(d.displayName).toBe("#otherTag");
  });

  it("exposes description from meta", () => {
    const meta: TagMeta = {
      name: "project",
      color: "green",
      count: 7,
      description: "Active project",
    };
    const d = tagDisplayData(meta, "project");
    expect(d.description).toBe("Active project");
  });

  it("description is undefined when not set", () => {
    const meta: TagMeta = { name: "misc", color: "slate", count: 0 };
    const d = tagDisplayData(meta, "misc");
    expect(d.description).toBeUndefined();
  });

  it("exposes count from meta", () => {
    const meta: TagMeta = { name: "todo", color: "red", count: 42 };
    const d = tagDisplayData(meta, "todo");
    expect(d.count).toBe(42);
  });

  it("count is undefined when meta is null", () => {
    const d = tagDisplayData(null, "x");
    expect(d.count).toBeUndefined();
  });
});

// ── personDisplayData ──────────────────────────────────────────────────────────

describe("personDisplayData", () => {
  it("uses displayName from meta", () => {
    const meta: PersonMeta = { slug: "alice", displayName: "Alice Smith", count: 3 };
    const d = personDisplayData(meta, "alice");
    expect(d.displayName).toBe("Alice Smith");
  });

  it("falls back to @slug when meta is null", () => {
    const d = personDisplayData(null, "bob");
    expect(d.displayName).toBe("@bob");
  });

  it("falls back to @slug when meta is undefined", () => {
    const d = personDisplayData(undefined, "carol");
    expect(d.displayName).toBe("@carol");
  });

  it("falls back when displayName is empty-ish (undefined meta)", () => {
    const d = personDisplayData(null, "dave");
    expect(d.displayName).toMatch(/^@/);
  });

  it("exposes description from meta", () => {
    const meta: PersonMeta = { slug: "eve", displayName: "Eve", count: 1, description: "Lead dev" };
    const d = personDisplayData(meta, "eve");
    expect(d.description).toBe("Lead dev");
  });

  it("description is undefined when not set", () => {
    const meta: PersonMeta = { slug: "frank", displayName: "Frank", count: 0 };
    const d = personDisplayData(meta, "frank");
    expect(d.description).toBeUndefined();
  });

  it("exposes count from meta", () => {
    const meta: PersonMeta = { slug: "grace", displayName: "Grace", count: 12 };
    const d = personDisplayData(meta, "grace");
    expect(d.count).toBe(12);
  });
});
