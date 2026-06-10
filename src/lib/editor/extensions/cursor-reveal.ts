// Cursor-reveal: the live-inline rendering layer (design-0003 §Decoration
// layers, layer 2; the core deliverable of issue #11).
//
// Model (spec 0006 §Rendering model): the buffer is byte-faithful; every visual
// effect is a decoration. Formatted rendering hides syntax markers; when the
// selection head touches a token, raw markdown is revealed for that region.
//
//   - Block syntax (headings): reveal is LINE-LEVEL. The `# ` marker is hidden
//     (replace decoration) and the heading text styled, unless the selection
//     head sits anywhere on the heading's line.
//   - Inline syntax (emphasis, strong, strikethrough, inline code, links): reveal
//     is RANGE-LEVEL. The delimiter marks (`**`, `` ` ``, `[`, `](url)`) are
//     hidden unless the selection head is within the node's range.
//   - Custom tokens (#tag, @mention, [[wikilink]]): a simple styled mark for now
//     (chips are #12). Revealed (mark dropped) when the selection head touches.
//
// Performance: the computation runs over supplied ranges only (the ViewPlugin
// passes `view.visibleRanges`), and recomputes only on doc / selection / viewport
// change. The pure `computeRevealDecorations(state, ranges)` entry point is
// state-level and DOM-free, so it is unit-tested headlessly.

import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import type { EditorState, Range } from "@codemirror/state";

import { TAG_NODE, MENTION_NODE, WIKILINK_NODE } from "./inline-tokens.js";

/** A region of the document the computation should consider. */
export interface ViewportRange {
  from: number;
  to: number;
}

// ── Decoration primitives ────────────────────────────────────────────────────

/** Hide a marker span entirely (no widget — chips/affordances come later). */
const hideMark = Decoration.replace({});

const headingLineDeco = (level: number) =>
  Decoration.line({ class: `cm-tnd-heading cm-tnd-h${level}` });

const tagMark = Decoration.mark({ class: "cm-tnd-tag" });
const mentionMark = Decoration.mark({ class: "cm-tnd-mention" });
const wikilinkMark = Decoration.mark({ class: "cm-tnd-wikilink" });

// ── Helpers ──────────────────────────────────────────────────────────────────

/** True if any selection head lies within [from, to] (range-level reveal). */
function headInRange(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) {
    if (r.head >= from && r.head <= to) return true;
  }
  return false;
}

/** True if any selection head lies on the line spanning [lineFrom, lineTo]. */
function headOnLine(state: EditorState, lineFrom: number, lineTo: number): boolean {
  return headInRange(state, lineFrom, lineTo);
}

const HEADING_RE = /^ATXHeading([1-6])$/;

// The actual marker leaf nodes the markdown grammar emits. Their enclosing
// token (Emphasis/StrongEmphasis/InlineCode/Link/Strikethrough) is the parent.
const INLINE_MARK_NODES = new Set(["EmphasisMark", "CodeMark", "LinkMark", "StrikethroughMark"]);

// ── Core computation ─────────────────────────────────────────────────────────

interface PendingDeco {
  from: number;
  to: number;
  deco: Decoration;
}

/**
 * Compute reveal decorations for the given state over the supplied ranges.
 * Pure and DOM-free — the heart of the layer, unit-tested directly.
 */
export function computeRevealDecorations(
  state: EditorState,
  ranges: readonly ViewportRange[],
): DecorationSet {
  const pending: PendingDeco[] = [];
  const tree = syntaxTree(state);

  for (const { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;

        // ── Headings: line-level reveal ──────────────────────────────────────
        const h = HEADING_RE.exec(name);
        if (h) {
          const line = state.doc.lineAt(node.from);
          const reveal = headOnLine(state, line.from, line.to);
          if (!reveal) {
            pending.push({ from: line.from, to: line.from, deco: headingLineDeco(Number(h[1])) });
            // Hide the leading `#`s and the single following space.
            const text = state.doc.sliceString(node.from, node.to);
            const m = /^#{1,6}\s/.exec(text);
            const markerEnd = m ? node.from + m[0].length : node.from;
            if (markerEnd > node.from) {
              pending.push({ from: node.from, to: markerEnd, deco: hideMark });
            }
          }
          return;
        }

        // ── Custom tokens: range-level reveal, styled mark when hidden ───────
        if (name === TAG_NODE || name === MENTION_NODE || name === WIKILINK_NODE) {
          if (headInRange(state, node.from, node.to)) return; // reveal raw
          const mark =
            name === TAG_NODE ? tagMark : name === MENTION_NODE ? mentionMark : wikilinkMark;
          pending.push({ from: node.from, to: node.to, deco: mark });
          return;
        }

        // ── Inline syntax markers: hide unless head is in the parent token ───
        if (INLINE_MARK_NODES.has(name)) {
          // The marker's enclosing token is its parent (Emphasis, InlineCode, …).
          const parent = node.node.parent;
          const tokFrom = parent ? parent.from : node.from;
          const tokTo = parent ? parent.to : node.to;
          if (headInRange(state, tokFrom, tokTo)) return; // reveal raw markers
          pending.push({ from: node.from, to: node.to, deco: hideMark });
          return;
        }

        // ── Link URL/title tail: hide `(url)` unless head is in the link ─────
        if (name === "URL") {
          const parent = node.node.parent; // Link
          if (parent && parent.name === "Link") {
            if (headInRange(state, parent.from, parent.to)) return;
            // Hide from the closing `]` through the URL's end is handled by the
            // LinkMark cases; here we hide the URL text and its wrapping marks
            // are LinkMark nodes already hidden above. Hide the URL itself.
            pending.push({ from: node.from, to: node.to, deco: hideMark });
          }
          return;
        }
      },
    });
  }

  // RangeSetBuilder requires sorted, side-ordered input. Line decorations sit at
  // a line start (from === to) and must come before any mark/replace at the same
  // position; sort by (from, to) then by startSide so zero-length line decos win.
  pending.sort((a, b) => a.from - b.from || a.to - b.to || decoSide(a.deco) - decoSide(b.deco));

  const builder = new RangeSetBuilder<Decoration>();
  for (const p of pending) builder.add(p.from, p.to, p.deco);
  return builder.finish();
}

/** Order hint so line decorations (block) precede inline ones at the same pos. */
function decoSide(deco: Decoration): number {
  // Decoration extends RangeValue, which carries `startSide`. Line decorations
  // use a large-negative side, so they sort before mark/replace at the same pos.
  const side = (deco as unknown as { startSide?: number }).startSide;
  return typeof side === "number" ? side : 0;
}

// ── ViewPlugin wiring ────────────────────────────────────────────────────────

/**
 * The cursor-reveal ViewPlugin. Recomputes viewport-only decorations on doc,
 * selection, or viewport change — nothing else triggers a rebuild.
 */
export const cursorReveal = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = computeRevealDecorations(view.state, view.visibleRanges);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = computeRevealDecorations(update.state, update.view.visibleRanges);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    // Atomic ranges so cursor motion treats hidden markers as a unit — arrowing
    // does not land "inside" a hidden `**`. The atomic set IS the decoration set.
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
  },
);

// Re-export the Range type for tests that build decoration arrays by hand.
export type { Range };
