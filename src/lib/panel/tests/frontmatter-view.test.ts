// Tests for frontmatter-view.ts — parse model and line-granular write-back.
//
// Covers (per scope):
//   • parseFrontmatter: each type inference (string, number, boolean, date,
//     datetime, range, tags/mentions arrays, complex); built-in classification;
//     no-frontmatter; empty frontmatter; malformed.
//   • applyPanelEdit: set-scalar, set-array, remove, add, replace-raw;
//     line-granular byte precision; no-frontmatter "add" creates the block;
//     unknown/complex lines are byte-untouched.

import { describe, it, expect } from "vitest";
import {
  parseFrontmatter,
  applyPanelEdit,
  inferType,
  createFrontmatterBlock,
} from "../frontmatter-view.js";
import type { FmEdit } from "../frontmatter-view.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Apply a ChangeSpec to a string (simulates CM6 doc.replace). */
function applyChange(doc: string, from: number, to: number, insert: string): string {
  return doc.slice(0, from) + insert + doc.slice(to);
}

/** Parse then apply an edit, returning the resulting document text. */
function editDoc(doc: string, edit: FmEdit): string {
  const model = parseFrontmatter(doc);
  const change = applyPanelEdit(doc, model, edit);
  if (!change) return doc;
  return applyChange(doc, change.from, change.to, change.insert);
}

// ── Fixture documents ─────────────────────────────────────────────────────────

const FM_BASIC = `---
id: abc-123
created: 2026-01-01T09:00+00:00
updated: 2026-05-10T14:00+02:00
tags: [work, planning]
mentions: [anna, bob]
due: 2026-06-15
done: false
priority: 3
note: hello world
archived: true
---

# Body text
`;

const FM_COMPLEX = `---
id: cplx-1
overrides:
  2026-06-01: skip
  2026-06-08: skip
tags: [a, b]
---
`;

const FM_BLOCK_SEQ = `---
tags:
  - alpha
  - beta
  - gamma
---
`;

const NO_FM = `# Just a heading

Body paragraph.
`;

const EMPTY_FM = `---
---
Body.
`;

// ── inferType tests ───────────────────────────────────────────────────────────

describe("inferType", () => {
  it("boolean true → boolean", () => {
    expect(inferType(true, "done")).toBe("boolean");
  });

  it("boolean false → boolean", () => {
    expect(inferType(false, "archived")).toBe("boolean");
  });

  it("number → number", () => {
    expect(inferType(3, "priority")).toBe("number");
    expect(inferType(0, "count")).toBe("number");
    expect(inferType(3.14, "ratio")).toBe("number");
  });

  it("ISO date string → date", () => {
    expect(inferType("2026-06-15", "due")).toBe("date");
    expect(inferType("2000-01-01", "start")).toBe("date");
  });

  it("ISO datetime string with offset → datetime", () => {
    expect(inferType("2026-05-20T14:00+02:00", "created")).toBe("datetime");
    expect(inferType("2026-05-20T09:00:00Z", "updated")).toBe("datetime");
    expect(inferType("2026-05-20T09:00Z", "ts")).toBe("datetime");
  });

  it("range string → range", () => {
    expect(inferType("2026-06-01..2026-06-05", "span")).toBe("range");
    expect(inferType("2026-06-01T09:00+00:00..2026-06-01T10:30+00:00", "slot")).toBe("range");
  });

  it("plain string → string", () => {
    expect(inferType("hello world", "note")).toBe("string");
    expect(inferType("not-a-date", "foo")).toBe("string");
    expect(inferType("", "empty")).toBe("string");
  });

  it("tags key with string array → tags", () => {
    expect(inferType(["work", "planning"], "tags")).toBe("tags");
  });

  it("mentions key with string array → tags (same widget)", () => {
    expect(inferType(["anna", "bob"], "mentions")).toBe("tags");
  });

  it("string array on a non-tag key → tags (generic chip array)", () => {
    expect(inferType(["a", "b"], "categories")).toBe("tags");
  });

  it("mixed array → complex", () => {
    expect(inferType([1, "two"], "mixed")).toBe("complex");
  });

  it("object → complex", () => {
    expect(inferType({ a: 1 }, "overrides")).toBe("complex");
  });

  it("null → complex", () => {
    expect(inferType(null, "foo")).toBe("complex");
  });
});

