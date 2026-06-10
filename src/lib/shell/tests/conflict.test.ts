// Tests for the conflict / external-edit state machine (spec 0006).
//
// Covers:
//   - hashText and collision properties
//   - onLoaded, onEditorChange, onWriteComplete tracker transitions
//   - onIndexChanged decision logic: ignore / reload / banner
//   - self_originated suppression via selfToken
//   - diffLines: unchanged / added / removed lines
//   - sessionStorage backup helpers (with mock storage)

import { describe, it, expect, beforeEach } from "vitest";
import {
  hashText,
  makeTracker,
  onLoaded,
  onEditorChange,
  onWriteComplete,
  onIndexChanged,
  diffLines,
  stashBufferBackup,
  getBufferBackup,
  clearBufferBackup,
} from "../conflict.js";
import type { BufferTracker } from "../conflict.js";

// ── hashText ──────────────────────────────────────────────────────────────────

describe("hashText", () => {
  it("same text produces same hash", () => {
    expect(hashText("hello world")).toBe(hashText("hello world"));
  });

  it("different text produces different hash", () => {
    expect(hashText("hello")).not.toBe(hashText("world"));
  });

  it("empty string has a stable hash", () => {
    expect(hashText("")).toBe(hashText(""));
  });

  it("single character difference produces different hash", () => {
    expect(hashText("abc")).not.toBe(hashText("abd"));
  });

  it("returns a 32-bit integer (bitwise safe)", () => {
    const h = hashText("some text");
    // JavaScript bitwise ops return signed 32-bit integers.
    expect(h).toBe(h | 0);
  });
});

// ── Tracker transitions ───────────────────────────────────────────────────────

describe("makeTracker", () => {
  it("starts in the idle state", () => {
    const t = makeTracker();
    expect(t.entryId).toBeNull();
    expect(t.dirtySinceLoad).toBe(false);
    expect(t.lastWriteToken).toBeNull();
  });
});

describe("onLoaded", () => {
  it("records entryId and hash, resets dirty flag", () => {
    const t0 = makeTracker();
    const t1 = onEditorChange(onLoaded(t0, "my-entry", "initial text"));
    // Now dirty; reload should clear it.
    const t2 = onLoaded(t1, "my-entry", "new text");
    expect(t2.entryId).toBe("my-entry");
    expect(t2.dirtySinceLoad).toBe(false);
    expect(t2.lastLoadedHash).toBe(hashText("new text"));
    expect(t2.lastLoadedText).toBe("new text");
  });

  it("clears lastWriteToken on load", () => {
    let t = makeTracker();
    t = onLoaded(t, "entry", "text");
    t = onWriteComplete(t, "tok-123");
    t = onLoaded(t, "entry", "text-v2");
    expect(t.lastWriteToken).toBeNull();
  });
});

describe("onEditorChange", () => {
  it("marks dirty on first change", () => {
    const t0 = onLoaded(makeTracker(), "entry", "text");
    const t1 = onEditorChange(t0);
    expect(t1.dirtySinceLoad).toBe(true);
  });

  it("is a no-op (same reference) if already dirty", () => {
    const t0 = onLoaded(makeTracker(), "entry", "text");
    const t1 = onEditorChange(t0);
    const t2 = onEditorChange(t1);
    expect(t2).toBe(t1); // same object — no allocation
  });
});

describe("onWriteComplete", () => {
  it("records the selfToken", () => {
    let t = onLoaded(makeTracker(), "e", "t");
    t = onWriteComplete(t, "tok-abc");
    expect(t.lastWriteToken).toBe("tok-abc");
  });
});

// ── onIndexChanged decision logic ─────────────────────────────────────────────

function makeReader(textMap: Record<string, string>) {
  return async (id: string): Promise<string | null> => textMap[id] ?? null;
}

