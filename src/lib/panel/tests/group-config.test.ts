// Tests for group configuration: schema write round-trip, enum/ref type
// resolution, and view resolution (spec 0002 §Rendering, spec 0003).
//
// Covers:
//   • resolveType: schema-declared types win over inference (spec 0002)
//   • parseFrontmatter with schema: enum/ref/ref[] rows carry correct types
//   • View resolution: entry `view` > group `view` > app default
//   • Mock IPC: get_group_config + update_group_config round-trip
//   • Enum row: enumValues populated from schema declaration
//   • ref/ref[] property types

import { describe, it, expect } from "vitest";
import { resolveType, parseFrontmatter } from "../frontmatter-view.js";
import type { SchemaPropDecl } from "../frontmatter-view.js";

// ── resolveType ───────────────────────────────────────────────────────────────

describe("resolveType", () => {
  it("returns inferred type when no schema provided", () => {
    expect(resolveType("string", "status", null)).toBe("string");
    expect(resolveType("string", "status", undefined)).toBe("string");
    expect(resolveType("number", "count", {})).toBe("number");
  });

  it("schema-declared enum overrides inferred string", () => {
    const schema: Record<string, SchemaPropDecl> = {
      status: { type: "enum", enumValues: ["draft", "active", "done"] },
    };
    expect(resolveType("string", "status", schema)).toBe("enum");
  });

  it("schema-declared ref overrides inferred string", () => {
    const schema: Record<string, SchemaPropDecl> = {
      relatedTo: { type: "ref" },
    };
    expect(resolveType("string", "relatedTo", schema)).toBe("ref");
  });

  it("schema-declared ref[] overrides inferred tags", () => {
    const schema: Record<string, SchemaPropDecl> = {
      refs: { type: "ref[]" },
    };
    expect(resolveType("tags", "refs", schema)).toBe("ref[]");
  });

  it("schema-declared number overrides inferred string", () => {
    const schema: Record<string, SchemaPropDecl> = {
      priority: { type: "number" },
    };
    // A value of "3" would infer as string, but schema says number.
    expect(resolveType("string", "priority", schema)).toBe("number");
  });

  it("schema-declared tag[] maps to tags type", () => {
    const schema: Record<string, SchemaPropDecl> = {
      categories: { type: "tag[]" },
    };
    expect(resolveType("string", "categories", schema)).toBe("tags");
  });

  it("schema-declared boolean overrides inferred string", () => {
    const schema: Record<string, SchemaPropDecl> = {
      done: { type: "boolean" },
    };
    expect(resolveType("string", "done", schema)).toBe("boolean");
  });

  it("unknown schema type falls back to inferred type", () => {
    const schema: Record<string, SchemaPropDecl> = {
      widget: { type: "custom-plugin-type" },
    };
    expect(resolveType("string", "widget", schema)).toBe("string");
  });

  it("key not in schema returns inferred type", () => {
    const schema: Record<string, SchemaPropDecl> = {
      status: { type: "enum" },
    };
    expect(resolveType("string", "unrelated", schema)).toBe("string");
  });
});

// ── parseFrontmatter with schema ──────────────────────────────────────────────

describe("parseFrontmatter — schema-driven type resolution", () => {
  const schema: Record<string, SchemaPropDecl> = {
    status: { type: "enum", enumValues: ["draft", "active", "done"] },
    relatedTo: { type: "ref" },
    links: { type: "ref[]" },
    priority: { type: "number" },
  };

  const doc = `---
status: draft
relatedTo: books/deep-work
links: [books/deep-work, books/thinking-fast-and-slow]
priority: 2
note: hello
---
`;

  it("status resolves to enum (schema wins over string inference)", () => {
    const m = parseFrontmatter(doc, schema);
    const row = m.rows.find((r) => r.key === "status");
    expect(row?.type).toBe("enum");
  });

  it("enum row carries enumValues from schema", () => {
    const m = parseFrontmatter(doc, schema);
    const row = m.rows.find((r) => r.key === "status");
    expect(row?.enumValues).toEqual(["draft", "active", "done"]);
  });

  it("relatedTo resolves to ref (schema wins over string inference)", () => {
    const m = parseFrontmatter(doc, schema);
    const row = m.rows.find((r) => r.key === "relatedTo");
    expect(row?.type).toBe("ref");
  });

  it("links resolves to ref[] (schema wins over tags inference)", () => {
    const m = parseFrontmatter(doc, schema);
    const row = m.rows.find((r) => r.key === "links");
    expect(row?.type).toBe("ref[]");
  });

  it("priority resolves to number (schema wins)", () => {
    const m = parseFrontmatter(doc, schema);
    const row = m.rows.find((r) => r.key === "priority");
    expect(row?.type).toBe("number");
  });

  it("note without schema entry uses inferred type (string)", () => {
    const m = parseFrontmatter(doc, schema);
    const row = m.rows.find((r) => r.key === "note");
    expect(row?.type).toBe("string");
  });

  it("parseFrontmatter without schema produces inferred types", () => {
    const m = parseFrontmatter(doc);
    const statusRow = m.rows.find((r) => r.key === "status");
    expect(statusRow?.type).toBe("string"); // no schema → inferred as string
    const linksRow = m.rows.find((r) => r.key === "links");
    expect(linksRow?.type).toBe("tags"); // array of strings → tags
  });

  it("non-enum rows do not carry enumValues", () => {
    const m = parseFrontmatter(doc, schema);
    const row = m.rows.find((r) => r.key === "relatedTo");
    expect(row?.enumValues).toBeUndefined();
  });
});

