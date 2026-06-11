<script lang="ts">
  import { registry, type Command } from "./registry.js";
  import { rankByFuzzy, highlightSegments } from "./fuzzy.js";
  import { getRecents, recordRecent } from "./recents.js";
  import { loadUserBindings } from "./settings.js";
  import { resolveBindings, type UserBindings } from "./keymap.js";
  import { evaluateContext } from "./zones.js";

  // ── Props ──────────────────────────────────────────────────────────────────

  interface Props {
    open?: boolean;
    onclose?: () => void;
  }

  let { open = $bindable(false), onclose }: Props = $props();

  // ── State ──────────────────────────────────────────────────────────────────

  let query = $state("");
  let selectedIndex = $state(0);
  let inputEl = $state<HTMLInputElement | null>(null);
  let userBindings = $state<UserBindings>(new Map());

  // Refresh user bindings when palette opens.
  $effect(() => {
    if (open) {
      userBindings = loadUserBindings();
      query = "";
      selectedIndex = 0;
      // Focus input after DOM update.
      requestAnimationFrame(() => inputEl?.focus());
    }
  });

  // ── Command list ───────────────────────────────────────────────────────────

  /**
   * Build the displayed list: recents first (when no query), then fuzzy-ranked.
   */
  const displayedCommands = $derived.by(() => {
    const all = registry.all();

    if (!query) {
      // No query: show recents first, then all.
      const recentIds = getRecents();
      const recentSet = new Set(recentIds);
      const recents = recentIds
        .map((id) => all.find((c) => c.id === id))
        .filter((c): c is Command => c !== undefined);
      const rest = all.filter((c) => !recentSet.has(c.id));
      return [...recents, ...rest];
    }

    return rankByFuzzy(query, all, (c) => c.name).map((r) => r.item);
  });

  // ── Binding display ────────────────────────────────────────────────────────

  function bindingDisplay(cmd: Command): string {
    const chords = resolveBindings(cmd.id, cmd.defaultBindings, userBindings);
    if (chords.length === 0) return "";
    return chords[0]; // show primary binding
  }

  // ── Context awareness ─────────────────────────────────────────────────────

  function isActive(cmd: Command): boolean {
    return evaluateContext(cmd.when);
  }

  // ── Keyboard navigation ────────────────────────────────────────────────────

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, displayedCommands.length - 1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const cmd = displayedCommands[selectedIndex];
      if (cmd) runCommand(cmd);
      return;
    }
  }

  // Reset selection when query changes.
  $effect(() => {
    query; // track
    selectedIndex = 0;
  });

  // ── Actions ────────────────────────────────────────────────────────────────

  function runCommand(cmd: Command): void {
    recordRecent(cmd.id);
    close();
    void cmd.handler();
  }

  function close(): void {
    open = false;
    onclose?.();
  }

  // ── Highlight helpers ──────────────────────────────────────────────────────

  function getHighlightSegments(cmd: Command) {
    if (!query) return [{ text: cmd.name, highlight: false }];
    const ranked = rankByFuzzy(query, [cmd], (c) => c.name);
    if (ranked.length === 0) return [{ text: cmd.name, highlight: false }];
    return highlightSegments(cmd.name, ranked[0].match.indices);
  }
</script>

