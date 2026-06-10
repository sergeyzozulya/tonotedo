<script lang="ts" module>
  // Public settings shape for the editor↔Svelte boundary (design-0003
  // §Interfaces). Theme tokens are CSS custom properties; the component applies
  // `font`, `lineWidth`, and any extra `--tnd-*` overrides onto the host element,
  // and theme.ts reads them via `var()`. The canonical token sheet (0011) is
  // owned by a sibling agent — these are per-instance overrides, not a palette.
  export interface EditorSettings {
    /** Font family for the editor content (maps to --tnd-editor-font). */
    font?: string;
    /** Max line width of the content column (maps to --tnd-editor-line-width). */
    lineWidth?: string;
    /**
     * Arbitrary `--tnd-*` overrides applied to the host element. Keys may be
     * given with or without the leading `--`. Lets a caller theme one editor
     * instance without a separate theming system.
     */
    tokens?: Record<string, string>;
  }
</script>

<script lang="ts">
  import { onMount } from "svelte";
  import { EditorState } from "@codemirror/state";
  import { EditorView } from "@codemirror/view";

  import { baseSetup, markdownExtension } from "./extensions/markdown.js";
  import { cursorReveal } from "./extensions/cursor-reveal.js";
  import { frontmatterFold } from "./extensions/frontmatter-fold.js";
  import { chips } from "./extensions/chips.js";
  import { editorTheme } from "./theme.js";
  import { selectionContext, type SelectionContext } from "./selection-context.js";
  import { ipc } from "../ipc/index.js";

  interface Props {
    /** Initial document text. The editor never mutates the buffer on its own. */
    doc?: string;
    /** Per-instance theme/layout settings (see EditorSettings). */
    settings?: EditorSettings;
    /**
     * Called with the full document text on every change. Debouncing is the
     * CALLER's responsibility — the save pipeline's 500ms debounce (0006,
     * design-0003 §Save pipeline) lives outside this component, not here.
     */
    onDocChanged?: (text: string) => void;
    /** Called on selection change with frontmatter / active-token context. */
    onSelectionContext?: (ctx: SelectionContext) => void;
    /**
     * Called when a tag or mention chip is clicked (non-navigational, per 0005).
     * The caller can open a side panel or handle as needed.
     */
    onTokenClick?: (kind: "tag" | "mention", value: string) => void;
    /**
     * Called when a wikilink chip is clicked. The target is the raw wikilink
     * target string (may be path-qualified). Actual navigation is the caller's
     * responsibility.
     */
    onNavigate?: (target: string) => void;
    /**
     * Map of entryId → display title used to resolve wikilink chips.
     * When provided, wikilinks whose target matches an entry id show the entry
     * title and are styled as resolved; unmatched targets are styled as
     * unresolved. When absent, all wikilinks render with their raw target text.
     */
    entryTitles?: Map<string, string>;
  }

  let {
    doc = "",
    settings = {},
    onDocChanged,
    onSelectionContext,
    onTokenClick,
    onNavigate,
    entryTitles = new Map(),
  }: Props = $props();

  let host: HTMLDivElement;
  let view: EditorView | undefined;

  /** Apply settings as inline `--tnd-*` properties; theme.ts reads them. */
  function applySettings(el: HTMLElement, s: EditorSettings) {
    if (s.font) el.style.setProperty("--tnd-editor-font", s.font);
    if (s.lineWidth) el.style.setProperty("--tnd-editor-line-width", s.lineWidth);
    for (const [k, val] of Object.entries(s.tokens ?? {})) {
      el.style.setProperty(k.startsWith("--") ? k : `--${k}`, val);
    }
  }

  const updateListener = EditorView.updateListener.of((u) => {
    if (u.docChanged) onDocChanged?.(u.state.doc.toString());
    if (u.selectionSet || u.docChanged) onSelectionContext?.(selectionContext(u.state));
  });

  onMount(() => {
    applySettings(host, settings);

    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        extensions: [
          // Precedence (design-0003):
          //   layer 1: frontmatterFold (earliest = highest precedence in CM6)
          //   layer 3: chips (above cursor-reveal so widget decos win for tokens)
          //   layer 2: cursorReveal (plain marks for headings/emphasis; tokens
          //             deferred to chips layer)
          //   base:    markdownExtension, baseSetup, editorTheme
          frontmatterFold,
          chips({ ipc, onTokenClick, onNavigate, entryTitles }),
          cursorReveal,
          markdownExtension,
          baseSetup,
          editorTheme,
          updateListener,
        ],
      }),
    });

    // Emit the initial selection context once mounted.
    onSelectionContext?.(selectionContext(view.state));

    return () => view?.destroy();
  });

  // Re-apply settings when they change (theme tokens are live).
  $effect(() => {
    if (host) applySettings(host, settings);
  });
</script>

<!-- Focus is owned by CM6 inside this element (design-0003 §Interfaces). -->
<div class="tnd-editor-host" bind:this={host}></div>

<style>
  .tnd-editor-host {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .tnd-editor-host :global(.cm-editor) {
    height: 100%;
  }
</style>