// ── parseFrontmatter: structural tests ────────────────────────────────────────

describe("parseFrontmatter — structure", () => {
  it("no-frontmatter document returns hasFrontmatter=false", () => {
    const m = parseFrontmatter(NO_FM);
    expect(m.hasFrontmatter).toBe(false);
    expect(m.rows).toHaveLength(0);
    expect(m.builtinRows).toHaveLength(0);
    expect(m.advancedRows).toHaveLength(0);
  });

  it("empty frontmatter block is valid (no rows)", () => {
    const m = parseFrontmatter(EMPTY_FM);
    expect(m.hasFrontmatter).toBe(true);
    expect(m.rows).toHaveLength(0);
  });

  it("unclosed opening fence → hasFrontmatter=false", () => {
    const m = parseFrontmatter("---\ntitle: x\nno close fence");
    expect(m.hasFrontmatter).toBe(false);
  });

  it("openFenceLine is 1, closeFenceLine is correct", () => {
    const doc = "---\nkey: val\n---\nbody";
    const m = parseFrontmatter(doc);
    expect(m.openFenceLine).toBe(1);
    expect(m.closeFenceLine).toBe(3);
  });
});

// ── parseFrontmatter: built-in classification ─────────────────────────────────

describe("parseFrontmatter — built-in classification", () => {
  const m = parseFrontmatter(FM_BASIC);

  it("title is hidden (not present in any section)", () => {
    const allKeys = [
      ...m.rows.map((r) => r.key),
      ...m.builtinRows.map((r) => r.key),
      ...m.advancedRows.map((r) => r.key),
    ];
    expect(allKeys).not.toContain("title");
  });

  it("id goes to advancedRows", () => {
    expect(m.advancedRows.map((r) => r.key)).toContain("id");
  });

  it("created goes to builtinRows (read-only)", () => {
    const row = m.builtinRows.find((r) => r.key === "created");
    expect(row).toBeDefined();
    expect(row!.readOnly).toBe(true);
  });

  it("updated goes to builtinRows (read-only)", () => {
    const row = m.builtinRows.find((r) => r.key === "updated");
    expect(row).toBeDefined();
    expect(row!.readOnly).toBe(true);
  });

  it("tags goes to rows (editable)", () => {
    const row = m.rows.find((r) => r.key === "tags");
    expect(row).toBeDefined();
    expect(row!.readOnly).toBe(false);
  });

  it("mentions goes to rows (editable)", () => {
    const row = m.rows.find((r) => r.key === "mentions");
    expect(row).toBeDefined();
    expect(row!.readOnly).toBe(false);
  });
});

// ── parseFrontmatter: per-type inference ──────────────────────────────────────

describe("parseFrontmatter — type inference on parsed rows", () => {
  const m = parseFrontmatter(FM_BASIC);

  it("due: 2026-06-15 → type=date", () => {
    const row = m.rows.find((r) => r.key === "due");
    expect(row?.type).toBe("date");
    expect(row?.value).toBe("2026-06-15");
  });

  it("done: false → type=boolean", () => {
    const row = m.rows.find((r) => r.key === "done");
    expect(row?.type).toBe("boolean");
    expect(row?.value).toBe(false);
  });

  it("priority: 3 → type=number", () => {
    const row = m.rows.find((r) => r.key === "priority");
    expect(row?.type).toBe("number");
    expect(row?.value).toBe(3);
  });

  it("note: hello world → type=string", () => {
    const row = m.rows.find((r) => r.key === "note");
    expect(row?.type).toBe("string");
    expect(row?.value).toBe("hello world");
  });

  it("archived: true → type=boolean", () => {
    const row = m.rows.find((r) => r.key === "archived");
    expect(row?.type).toBe("boolean");
    expect(row?.value).toBe(true);
  });

  it("tags: [work, planning] → type=tags", () => {
    const row = m.rows.find((r) => r.key === "tags");
    expect(row?.type).toBe("tags");
    expect(row?.value).toEqual(["work", "planning"]);
  });

  it("created datetime → type=datetime in builtinRows", () => {
    const row = m.builtinRows.find((r) => r.key === "created");
    expect(row?.type).toBe("datetime");
  });
});