{#if open}
  <!-- Backdrop -->
  <div
    class="palette-backdrop"
    role="presentation"
    onmousedown={(e) => {
      if (e.target === e.currentTarget) close();
    }}
  >
    <!-- Panel -->
    <div class="palette-panel" role="dialog" aria-label="Command Palette" aria-modal="true">
      <!-- Search input -->
      <div class="palette-input-row">
        <span class="palette-icon" aria-hidden="true">⌕</span>
        <input
          bind:this={inputEl}
          bind:value={query}
          class="palette-input"
          type="text"
          placeholder="Search commands…"
          autocomplete="off"
          spellcheck="false"
          aria-label="Command search"
          onkeydown={handleKeydown}
        />
        {#if query}
          <button
            class="palette-clear"
            onclick={() => (query = "")}
            aria-label="Clear search"
            tabindex="-1">×</button
          >
        {/if}
        <span class="palette-esc-hint">esc</span>
      </div>

      <!-- Results -->
      <ul class="palette-list" role="listbox" aria-label="Commands">
        {#if displayedCommands.length === 0}
          <li class="palette-empty">No commands match "{query}"</li>
        {:else}
          <li class="palette-section-label" aria-hidden="true">COMMANDS</li>
        {/if}
        {#each displayedCommands as cmd, i (cmd.id)}
          {@const active = i === selectedIndex}
          {@const contextOk = isActive(cmd)}
          <li
            class="palette-item"
            class:selected={active}
            class:inactive={!contextOk}
            role="option"
            aria-selected={active}
            onclick={() => runCommand(cmd)}
            onkeydown={(e) => {
              if (e.key === "Enter" || e.key === " ") runCommand(cmd);
            }}
            onmouseenter={() => (selectedIndex = i)}
          >
            <span class="palette-item-left">
              <span class="palette-item-name">
                {#each getHighlightSegments(cmd) as seg (seg.text + seg.highlight)}
                  {#if seg.highlight}
                    <mark>{seg.text}</mark>
                  {:else}
                    {seg.text}
                  {/if}
                {/each}
              </span>
              {#if cmd.description}
                <span class="palette-item-desc">{cmd.description}</span>
              {/if}
            </span>
            <span class="palette-item-right">
              <span class="palette-item-cat-badge">{cmd.category}</span>
              {#if !contextOk && cmd.when}
                <span class="palette-item-hint">{cmd.when.replace("zone:", "")}</span>
              {/if}
              {#if bindingDisplay(cmd)}
                <kbd class="palette-item-kbd">{bindingDisplay(cmd)}</kbd>
              {/if}
            </span>
          </li>
        {/each}
      </ul>

      <!-- Footer -->
      <div class="palette-footer">
        <span>↑↓ navigate</span>
        <span>↵ run</span>
        <span>esc close</span>
      </div>
    </div>
  </div>
{/if}

<style>
  /* ── Backdrop ────────────────────────────────────────────────────────────── */

  .palette-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 12vh;
    z-index: 9000;
  }

  /* ── Panel ───────────────────────────────────────────────────────────────── */

  .palette-panel {
    width: min(620px, 92vw);
    background: var(--tnd-panel);
    border: 1px solid var(--tnd-line-strong);
    border-radius: var(--tnd-radius);
    box-shadow:
      var(--tnd-shadow),
      0 20px 50px rgba(0, 0, 0, 0.5);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font-family: var(--tnd-font-ui);
    font-size: 13px;
    color: var(--tnd-text);
  }

  /* ── Input row ───────────────────────────────────────────────────────────── */

  .palette-input-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--tnd-line-strong);
  }

  .palette-icon {
    font-family: var(--tnd-font-mono);
    font-size: 17px;
    color: var(--tnd-text-muted);
    flex-shrink: 0;
    user-select: none;
    line-height: 1;
  }

  .palette-input {
    flex: 1;
    border: none;
    outline: none;
    background: transparent;
    font-family: var(--tnd-font-ui);
    font-size: 16px;
    color: var(--tnd-text);
  }

  .palette-input::placeholder {
    color: var(--tnd-text-faint);
  }

  .palette-clear {
    border: none;
    background: none;
    cursor: pointer;
    color: var(--tnd-text-muted);
    font-size: 16px;
    padding: 0 2px;
    line-height: 1;
    font-family: var(--tnd-font-mono);
  }

  .palette-esc-hint {
    font-family: var(--tnd-font-mono);
    font-size: 12px;
    color: var(--tnd-text-faint);
    flex-shrink: 0;
  }

  /* ── Command list ────────────────────────────────────────────────────────── */

  .palette-list {
    list-style: none;
    padding: 6px 0 10px;
    margin: 0;
    max-height: 380px;
    overflow-y: auto;
    scrollbar-width: thin;
  }

  /* Section heading within the list */
  .palette-section-label {
    padding: 8px 16px 4px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.07em;
    color: var(--tnd-text-faint);
    font-family: var(--tnd-font-ui);
  }

  .palette-empty {
    padding: 20px 16px;
    text-align: center;
    color: var(--tnd-text-muted);
    font-size: 13px;
  }

  .palette-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 11px 16px;
    cursor: default;
    gap: 11px;
  }

  .palette-item.selected {
    background: var(--tnd-accent-soft);
  }

  .palette-item.inactive {
    opacity: 0.55;
  }

  .palette-item-left {
    display: flex;
    align-items: center;
    gap: 11px;
    flex: 1;
    min-width: 0;
  }

  .palette-item-name {
    font-size: 13.5px;
    font-weight: 500;
    color: var(--tnd-text);
    flex-shrink: 0;
  }

  /* Selected row: name goes bold */
  .palette-item.selected .palette-item-name {
    font-weight: 700;
  }

  .palette-item-name mark {
    background: transparent;
    color: var(--tnd-accent-text);
    font-weight: 700;
  }

  .palette-item-desc {
    font-size: 11px;
    color: var(--tnd-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .palette-item-right {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .palette-item-hint {
    font-size: 10px;
    color: var(--tnd-text-faint);
    font-style: italic;
  }

  .palette-item-cat-badge {
    font-size: 10.5px;
    color: var(--tnd-text-faint);
    font-family: var(--tnd-font-ui);
  }

  .palette-item-kbd {
    font-family: var(--tnd-font-mono);
    font-size: 11px;
    font-weight: 700;
    color: var(--tnd-accent-text);
    padding: 0;
    background: none;
    border: none;
  }

  /* ── Footer ──────────────────────────────────────────────────────────────── */

  .palette-footer {
    display: flex;
    gap: 16px;
    padding: 7px 14px;
    border-top: 1px solid var(--tnd-line-strong);
    font-size: 11px;
    color: var(--tnd-text-faint);
    font-family: var(--tnd-font-ui);
  }

  /* ── Per-theme: Mono uses mono font throughout ───────────────────────────── */

  :global([data-tnd-theme="mono"]) .palette-panel,
  :global([data-tnd-theme="mono"]) .palette-input,
  :global([data-tnd-theme="mono"]) .palette-item-name,
  :global([data-tnd-theme="mono"]) .palette-item-desc,
  :global([data-tnd-theme="mono"]) .palette-section-label,
  :global([data-tnd-theme="mono"]) .palette-footer,
  :global([data-tnd-theme="mono"]) .palette-item-cat-badge {
    font-family: var(--tnd-font-mono);
  }
</style>