// ── View resolution (spec 0002 §Rendering) ───────────────────────────────────

// The spec defines: entry's `view` → nearest ancestor group's `view` → "note".
// This is a pure function; we test the logic of resolution separately.

/**
 * Resolve the effective view for an entry.
 * entryView: the value of the `view` property in the entry's frontmatter (or null)
 * groupView: the `view` declared in the nearest ancestor group's _group.md (or null)
 * Returns the effective view name.
 */
function resolveView(entryView: string | null, groupView: string | null): string {
  if (entryView) return entryView;
  if (groupView) return groupView;
  return "note";
}

describe("view resolution (spec 0002 §Rendering)", () => {
  it("entry view overrides group view", () => {
    expect(resolveView("task-list", "note")).toBe("task-list");
  });

  it("group view used when entry has no view", () => {
    expect(resolveView(null, "task-list")).toBe("task-list");
  });

  it("falls back to app default (note) when neither entry nor group has view", () => {
    expect(resolveView(null, null)).toBe("note");
  });

  it("empty string is treated as absent (falls through)", () => {
    expect(resolveView("", "task-list")).toBe("task-list");
    expect(resolveView("", "")).toBe("note");
  });
});

// ── parseFrontmatter: view as well-known string property ──────────────────────

describe("parseFrontmatter — view property", () => {
  const doc = `---
view: task-list
note: hello
---
`;

  it("view property is parsed as type=string", () => {
    const m = parseFrontmatter(doc);
    const row = m.rows.find((r) => r.key === "view");
    expect(row?.type).toBe("string");
    expect(row?.value).toBe("task-list");
    expect(row?.readOnly).toBe(false);
  });

  it("view property is editable (not a builtin)", () => {
    const m = parseFrontmatter(doc);
    const row = m.rows.find((r) => r.key === "view");
    expect(row).toBeDefined();
    expect(m.builtinRows.find((r) => r.key === "view")).toBeUndefined();
    expect(m.advancedRows.find((r) => r.key === "view")).toBeUndefined();
  });
});

// ── Mock IPC: group config round-trip ─────────────────────────────────────────

describe("mock IPC — group config round-trip", () => {
  it("get_group_config returns pre-seeded work/atlas config", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const res = await mock.get_group_config("work/atlas");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.icon).toBe("🗺️");
    expect(res.value.color).toBe("#4a90d9");
    expect(res.value.schema).toBeDefined();
    expect(res.value.schema!.status?.type).toBe("enum");
    expect(res.value.schema!.status?.enumValues).toContain("draft");
  });

  it("update_group_config persists and get_group_config reads it back", async () => {
    const { mock } = await import("../../ipc/mock.js");

    // Create a fresh group path to avoid test pollution.
    const testPath = "test-round-trip-group";

    // Initial get returns empty config.
    const before = await mock.get_group_config(testPath);
    expect(before.ok).toBe(true);

    // Write a config.
    const updateRes = await mock.update_group_config(testPath, {
      name: "Test Group",
      icon: "🧪",
      color: "#123456",
      view: "task-list",
      schema: {
        myProp: { type: "enum", enumValues: ["a", "b"], default: "a" },
      },
    });
    expect(updateRes.ok).toBe(true);

    // Read back.
    const after = await mock.get_group_config(testPath);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.name).toBe("Test Group");
    expect(after.value.icon).toBe("🧪");
    expect(after.value.color).toBe("#123456");
    expect(after.value.view).toBe("task-list");
    expect(after.value.schema?.myProp?.type).toBe("enum");
    expect(after.value.schema?.myProp?.enumValues).toEqual(["a", "b"]);
    expect(after.value.schema?.myProp?.default).toBe("a");
  });

  it("partial update merges with existing config", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const testPath = "test-partial-update";

    // Write initial.
    await mock.update_group_config(testPath, { name: "Initial", icon: "A", color: "#aabbcc" });
    // Update only name.
    await mock.update_group_config(testPath, { name: "Updated" });
    // Read back.
    const res = await mock.get_group_config(testPath);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.name).toBe("Updated");
    expect(res.value.icon).toBe("A"); // preserved from initial
    expect(res.value.color).toBe("#aabbcc"); // preserved
  });

  it("effective_schema uses groupConfigStore schema", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const res = await mock.effective_schema("work/atlas");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).not.toBeNull();
    const schema = JSON.parse(res.value!);
    expect(schema.status?.type).toBe("enum");
    expect(schema.priority?.type).toBe("number");
  });

  it("list_groups includes icon from config", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const res = await mock.list_groups();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const atlas = res.value.find((g) => g.path === "work/atlas");
    expect(atlas).toBeDefined();
    expect(atlas?.icon).toBe("🗺️");
  });
});
