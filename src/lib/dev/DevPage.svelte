<script lang="ts">
  import { ipc } from "../ipc/index.js";
  import { Editor } from "../editor/index.js";
  import PropertiesPanel from "../panel/PropertiesPanel.svelte";
  import themeMap from "../../styles/THEME-MAP.json";
  import type { EntrySummary } from "../ipc/types.js";
  import type { ChangeSpec } from "../panel/frontmatter-view.js";

  // Entry titles for wikilink resolution are now loaded by the chips plugin
  // via ipc.entry_titles() — no manual loading needed here.

  // ── Chip event log (shows last click in the topbar) ─────────────────────────

  let lastChipEvent = $state<string | null>(null);

  function onTokenClick(kind: "tag" | "mention", value: string): void {
    lastChipEvent = `${kind}: ${value}`;
  }

  function onNavigate(target: string): void {
    lastChipEvent = `navigate → ${target}`;
  }

  function onCreatePerson(slug: string): void {
    lastChipEvent = `create person: ${slug || "(empty)"}`;
    console.log("[dev] create person:", slug);
  }

  // ── Theme switcher state ────────────────────────────────────────────────────

  type Mode = "light" | "dark" | "system";

  let selectedTheme = $state("paper");
  let selectedMode = $state<Mode>("light");

  const themeKeys = themeMap.themes.map((t) => t.key);
  const themeNames = Object.fromEntries(themeMap.themes.map((t) => [t.key, t.name]));

  let mediaQuery: MediaQueryList | undefined;

  function applyTheme(theme: string, mode: Mode): void {
    const html = document.documentElement;
    html.setAttribute("data-tnd-theme", theme);
    if (mode === "system") {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      html.setAttribute("data-tnd-mode", prefersDark ? "dark" : "light");
    } else {
      html.setAttribute("data-tnd-mode", mode);
    }
  }

  function handleSystemChange(e: MediaQueryListEvent): void {
    if (selectedMode === "system") {
      document.documentElement.setAttribute("data-tnd-mode", e.matches ? "dark" : "light");
    }
  }

  $effect(() => {
    applyTheme(selectedTheme, selectedMode);

    if (selectedMode === "system") {
      mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      mediaQuery.addEventListener("change", handleSystemChange);
    } else if (mediaQuery) {
      mediaQuery.removeEventListener("change", handleSystemChange);
      mediaQuery = undefined;
    }

    return () => {
      mediaQuery?.removeEventListener("change", handleSystemChange);
    };
  });

  // ── Entry list (left panel) ─────────────────────────────────────────────────

  let entries = $state<EntrySummary[]>([]);
  let selectedId = $state<string | null>(null);
  let editorText = $state("");
  let loadError = $state<string | null>(null);

  const DEMO_GROUP = "work/atlas";

  async function loadEntries(): Promise<void> {
    const result = await ipc.entries_in_group(DEMO_GROUP);
    if (result.ok) {
      entries = result.value.items;
      if (entries.length > 0 && !selectedId) {
        await selectEntry(entries[0].id);
      }
    } else {
      loadError = result.error.message;
    }
  }

  async function selectEntry(id: string): Promise<void> {
    const result = await ipc.read_entry(id);
    if (result.ok) {
      selectedId = id;
      editorText = result.value.text;
    } else {
      loadError = result.error.message;
    }
  }

  // Debounce handle for write
  let writeTimer: ReturnType<typeof setTimeout> | undefined;

  function onDocChanged(text: string): void {
    editorText = text;
    if (!selectedId) return;
    clearTimeout(writeTimer);
    writeTimer = setTimeout(async () => {
      if (!selectedId) return;
      await ipc.write_entry(selectedId, text, `dev-self-tok`);
    }, 500);
  }

  // ── Panel write-back (issue #15) ─────────────────────────────────────────────

  // The panel emits a ChangeSpec; we hand it to the editor as externalChange.
  // Each new object reference triggers the Editor's $effect.
  let panelChange = $state<ChangeSpec | null>(null);

  function onPanelEdit(change: ChangeSpec): void {
    panelChange = { ...change };
  }

  // Block callbacks — mock: log to console. Real: will OS-open.
  const blockCallbacks = {
    onOpenAttachment(path: string) {
      console.log("[dev] open attachment:", path);
      // In browser demo: just log. Tauri will use shell.open().
    },
    onAttachmentAction(path: string, action: "relink" | "remove") {
      console.log(`[dev] attachment action: ${action} on`, path);
    },
  };

  // Load on mount — default to blocks-demo entry so /dev shows blocks.
  $effect(() => {
    loadEntries().then(() => {
      const blocksDemo = entries.find((e) => e.id === "work/atlas/blocks-demo");
      if (blocksDemo) selectEntry(blocksDemo.id);
    });
  });
</script>

