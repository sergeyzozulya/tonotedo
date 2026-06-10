// Frontmatter fold (design-0003 §Decoration layers, layer 1).
//
// A document-start YAML block (`---` … `---`) renders as a single collapsed
// affordance line. The real frontmatter editing surface is the properties panel
// (0006, issue #15); here we only fold it out of the prose flow. Consistent with
// cursor-reveal semantics, moving the selection head into the block reveals the
// raw YAML.
//
// This is always at the document start and is at most a few dozen lines, so it
// is computed as a StateField over the whole document (not viewport-bound). The
// replace decoration is atomic so the cursor skips over the folded line rather
// than landing inside hidden YAML.
//
// Detection rules (kept deliberately simple — this is the architecture layer,
// not a YAML parser):
//   - The very first line must be exactly `---` (after optional trailing space).
//   - The block closes at the next line that is exactly `---`.
//   - No closing fence → no frontmatter (the leading `---` is just an <hr> /
//     thematic break in the body), so nothing is folded.
//   - A block with no body lines between the fences is still a valid (empty)
//     frontmatter region and folds.

import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { StateField, RangeSetBuilder } from "@codemirror/state";
import type { EditorState, Extension, Range } from "@codemirror/state";

/** Region of the document occupied by the frontmatter block, fences included. */
export interface FrontmatterRegion {
  /** Offset of the opening `---` (always 0 when present). */
  from: number;
  /** Offset just past the closing `---` line (excluding its trailing newline). */
  to: number;
}

const FENCE_RE = /^---\s*$/;

/**
 * Detect the document-start frontmatter region, or `null` if there is none.
 * Pure and DOM-free — unit-tested directly (no-frontmatter and unclosed cases).
 */
export function detectFrontmatter(state: EditorState): FrontmatterRegion | null {
  const doc = state.doc;
  if (doc.lines < 2) return null;
  const first = doc.line(1);
  if (!FENCE_RE.test(first.text)) return null;

  for (let n = 2; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (FENCE_RE.test(line.text)) {
      return { from: first.from, to: line.to };
    }
  }
  // Opening fence with no closing fence → not frontmatter.
  return null;
}

/** The collapsed affordance shown in place of the YAML block. */
class FrontmatterWidget extends WidgetType {
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-tnd-frontmatter-fold";
    el.textContent = "⚙ Properties";
    el.setAttribute("aria-label", "Frontmatter properties (collapsed)");
    return el;
  }
  ignoreEvent(): boolean {
    // Let clicks through so a later layer (#15) can open the properties panel.
    return false;
  }
}

const frontmatterReplace = Decoration.replace({
  widget: new FrontmatterWidget(),
  block: true,
  inclusive: false,
});

/** True if any selection head lies within [from, to]. */
function headInside(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) {
    if (r.head >= from && r.head <= to) return true;
  }
  return false;
}

/** Build the fold decoration set for the current state (empty when revealed). */
export function computeFrontmatterDecorations(state: EditorState): DecorationSet {
  const region = detectFrontmatter(state);
  const builder = new RangeSetBuilder<Decoration>();
  if (region && !headInside(state, region.from, region.to)) {
    builder.add(region.from, region.to, frontmatterReplace);
  }
  return builder.finish();
}

/**
 * StateField holding the frontmatter fold decoration. Recomputed on any
 * transaction (doc or selection change); the work is bounded by the block size.
 */
const frontmatterField = StateField.define<DecorationSet>({
  create: (state) => computeFrontmatterDecorations(state),
  update: (value, tr) => {
    if (tr.docChanged || tr.selection) return computeFrontmatterDecorations(tr.state);
    return value;
  },
  provide: (field) => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of((view) => view.state.field(field)),
  ],
});

export const frontmatterFold: Extension = frontmatterField;

// Re-export Range for tests that assert over the decoration set.
export type { Range };
