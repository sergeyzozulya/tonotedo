// Selection context derivation for the editor↔Svelte boundary (design-0003
// §Interfaces). The component emits this on every selection change so the future
// properties panel (#15) and zone-aware commands (0007) can react. Pure and
// DOM-free so it is unit-testable and cheap to call per selection.

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

import { TAG_NODE, MENTION_NODE, WIKILINK_NODE } from "./extensions/inline-tokens.js";
import { detectFrontmatter } from "./extensions/frontmatter-fold.js";

export interface ActiveToken {
  kind: "tag" | "mention" | "wikilink";
  from: number;
  to: number;
  /** The literal text of the token, including its `#`/`@`/`[[`…`]]`. */
  text: string;
}

export interface SelectionContext {
  /** True when the primary selection head is inside the frontmatter region. */
  inFrontmatter: boolean;
  /** Custom tokens whose range the primary selection head currently touches. */
  activeTokens: ActiveToken[];
}

const TOKEN_NAMES: Record<string, ActiveToken["kind"]> = {
  [TAG_NODE]: "tag",
  [MENTION_NODE]: "mention",
  [WIKILINK_NODE]: "wikilink",
};

/** Derive the selection context for the primary selection of `state`. */
export function selectionContext(state: EditorState): SelectionContext {
  const head = state.selection.main.head;

  const fm = detectFrontmatter(state);
  const inFrontmatter = fm !== null && head >= fm.from && head <= fm.to;

  const activeTokens: ActiveToken[] = [];
  const tree = syntaxTree(state);
  tree.iterate({
    from: head,
    to: head,
    enter: (node) => {
      const kind = TOKEN_NAMES[node.name];
      if (kind && head >= node.from && head <= node.to) {
        activeTokens.push({
          kind,
          from: node.from,
          to: node.to,
          text: state.doc.sliceString(node.from, node.to),
        });
      }
    },
  });

  return { inFrontmatter, activeTokens };
}
