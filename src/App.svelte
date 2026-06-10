<script lang="ts">
  import { Editor, type SelectionContext } from "./lib/editor/index.js";

  const sample = `---
title: Phase 3 demo
tags: [editor, demo]
---

# ToNoteDo editor

Live-inline rendering over a **byte-faithful** buffer. Move the cursor into
*emphasis* or a heading to reveal the raw markdown.

A #tag, a #project/atlas hierarchy tag, a @sergey mention (but email@host is
not one), and a [[meeting-notes|wikilink]].

\`\`\`ts
// tokens inside code are not parsed: #nope @nope [[nope]]
const x = 1;
\`\`\`

- [ ] a task
- [x] a done task
`;

  let ctx = $state<SelectionContext>({ inFrontmatter: false, activeTokens: [] });
</script>

<main>
  <header>
    <h1>ToNoteDo — editor core</h1>
    <small>
      frontmatter: {ctx.inFrontmatter ? "yes" : "no"} · active tokens:
      {ctx.activeTokens.map((t) => t.text).join(", ") || "none"}
    </small>
  </header>
  <div class="editor">
    <Editor doc={sample} settings={{ lineWidth: "44rem" }} onSelectionContext={(c) => (ctx = c)} />
  </div>
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    height: 100vh;
    font-family: ui-sans-serif, system-ui, sans-serif;
  }
  header {
    padding: 0.5rem 1rem;
    border-bottom: 1px solid rgba(0, 0, 0, 0.1);
  }
  header h1 {
    margin: 0;
    font-size: 1rem;
  }
  header small {
    color: #666;
  }
  .editor {
    flex: 1;
    min-height: 0;
  }
</style>