describe("onIndexChanged", () => {
  let tracker: BufferTracker;

  beforeEach(() => {
    tracker = onLoaded(makeTracker(), "work/atlas/foo", "original content\nline 2");
  });

  it("ignores event when no entry is open", async () => {
    const t = makeTracker(); // entryId is null
    const d = await onIndexChanged(t, "work/atlas/foo.md", undefined, makeReader({}));
    expect(d.action).toBe("ignore");
  });

  it("ignores event for a different path", async () => {
    const d = await onIndexChanged(
      tracker,
      "work/atlas/bar.md",
      undefined,
      makeReader({ "work/atlas/foo": "changed" }),
    );
    expect(d.action).toBe("ignore");
  });

  it("ignores event when self-token matches", async () => {
    tracker = onWriteComplete(tracker, "tok-self");
    const d = await onIndexChanged(
      tracker,
      "work/atlas/foo.md",
      "tok-self",
      makeReader({ "work/atlas/foo": "external change" }),
    );
    expect(d.action).toBe("ignore");
  });

  it("ignores event when disk content is unchanged (hash identical)", async () => {
    // The text on disk is the same as what was loaded — no real change.
    const d = await onIndexChanged(
      tracker,
      "work/atlas/foo.md",
      undefined,
      makeReader({ "work/atlas/foo": "original content\nline 2" }),
    );
    expect(d.action).toBe("ignore");
  });

  it("ignores event when readEntry returns null (entry gone)", async () => {
    const d = await onIndexChanged(tracker, "work/atlas/foo.md", undefined, makeReader({}));
    expect(d.action).toBe("ignore");
  });

  it("returns reload when buffer is clean and disk changed", async () => {
    // tracker is clean (not dirty)
    const d = await onIndexChanged(
      tracker,
      "work/atlas/foo.md",
      undefined,
      makeReader({ "work/atlas/foo": "new disk content" }),
    );
    expect(d.action).toBe("reload");
  });

  it("returns banner when buffer is dirty and disk changed", async () => {
    tracker = onEditorChange(tracker); // mark dirty
    const d = await onIndexChanged(
      tracker,
      "work/atlas/foo.md",
      undefined,
      makeReader({ "work/atlas/foo": "new disk content" }),
    );
    expect(d.action).toBe("banner");
    if (d.action === "banner") {
      expect(d.diskText).toBe("new disk content");
    }
  });

  it("matches path with or without .md extension", async () => {
    // event path without .md extension
    const d = await onIndexChanged(
      tracker,
      "work/atlas/foo", // no .md
      undefined,
      makeReader({ "work/atlas/foo": "changed disk" }),
    );
    expect(d.action).toBe("reload");
  });

  it("ignores self-write even when buffer is dirty", async () => {
    tracker = onEditorChange(tracker);
    tracker = onWriteComplete(tracker, "tok-mine");
    const d = await onIndexChanged(
      tracker,
      "work/atlas/foo.md",
      "tok-mine",
      makeReader({ "work/atlas/foo": "changed disk" }),
    );
    // Self-originated: must not show banner.
    expect(d.action).toBe("ignore");
  });

  it("does NOT suppress when event token differs from write token", async () => {
    tracker = onEditorChange(tracker);
    tracker = onWriteComplete(tracker, "tok-mine");
    const d = await onIndexChanged(
      tracker,
      "work/atlas/foo.md",
      "tok-other",
      makeReader({ "work/atlas/foo": "changed disk" }),
    );
    expect(d.action).toBe("banner");
  });

  it("does NOT suppress when event has no token (external change)", async () => {
    tracker = onEditorChange(tracker);
    tracker = onWriteComplete(tracker, "tok-mine");
    const d = await onIndexChanged(
      tracker,
      "work/atlas/foo.md",
      undefined, // no selfToken in event
      makeReader({ "work/atlas/foo": "changed disk" }),
    );
    expect(d.action).toBe("banner");
  });
});

// ── diffLines ─────────────────────────────────────────────────────────────────

describe("diffLines", () => {
  it("identical texts produce only unchanged lines", () => {
    const result = diffLines("line1\nline2\nline3", "line1\nline2\nline3");
    expect(result.every((l) => l.kind === "unchanged")).toBe(true);
    expect(result).toHaveLength(3);
  });

  it("added line at end", () => {
    const result = diffLines("line1\nline2", "line1\nline2\nline3");
    const added = result.filter((l) => l.kind === "added");
    expect(added).toHaveLength(1);
    expect(added[0].text).toBe("line3");
    expect(added[0].diskLine).toBeDefined();
    expect(added[0].mineLine).toBeUndefined();
  });

  it("removed line in mine", () => {
    const result = diffLines("line1\nline2\nline3", "line1\nline3");
    const removed = result.filter((l) => l.kind === "removed");
    expect(removed).toHaveLength(1);
    expect(removed[0].text).toBe("line2");
    expect(removed[0].mineLine).toBeDefined();
    expect(removed[0].diskLine).toBeUndefined();
  });

  it("modified line shows as remove+add", () => {
    const result = diffLines("hello", "world");
    expect(result.some((l) => l.kind === "removed" && l.text === "hello")).toBe(true);
    expect(result.some((l) => l.kind === "added" && l.text === "world")).toBe(true);
  });

  it("empty mine → all disk lines are added", () => {
    const result = diffLines("", "a\nb\nc");
    // "" split by "\n" gives [""] — one empty line in mine, then "a","b","c" in disk.
    const added = result.filter((l) => l.kind === "added");
    expect(added.length).toBeGreaterThanOrEqual(3);
  });

  it("empty disk → all mine lines are removed", () => {
    const result = diffLines("a\nb\nc", "");
    const removed = result.filter((l) => l.kind === "removed");
    expect(removed.length).toBeGreaterThanOrEqual(3);
  });

  it("line numbers are 1-based and sequential for unchanged lines", () => {
    const result = diffLines("a\nb\nc", "a\nb\nc");
    expect(result[0].mineLine).toBe(1);
    expect(result[1].mineLine).toBe(2);
    expect(result[2].mineLine).toBe(3);
    expect(result[0].diskLine).toBe(1);
    expect(result[1].diskLine).toBe(2);
    expect(result[2].diskLine).toBe(3);
  });

  it("keeps common prefix and suffix as unchanged", () => {
    const mine = "header\noriginal middle\nfooter";
    const disk = "header\nnew middle\nfooter";
    const result = diffLines(mine, disk);
    expect(result.find((l) => l.kind === "unchanged" && l.text === "header")).toBeDefined();
    expect(result.find((l) => l.kind === "unchanged" && l.text === "footer")).toBeDefined();
    expect(result.find((l) => l.kind === "removed" && l.text === "original middle")).toBeDefined();
    expect(result.find((l) => l.kind === "added" && l.text === "new middle")).toBeDefined();
  });

  it("handles single-line texts", () => {
    const result = diffLines("foo", "bar");
    expect(result).toHaveLength(2);
    expect(result.some((l) => l.kind === "removed" && l.text === "foo")).toBe(true);
    expect(result.some((l) => l.kind === "added" && l.text === "bar")).toBe(true);
  });
});

