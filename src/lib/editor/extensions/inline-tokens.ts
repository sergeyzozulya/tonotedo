// Custom inline tokens: #tag, @mention, [[wikilink]].
//
// Two layers live here:
//
//   1. A pure, dependency-free scanner (`scanLine`) that mirrors the Rust body
//      scanner in `src-tauri/src/core/index/scanner.rs` (`scan_stripped`). It is
//      the parity reference the tokenization tests pin, and it is reused by the
//      cursor-reveal layer to find token ranges without walking the Lezer tree
//      for these custom nodes.
//
//   2. A Lezer `MarkdownConfig` (`customTokens`) that registers three inline
//      parsers so the same tokens become first-class nodes in the syntax tree.
//      Lezer does not run inline parsers inside fenced code blocks or inline
//      code spans, so code suppression (spec 0005 §Edge cases, applied uniformly
//      per design-0003) comes for free at the parser layer — verified in tests.
//
// Spec refs:
//   - docs/spec/0004-tags.md §Form      — charset letters/digits/-/_// , hierarchy
//   - docs/spec/0005-mentions.md §Form  — charset letters/digits/-/_ , word boundary
//   - docs/spec/0006-markdown-editor.md — wikilink [[target|display]], qualified targets
//
// Parity note vs the Rust scanner: the Rust scanner is line-based and strips
// inline code with a character scan before tokenizing; the Lezer layer gets the
// same suppression structurally. `scanLine` matches `scan_stripped` exactly —
// it assumes its input is a single already-code-stripped line.

import type { MarkdownConfig, InlineContext } from "@lezer/markdown";

/** Node type names contributed to the Lezer tree. */
export const TAG_NODE = "TndTag";
export const MENTION_NODE = "TndMention";
export const WIKILINK_NODE = "TndWikiLink";

export type TokenKind = "tag" | "mention" | "wikilink";

/** A token found by the pure scanner, with offsets relative to the scanned string. */
export interface ScannedToken {
  kind: TokenKind;
  /** Start offset of the whole literal (the leading `#`, `@`, or `[[`). */
  from: number;
  /** End offset of the whole literal (one past the last char / closing `]]`). */
  to: number;
  /**
   * The semantic value: tag slug, mention slug, or wikilink target (the text
   * before `|`, trimmed). Matches what the Rust scanner pushes into `Token`.
   */
  value: string;
}

const CC_HASH = 35; // #
const CC_AT = 64; // @
const CC_OPEN_BRACKET = 91; // [
const CC_CLOSE_BRACKET = 93; // ]

/** Word character for the word-boundary rule: letter, digit, or `_`. */
function isWordChar(cc: number): boolean {
  return isAlphaNum(cc) || cc === 95; // _
}

function isAlphaNum(cc: number): boolean {
  return (
    (cc >= 48 && cc <= 57) || // 0-9
    (cc >= 65 && cc <= 90) || // A-Z
    (cc >= 97 && cc <= 122) || // a-z
    cc > 127 // non-ASCII: treat as alphanumeric (Rust uses char::is_alphanumeric)
  );
}

/** Allowed in a tag slug: letters, digits, `-`, `_`, `/`. */
function isTagChar(cc: number): boolean {
  return isAlphaNum(cc) || cc === 45 || cc === 95 || cc === 47; // - _ /
}

/** Allowed in a mention slug: letters, digits, `-`, `_` (no slash). */
function isMentionChar(cc: number): boolean {
  return isAlphaNum(cc) || cc === 45 || cc === 95; // - _
}

/**
 * Scan a single (already inline-code-stripped) line for tokens.
 *
 * Direct port of `scan_stripped` in the Rust scanner. Operates on JS string
 * indices; tokens with astral characters keep code-unit offsets, which is what
 * CodeMirror positions use, so this is the correct unit for decorations.
 */
