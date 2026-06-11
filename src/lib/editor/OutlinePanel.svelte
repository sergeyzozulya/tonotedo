<script lang="ts">
  // Outline / TOC sidebar (spec 0006 §Outline). Opt-in panel listing the open
  // entry's headings; clicking a heading scrolls the editor to it. Toggle state
  // is a UI boolean owned by the shell — nothing is persisted to the entry file.

  import { extractHeadings } from "./outline.js";
  import { getActiveEditorView } from "./active-view.js";
  import { EditorSelection } from "@codemirror/state";
  import { EditorView } from "@codemirror/view";

  interface Props {
    /** Current document text; outline is derived reactively from it. */
    docText: string;
  }

  let { docText }: Props = $props();

  const headings = $derived(extractHeadings(docText));

  function goTo(pos: number): void {
    const view = getActiveEditorView();
    if (!view) return;
    const at = Math.min(pos, view.state.doc.length);
    view.dispatch({
      selection: EditorSelection.cursor(at),
      effects: EditorView.scrollIntoView(at, { y: "start" }),
    });
    view.focus();
  }
</script>

<aside class="outline" aria-label="Outline">
  <div class="outline-header">Outline</div>
  {#if headings.length === 0}
    <div class="outline-empty">No headings</div>
  {:else}
    <nav>
      {#each headings as h (h.pos)}
        <button
          class="outline-item"
          style="padding-left: calc(0.5rem + {(h.level - 1) * 0.75}rem)"
          title={h.text}
          onclick={() => goTo(h.pos)}
        >
          {h.text}
        </button>
      {/each}
    </nav>
  {/if}
</aside>

<style>
  .outline {
    width: 200px;
    flex-shrink: 0;
    border-left: 1px solid var(--tnd-line);
    background: var(--tnd-panel);
    overflow-y: auto;
    font-family: var(--tnd-font-ui);
    padding: 0.5rem 0;
  }
  .outline-header {
    padding: 0 0.75rem 0.5rem;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--tnd-text-muted);
  }
  .outline-empty {
    padding: 0 0.75rem;
    font-size: 13px;
    color: var(--tnd-text-muted);
  }
  .outline-item {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    padding: 0.2rem 0.5rem;
    font: inherit;
    font-size: 13px;
    color: var(--tnd-text);
    cursor: pointer;
    border-radius: var(--tnd-radius);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .outline-item:hover {
    background: var(--tnd-panel2);
  }
</style>
