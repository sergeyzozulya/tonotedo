// entry-ops.ts — pure helpers for archive and duplicate entry operations.
// Extracted so they can be tested without IPC side-effects.
//
// All frontmatter manipulation here is scoped to the leading `---` block only:
// body lines that merely look like frontmatter (e.g. a literal "id: …" in a
// code sample) must never be touched.

/** Match the leading frontmatter block: open fence, inner, close fence. */
const FM_BLOCK = /^(---\n)([\s\S]*?)(\n---\n?)/;

/**
 * Apply or remove the `archived: true` frontmatter property in the given text.
 *
 * Rules:
 *   archive=true  → set `archived: true` (replacing existing line, or inserting after opening ---)
 *   archive=false → remove any `archived:` line
 *
 * Entries without a frontmatter block are returned unchanged (the app always
 * writes one, so this only guards hand-authored files).
 */
export function applyArchiveToText(text: string, archive: boolean): string {
  const m = text.match(FM_BLOCK);
  if (!m) return text;
  const inner = m[2];
  let nextInner: string;
  if (archive) {
    if (/^archived:\s*.+$/m.test(inner)) {
      nextInner = inner.replace(/^archived:\s*.+$/m, "archived: true");
    } else {
      nextInner = `archived: true\n${inner}`;
    }
  } else {
    nextInner = inner
      .split("\n")
      .filter((l) => !/^archived:/.test(l))
      .join("\n");
  }
  return m[1] + nextInner + m[3] + text.slice(m[0].length);
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

/**
 * Build the text for a duplicate of an entry: strip `id`/`created`/`updated`
 * from the frontmatter (the write path assigns fresh timestamps) and insert a
 * fresh id line. Only the frontmatter block is touched.
 */
export function prepareDuplicateText(text: string, newId: string): string {
  const newIdLine = `id: ${newId.split("/").at(-1)}-copy`;
  const m = text.match(FM_BLOCK);
  if (!m) {
    return `---\n${newIdLine}\n---\n${text}`;
  }
  const kept = m[2].split("\n").filter((l) => !/^(id|created|updated):/.test(l));
  const inner = [newIdLine, ...kept].join("\n");
  return m[1] + inner + m[3] + text.slice(m[0].length);
}
