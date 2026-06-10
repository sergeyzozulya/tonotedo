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
  }

  const BUTTONS: BarButton[] = [
    { label: "H1", title: "Heading 1", commandId: "editor.heading-1" },
    { label: "H2", title: "Heading 2", commandId: "editor.heading-2" },
    { label: "—", title: "Bullet list", insert: "- " },
    { label: "☑", title: "Checkbox", insert: "- [ ] " },
    { label: "B", title: "Bold", commandId: "editor.bold" },
    { label: "I", title: "Italic", commandId: "editor.italic" },
    { label: "`", title: "Inline code", commandId: "editor.code" },
    { label: "#", title: "Insert tag", insert: "#" },
    { label: "@", title: "Insert mention", insert: "@" },
    { label: "[[", title: "Insert wikilink", insert: "[[" },
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
    bottom: 0;
    left: 0;
    right: 0;
    height: 44px;
    display: flex;
    align-items: stretch;
    background: var(--tnd-panel2, #eeebe2);
    border-top: 1px solid var(--tnd-line-strong);
    overflow-x: auto;
    overflow-y: hidden;
    /* Snap above the native keyboard using env() if available */
    bottom: env(safe-area-inset-bottom, 0px);
    z-index: 2000;
  }

  .accessory-btn {
    flex-shrink: 0;
    min-width: 44px;
    padding: 0 10px;
    border: none;
    border-right: 1px solid var(--tnd-line);
    background: transparent;
    color: var(--tnd-text);
    font-size: 14px;
    font-family: ui-monospace, monospace;
    font-weight: 600;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .accessory-btn:last-child {
    border-right: none;
  }

  .accessory-btn:active {
    background: var(--tnd-accent-soft);
    color: var(--tnd-accent-text);
  }
</style>
