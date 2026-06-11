<script lang="ts">
  // EditorAccessoryBar — slim accessory toolbar shown above the software keyboard
  // on narrow viewports when the editor is focused (spec 0013 §Hardware keyboard
  // — software-keyboard editing uses an accessory row).
  //
  // Buttons dispatch editor commands via the command registry (spec 0007).
  // In-browser approximation: fixed bottom toolbar when editor is focused.
  //
  // Commands wired: heading-1, heading-2, list (bullet), checkbox, bold, italic,
  // inline-code, insert tag (#), insert mention (@), insert wikilink ([[).

  import { registry } from "../commands/index.js";

  interface Props {
    /** Whether the editor is currently focused (controls visibility). */
    editorFocused?: boolean;
  }

  let { editorFocused = false }: Props = $props();

  interface BarButton {
    label: string;
    title: string;
    commandId?: string;
    /** Raw markdown prefix to insert at cursor (fallback for stub commands). */
    insert?: string;
    /** Accent-colored buttons (tag/mention/wikilink shortcuts) */
    accent?: boolean;
  }

  const BUTTONS: BarButton[] = [
    { label: "H1", title: "Heading 1", commandId: "editor.heading-1" },
    { label: "H2", title: "Heading 2", commandId: "editor.heading-2" },
    { label: "•", title: "Bullet list", insert: "- " },
    { label: "☑", title: "Checkbox", insert: "- [ ] " },
    { label: "B", title: "Bold", commandId: "editor.bold" },
    { label: "I", title: "Italic", commandId: "editor.italic" },
    { label: "`", title: "Inline code", commandId: "editor.code" },
    { label: "#", title: "Insert tag", insert: "#", accent: true },
    { label: "@", title: "Insert mention", insert: "@", accent: true },
    { label: "[[", title: "Insert wikilink", insert: "[[", accent: true },
  ];

  function tap(btn: BarButton): void {
    if (btn.commandId) {
      const cmd = registry.get(btn.commandId);
      if (cmd) {
        void cmd.handler();
        return;
      }
    }
    // Fallback for commands without a real handler yet: dispatch a custom event
    // that the editor host can intercept for text insertion.
    if (btn.insert !== undefined) {
      document.activeElement?.dispatchEvent(
        new CustomEvent("tnd:accessory-insert", {
          detail: { text: btn.insert },
          bubbles: true,
        }),
      );
    }
  }
</script>

{#if editorFocused}
  <div class="accessory-bar" role="toolbar" aria-label="Editor formatting">
    {#each BUTTONS as btn (btn.label)}
      <button
        class="accessory-btn"
        class:accessory-btn--accent={btn.accent}
        title={btn.title}
        aria-label={btn.title}
        onpointerdown={(e) => {
          // Use pointerdown so it fires before the editor loses focus
          e.preventDefault();
          tap(btn);
        }}
      >
        {btn.label}
      </button>
    {/each}
  </div>
{/if}

<style>
  .accessory-bar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: env(safe-area-inset-bottom, 0px);
    height: 44px;
    display: flex;
    align-items: stretch;
    background: var(--tnd-bg);
    border-top: 1px solid var(--tnd-line);
    overflow-x: auto;
    overflow-y: hidden;
    z-index: 2000;
    font-family: var(--tnd-font-ui);
  }

  .accessory-btn {
    flex-shrink: 0;
    flex: 1;
    min-width: 36px;
    padding: 0 6px;
    margin: 6px 3px;
    border: 1px solid var(--tnd-line);
    border-radius: var(--tnd-radius);
    background: var(--tnd-panel);
    color: var(--tnd-text-muted);
    font-size: 13px;
    font-family: var(--tnd-font-ui);
    font-weight: 700;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 32px;
  }

  /* Accent-colored shortcut keys: # @ [[ */
  .accessory-btn--accent {
    color: var(--tnd-accent-text);
  }

  .accessory-btn:active {
    background: var(--tnd-panel2);
    color: var(--tnd-text);
  }

  .accessory-btn--accent:active {
    background: var(--tnd-accent-soft);
    color: var(--tnd-accent-text);
  }
</style>
