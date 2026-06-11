// Outline / TOC extraction (spec 0006 §Outline).
//
// "Long entries can opt into an outline / TOC sidebar listing the entry's
// headings." The toggle is per-entry UI state, not stored in the file (a single
// UI boolean in the shell). This module derives the heading list from the
// document text: ATX headings (`#`..`######`) at line start, skipping fenced
// code blocks and the leading YAML frontmatter so `#` lines inside them are not
// mistaken for headings.

export interface OutlineHeading {
  /** Heading depth 1–6. */
  level: number;
  /** Heading text with the leading `#`s and surrounding whitespace stripped. */
  text: string;
  /** Character offset of the heading line start in the document. */
  pos: number;
}

const ATX_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * Extract the ATX headings from markdown `doc`, in document order. Fenced code
 * blocks and a leading `---` frontmatter block are skipped so their `#` lines
 * are not treated as headings.
 */
export function extractHeadings(doc: string): OutlineHeading[] {
  const out: OutlineHeading[] = [];
  let offset = 0;
  let inFence = false;
  let inFrontmatter = false;
  let lineIndex = 0;

  const lines = doc.split("\n");
  for (const line of lines) {
    // Leading frontmatter: opens on a line-1 `---`, closes on the next `---`.
    if (lineIndex === 0 && line.trim() === "---") {
      inFrontmatter = true;
    } else if (inFrontmatter && line.trim() === "---") {
      inFrontmatter = false;
      offset += line.length + 1;
      lineIndex += 1;
      continue;
    }

    if (!inFrontmatter) {
      if (FENCE_RE.test(line)) {
        inFence = !inFence;
      } else if (!inFence) {
        const m = ATX_RE.exec(line);
        if (m) {
          out.push({ level: m[1].length, text: m[2].trim(), pos: offset });
        }
      }
    }

    offset += line.length + 1; // + newline
    lineIndex += 1;
  }

  return out;
}