<div class="dev-page">
  <!-- Top bar -->
  <header class="dev-topbar">
    <span class="dev-topbar-title">ToNoteDo /dev</span>

    <div class="dev-topbar-controls">
      {#if lastChipEvent}
        <span class="dev-chip-event">chip click: {lastChipEvent}</span>
      {/if}
      <label class="dev-label" for="theme-select">Theme</label>
      <select id="theme-select" class="dev-select" bind:value={selectedTheme}>
        {#each themeKeys as key (key)}
          <option value={key}>{themeNames[key]}</option>
        {/each}
      </select>

      <label class="dev-label" for="mode-select">Mode</label>
      <select id="mode-select" class="dev-select" bind:value={selectedMode}>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
        <option value="system">System</option>
      </select>
    </div>
  </header>

  <div class="dev-body">
    <!-- Entry list -->
    <nav class="dev-sidebar">
      <div class="dev-sidebar-label">Group: {DEMO_GROUP}</div>
      {#if loadError}
        <div class="dev-error">{loadError}</div>
      {:else}
        <ul class="dev-entry-list" role="listbox">
          {#each entries as entry (entry.id)}
            <li
              class="dev-entry-item"
              class:dev-entry-item--active={entry.id === selectedId}
              role="option"
              aria-selected={entry.id === selectedId}
              tabindex="0"
              onclick={() => selectEntry(entry.id)}
              onkeydown={(e) => e.key === "Enter" && selectEntry(entry.id)}
            >
              <span class="dev-entry-title">{entry.title}</span>
              {#if entry.tags.length > 0}
                <span class="dev-entry-tags"
                  >{entry.tags
                    .slice(0, 2)
                    .map((t) => `#${t}`)
                    .join(" ")}</span
                >
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </nav>

    <!-- Editor -->
    <main class="dev-main">
      {#if selectedId}
        <Editor
          doc={editorText}
          {onDocChanged}
          {onTokenClick}
          {onNavigate}
          {onCreatePerson}
          entryPath={selectedId}
          {blockCallbacks}
          externalChange={panelChange}
        />
      {:else}
        <div class="dev-empty">Select an entry</div>
      {/if}
    </main>

    <!-- Properties panel (issue #15) -->
    <aside class="dev-panel-aside">
      {#if selectedId}
        <PropertiesPanel docText={editorText} onEdit={onPanelEdit} />
      {:else}
        <div class="dev-empty">No entry</div>
      {/if}
    </aside>
  </div>
</div>

<style>
  .dev-page {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--tnd-bg);
    color: var(--tnd-text);
    font-family: ui-sans-serif, system-ui, sans-serif;
  }

  .dev-topbar {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.5rem 1rem;
    background: var(--tnd-panel);
    border-bottom: 1px solid var(--tnd-line-strong);
    flex-shrink: 0;
  }

  .dev-topbar-title {
    font-weight: 600;
    font-size: 0.875rem;
    color: var(--tnd-text);
    margin-right: auto;
  }

  .dev-topbar-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .dev-label {
    font-size: 0.75rem;
    color: var(--tnd-text-muted);
  }

  .dev-select {
    font-size: 0.8rem;
    padding: 0.25rem 0.5rem;
    background: var(--tnd-panel2);
    color: var(--tnd-text);
    border: 1px solid var(--tnd-line-strong);
    border-radius: 4px;
    outline: none;
    cursor: pointer;
  }

  .dev-select:focus {
    border-color: var(--tnd-accent);
  }

  .dev-body {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .dev-sidebar {
    width: 220px;
    flex-shrink: 0;
    background: var(--tnd-panel);
    border-right: 1px solid var(--tnd-line);
    overflow-y: auto;
    padding: 0.5rem 0;
  }

  .dev-sidebar-label {
    font-size: 0.7rem;
    color: var(--tnd-text-faint);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0.25rem 0.75rem 0.5rem;
  }

  .dev-entry-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .dev-entry-item {
    padding: 0.5rem 0.75rem;
    cursor: pointer;
    border-left: 2px solid transparent;
    transition: background 0.1s;
  }

  .dev-entry-item:hover {
    background: var(--tnd-panel2);
  }

  .dev-entry-item--active {
    background: var(--tnd-accent-soft);
    border-left-color: var(--tnd-accent);
  }

  .dev-entry-title {
    display: block;
    font-size: 0.8rem;
    color: var(--tnd-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dev-entry-tags {
    display: block;
    font-size: 0.7rem;
    color: var(--tnd-text-muted);
    margin-top: 0.1rem;
  }

  .dev-main {
    flex: 1;
    min-width: 0;
    min-height: 0;
    background: var(--tnd-panel);
  }

  .dev-panel-aside {
    width: 260px;
    flex-shrink: 0;
    min-height: 0;
    overflow: hidden;
  }

  .dev-chip-event {
    font-size: 0.7rem;
    color: var(--tnd-text-muted);
    background: var(--tnd-panel2);
    border: 1px solid var(--tnd-line);
    border-radius: 4px;
    padding: 0.15rem 0.5rem;
    white-space: nowrap;
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dev-error {
    font-size: 0.75rem;
    color: var(--tnd-chip-red-fg);
    padding: 0.5rem 0.75rem;
  }

  .dev-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--tnd-text-faint);
    font-size: 0.875rem;
  }
</style>
