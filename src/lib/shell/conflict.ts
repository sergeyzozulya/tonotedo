// Conflict / external-edit state machine (spec 0006 §External edits).
//
// Tracks whether the open buffer is clean or dirty relative to the last load,
// and decides whether an incoming index_changed event for the open entry should
// trigger a silent reload (clean) or show the conflict banner (dirty).
//
// Self-write suppression: when the app writes the buffer itself, write_entry
// returns a selfToken.  The reconciler echoes that token back in the
// index_changed event's selfToken field.  If the event carries our token, the
// change came from us — no conflict.
//
// Hash comparison: we store a simple hash of the last-loaded text so we can
// detect whether the on-disk version actually changed content (not just mtime).
// Using djb2 — fast, dependency-free, collision-acceptable for this UX case.

export type ConflictState =
  | { status: "idle" }
  | { status: "conflict"; diskText: string; bufferText: string };

export interface BufferTracker {
  /** The entry id currently open, or null. */
  entryId: string | null;
  /** Hash of the text we last loaded from disk. */
  lastLoadedHash: number;
  /** The exact text we last loaded (needed to build the diff). */
  lastLoadedText: string;
  /** True when the editor has unsaved changes since the last load. */
  dirtySinceLoad: boolean;
  /** The selfToken returned by the most recent write_entry call. */
  lastWriteToken: string | null;
}

export function makeTracker(): BufferTracker {
  return {
    entryId: null,
    lastLoadedHash: 0,
    lastLoadedText: "",
    dirtySinceLoad: false,
    lastWriteToken: null,
  };
}

/** djb2 hash — fast, good enough for UX-level duplicate detection. */
export function hashText(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    // (h << 5) + h + charCode  ===  h * 33 + charCode
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return h;
}

/** Call this after a successful read_entry / initial load. */
export function onLoaded(tracker: BufferTracker, entryId: string, text: string): BufferTracker {
  return {
    ...tracker,
    entryId,
    lastLoadedHash: hashText(text),
    lastLoadedText: text,
    dirtySinceLoad: false,
    lastWriteToken: null,
  };
}

/** Call this on every doc change from the editor. */
export function onEditorChange(tracker: BufferTracker): BufferTracker {
  if (tracker.dirtySinceLoad) return tracker; // already dirty — avoid re-allocating
  return { ...tracker, dirtySinceLoad: true };
}

/** Call this after write_entry succeeds to record the returned selfToken. */
export function onWriteComplete(tracker: BufferTracker, selfToken: string): BufferTracker {
  return { ...tracker, lastWriteToken: selfToken };
}

/**
 * Called when an index_changed event arrives for the currently open entry.
 *
 * Returns one of:
 *  - { action: "ignore" }                  — self-originated, no-op
 *  - { action: "reload" }                  — buffer clean, caller should re-read + replace doc
 *  - { action: "banner", diskText: string }  — buffer dirty, caller shows the conflict banner
 */
export type ConflictDecision =
  | { action: "ignore" }
  | { action: "reload" }
  | { action: "banner"; diskText: string };

export async function onIndexChanged(
  tracker: BufferTracker,
  eventEntryPath: string,
  eventSelfToken: string | undefined,
  readEntry: (id: string) => Promise<string | null>,
): Promise<ConflictDecision> {
  if (!tracker.entryId) return { action: "ignore" };

  // Check if this event is for the open entry (event carries a path; entry id
  // may differ by extension — normalise by stripping .md suffix).
  const openPath = tracker.entryId.endsWith(".md")
    ? tracker.entryId
    : tracker.entryId + ".md";
  if (eventEntryPath !== openPath && eventEntryPath !== tracker.entryId) {
    return { action: "ignore" };
  }

  // Self-originated write — suppress.
  if (eventSelfToken && tracker.lastWriteToken && eventSelfToken === tracker.lastWriteToken) {
    return { action: "ignore" };
  }

  // Read current disk content.
  const diskText = await readEntry(tracker.entryId);
  if (diskText === null) return { action: "ignore" };

  // If disk content is identical to what we loaded, nothing to do.
  if (hashText(diskText) === tracker.lastLoadedHash) return { action: "ignore" };

  if (!tracker.dirtySinceLoad) {
    return { action: "reload" };
  }

  return { action: "banner", diskText };
}

// ── Diff ──────────────────────────────────────────────────────────────────────

export type DiffLineKind = "unchanged" | "added" | "removed";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 1-based line number in the "mine" side (absent for added lines). */
  mineLine?: number;
  /** 1-based line number in the "disk" side (absent for removed lines). */
  diskLine?: number;
}

/**
 * Produce a unified line-level diff between bufferText (mine) and diskText.
 *
 * Uses the patience-diff observation that common lines form the backbone;
 * here we use a simple O(n*m) LCS over lines — acceptable for typical note
 * sizes (< a few thousand lines).
 */
export function diffLines(mine: string, disk: string): DiffLine[] {
  const mineLines = mine.split("\n");
  const diskLines = disk.split("\n");
  const m = mineLines.length;
  const n = diskLines.length;

  // LCS length table.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (mineLines[i] === diskLines[j]) {
        dp[i][j] = 1 + dp[i + 1][j + 1];
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  // Trace back.
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let mLineNum = 1;
  let dLineNum = 1;

  while (i < m || j < n) {
    if (i < m && j < n && mineLines[i] === diskLines[j]) {
      result.push({ kind: "unchanged", text: mineLines[i], mineLine: mLineNum, diskLine: dLineNum });
      i++;
      j++;
      mLineNum++;
      dLineNum++;
    } else if (j < n && (i >= m || dp[i + 1][j] <= dp[i][j + 1])) {
      result.push({ kind: "added", text: diskLines[j], diskLine: dLineNum });
      j++;
      dLineNum++;
    } else {
      result.push({ kind: "removed", text: mineLines[i], mineLine: mLineNum });
      i++;
      mLineNum++;
    }
  }

  return result;
}

// ── SessionStorage backup ─────────────────────────────────────────────────────

const SS_PREFIX = "tnd-conflict-backup:";

/**
 * Stash the current buffer text to sessionStorage before overwriting it with
 * disk content (use-disk action). Cheap insurance against accidental data loss.
 * The key encodes the entry id so multiple open sessions don't collide.
 */
export function stashBufferBackup(entryId: string, text: string): void {
  try {
    sessionStorage.setItem(SS_PREFIX + entryId, text);
  } catch {
    // sessionStorage may be unavailable in tests / private mode — ignore.
  }
}

/** Retrieve the stashed backup text (returns null if absent). */
export function getBufferBackup(entryId: string): string | null {
  try {
    return sessionStorage.getItem(SS_PREFIX + entryId);
  } catch {
    return null;
  }
}

/** Remove the backup once it's no longer needed (keep-mine resolved). */
export function clearBufferBackup(entryId: string): void {
  try {
    sessionStorage.removeItem(SS_PREFIX + entryId);
  } catch {
    // ignore
  }
}