// ── parseFrontmatter: complex / unknown shape ─────────────────────────────────

describe("parseFrontmatter — complex values", () => {
  const m = parseFrontmatter(FM_COMPLEX);

  it("overrides (YAML map) → type=complex, readOnly=true", () => {
    const row = m.rows.find((r) => r.key === "overrides");
    expect(row?.type).toBe("complex");
    expect(row?.readOnly).toBe(true);
  });

  it("tags in the same frontmatter still parses correctly", () => {
    const row = m.rows.find((r) => r.key === "tags");
    expect(row?.type).toBe("tags");
  });
});

// ── parseFrontmatter: block sequence ─────────────────────────────────────────

describe("parseFrontmatter — block sequence arrays", () => {
  it("block sequence tags → type=tags with correct value", () => {
    const m = parseFrontmatter(FM_BLOCK_SEQ);
    const row = m.rows.find((r) => r.key === "tags");
    expect(row?.type).toBe("tags");
    expect(row?.value).toEqual(["alpha", "beta", "gamma"]);
  });

  it("block sequence lines span multiple doc lines", () => {
    const m = parseFrontmatter(FM_BLOCK_SEQ);
    const row = m.rows.find((r) => r.key === "tags");
    expect(row?.lines.length).toBeGreaterThan(1);
  });
});

// ── applyPanelEdit: set-scalar ────────────────────────────────────────────────

describe("applyPanelEdit — set-scalar", () => {
  const doc = `---
due: 2026-06-15
done: false
note: hello
---
`;

  it("changes a string value", () => {
    const result = editDoc(doc, { kind: "set-scalar", key: "note", value: "goodbye" });
    expect(result).toContain("note: goodbye");
    expect(result).not.toContain("note: hello");
  });

  it("changes a date value", () => {
    const result = editDoc(doc, { kind: "set-scalar", key: "due", value: "2026-07-01" });
    expect(result).toContain("due: 2026-07-01");
    expect(result).not.toContain("due: 2026-06-15");
  });

  it("changes a boolean value", () => {
    const result = editDoc(doc, { kind: "set-scalar", key: "done", value: true });
    expect(result).toContain("done: true");
    expect(result).not.toContain("done: false");
  });

  it("only changes the target line — other lines are byte-identical", () => {
    const result = editDoc(doc, { kind: "set-scalar", key: "note", value: "new" });
    expect(result).toContain("due: 2026-06-15");
    expect(result).toContain("done: false");
  });

  it("returns null for a read-only key (created)", () => {
    const docWithBuiltin = `---
created: 2026-01-01T09:00+00:00
note: x
---
`;
    const model = parseFrontmatter(docWithBuiltin);
    const change = applyPanelEdit(docWithBuiltin, model, {
      kind: "set-scalar",
      key: "created",
      value: "2026-02-01T09:00+00:00",
    });
    expect(change).toBeNull();
  });

  it("returns null for a missing key", () => {
    const model = parseFrontmatter(doc);
    const change = applyPanelEdit(doc, model, {
      kind: "set-scalar",
      key: "nonexistent",
      value: "x",
    });
    expect(change).toBeNull();
  });
});

// ── applyPanelEdit: set-array ─────────────────────────────────────────────────

describe("applyPanelEdit — set-array", () => {
  const doc = `---
tags: [work, planning]
note: hello
---
`;

  it("rewrites tags array to inline flow form", () => {
    const result = editDoc(doc, { kind: "set-array", key: "tags", values: ["work", "done"] });
    expect(result).toContain("tags: [work, done]");
    expect(result).not.toContain("tags: [work, planning]");
  });

  it("produces empty array form when values is empty", () => {
    const result = editDoc(doc, { kind: "set-array", key: "tags", values: [] });
    expect(result).toContain("tags: []");
  });

  it("does not touch other lines", () => {
    const result = editDoc(doc, { kind: "set-array", key: "tags", values: ["x"] });
    expect(result).toContain("note: hello");
  });

  it("rewrites block sequence to inline form", () => {
    const result = editDoc(FM_BLOCK_SEQ, {
      kind: "set-array",
      key: "tags",
      values: ["alpha", "delta"],
    });
    expect(result).toContain("tags: [alpha, delta]");
    // Block seq lines should be gone
    expect(result).not.toMatch(/^\s+- alpha/m);
  });
});

