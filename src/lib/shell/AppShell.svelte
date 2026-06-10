<script lang="ts">
  // AppShell — three-zone layout (sidebar + entry-list + editor + properties).
  // (spec 0007 focus zones, spec 0013 mobile, issue #18)
  //
  // Zones:
  //   Left   — Sidebar (group tree navigation, 246px)
  //   Centre-left — EntryList (300px)
  //   Centre — Editor (fills remaining space)
  //   Right  — PropertiesPanel (260px, toggleable)
  //
  // Mobile (<700px): zones become full-screen screens per 0013.
  //   - "sidebar" screen: group tree, back button returns to "list"
  //   - "list" screen: entry list + hamburger to open sidebar
  //   - "editor" screen: open entry + back button to "list"
  //
  // Theme attributes (data-tnd-theme / data-tnd-mode) live on <html> managed
  // by theme-store.ts.  Issue #23 will formalise persistence.

  import { ipc } from "../ipc/index.js";
  import { registry, seedThemeCommands } from "../commands/index.js";
  import { settings_get_user } from "../commands/settings.js";
  import { buildGroupTree } from "./group-tree.js";
  import { themeStore } from "./theme-store.js";
  import Sidebar from "./Sidebar.svelte";
  import EntryList from "./EntryList.svelte";
  import { Editor } from "../editor/index.js";
  import PropertiesPanel from "../panel/PropertiesPanel.svelte";
  import SearchOverlay from "../search/SearchOverlay.svelte";
  import { savedSearchesStore } from "../search/saved-searches-store.js";
  import PersonView from "../people/PersonView.svelte";
  import TagBrowser from "../tags/TagBrowser.svelte";
  import CreatePersonDialog from "../people/CreatePersonDialog.svelte";
  import CalendarView from "../calendar/CalendarView.svelte";
  import SettingsView from "../settings/SettingsView.svelte";
  import type { EntrySummary, PersonMeta } from "../ipc/types.js";
  import type { GroupNode } from "./group-tree.js";
  import type { ChangeSpec } from "../panel/frontmatter-view.js";
  import type { SavedSearch } from "../search/saved-searches-store.js";
  import themeMap from "../../styles/THEME-MAP.json";

  // ── Theme (initialise from persisted user settings, then wire commands) ────────

  type ThemeMode = "light" | "dark" | "system";

  const themeKeys = themeMap.themes.map((t) => t.key);
  const themeNames = Object.fromEntries(themeMap.themes.map((t) => [t.key, t.name]));

  $effect(() => {
    // Restore persisted theme/mode before init() applies DOM attributes.
    const savedTheme = settings_get_user("theme");
    const savedMode = settings_get_user("mode");
    if (savedTheme && typeof savedTheme === "string") themeStore.setTheme(savedTheme);
    if (savedMode && (savedMode === "light" || savedMode === "dark" || savedMode === "system")) {
      themeStore.setMode(savedMode as ThemeMode);
    }
    themeStore.init();
    // Wire theme/mode commands through themeStore (fixes issue #23 sync gap).
    seedThemeCommands(themeStore);
    return () => themeStore.destroy();
  });

  // ── Responsive mode detection ─────────────────────────────────────────────────

  let narrow = $state(false);

  $effect(() => {
    const mq = window.matchMedia("(max-width: 699px)");
    narrow = mq.matches;
    const handler = (e: MediaQueryListEvent) => {
      narrow = e.matches;
      // On widening viewport, return to editor screen if on mobile
      if (!e.matches) mobileScreen = "editor";
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  });

  // Mobile screen stack: "list" | "editor" | "sidebar"
  type MobileScreen = "list" | "editor" | "sidebar";
  let mobileScreen = $state<MobileScreen>("list");

  let sidebarOpen = $state(false);

  // ── Group tree ────────────────────────────────────────────────────────────────

  let groupTree = $state<GroupNode[]>([]);

  async function loadGroups(): Promise<void> {
    const result = await ipc.list_groups();
    if (result.ok) {
      groupTree = buildGroupTree(result.value);
    } else {
      console.error("[shell] list_groups failed:", result.error.message);
    }
  }

  // ── People ────────────────────────────────────────────────────────────────────

  let people = $state<PersonMeta[]>([]);

  async function loadPeople(): Promise<void> {
    const result = await ipc.people_index();
    if (result.ok) {
      people = result.value;
    } else {
      console.error("[shell] people_index failed:", result.error.message);
    }
  }

  // ── Main zone mode ────────────────────────────────────────────────────────────

  /** Which main-zone content to show: editor, person view, tag browser, or settings. */
  type MainZone = "editor" | "person" | "tags" | "settings";
  let mainZone = $state<MainZone>("editor");

  let selectedPersonSlug = $state<string | null>(null);
  let selectedPersonMeta = $derived(
    selectedPersonSlug ? (people.find((p) => p.slug === selectedPersonSlug) ?? null) : null,
  );

  // Create-person dialog (also wired from autocomplete onCreatePerson).
  let showCreateDialog = $state(false);
  let createDialogInitialSlug = $state("");

  // ── Entry list ────────────────────────────────────────────────────────────────

  let selectedGroupPath = $state<string | null>(null);
  let entries = $state<EntrySummary[]>([]);
  let entriesLoading = $state(false);
  let entriesError = $state<string | null>(null);

  async function loadEntries(group: string | null): Promise<void> {
    entriesLoading = true;
    entriesError = null;
    const result = group
      ? await ipc.entries_in_group(group)
      : await ipc.search({ text: "", sort: "modified_desc" });
    entriesLoading = false;
    if (result.ok) {
      entries = result.value.items;
      // Auto-select first if current selection is no longer in the list
      if (selectedEntryId && !entries.find((e) => e.id === selectedEntryId)) {
        if (entries.length > 0) {
          await selectEntry(entries[0].id);
        } else {
          selectedEntryId = null;
          editorText = "";
        }
      } else if (!selectedEntryId && entries.length > 0) {
        await selectEntry(entries[0].id);
      }
    } else {
      entriesError = result.error.message;
    }
  }

  function onGroupSelect(path: string | null): void {
    selectedGroupPath = path;
    // Calendar stays open across group changes (the group filter passes through);
    // any other non-editor view returns to the editor.
    if (!calendarOpen) mainZone = "editor";
    loadEntries(path);
    if (narrow) {
      sidebarOpen = false;
      mobileScreen = "list";
    }
  }

  // ── Editor ────────────────────────────────────────────────────────────────────

  let selectedEntryId = $state<string | null>(null);
  let editorText = $state("");
  let panelChange = $state<ChangeSpec | null>(null);
  let propertiesVisible = $state(true);

  let writeTimer: ReturnType<typeof setTimeout> | undefined;

  async function selectEntry(id: string): Promise<void> {
    const result = await ipc.read_entry(id);
    if (result.ok) {
      selectedEntryId = id;
      editorText = result.value.text;
      if (narrow) mobileScreen = "editor";
    } else {
      console.error("[shell] read_entry failed:", result.error.message);
    }
  }

  function onEntrySelect(id: string): void {
    selectEntry(id);
  }

  function onDocChanged(text: string): void {
    editorText = text;
    if (!selectedEntryId) return;
    clearTimeout(writeTimer);
    const id = selectedEntryId;
    writeTimer = setTimeout(async () => {
      await ipc.write_entry(id, text, "shell-self-tok");
    }, 500);
  }

  function onPanelEdit(change: ChangeSpec): void {
    panelChange = { ...change };
  }

  const blockCallbacks = {
    onOpenAttachment(path: string) {
      console.log("[shell] open attachment:", path);
    },
    onAttachmentAction(path: string, action: "relink" | "remove") {
      console.log(`[shell] attachment action: ${action} on`, path);
    },
  };

  // ── index_changed → refresh lists ─────────────────────────────────────────────

  $effect(() => {
    const unsub = ipc.on("index_changed", () => {
      loadEntries(selectedGroupPath);
      loadGroups();
      loadPeople();
    });
    return unsub;
  });

  // ── Chip interaction (spec 0005 — chip click opens side panel) ───────────────

  function onTokenClick(kind: "tag" | "mention", value: string): void {
    if (kind === "mention") {
      // Open person view in main zone (spec 0005: non-navigational chip click).
      selectedPersonSlug = value;
      mainZone = "person";
      if (narrow) mobileScreen = "editor";
    } else {
      // Tag chip click: open tag browser.
      mainZone = "tags";
      if (narrow) mobileScreen = "editor";
    }
  }

  function onPersonSelect(slug: string): void {
    selectedPersonSlug = slug;
    mainZone = "person";
    if (narrow) {
      sidebarOpen = false;
      mobileScreen = "editor";
    }
  }

  function onTagsOpen(): void {
    mainZone = "tags";
    if (narrow) {
      sidebarOpen = false;
      mobileScreen = "editor";
    }
  }

  function onNavigate(target: string): void {
    console.log("[shell] navigate →", target);
  }

  function onCreatePerson(slug: string): void {
    // Autocomplete "Create person" sentinel → open create dialog.
    createDialogInitialSlug = slug;
    showCreateDialog = true;
  }

  function onPersonCreated(slug: string): void {
    showCreateDialog = false;
    loadPeople();
    // Immediately show the new person's view.
    selectedPersonSlug = slug;
    mainZone = "person";
  }

  // ── Group display name for entry list header ──────────────────────────────────

  function resolveGroupName(path: string | null, tree: GroupNode[]): string {
    if (!path) return "All entries";
    function search(nodes: GroupNode[]): string | null {
      for (const n of nodes) {
        if (n.path === path) return n.name;
        const found = search(n.children);
        if (found) return found;
      }
      return null;
    }
    return search(tree) ?? path.split("/").at(-1) ?? path;
  }

  const groupDisplayName = $derived(resolveGroupName(selectedGroupPath, groupTree));

  // ── Search overlay ────────────────────────────────────────────────────────────

  let searchOverlay = $state<
    | {
        openSearch(): void;
        restoreSavedSearch(s: {
          text: string;
          filters: import("../ipc/types.js").SavedSearchFilter[];
        }): void;
      }
    | undefined
  >();

  function openSearch(): void {
    searchOverlay?.openSearch();
  }

  function onSelectSavedSearch(s: SavedSearch): void {
    searchOverlay?.restoreSavedSearch(s);
  }

  // ── cmd+p via the command registry ────────────────────────────────────────────
  // The keymap engine (0007) owns all bindings; entry.search is seeded with
  // cmd+p and a stub handler — re-register it pointing at the real overlay so
  // there is exactly one owner of the binding (no parallel keydown listeners).

  $effect(() => {
    const seeded = registry.get("entry.search");
    if (seeded) {
      registry.register({ ...seeded, handler: () => openSearch() });
    }
  });

  // ── app.settings via the command registry ─────────────────────────────────────
  // Re-register the seeded stub with the real handler that opens the settings view.

  function openSettings(): void {
    mainZone = "settings";
    if (narrow) mobileScreen = "editor";
  }

  $effect(() => {
    const seeded = registry.get("app.settings");
    if (seeded) {
      registry.register({ ...seeded, handler: () => openSettings() });
    }
  });

  // ── Calendar zone ─────────────────────────────────────────────────────────────

  let calendarOpen = $state(false);

  function openCalendar(): void {
    calendarOpen = true;
    mainZone = "editor";
    if (narrow) mobileScreen = "editor"; // reuse editor screen slot on mobile
  }

  function onCalendarSelectEntry(entryId: string): void {
    // Open the selected entry's properties side panel.
    selectEntry(entryId);
    if (calendarOpen) propertiesVisible = true;
  }

  function onCalendarApplyEdit(entryId: string, change: ChangeSpec): void {
    // Reflect a calendar drag-to-reschedule into the editor buffer if the entry
    // is currently open.
    if (selectedEntryId === entryId) {
      onPanelEdit(change);
    }
  }

  // ── Initial load ──────────────────────────────────────────────────────────────

  $effect(() => {
    loadGroups();
    loadEntries(null);
    void savedSearchesStore.load();
    loadPeople();
  });
</script>

<div class="app-shell" class:app-shell--narrow={narrow} class:sidebar-open={sidebarOpen}>
  <!-- Title bar -->
  <header class="titlebar">
    <div class="titlebar-left">
      {#if narrow}
        <!-- Hamburger to reveal sidebar on mobile -->
        <button
          class="titlebar-btn"
          aria-label="Open sidebar"
          onclick={() => {
            sidebarOpen = !sidebarOpen;
          }}
        >
          ☰
        </button>
        {#if mobileScreen === "editor" && selectedEntryId}
          <button
            class="titlebar-btn titlebar-btn--back"
            aria-label="Back to list"
            onclick={() => (mobileScreen = "list")}
          >
            ‹ Back
          </button>
        {/if}
      {/if}
      <span class="titlebar-app-name">ToNoteDo</span>
      {#if selectedGroupPath}
        <span class="titlebar-crumb-sep">/</span>
        <span class="titlebar-crumb">{groupDisplayName}</span>
      {/if}
    </div>

    <div class="titlebar-right">
      <!-- Theme switcher (minimal; #23 will formalise) -->
      <label class="titlebar-label" for="shell-theme">Theme</label>
      <select
        id="shell-theme"
        class="titlebar-select"
        value={themeStore.theme}
        onchange={(e) => themeStore.setTheme((e.target as HTMLSelectElement).value)}
      >
        {#each themeKeys as key (key)}
          <option value={key}>{themeNames[key]}</option>
        {/each}
      </select>

      <label class="titlebar-label" for="shell-mode">Mode</label>
      <select
        id="shell-mode"
        class="titlebar-select"
        value={themeStore.mode}
        onchange={(e) => themeStore.setMode((e.target as HTMLSelectElement).value as ThemeMode)}
      >
        <option value="light">Light</option>
        <option value="dark">Dark</option>
        <option value="system">System</option>
      </select>

      {#if !narrow}
        <button
          class="titlebar-btn titlebar-btn--toggle"
          aria-label="Toggle properties panel"
          aria-pressed={propertiesVisible}
          onclick={() => (propertiesVisible = !propertiesVisible)}
        >
          Properties
        </button>
      {/if}

      <!-- Settings gear affordance -->
      <button
        class="titlebar-btn titlebar-btn--settings"
        class:titlebar-btn--toggle={mainZone === "settings"}
        aria-label="Open Settings (⌘,)"
        aria-pressed={mainZone === "settings"}
        onclick={openSettings}
        title="Settings (⌘,)"
      >
        ⚙
      </button>
    </div>
  </header>

  <!-- Body: sidebar + entry-list + editor + properties -->
  <div class="app-body">
    <!-- Sidebar overlay backdrop on mobile -->
    {#if narrow && sidebarOpen}
      <div class="sidebar-backdrop" role="presentation" onclick={() => (sidebarOpen = false)}></div>
    {/if}

    <!-- Sidebar -->
    <Sidebar
      tree={groupTree}
      selectedPath={selectedGroupPath}
      {onGroupSelect}
      onOpenSearch={openSearch}
      {onSelectSavedSearch}
      {people}
      {selectedPersonSlug}
      {onPersonSelect}
      {onTagsOpen}
      tagsOpen={mainZone === "tags"}
      onCalendarOpen={openCalendar}
      calendarActive={calendarOpen}
    />

    <!-- Entry list (hidden on mobile when in editor screen) -->
    {#if !narrow || mobileScreen === "list"}
      <EntryList
        groupName={groupDisplayName}
        {entries}
        selectedId={selectedEntryId}
        loading={entriesLoading}
        error={entriesError}
        {onEntrySelect}
      />
    {/if}

    <!-- Editor / Person / Tags zone (hidden on mobile when in list screen) -->
    {#if !narrow || mobileScreen === "editor"}
      <main class="editor-zone" data-focus-zone="editor">
        {#if calendarOpen && mainZone === "editor"}
          <CalendarView
            group={selectedGroupPath}
            onSelectEntry={onCalendarSelectEntry}
            onApplyEdit={onCalendarApplyEdit}
          />
        {:else if mainZone === "person" && selectedPersonMeta}
          <PersonView
            person={selectedPersonMeta}
            onEntrySelect={(id) => {
              mainZone = "editor";
              selectEntry(id);
            }}
            {onPersonCreated}
          />
        {:else if mainZone === "tags"}
          <TagBrowser
            onTagSelect={(name) => {
              console.log("[shell] tag selected:", name);
            }}
          />
        {:else if mainZone === "settings"}
          <SettingsView onClose={() => (mainZone = "editor")} />
        {:else if selectedEntryId}
          <Editor
            doc={editorText}
            {onDocChanged}
            {onTokenClick}
            {onNavigate}
            {onCreatePerson}
            entryPath={selectedEntryId}
            {blockCallbacks}
            externalChange={panelChange}
          />
        {:else}
          <div class="editor-empty">Select an entry to begin editing</div>
        {/if}
      </main>
    {/if}

    <!-- Properties panel (desktop only when visible; not shown for person/tags views) -->
    {#if !narrow && propertiesVisible && mainZone === "editor"}
      <aside class="properties-zone" data-focus-zone="properties">
        {#if selectedEntryId}
          <PropertiesPanel docText={editorText} onEdit={onPanelEdit} />
        {:else}
          <div class="properties-empty">No entry selected</div>
        {/if}
      </aside>
    {/if}
  </div>

  <!-- Search overlay (cmd+p) -->
  <SearchOverlay
    bind:this={searchOverlay}
    onSelectEntry={(id) => {
      selectEntry(id);
      if (narrow) mobileScreen = "editor";
    }}
  />

  <!-- Create-person dialog (from autocomplete onCreatePerson) -->
  {#if showCreateDialog}
    <CreatePersonDialog
      initialSlug={createDialogInitialSlug}
      onClose={() => (showCreateDialog = false)}
      onCreated={onPersonCreated}
    />
  {/if}

  <!-- Status bar -->
  <footer class="statusbar">
    <span class="statusbar-hints">
      <kbd>⌘K</kbd> Commands
      <kbd>⌘P</kbd> Search
      <kbd>⌘N</kbd> New entry
      <kbd>?</kbd> Shortcuts
    </span>
    <span class="statusbar-zone">
      {#if selectedEntryId}EDITOR{:else}ENTRY-LIST{/if}
    </span>
  </footer>
</div>

<style>
  /* ── Shell chrome ──────────────────────────────────────────────────────────── */

  .app-shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--tnd-bg);
    color: var(--tnd-text);
    font-family: ui-sans-serif, system-ui, sans-serif;
    overflow: hidden;
  }

  /* Title bar */
  .titlebar {
    height: 44px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 12px;
    gap: 12px;
    background: var(--tnd-panel);
    border-bottom: 1px solid var(--tnd-line-strong);
  }

  .titlebar-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .titlebar-app-name {
    font-weight: 700;
    font-size: 13.5px;
    color: var(--tnd-text);
    letter-spacing: -0.01em;
    white-space: nowrap;
  }

  .titlebar-crumb-sep {
    color: var(--tnd-text-faint);
    font-size: 13px;
  }

  .titlebar-crumb {
    font-size: 12.5px;
    font-weight: 500;
    color: var(--tnd-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 220px;
  }

  .titlebar-right {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .titlebar-label {
    font-size: 11.5px;
    color: var(--tnd-text-faint);
    white-space: nowrap;
  }

  .titlebar-select {
    font-size: 12px;
    padding: 3px 6px;
    background: var(--tnd-panel2);
    color: var(--tnd-text);
    border: 1px solid var(--tnd-line-strong);
    border-radius: 4px;
    outline: none;
    cursor: pointer;
  }

  .titlebar-select:focus {
    border-color: var(--tnd-accent);
  }

  .titlebar-btn {
    background: transparent;
    border: 1px solid var(--tnd-line-strong);
    color: var(--tnd-text-muted);
    font-size: 12px;
    padding: 3px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    white-space: nowrap;
  }

  .titlebar-btn:hover {
    background: var(--tnd-panel2);
  }

  .titlebar-btn--toggle[aria-pressed="true"] {
    background: var(--tnd-accent-soft);
    color: var(--tnd-accent-text);
    border-color: var(--tnd-accent);
  }

  .titlebar-btn--back {
    color: var(--tnd-accent-text);
    border-color: transparent;
    font-size: 13px;
  }

  .titlebar-btn--settings {
    font-size: 15px;
    padding: 2px 7px;
  }

  /* Body */
  .app-body {
    flex: 1;
    display: flex;
    min-height: 0;
    position: relative;
  }

  /* Editor zone */
  .editor-zone {
    flex: 1;
    min-width: 0;
    min-height: 0;
    background: var(--tnd-bg);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .editor-empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--tnd-text-faint);
    font-size: 14px;
  }

  /* Properties zone */
  .properties-zone {
    width: 260px;
    flex-shrink: 0;
    min-height: 0;
    border-left: 1px solid var(--tnd-line);
    background: var(--tnd-panel);
    overflow: hidden;
  }

  .properties-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--tnd-text-faint);
    font-size: 13px;
  }

  /* Status bar */
  .statusbar {
    height: 26px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 12px;
    background: var(--tnd-accent);
    color: rgba(255, 255, 255, 0.92);
    font-size: 11px;
  }

  .statusbar-hints {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .statusbar-hints kbd {
    font-weight: 700;
    font-family: ui-monospace, monospace;
    font-size: 10.5px;
    margin-right: 4px;
    color: #fff;
  }

  .statusbar-zone {
    font-size: 10.5px;
    letter-spacing: 0.06em;
    opacity: 0.85;
  }

  /* Sidebar backdrop (mobile overlay) */
  .sidebar-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 199;
  }

  /* ── Responsive ──────────────────────────────────────────────────────────── */

  @media (max-width: 699px) {
    .titlebar {
      height: 48px;
    }

    .titlebar-label {
      display: none;
    }

    .editor-zone {
      width: 100%;
    }

    .statusbar-hints {
      display: none;
    }
  }
</style>
