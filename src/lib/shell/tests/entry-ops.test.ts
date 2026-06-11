import { describe, it, expect } from "vitest";
import { applyArchiveToText, nextDuplicateId, prepareDuplicateText } from "../entry-ops.js";

// ── applyArchiveToText ──────────────────────────────────────────────────────

describe("applyArchiveToText", () => {
  const base = "---\nid: test\ntitle: Test\n---\n\nBody text.\n";

  it("inserts archived: true after opening --- when not present", () => {
    const result = applyArchiveToText(base, true);
    expect(result).toBe("---\narchived: true\nid: test\ntitle: Test\n---\n\nBody text.\n");
  });

  it("replaces an existing archived: false line with archived: true", () => {
    const text = "---\nid: test\narchived: false\ntitle: Test\n---\n\nBody.\n";
    const result = applyArchiveToText(text, true);
    expect(result).toBe("---\nid: test\narchived: true\ntitle: Test\n---\n\nBody.\n");
  });

  it("replaces an existing archived: true line when re-archiving", () => {
    const text = "---\narchived: true\nid: test\n---\n\nBody.\n";
    const result = applyArchiveToText(text, true);
    expect(result).toBe("---\narchived: true\nid: test\n---\n\nBody.\n");
  });

  it("removes archived: true line when unarchiving", () => {
    const text = "---\nid: test\narchived: true\ntitle: Test\n---\n\nBody.\n";
    const result = applyArchiveToText(text, false);
    expect(result).toBe("---\nid: test\ntitle: Test\n---\n\nBody.\n");
  });

  it("is a no-op when unarchiving entry that has no archived line", () => {
    const result = applyArchiveToText(base, false);
    expect(result).toBe(base);
  });

  it("preserves body content after unarchiving", () => {
    const text = "---\narchived: true\nid: test\n---\n\nHello world.\n";
    const result = applyArchiveToText(text, false);
    expect(result).toContain("Hello world.");
    expect(result).not.toContain("archived:");
  });
});

// ── nextDuplicateId ─────────────────────────────────────────────────────────

describe("nextDuplicateId", () => {
  it("returns base-2 when nothing is taken", () => {
    const id = nextDuplicateId("inbox/my-note", new Set());
    expect(id).toBe("inbox/my-note-2");
  });

  it("skips to -3 when -2 is taken", () => {
    const id = nextDuplicateId("inbox/my-note", new Set(["inbox/my-note-2"]));
    expect(id).toBe("inbox/my-note-3");
  });

  it("skips to -4 when -2 and -3 are taken", () => {
    const id = nextDuplicateId("inbox/my-note", new Set(["inbox/my-note-2", "inbox/my-note-3"]));
    expect(id).toBe("inbox/my-note-4");
  });

  it("strips a trailing -N suffix from the source id before computing", () => {
    // Duplicating "my-note-2" should produce "my-note-2" → base "my-note" → first free
    const id = nextDuplicateId("my-note-2", new Set(["my-note-2", "my-note-3"]));
    expect(id).toBe("my-note-4");
  });

  it("works with flat (no-path) ids", () => {
    const id = nextDuplicateId("standalone", new Set());
    expect(id).toBe("standalone-2");
  });

  it("works with nested paths", () => {
    const id = nextDuplicateId("projects/work/meeting-notes", new Set());
    expect(id).toBe("projects/work/meeting-notes-2");
  });
});

// ── prepareDuplicateText ────────────────────────────────────────────────────

describe("prepareDuplicateText", () => {
  it("strips id/created/updated from frontmatter and inserts a fresh id", () => {
    const text =
      "---\nid: old\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-02T00:00:00Z\ntags: [a]\n---\n\nBody.\n";
    const result = prepareDuplicateText(text, "inbox/note-2");
    expect(result).toBe("---\nid: note-2-copy\ntags: [a]\n---\n\nBody.\n");
  });

  it("leaves body lines that look like frontmatter untouched", () => {
    const text = "---\ntags: [a]\n---\n\nid: prod-db-key\ncreated: yesterday\n";
    const result = prepareDuplicateText(text, "note-2");
    expect(result).toContain("id: prod-db-key");
    expect(result).toContain("created: yesterday");
    expect(result.startsWith("---\nid: note-2-copy\ntags: [a]\n---\n")).toBe(true);
  });

  it("strips a body-less id only from the frontmatter when frontmatter has no id", () => {
    const text = "---\ntags: [a]\n---\n\nid: keep-me\n";
    const result = prepareDuplicateText(text, "note-2");
    expect(result).toContain("id: keep-me");
  });

  it("prepends a minimal frontmatter block when none exists", () => {
    const result = prepareDuplicateText("# Just a heading\n", "note-2");
    expect(result).toBe("---\nid: note-2-copy\n---\n# Just a heading\n");
  });
});

// ── applyArchiveToText body-scoping regression ──────────────────────────────

describe("applyArchiveToText frontmatter scoping", () => {
  it("does not remove an archived-looking line from the body on unarchive", () => {
    const text = "---\nid: t\narchived: true\n---\n\narchived: notes about archiving\n";
    const result = applyArchiveToText(text, false);
    expect(result).toBe("---\nid: t\n---\n\narchived: notes about archiving\n");
  });

  it("is a no-op on text without a frontmatter block", () => {
    const text = "archived: body line\n";
    expect(applyArchiveToText(text, true)).toBe(text);
    expect(applyArchiveToText(text, false)).toBe(text);
  });
});