// ── applyPanelEdit: remove ────────────────────────────────────────────────────

describe("applyPanelEdit — remove", () => {
  const doc = `---
due: 2026-06-15
done: false
note: hello
---
`;

  it("removes a scalar property line", () => {
    const result = editDoc(doc, { kind: "remove", key: "due" });
    expect(result).not.toContain("due:");
    // Other properties survive
    expect(result).toContain("done: false");
    expect(result).toContain("note: hello");
  });

  it("removes a multi-line block sequence (all its lines)", () => {
    const result = editDoc(FM_BLOCK_SEQ, { kind: "remove", key: "tags" });
    expect(result).not.toContain("tags:");
    expect(result).not.toContain("- alpha");
    expect(result).not.toContain("- beta");
  });

  it("removes tags inline form", () => {
    const result = editDoc(doc.replace("done: false\n", ""), { kind: "remove", key: "note" });
    expect(result).not.toContain("note:");
    expect(result).toContain("due: 2026-06-15");
  });

  it("returns null for a missing key", () => {
    const model = parseFrontmatter(doc);
    const change = applyPanelEdit(doc, model, { kind: "remove", key: "nonexistent" });
    expect(change).toBeNull();
  });
});

// ── applyPanelEdit: add ───────────────────────────────────────────────────────

describe("applyPanelEdit — add", () => {
  const doc = `---
note: hello
---
body
`;

  it("inserts a new scalar before closing fence", () => {
    const result = editDoc(doc, { kind: "add", key: "due", value: "2026-07-01" });
    // The new key appears before the closing fence
    const closeFenceIdx = result.indexOf("---\nbody");
    const newKeyIdx = result.indexOf("due:");
    expect(newKeyIdx).toBeGreaterThan(-1);
    expect(newKeyIdx).toBeLessThan(closeFenceIdx);
  });

  it("inserts a boolean property", () => {
    const result = editDoc(doc, { kind: "add", key: "done", value: false });
    expect(result).toContain("done: false");
  });

  it("inserts an array property in inline form", () => {
    const result = editDoc(doc, { kind: "add", key: "tags", value: ["a", "b"] });
    expect(result).toContain("tags: [a, b]");
  });

  it("does not disturb existing keys", () => {
    const result = editDoc(doc, { kind: "add", key: "new", value: "val" });
    expect(result).toContain("note: hello");
  });
});

// ── applyPanelEdit: add on no-frontmatter doc ─────────────────────────────────

describe("applyPanelEdit — add on no-frontmatter document", () => {
  it("creates a full frontmatter block at the start", () => {
    const result = editDoc(NO_FM, { kind: "add", key: "due", value: "2026-07-01" });
    expect(result.startsWith("---\n")).toBe(true);
    expect(result).toContain("due: 2026-07-01");
    // The original body is preserved after the block
    expect(result).toContain("# Just a heading");
  });

  it("createFrontmatterBlock produces a well-formed block", () => {
    const spec = createFrontmatterBlock("done", true);
    expect(spec.from).toBe(0);
    expect(spec.to).toBe(0);
    const inserted = spec.insert;
    expect(inserted.startsWith("---\n")).toBe(true);
    expect(inserted).toContain("done: true");
    expect(inserted).toContain("\n---\n");
  });
});

// ── applyPanelEdit: replace-raw ───────────────────────────────────────────────

describe("applyPanelEdit — replace-raw", () => {
  const doc = `---
note: hello
due: 2026-06-15
---
body
`;

  it("replaces the frontmatter block verbatim", () => {
    const newBlock = "---\nnote: changed\n---\n";
    const model = parseFrontmatter(doc);
    const change = applyPanelEdit(doc, model, { kind: "replace-raw", rawBlock: newBlock });
    expect(change).not.toBeNull();
    const result = applyChange(doc, change!.from, change!.to, change!.insert);
    expect(result.startsWith("---\nnote: changed\n---\n")).toBe(true);
    // Body is preserved
    expect(result).toContain("body");
    // Old keys gone
    expect(result).not.toContain("due:");
  });

  it("returns null when there is no frontmatter", () => {
    const model = parseFrontmatter(NO_FM);
    const change = applyPanelEdit(NO_FM, model, {
      kind: "replace-raw",
      rawBlock: "---\nkey: val\n---\n",
    });
    expect(change).toBeNull();
  });
});