export function scanLine(text: string): ScannedToken[] {
  const tokens: ScannedToken[] = [];
  const n = text.length;
  let i = 0;

  while (i < n) {
    const cc = text.charCodeAt(i);

    // ── Wikilink: [[ ... ]] ────────────────────────────────────────────────
    if (cc === CC_OPEN_BRACKET && i + 1 < n && text.charCodeAt(i + 1) === CC_OPEN_BRACKET) {
      const start = i + 2;
      let j = start;
      while (
        j + 1 < n &&
        !(text.charCodeAt(j) === CC_CLOSE_BRACKET && text.charCodeAt(j + 1) === CC_CLOSE_BRACKET)
      ) {
        j += 1;
      }
      if (j + 1 < n) {
        const inner = text.slice(start, j);
        const pipe = inner.indexOf("|");
        const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
        if (target.length > 0) {
          tokens.push({ kind: "wikilink", from: i, to: j + 2, value: target });
        }
        i = j + 2;
        continue;
      }
    }

    // ── #tag ───────────────────────────────────────────────────────────────
    if (cc === CC_HASH) {
      const precededByWord = i > 0 && isWordChar(text.charCodeAt(i - 1));
      if (!precededByWord) {
        const start = i + 1;
        let j = start;
        while (j < n && isTagChar(text.charCodeAt(j))) j += 1;
        if (j > start) {
          tokens.push({ kind: "tag", from: i, to: j, value: text.slice(start, j) });
          i = j;
          continue;
        }
      }
    }

    // ── @mention ───────────────────────────────────────────────────────────
    if (cc === CC_AT) {
      // Word-boundary rule: must NOT be preceded by a word char, so
      // `email@host` is not a mention (the `@` follows a letter).
      const precededByWord = i > 0 && isWordChar(text.charCodeAt(i - 1));
      if (!precededByWord) {
        const start = i + 1;
        let j = start;
        while (j < n && isMentionChar(text.charCodeAt(j))) j += 1;
        if (j > start) {
          tokens.push({ kind: "mention", from: i, to: j, value: text.slice(start, j) });
          i = j;
          continue;
        }
      }
    }

    i += 1;
  }

  return tokens;
}

// ── Lezer inline parsers ───────────────────────────────────────────────────
//
// Each `parse(cx, next, pos)` is called per character. It returns -1 to decline
// or the end position of an added element. The word-boundary check reads the
// preceding character from the inline section via `cx.char(pos - 1)`; when `pos`
// is at the section start, `cx.char` returns -1, which `isWordChar` rejects, so
// a token at the very start of an inline run is allowed (matching the scanner's
// `i > 0` guard).

function precededByWordChar(cx: InlineContext, pos: number): boolean {
  if (pos <= cx.offset) return false;
  return isWordChar(cx.char(pos - 1));
}

const parseTag = {
  name: TAG_NODE,
  parse(cx: InlineContext, next: number, pos: number): number {
    if (next !== CC_HASH) return -1;
    if (precededByWordChar(cx, pos)) return -1;
    let end = pos + 1;
    while (end < cx.end && isTagChar(cx.char(end))) end += 1;
    if (end === pos + 1) return -1; // bare `#` is not a tag
    return cx.addElement(cx.elt(TAG_NODE, pos, end));
  },
};

const parseMention = {
  name: MENTION_NODE,
  parse(cx: InlineContext, next: number, pos: number): number {
    if (next !== CC_AT) return -1;
    if (precededByWordChar(cx, pos)) return -1; // email@host fails here
    let end = pos + 1;
    while (end < cx.end && isMentionChar(cx.char(end))) end += 1;
    if (end === pos + 1) return -1;
    return cx.addElement(cx.elt(MENTION_NODE, pos, end));
  },
};

const parseWikiLink = {
  name: WIKILINK_NODE,
  // Run before the standard Link parser so `[[` is claimed as a wikilink
  // rather than starting a normal `[` link delimiter.
  before: "Link",
  parse(cx: InlineContext, next: number, pos: number): number {
    if (next !== CC_OPEN_BRACKET || cx.char(pos + 1) !== CC_OPEN_BRACKET) return -1;
    let end = pos + 2;
    while (
      end + 1 < cx.end &&
      !(cx.char(end) === CC_CLOSE_BRACKET && cx.char(end + 1) === CC_CLOSE_BRACKET)
    ) {
      end += 1;
    }
    // Require a closing `]]`.
    if (
      !(
        end + 1 < cx.end &&
        cx.char(end) === CC_CLOSE_BRACKET &&
        cx.char(end + 1) === CC_CLOSE_BRACKET
      )
    ) {
      return -1;
    }
    const inner = cx.slice(pos + 2, end);
    const pipe = inner.indexOf("|");
    const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
    if (target.length === 0) return -1;
    return cx.addElement(cx.elt(WIKILINK_NODE, pos, end + 2));
  },
};

/**
 * Lezer MarkdownConfig adding the three custom inline tokens. Suppression inside
 * fenced/inline code is structural: the markdown parser does not invoke inline
 * parsers within those regions.
 */
export const customTokens: MarkdownConfig = {
  defineNodes: [TAG_NODE, MENTION_NODE, WIKILINK_NODE],
  parseInline: [parseTag, parseMention, parseWikiLink],
};
