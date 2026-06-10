<script lang="ts">
  import { SvelteMap } from "svelte/reactivity";
  import { registry, type Command, type CommandCategory } from "./registry.js";
  import { loadUserBindings } from "./settings.js";
  import { resolveBindings } from "./keymap.js";
  import { getActiveZone, zoneLabel, type ZoneId } from "./zones.js";

  // ── Props ──────────────────────────────────────────────────────────────────

  interface Props {
    open?: boolean;
    onclose?: () => void;
  }

  let { open = $bindable(false), onclose }: Props = $props();

  // ── Computed ───────────────────────────────────────────────────────────────

  const activeZone = $derived(getActiveZone());
  const activeContext = $derived(`zone:${activeZone}`);
  const zoneTitle = $derived(zoneLabel(activeZone as ZoneId));

  const groupedCommands = $derived.by(() => {
    const userBindings = loadUserBindings();

    // Include global commands + commands for current zone.
    const relevant = registry.all().filter((c) => !c.when || c.when === activeContext);

    // Group by category.
    const groups = new SvelteMap<CommandCategory, Array<{ cmd: Command; binding: string }>>();

    for (const cmd of relevant) {
      const chords = resolveBindings(cmd.id, cmd.defaultBindings, userBindings);
      const binding = chords.length > 0 ? chords.join(", ") : "–";

      if (!groups.has(cmd.category)) {
        groups.set(cmd.category, []);
      }
      groups.get(cmd.category)!.push({ cmd, binding });
    }

    // Sort categories.
    const categoryOrder: CommandCategory[] = [
      "Navigation",
      "Entry",
      "Editor",
      "Group",
      "Tag",
      "View",
      "App",
    ];

    return categoryOrder
      .filter((cat) => groups.has(cat))
      .map((cat) => ({ category: cat, items: groups.get(cat)! }));
  });

  // ── Close ──────────────────────────────────────────────────────────────────

  function close(): void {
    open = false;
    onclose?.();
  }

  function handleBackdropClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) close();
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") close();
  }
</script>

<svelte:window onkeydown={open ? handleKeydown : undefined} />

{#if open}
  <div class="sheet-backdrop" role="presentation" onmousedown={handleBackdropClick}>
    <div class="sheet-panel" role="dialog" aria-label="Keyboard Cheatsheet" aria-modal="true">
      <div class="sheet-header">
        <span class="sheet-title">Keyboard Shortcuts</span>
        <span class="sheet-zone">{zoneTitle}</span>
        <button class="sheet-close" onclick={close} aria-label="Close cheatsheet">×</button>
      </div>

      <div class="sheet-body">
        {#if groupedCommands.length === 0}
          <p class="sheet-empty">No shortcuts available in this zone.</p>
        {/if}

        {#each groupedCommands as group (group.category)}
          <section class="sheet-section">
            <h3 class="sheet-section-title">{group.category}</h3>
            <table class="sheet-table">
              <tbody>
                {#each group.items as { cmd, binding } (cmd.id)}
                  <tr class="sheet-row">
                    <td class="sheet-name">{cmd.name}</td>
                    <td class="sheet-kbd-cell">
                      {#if binding === "–"}
                        <span class="sheet-no-binding">–</span>
                      {:else}
                        <kbd class="sheet-kbd">{binding}</kbd>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </section>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .sheet-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    display: flex;
    align-items: center;
    justify-content: flex-end;
    z-index: 8500;
  }

  .sheet-panel {
    width: min(400px, 95vw);
    height: 100vh;
    background: var(--tnd-panel, #fbfaf6);
    border-left: 1px solid var(--tnd-line-strong, rgba(40, 38, 28, 0.3));
    display: flex;
    flex-direction: column;
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 13px;
    color: var(--tnd-text, #1f1e1a);
    overflow: hidden;
  }

  .sheet-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--tnd-line, rgba(40, 38, 28, 0.16));
  }

  .sheet-title {
    font-weight: 600;
    font-size: 14px;
    flex: 1;
  }

  .sheet-zone {
    font-size: 11px;
    color: var(--tnd-text-faint, #a8a393);
    background: var(--tnd-panel2, #eeebe2);
    border-radius: 4px;
    padding: 2px 7px;
  }

  .sheet-close {
    border: none;
    background: none;
    cursor: pointer;
    color: var(--tnd-text-muted, #7c7868);
    font-size: 18px;
    padding: 0;
    line-height: 1;
  }

  .sheet-body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
  }

  .sheet-empty {
    padding: 20px 16px;
    color: var(--tnd-text-muted, #7c7868);
    text-align: center;
  }

  .sheet-section {
    padding: 8px 0;
  }

  .sheet-section + .sheet-section {
    border-top: 1px solid var(--tnd-line, rgba(40, 38, 28, 0.16));
  }

  .sheet-section-title {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--tnd-text-faint, #a8a393);
    padding: 6px 16px 4px;
    margin: 0;
    font-weight: 600;
  }

  .sheet-table {
    width: 100%;
    border-collapse: collapse;
  }

  .sheet-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 16px;
  }

  .sheet-row:hover {
    background: var(--tnd-panel2, #eeebe2);
  }

  .sheet-name {
    flex: 1;
    font-size: 13px;
  }

  .sheet-kbd-cell {
    text-align: right;
  }

  .sheet-no-binding {
    color: var(--tnd-text-faint, #a8a393);
  }

  .sheet-kbd {
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: var(--tnd-text-muted, #7c7868);
    background: var(--tnd-panel2, #eeebe2);
    border: 1px solid var(--tnd-line-strong, rgba(40, 38, 28, 0.3));
    border-radius: 4px;
    padding: 1px 6px;
  }
</style>
