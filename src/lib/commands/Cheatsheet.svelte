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
      <!-- Header -->
      <div class="sheet-header">
        <span class="sheet-title">Cheatsheet</span>
        <span class="sheet-header-right">
          <span class="sheet-zone-label">zone:</span>
          <span class="sheet-zone">{zoneTitle}</span>
          <kbd class="sheet-trigger-hint">?</kbd>
        </span>
      </div>

      <!-- Body: 2-column grid of sections -->
      <div class="sheet-body">
        {#if groupedCommands.length === 0}
          <p class="sheet-empty">No shortcuts available in this zone.</p>
        {/if}

        {#each groupedCommands as group (group.category)}
          <section class="sheet-section">
            <h3 class="sheet-section-title">[ {group.category.toUpperCase()} ]</h3>
            {#each group.items as { cmd, binding } (cmd.id)}
              <div class="sheet-row">
                <span class="sheet-name">{cmd.name}</span>
                <span class="sheet-kbd-cell">
                  {#if binding === "–"}
                    <span class="sheet-no-binding">–</span>
                  {:else}
                    <kbd class="sheet-kbd">{binding}</kbd>
                  {/if}
                </span>
              </div>
            {/each}
          </section>
        {/each}
      </div>

      <!-- Footer -->
      <div class="sheet-footer">
        commands reflect the active zone · rebind any in
        <span class="sheet-footer-link">Settings → Keymap</span>
      </div>
    </div>
  </div>
{/if}

<style>
  /* ── Backdrop: dim the workspace behind ──────────────────────────────────── */

  .sheet-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 8500;
  }

  /* ── Centered modal panel ────────────────────────────────────────────────── */

  .sheet-panel {
    width: min(860px, 95vw);
    max-height: 640px;
    background: var(--tnd-panel);
    border: 1px solid var(--tnd-line-strong);
    border-radius: var(--tnd-radius);
    box-shadow:
      var(--tnd-shadow),
      0 24px 80px rgba(0, 0, 0, 0.5);
    display: flex;
    flex-direction: column;
    font-family: var(--tnd-font-ui);
    font-size: 13px;
    color: var(--tnd-text);
    overflow: hidden;
  }

  /* ── Header ──────────────────────────────────────────────────────────────── */

  .sheet-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px;
    border-bottom: 1px solid var(--tnd-line-strong);
    flex-shrink: 0;
  }

  .sheet-title {
    font-size: 14px;
    font-weight: 700;
    color: var(--tnd-text);
    text-transform: var(--tnd-label-transform);
    letter-spacing: var(--tnd-label-spacing);
  }

  .sheet-header-right {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .sheet-zone-label {
    font-size: 11px;
    color: var(--tnd-text-faint);
  }

  .sheet-zone {
    font-size: 11px;
    font-weight: 700;
    color: var(--tnd-accent-text);
    padding: 2px 8px;
    border: 1px solid var(--tnd-line-strong);
    letter-spacing: 0.02em;
  }

  .sheet-trigger-hint {
    font-family: var(--tnd-font-mono);
    font-size: 11px;
    color: var(--tnd-text-faint);
    padding: 2px 6px;
    border: 1px solid var(--tnd-line);
  }

  /* ── Body: 2-column grid ─────────────────────────────────────────────────── */

  .sheet-body {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0 36px;
    align-content: start;
    scrollbar-width: thin;
  }

  .sheet-empty {
    grid-column: 1 / -1;
    padding: 20px 0;
    color: var(--tnd-text-muted);
    text-align: center;
  }

  /* ── Section ─────────────────────────────────────────────────────────────── */

  .sheet-section {
    margin-bottom: 16px;
  }

  .sheet-section-title {
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--tnd-text-faint);
    margin: 0 0 6px;
    padding-bottom: 5px;
    border-bottom: 1px solid var(--tnd-line);
    font-family: var(--tnd-font-ui);
  }

  .sheet-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 5px 0;
  }

  .sheet-name {
    font-size: 12.5px;
    color: var(--tnd-text);
  }

  .sheet-kbd-cell {
    text-align: right;
  }

  .sheet-no-binding {
    color: var(--tnd-text-faint);
    font-size: 11px;
  }

  .sheet-kbd {
    font-family: var(--tnd-font-mono);
    font-size: 11.5px;
    font-weight: 700;
    color: var(--tnd-accent-text);
    background: var(--tnd-panel2);
    border: 1px solid var(--tnd-line);
    border-radius: var(--tnd-radius);
    padding: 2px 8px;
  }

  /* ── Footer ──────────────────────────────────────────────────────────────── */

  .sheet-footer {
    flex-shrink: 0;
    padding: 10px 18px;
    border-top: 1px solid var(--tnd-line-strong);
    font-size: 11px;
    color: var(--tnd-text-faint);
    font-family: var(--tnd-font-ui);
  }

  .sheet-footer-link {
    color: var(--tnd-accent-text);
  }

  /* ── Per-theme: Mono uses mono font throughout ───────────────────────────── */

  :global([data-tnd-theme="mono"]) .sheet-panel,
  :global([data-tnd-theme="mono"]) .sheet-title,
  :global([data-tnd-theme="mono"]) .sheet-name,
  :global([data-tnd-theme="mono"]) .sheet-section-title,
  :global([data-tnd-theme="mono"]) .sheet-footer,
  :global([data-tnd-theme="mono"]) .sheet-zone-label,
  :global([data-tnd-theme="mono"]) .sheet-zone {
    font-family: var(--tnd-font-mono);
  }

  :global([data-tnd-theme="mono"]) .sheet-kbd,
  :global([data-tnd-theme="mono"]) .sheet-trigger-hint {
    border-radius: 0;
  }

  /* ── Per-theme: Editorial → mono font for section headers ───────────────── */

  :global([data-tnd-theme="editorial"]) .sheet-section-title {
    font-family: var(--tnd-font-mono);
    letter-spacing: 0.1em;
  }
</style>
