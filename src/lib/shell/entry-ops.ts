// entry-ops.ts — pure helpers for archive and duplicate entry operations.
// Extracted so they can be tested without IPC side-effects.

/**
 * Apply or remove the `archived: true` frontmatter property in the given text.
 *
 * Rules:
 *   archive=true  → set `archived: true` (replacing existing line, or inserting after opening ---)
 *   archive=false → remove any `archived:` line
 */
export function applyArchiveToText(text: string, archive: boolean): string {
  const archivedLine = /^archived:\s*.+$/m;
  if (archive) {
    if (archivedLine.test(text)) {
      return text.replace(archivedLine, "archived: true");
    }
    return text.replace(/^(---\n)/, "$1archived: true\n");
  }
  return text.replace(/^archived:.*\n?/m, "");
}

/**
 * Determine the next free duplicate id for `entryId` given a set of existing ids.
 *
 * Strategy: strip a trailing `-<digits>` from the base slug, then try `-2`, `-3`, …
 * until a free slot is found.
 */
export function nextDuplicateId(entryId: string, existing: ReadonlySet<string>): string {
  const base = entryId.replace(/-(\d+)$/, "");
  let n = 2;
  let newId = `${base}-${n}`;
  while (existing.has(newId)) {
    n++;
    newId = `${base}-${n}`;
  }
  return newId;
}
