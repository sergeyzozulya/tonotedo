// Bare-wikilink ambiguity resolution (spec 0006 §Wikilinks, spec 0003 §Wikilink
// target).
//
// Resolution order: entry by slug → group by name → ambiguous. Slugs are unique
// only per group (spec 0002), so a hand-written bare `[[slug]]` is ambiguous
// when more than one entry carries that slug, or an entry slug clashes with a
// group name. "The picker writes the qualified form automatically on ambiguity;
// a hand-written bare `[[slug]]` that is ambiguous prompts the UI on first
// resolution" and the resolved link is stored path-qualified.
//
// Pure & DOM-free so the resolution rules are unit-testable. Entry ids and group
// paths are path-qualified (e.g. "work/atlas/meeting-notes", "work/atlas"); the
// slug / group name is the last path segment.

export interface WikilinkCandidate {
  /** The path-qualified target to store, e.g. "work/atlas/meeting-notes". */
  target: string;
  /** "entry" or "group" — drives the picker's icon / label. */
  kind: "entry" | "group";
  /** Display title (entry title or group name) for the picker row. */
  label: string;
}

export type WikilinkResolution =
  | { status: "unique"; target: string; kind: "entry" | "group" }
  | { status: "ambiguous"; candidates: WikilinkCandidate[] }
  | { status: "none" };

/** The last path segment of a qualified id/path (the bare slug / group name). */
function lastSegment(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

export interface ResolveInput {
  /** The raw wikilink target as written (may be bare or already qualified). */
  target: string;
  /** entryId → title for every entry in the library. */
  entryTitles: Map<string, string>;
  /** Every group path in the library (e.g. "work", "work/atlas"). */
  groupPaths: readonly string[];
}

/**
 * Resolve a wikilink target to a unique path-qualified destination, the set of
 * ambiguous candidates, or nothing.
 *
 * An already-qualified target (one that exactly matches an entry id or group
 * path) resolves uniquely. A bare target collects every entry whose slug matches
 * and every group whose name matches; one match → unique, more than one →
 * ambiguous, zero → none.
 */
export function resolveWikilink(input: ResolveInput): WikilinkResolution {
  const { target, entryTitles, groupPaths } = input;

  // Exact qualified match wins (this is the form the picker stored earlier).
  if (entryTitles.has(target)) return { status: "unique", target, kind: "entry" };
  if (groupPaths.includes(target)) return { status: "unique", target, kind: "group" };

  // Bare target: collect candidates by last-segment match.
  const candidates: WikilinkCandidate[] = [];
  for (const [id, title] of entryTitles) {
    if (lastSegment(id) === target) {
      candidates.push({ target: id, kind: "entry", label: title });
    }
  }
  for (const path of groupPaths) {
    if (lastSegment(path) === target) {
      candidates.push({ target: path, kind: "group", label: lastSegment(path) });
    }
  }

  if (candidates.length === 0) return { status: "none" };
  if (candidates.length === 1) {
    return { status: "unique", target: candidates[0].target, kind: candidates[0].kind };
  }
  return { status: "ambiguous", candidates };
}
