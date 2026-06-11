// Mock parity tests for group-management + trash IPC commands (phase 6 / issue #28).
//
// Validates that the mock implementation behaves correctly so that /dev stays
// green and the mock matches the Rust semantics.

import { describe, it, expect } from "vitest";
import { mock } from "../mock.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Reset all in-memory stores between tests by re-importing the module is not
 * possible in vitest without a full reset, so we rely on the tests being
 * independent (using unique group/entry paths). */

// ── create_group ─────────────────────────────────────────────────────────────

describe("mock create_group", () => {
  it("creates a group and it appears in list_groups", async () => {
    const res = await mock.create_group("test-create-unique-1");
    expect(res.ok).toBe(true);

    const groups = await mock.list_groups();
    expect(groups.ok).toBe(true);
    if (!groups.ok) return;
    const paths = groups.value.map((g) => g.path);
    expect(paths).toContain("test-create-unique-1");
  });

  it("rejects reserved names starting with _", async () => {
    const res = await mock.create_group("_private");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("invalid_argument");
  });

  it("rejects reserved names starting with .", async () => {
    const res = await mock.create_group(".hidden");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("invalid_argument");
  });
});

// ── rename_group ──────────────────────────────────────────────────────────────

describe("mock rename_group", () => {
  it("renames a group and entries follow", async () => {
    // Use an existing group from mock data.
    // "inbox" is an existing group. Rename to "inbox-renamed-xxx".
    const newName = "inbox-renamed-test-2";
    const res = await mock.rename_group("inbox", newName);
    expect(res.ok).toBe(true);

    const groups = await mock.list_groups();
    expect(groups.ok).toBe(true);
    if (!groups.ok) return;
    const paths = groups.value.map((g) => g.path);
    expect(paths).toContain(newName);
    // Rename back so other tests aren't affected.
    await mock.rename_group(newName, "inbox");
  });

  it("rejects reserved new name", async () => {
    const res = await mock.rename_group("books", "_archive");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("invalid_argument");
  });

  it("rejects sibling collision", async () => {
    // "books" and "journal" both exist at root level.
    const res = await mock.rename_group("books", "journal");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("conflict");
  });
});

// ── move_group ────────────────────────────────────────────────────────────────

describe("mock move_group", () => {
  it("rejects moving a group into itself", async () => {
    const res = await mock.move_group("work/atlas", "work/atlas");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("invalid_argument");
  });

  it("rejects moving a group into a descendant", async () => {
    const res = await mock.move_group("work", "work/atlas");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("invalid_argument");
  });
});

// ── move_entry ────────────────────────────────────────────────────────────────

describe("mock move_entry", () => {
  it("moves an entry to another group", async () => {
    // Create a temporary entry to move.
    const entryId = "inbox/move-test-entry-x1";
    const text = "---\ntitle: Move Test\n---\n# Move Test\n";
    await mock.write_entry(entryId, text, "tok");

    const res = await mock.move_entry("inbox/move-test-entry-x1.md", "journal");
    expect(res.ok).toBe(true);

    // After move, the entry should be in "journal".
    const result = await mock.entries_in_group("journal");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.items.map((e) => e.id);
    expect(ids.some((id) => id.includes("move-test-entry-x1"))).toBe(true);
  });

  it("returns not_found for a missing entry", async () => {
    const res = await mock.move_entry("inbox/ghost-entry-zzz.md", "journal");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("not_found");
  });
});

// ── rename_entry (spec 0002 §Identity) ─────────────────────────────────────────

describe("mock rename_entry", () => {
  it("renames an entry's slug and rewrites wikilink references", async () => {
    const srcId = "inbox/rename-src-r1";
    await mock.write_entry(srcId, "# Rename Src\n", "tok");
    const refId = "inbox/rename-ref-r1";
    await mock.write_entry(refId, "see [[inbox/rename-src-r1]] here\n", "tok");

    const res = await mock.rename_entry("inbox/rename-src-r1.md", "renamed-r1");
    expect(res.ok).toBe(true);

    // Old id gone, new id present.
    const oldRead = await mock.read_entry(srcId);
    expect(oldRead.ok).toBe(false);
    const newRead = await mock.read_entry("inbox/renamed-r1");
    expect(newRead.ok).toBe(true);

    // Referencing entry's wikilink updated.
    const refRead = await mock.read_entry(refId);
    expect(refRead.ok).toBe(true);
    if (!refRead.ok) return;
    expect(refRead.value.text).toContain("[[inbox/renamed-r1]]");
    expect(refRead.value.text).not.toContain("rename-src-r1");
  });

  it("appends -2 on slug collision within the group", async () => {
    await mock.write_entry("inbox/coll-a-r2", "# A\n", "tok");
    await mock.write_entry("inbox/coll-target-r2", "# Existing\n", "tok");

    const res = await mock.rename_entry("inbox/coll-a-r2.md", "coll-target-r2");
    expect(res.ok).toBe(true);
    // The returned slug must be the suffixed one so callers can re-select.
    if (!res.ok) return;
    expect(res.value).toBe("coll-target-r2-2");

    const suffixed = await mock.read_entry("inbox/coll-target-r2-2");
    expect(suffixed.ok).toBe(true);
    // Original target untouched.
    const original = await mock.read_entry("inbox/coll-target-r2");
    expect(original.ok).toBe(true);
  });

  it("rejects a reserved slug", async () => {
    await mock.write_entry("inbox/reserved-src-r3", "# X\n", "tok");
    const res = await mock.rename_entry("inbox/reserved-src-r3.md", "_meta");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("invalid_argument");
  });

  it("returns not_found for a missing entry", async () => {
    const res = await mock.rename_entry("inbox/ghost-rename-r4.md", "whatever");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("not_found");
  });
});

