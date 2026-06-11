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
  import {
    blocksPlugin,
    blocksTheme,
    pasteDropHandlers,
    type BlockCallbacks,
  } from "./extensions/blocks.js";
  import { autocomplete } from "./extensions/autocomplete.js";
  import { ipc } from "../ipc/index.js";
  import { vimCompartment, modalEnabled, registerModeListener, type VimMode } from "./vim/index.js";

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
    /**
     * External change to dispatch into the editor buffer (issue #15 — panel
     * write-back). When set to a non-null ChangeSpec, the editor dispatches it
     * as a targeted doc transaction. The caller must reset this to null after
     * each dispatch (swap the reference to trigger the effect).
     */
    externalChange?: { from: number; to: number; insert: string } | null;
    /**
     * Full-document replacement (spec 0006 — conflict resolution: silent reload
     * and use-disk action). When non-null, replaces the entire editor document
     * with the given text, preserving cursor position where possible (cursor is
     * clamped to the new document length). Caller must swap the reference to
     * trigger re-dispatch.
     */
    externalDocReplace?: { fullDoc: string } | null;
    /** Vault-relative path of the currently open entry (for asset resolution). */
    entryPath?: string;
    /** Block-layer callbacks (open attachment, relink/remove broken). */
    blockCallbacks?: BlockCallbacks;
    /**
     * Called when the user selects the "Create person '<slug>'" autocomplete
     * option. No text is inserted; creation is the caller's responsibility.
     */
    onCreatePerson?: (slug: string) => void;
    /**
     * Group path of the entry being edited. Passed to the autocomplete source
     * so scoped tags (from _group.md) are ranked/filtered correctly (phase 6).
     */
    groupPath?: string | null;
    /**
     * Whether the vim-flavor modal editor engine is active (spec 0007
     * §Modal vs modeless). Toggled live via a CM6 compartment; when true the
     * editor opens in normal mode and shows a mode indicator. Defaults to off.
     */
    modalEditor?: boolean;
  }

  let {
    doc = "",
    settings = {},
    onDocChanged,
    onSelectionContext,
    onTokenClick,
    onNavigate,
    entryTitles = new Map(),
    entryPath = "",
    blockCallbacks = {},
    onCreatePerson,
    externalChange = null,
    externalDocReplace = null,
    groupPath = null,
    modalEditor = false,
  }: Props = $props();

  // groupPathRef is a mutable box so the autocomplete source always reads the
  // latest value without requiring an editor rebuild when the user switches entries.
  // Initialized to null; $effect syncs it on every change to the `groupPath` prop.
  const groupPathRef: { current: string | null | undefined } = { current: null };
  $effect(() => {
    groupPathRef.current = groupPath; // runs reactively whenever groupPath changes
  });

  let host: HTMLDivElement;
  let view: EditorView | undefined;

  // Current vim mode for the indicator; null when the modal engine is off.
  let vimMode = $state<VimMode | null>(null);
  let unregisterMode: (() => void) | undefined;

  /** Offset of the first body character after a leading `---` frontmatter block
   * (0 if there is none). Used to seat the initial cursor in the prose. */
  function bodyStartOffset(text: string): number {
    if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return 0;
    const close = text.indexOf("\n---", 3);
    if (close === -1) return 0;
    // Skip past the closing fence line and any blank line that follows.
    let i = text.indexOf("\n", close + 1);
    if (i === -1) return text.length;
    i += 1;
    while (i < text.length && (text[i] === "\n" || text[i] === "\r")) i += 1;
    return Math.min(i, text.length);
  }

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
        // Land the cursor in the body (past frontmatter) so the YAML stays
        // folded on open — matches the design, where properties live in the
        // panel, not the prose. cursor-reveal still expands it on click.
        selection: { anchor: bodyStartOffset(doc) },
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
          blocksPlugin(ipc, blockCallbacks),
          pasteDropHandlers(ipc, () => entryPath),
          autocomplete({ ipc, onCreatePerson, groupPath: groupPathRef }),
          markdownExtension,
          baseSetup,
          editorTheme,
          blocksTheme,
          updateListener,
          // Vim modal engine — loaded into a compartment so the active preset
          // can toggle it live (spec 0007). Empty unless modalEditor is set.
          vimCompartment.of(modalEnabled(modalEditor)),
        ],
      }),
    });

    // Mirror the modal engine's mode into the indicator. The listener emits the
    // current mode immediately and `null` whenever the engine is uninstalled.
    unregisterMode = registerModeListener(view, (m) => {
      vimMode = m;
    });

    // Emit the initial selection context once mounted.
    onSelectionContext?.(selectionContext(view.state));

    return () => {
      unregisterMode?.();
      view?.destroy();
    };
  });

  // Toggle the modal engine live when the modalEditor prop changes (preset
  // switch in settings, no restart — spec 0007 acceptance criterion).
  $effect(() => {
    view?.dispatch({
      effects: vimCompartment.reconfigure(modalEnabled(modalEditor)),
    });
  });

  // Re-apply settings when they change (theme tokens are live).
  $effect(() => {
    if (host) applySettings(host, settings);
  });

  // Dispatch an external change (panel write-back, issue #15) into the buffer.
  $effect(() => {
    if (externalChange && view) {
      view.dispatch({
        changes: {
          from: externalChange.from,
          to: externalChange.to,
          insert: externalChange.insert,
        },
      });
    }
  });

  // Dispatch a full-document replacement (conflict reload / use-disk, spec 0006).
  $effect(() => {
    if (externalDocReplace && view) {
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: externalDocReplace.fullDoc,
        },
      });
    }
  });
</script>

<!-- Editor wrapper: CM6 host plus the optional vim mode indicator strip. -->
<div class="tnd-editor-wrap">
  <!-- Focus is owned by CM6 inside this element (design-0003 §Interfaces). -->
  <div class="tnd-editor-host" bind:this={host}></div>

  <!-- Vim mode indicator — only present while the modal engine is active. -->
  {#if vimMode}
    <div class="tnd-vim-status" data-vim-mode={vimMode} aria-live="polite">
      <span class="tnd-vim-mode-label">
        {#if vimMode === "normal"}NORMAL{:else if vimMode === "insert"}INSERT{:else}VISUAL{/if}
      </span>
    </div>
  {/if}
</div>

<style>
  .tnd-editor-wrap {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .tnd-editor-host {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .tnd-editor-host :global(.cm-editor) {
    height: 100%;
  }

  /* Vim mode indicator — statusbar-style strip pinned to the editor's bottom. */
  .tnd-vim-status {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    height: 22px;
    padding: 0 10px;
    border-top: 1px solid var(--tnd-line);
    background: var(--tnd-panel2);
    font-family: var(--tnd-font-mono);
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.08em;
    user-select: none;
  }

  .tnd-vim-mode-label {
    display: inline-flex;
    align-items: center;
    padding: 1px 7px;
    border-radius: var(--tnd-radius);
    color: var(--tnd-accent-text);
    background: var(--tnd-accent-soft);
  }

  .tnd-vim-status[data-vim-mode="insert"] .tnd-vim-mode-label {
    color: var(--tnd-chip-green-fg);
    background: var(--tnd-chip-green-bg);
  }

  .tnd-vim-status[data-vim-mode="visual"] .tnd-vim-mode-label {
    color: var(--tnd-chip-amber-fg);
    background: var(--tnd-chip-amber-bg);
  }
</style>
