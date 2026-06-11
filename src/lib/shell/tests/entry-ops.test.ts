import { describe, it, expect } from "vitest";
import { applyArchiveToText, nextDuplicateId } from "../entry-ops.js";

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