// ── sessionStorage backup ─────────────────────────────────────────────────────

describe("stashBufferBackup / getBufferBackup / clearBufferBackup", () => {
  // Inject a mock sessionStorage into global so the helpers can use it.
  // Tests run in Node which has no window/sessionStorage.
  const storage = new Map<string, string>();
  const mockSessionStorage: Storage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => storage.clear(),
    key: (i: number) => Array.from(storage.keys())[i] ?? null,
    get length() {
      return storage.size;
    },
  };

  beforeEach(() => {
    storage.clear();
    // Install mock on globalThis so the helpers' `sessionStorage` reference resolves.
    (globalThis as Record<string, unknown>).sessionStorage = mockSessionStorage;
  });

  it("stash stores the buffer text", () => {
    stashBufferBackup("entry-1", "my unsaved text");
    expect(getBufferBackup("entry-1")).toBe("my unsaved text");
  });

  it("getBufferBackup returns null when nothing stashed", () => {
    expect(getBufferBackup("nonexistent")).toBeNull();
  });

  it("clearBufferBackup removes the stash", () => {
    stashBufferBackup("entry-2", "draft");
    clearBufferBackup("entry-2");
    expect(getBufferBackup("entry-2")).toBeNull();
  });

  it("different entry ids do not collide", () => {
    stashBufferBackup("entry-a", "text for a");
    stashBufferBackup("entry-b", "text for b");
    expect(getBufferBackup("entry-a")).toBe("text for a");
    expect(getBufferBackup("entry-b")).toBe("text for b");
  });

  it("overwrites existing stash for same entry", () => {
    stashBufferBackup("entry-x", "first draft");
    stashBufferBackup("entry-x", "second draft");
    expect(getBufferBackup("entry-x")).toBe("second draft");
  });
});

// ── mock.simulateExternalEdit integration ─────────────────────────────────────

describe("mock.simulateExternalEdit", () => {
  it("emits index_changed without selfToken", async () => {
    const { mock, simulateExternalEdit } = await import("../../ipc/mock.js");

    const received: unknown[] = [];
    const unsub = mock.on("index_changed", (e) => received.push(e));

    const ok = simulateExternalEdit("work/atlas/project-overview", "# Modified externally\n");
    expect(ok).toBe(true);

    unsub();

    expect(received).toHaveLength(1);
    const evt = received[0] as { paths: string[]; selfToken?: string };
    expect(evt.paths).toContain("work/atlas/project-overview.md");
    expect(evt.selfToken).toBeUndefined();
  });

  it("returns false for non-existent entry", async () => {
    const { simulateExternalEdit } = await import("../../ipc/mock.js");
    expect(simulateExternalEdit("no/such/entry", "text")).toBe(false);
  });

  it("updates the entry text in the store", async () => {
    const { mock, simulateExternalEdit } = await import("../../ipc/mock.js");
    simulateExternalEdit("books/deep-work", "# Overwritten\n");
    const r = await mock.read_entry("books/deep-work");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.text).toBe("# Overwritten\n");
  });
});

// ── mock.write_entry carries selfToken in index_changed ───────────────────────

describe("mock.write_entry selfToken echo", () => {
  it("index_changed from write_entry carries the returned selfToken", async () => {
    const { mock } = await import("../../ipc/mock.js");

    const received: unknown[] = [];
    const unsub = mock.on("index_changed", (e) => received.push(e));

    const result = await mock.write_entry(
      "inbox/ideas-backlog",
      "# Updated by shell\n",
      "prev-tok",
    );

    unsub();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const writtenToken = result.value.selfToken;
    const evt = received[0] as { selfToken?: string };
    expect(evt.selfToken).toBe(writtenToken);
  });
});

describe("selfOriginated batch suppression (real-backend path, no token echo)", () => {
  it("ignores a dirty-buffer event when the batch is selfOriginated", async () => {
    let t = makeTracker();
    t = onLoaded(t, "work/a.md", "original");
    t = onEditorChange(t);
    const decision = await onIndexChanged(
      t,
      "work/a.md",
      undefined,
      async () => "different disk content",
      true,
    );
    expect(decision.action).toBe("ignore");
  });
});