// ── Unknown/complex values: byte-untouched ────────────────────────────────────

describe("applyPanelEdit — complex values are never rewritten", () => {
  it("set-scalar on a complex key returns null", () => {
    const model = parseFrontmatter(FM_COMPLEX);
    const change = applyPanelEdit(FM_COMPLEX, model, {
      kind: "set-scalar",
      key: "overrides",
      value: "anything",
    });
    expect(change).toBeNull();
  });

  it("set-array on a complex key returns null", () => {
    const model = parseFrontmatter(FM_COMPLEX);
    const change = applyPanelEdit(FM_COMPLEX, model, {
      kind: "set-array",
      key: "overrides",
      values: ["x"],
    });
    expect(change).toBeNull();
  });

  it("remove on a complex key does work (delete the lines)", () => {
    const result = editDoc(FM_COMPLEX, { kind: "remove", key: "overrides" });
    expect(result).not.toContain("overrides:");
    // Other keys survive
    expect(result).toContain("tags:");
  });
});

// ── Exact line-granular precision ─────────────────────────────────────────────

describe("applyPanelEdit — exact line-granular byte precision", () => {
  const doc = `---
alpha: one
beta: two
gamma: three
---
body
`;

  it("changing beta does not affect alpha or gamma lines", () => {
    const result = editDoc(doc, { kind: "set-scalar", key: "beta", value: "NEW" });
    const lines = result.split("\n");
    // Lines 2 and 4 (0-indexed 1 and 3 within the split) are alpha and gamma
    expect(lines.find((l) => l.startsWith("alpha:"))).toBe("alpha: one");
    expect(lines.find((l) => l.startsWith("gamma:"))).toBe("gamma: three");
    expect(lines.find((l) => l.startsWith("beta:"))).toBe("beta: NEW");
  });

  it("removing beta produces exactly 1 fewer line inside the frontmatter", () => {
    const before = doc.split("\n").filter((l) => l.trim()).length;
    const result = editDoc(doc, { kind: "remove", key: "beta" });
    const after = result.split("\n").filter((l) => l.trim()).length;
    expect(after).toBe(before - 1);
  });

  it("adding a key increments the line count by 1", () => {
    const before = doc.split("\n").filter((l) => l.trim()).length;
    const result = editDoc(doc, { kind: "add", key: "delta", value: "four" });
    const after = result.split("\n").filter((l) => l.trim()).length;
    expect(after).toBe(before + 1);
  });
});

// ── Range property: editable but read-only in panel by type ──────────────────

describe("parseFrontmatter — range property", () => {
  const doc = `---
span: 2026-06-01..2026-06-05
---
`;

  it("range → type=range", () => {
    const m = parseFrontmatter(doc);
    const row = m.rows.find((r) => r.key === "span");
    expect(row?.type).toBe("range");
    expect(row?.readOnly).toBe(false); // range is editable in principle (calendar UI)
  });
});

// ── YAML quoting edge cases ───────────────────────────────────────────────────

describe("applyPanelEdit — YAML quoting", () => {
  const doc = `---
note: simple
---
`;

  it("strings with colons are serialised without breaking YAML", () => {
    const result = editDoc(doc, { kind: "set-scalar", key: "note", value: "a: b" });
    // The value must be quoted so YAML round-trips correctly
    const model2 = parseFrontmatter(result);
    const row = model2.rows.find((r) => r.key === "note");
    expect(row?.value).toBe("a: b");
  });

  it("numbers round-trip as numbers", () => {
    const result = editDoc(doc, { kind: "set-scalar", key: "note", value: 42 });
    expect(result).toContain("note: 42");
    const model2 = parseFrontmatter(result);
    const row = model2.rows.find((r) => r.key === "note");
    expect(typeof row?.value).toBe("number");
    expect(row?.value).toBe(42);
  });
});