// ── parse warning (spec 0002 §Malformed frontmatter) ───────────────────────────

describe("mock read_entry parseWarning", () => {
  it("flags an unclosed frontmatter fence", async () => {
    await mock.write_entry("inbox/malformed-pw1", "---\nbad: [unclosed\nstill body\n", "tok");
    const r = await mock.read_entry("inbox/malformed-pw1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.parseWarning).toBeTruthy();
  });

  it("leaves well-formed entries without a warning", async () => {
    await mock.write_entry("inbox/wellformed-pw2", "---\nid: x\n---\n# Title\n", "tok");
    const r = await mock.read_entry("inbox/wellformed-pw2");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.parseWarning).toBeUndefined();
  });
});

// ── trash_entry / trash_restore / trash_purge ─────────────────────────────────

describe("mock trash_entry", () => {
  it("trashes an entry and it disappears from the store", async () => {
    // Create a throwaway entry.
    const id = "inbox/trash-target-abc1";
    await mock.write_entry(id, "---\ntitle: Trash Me\n---\n# Trash Me\n", "tok");

    const trashRes = await mock.trash_entry("inbox/trash-target-abc1.md");
    expect(trashRes.ok).toBe(true);
    if (!trashRes.ok) return;

    // Entry must no longer be readable.
    const readRes = await mock.read_entry(id);
    expect(readRes.ok).toBe(false);
    if (readRes.ok) return;
    expect(readRes.error.code).toBe("not_found");
  });

  it("trashed entry appears in trash_list", async () => {
    const id = "inbox/trash-list-abc2";
    await mock.write_entry(id, "---\ntitle: T\n---\n", "tok");

    const r = await mock.trash_entry("inbox/trash-list-abc2.md");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const listRes = await mock.trash_list();
    expect(listRes.ok).toBe(true);
    if (!listRes.ok) return;
    const ids = listRes.value.map((m) => m.trashId);
    expect(ids).toContain(r.value.trashId);
  });

  it("trash_restore brings the entry back", async () => {
    const id = "inbox/restore-abc3";
    await mock.write_entry(id, "---\ntitle: Restore\n---\n", "tok");

    const trashRes = await mock.trash_entry("inbox/restore-abc3.md");
    expect(trashRes.ok).toBe(true);
    if (!trashRes.ok) return;

    const restoreRes = await mock.trash_restore(trashRes.value.trashId);
    expect(restoreRes.ok).toBe(true);
    if (!restoreRes.ok) return;

    // Entry must be readable again.
    const readRes = await mock.read_entry(id);
    expect(readRes.ok).toBe(true);
  });

  it("trash_purge removes the slot permanently", async () => {
    const id = "inbox/purge-abc4";
    await mock.write_entry(id, "---\ntitle: Purge\n---\n", "tok");

    const trashRes = await mock.trash_entry("inbox/purge-abc4.md");
    expect(trashRes.ok).toBe(true);
    if (!trashRes.ok) return;

    await mock.trash_purge(trashRes.value.trashId);

    // Slot must not appear in list.
    const listRes = await mock.trash_list();
    expect(listRes.ok).toBe(true);
    if (!listRes.ok) return;
    const ids = listRes.value.map((m) => m.trashId);
    expect(ids).not.toContain(trashRes.value.trashId);
  });

  it("trash_restore returns not_found for unknown id", async () => {
    const res = await mock.trash_restore("nonexistent-trash-id-zzz");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("not_found");
  });
});

// ── trash_group ───────────────────────────────────────────────────────────────

describe("mock trash_group", () => {
  it("trashes a group and all its entries disappear", async () => {
    // Verify books group has entries.
    const before = await mock.entries_in_group("books");
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const beforeCount = before.value.items.length;
    expect(beforeCount).toBeGreaterThan(0);

    const trashRes = await mock.trash_group("books");
    expect(trashRes.ok).toBe(true);
    if (!trashRes.ok) return;

    // Entries must be gone.
    const after = await mock.entries_in_group("books");
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.items.length).toBe(0);

    // Restore so other tests are not affected.
    await mock.trash_restore(trashRes.value.trashId);
  });

  it("trashed group appears in trash_list with kind=group", async () => {
    // Use a group we created fresh so it doesn't collide with books (which may have been restored).
    await mock.create_group("test-group-trash-x99");
    const trashRes = await mock.trash_group("test-group-trash-x99");
    expect(trashRes.ok).toBe(true);
    if (!trashRes.ok) return;

    const listRes = await mock.trash_list();
    expect(listRes.ok).toBe(true);
    if (!listRes.ok) return;
    const slot = listRes.value.find((m) => m.trashId === trashRes.value.trashId);
    expect(slot).toBeDefined();
    expect(slot?.kind).toBe("group");
  });
});
