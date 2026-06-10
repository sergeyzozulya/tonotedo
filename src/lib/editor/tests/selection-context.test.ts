import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";

import { markdownExtension } from "../extensions/markdown.js";
import { selectionContext } from "../selection-context.js";

function ctxAt(doc: string, head: number) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(head),
    extensions: [markdownExtension],
  });
  return selectionContext(state);
}

describe("selectionContext", () => {
  const doc = "---\ntitle: x\n---\n\nsee #tag and @me here";

  it("reports inFrontmatter when the head is inside the YAML block", () => {
    expect(ctxAt(doc, 5).inFrontmatter).toBe(true);
  });

  it("reports not-in-frontmatter when the head is in the body", () => {
    expect(ctxAt(doc, doc.length).inFrontmatter).toBe(false);
  });

  it("reports the active token the head touches", () => {
    const tagPos = doc.indexOf("#tag") + 1;
    const ctx = ctxAt(doc, tagPos);
    expect(ctx.activeTokens).toHaveLength(1);
    expect(ctx.activeTokens[0]).toMatchObject({ kind: "tag", text: "#tag" });
  });

  it("reports no active tokens when the head is in plain prose", () => {
    const pos = doc.indexOf("see ") + 1;
    expect(ctxAt(doc, pos).activeTokens).toEqual([]);
  });
});
