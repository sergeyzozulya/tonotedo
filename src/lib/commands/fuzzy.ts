// Fuzzy matching utility for the command palette.
//
// Lightweight implementation that doesn't need a heavy dependency.
// Strategy: consecutive-character subsequence match with a ranking score.
// Higher score = better match.

export interface FuzzyMatch {
  /** Indices of matched characters in the target string (for highlight). */
  indices: number[];
  /** Ranking score — higher is better. */
  score: number;
}

/**
 * Test whether `query` matches `target` as a fuzzy subsequence, and if so,
 * return match data. Returns null on no match.
 *
 * Scoring bonuses:
 *   +10 per match at word boundary (start, after space/dash/dot)
 *   +5  per consecutive match
 *   +3  per start-of-string match
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (!query) return { indices: [], score: 0 };

  const q = query.toLowerCase();
  const t = target.toLowerCase();

  const indices: number[] = [];
  let qi = 0;
  let score = 0;
  let lastMatch = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      indices.push(ti);
      score += 1;

      // Bonus: word boundary
      if (ti === 0 || /[\s\-_.]/.test(t[ti - 1])) score += 10;
      // Bonus: start of string
      if (ti === 0) score += 3;
      // Bonus: consecutive match
      if (lastMatch === ti - 1) score += 5;

      lastMatch = ti;
      qi++;
    }
  }

  if (qi < q.length) return null; // not all chars matched
  return { indices, score };
}

export interface RankedCommand<T> {
  item: T;
  match: FuzzyMatch;
}

/**
 * Rank a list of items by fuzzy match score. Returns only matching items,
 * sorted by score descending (best first).
 */
export function rankByFuzzy<T>(
  query: string,
  items: T[],
  getText: (item: T) => string,
): RankedCommand<T>[] {
  if (!query) {
    // No query: return all with score 0.
    return items.map((item) => ({ item, match: { indices: [], score: 0 } }));
  }

  const results: RankedCommand<T>[] = [];
  for (const item of items) {
    const m = fuzzyMatch(query, getText(item));
    if (m) results.push({ item, match: m });
  }
  results.sort((a, b) => b.match.score - a.match.score);
  return results;
}

/**
 * Highlight a string by wrapping matched indices in <mark> tags.
 * Returns an array of {text, highlight} segments for rendering in Svelte.
 */
export interface TextSegment {
  text: string;
  highlight: boolean;
}

export function highlightSegments(text: string, indices: number[]): TextSegment[] {
  if (indices.length === 0) return [{ text, highlight: false }];

  const indexSet = new Set(indices);
  const segments: TextSegment[] = [];
  let current = "";
  let inHighlight = false;

  for (let i = 0; i < text.length; i++) {
    const shouldHighlight = indexSet.has(i);
    if (shouldHighlight !== inHighlight) {
      if (current) segments.push({ text: current, highlight: inHighlight });
      current = "";
      inHighlight = shouldHighlight;
    }
    current += text[i];
  }
  if (current) segments.push({ text: current, highlight: inHighlight });

  return segments;
}
