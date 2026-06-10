// query-parse.ts — Free-text query parser for the search overlay (spec 0009).
//
// Grammar (v1):
//   query    = token*
//   token    = quoted | term
//   quoted   = '"' [^"]* '"'
//   term     = non-whitespace+
//
// Multiple tokens are AND — all must match.
// Quoted phrases require an exact substring match.
// Plain terms are case-insensitive substring matches.
//
// Parsing is client-side for the mock. The real SQLite backend handles FTS5
// natively; this module is used only when the mock IPC is active.

export interface ParsedQuery {
  /** Plain terms (case-insensitive substring match required). */
  terms: string[];
  /** Exact phrases (verbatim substring match required). */
  phrases: string[];
}

/**
 * Parse a raw search string into terms and quoted phrases.
 *
 * @example
 * parseQuery('atlas budget "end of quarter"')
 * // → { terms: ["atlas", "budget"], phrases: ["end of quarter"] }
 */
export function parseQuery(raw: string): ParsedQuery {
  const terms: string[] = [];
  const phrases: string[] = [];

  let i = 0;
  const s = raw.trim();

  while (i < s.length) {
    // Skip whitespace
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;

    if (s[i] === '"') {
      // Quoted phrase: collect until closing quote or end of string
      i++; // skip opening "
      let start = i;
      while (i < s.length && s[i] !== '"') i++;
      const phrase = s.slice(start, i).trim();
      if (phrase.length > 0) phrases.push(phrase);
      if (i < s.length) i++; // skip closing "
    } else {
      // Plain term: collect until whitespace
      let start = i;
      while (i < s.length && !/\s/.test(s[i])) i++;
      const term = s.slice(start, i).toLowerCase();
      if (term.length > 0) terms.push(term);
    }
  }

  return { terms, phrases };
}

/**
 * Test whether `text` satisfies a parsed query.
 * All terms and phrases must match (AND semantics).
 *
 * @param text  The haystack (entry title + body concatenated, lowercased).
 * @param query Parsed query from parseQuery().
 */
export function matchesQuery(text: string, query: ParsedQuery): boolean {
  const lower = text.toLowerCase();

  for (const term of query.terms) {
    if (!lower.includes(term)) return false;
  }

  for (const phrase of query.phrases) {
    // Phrase match is case-insensitive (normalise both sides).
    if (!lower.includes(phrase.toLowerCase())) return false;
  }

  return true;
}

/** Convenience: parse + test in one call. */
export function queryMatches(raw: string, text: string): boolean {
  if (!raw.trim()) return true; // empty query matches everything
  return matchesQuery(text, parseQuery(raw));
}
