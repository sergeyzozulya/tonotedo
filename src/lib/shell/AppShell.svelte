<script lang="ts">
  // AppShell — three-zone layout (sidebar + entry-list + editor + properties).
  // (spec 0007 focus zones, spec 0013 mobile, issue #18, issue #24)
  //
  // Zones:
  //   Left   — Sidebar (group tree navigation, 246px)
  //   Centre-left — EntryList (300px)
  //   Centre — Editor (fills remaining space)
  //   Right  — PropertiesPanel (260px, toggleable)
  //
  // Mobile (<700px): zones become full-screen screens per 0013 (issue #24).
  //   Screens: list | editor | sidebar | calendar | person | tags | settings
  //   Properties → slide-up bottom sheet from editor toolbar button.
  //   Consistent top app bar: back/title/search/palette actions.
  //   Floating palette FAB, pull-down-to-palette, long-press entry → action sheet,
  //   tap-and-hold chip → metadata popover, editor accessory bar above keyboard.
  //
  // Theme attributes (data-tnd-theme / data-tnd-mode) live on <html> managed
  // by theme-store.ts.  Issue #23 will formalise persistence.

  import { ipc } from "../ipc/index.js";
  import { registry, seedThemeCommands } from "../commands/index.js";
  import { settings_get_user } from "../commands/settings.js";
  import { buildGroupTree } from "./group-tree.js";
  import { themeStore } from "./theme-store.svelte.js";
  import Sidebar from "./Sidebar.svelte";
  import EntryList from "./EntryList.svelte";
  import { Editor } from "../editor/index.js";
  import PropertiesPanel from "../panel/PropertiesPanel.svelte";
  import SearchOverlay from "../search/SearchOverlay.svelte";
  import { savedSearchesStore } from "../search/saved-searches-store.svelte.js";
  import ConflictBanner from "./ConflictBanner.svelte";
  import {
    makeTracker,
    onLoaded,
    onEditorChange,
    onWriteComplete,
    onIndexChanged,
    stashBufferBackup,
    clearBufferBackup,
  } from "./conflict.js";
  import PersonView from "../people/PersonView.svelte";
  import TagBrowser from "../tags/TagBrowser.svelte";
  import CreatePersonDialog from "../people/CreatePersonDialog.svelte";
  import CalendarView from "../calendar/CalendarView.svelte";
  import SettingsView from "../settings/SettingsView.svelte";
  import TrashView from "./TrashView.svelte";
  import { PluginManager } from "../plugins/index.js";
  import type { EntrySummary, PersonMeta, TagMeta } from "../ipc/types.js";
  import type { GroupNode } from "./group-tree.js";
  import type { ChangeSpec } from "../panel/frontmatter-view.js";
  import type { SavedSearch } from "../search/saved-searches-store.svelte.js";
  // Mobile components (issue #24)
  import MobileTopBar from "./MobileTopBar.svelte";
  import PropertiesSheet from "./PropertiesSheet.svelte";
  import ActionSheet from "./ActionSheet.svelte";
  import ChipPopover from "./ChipPopover.svelte";
  import EditorAccessoryBar from "./EditorAccessoryBar.svelte";
  import FloatingPaletteButton from "./FloatingPaletteButton.svelte";
  import {
    initialMobileScreenState,
    mobileScreenReduce,
    screenTitle,
    hasBack,
  } from "./mobile-screen.js";
  import { setPaletteOpener } from "../commands/index.js";
  import Palette from "../commands/Palette.svelte";

  // ── Theme (initialise from persisted user settings, then wire commands) ────────

  type ThemeMode = "light" | "dark" | "system";

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
      if (!e.matches) {
        // Widened — collapse the mobile state machine
        mobileState = mobileScreenReduce(mobileState, { type: "widen" });
      }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  });

  // ── Mobile screen state machine (spec 0013, issue #24) ───────────────────────

  let mobileState = $state(initialMobileScreenState());

  // Convenience accessors
  const mobileScreen = $derived(mobileState.screen);
  const mobilePropertiesOpen = $derived(mobileState.propertiesOpen);

  function mobilePush(screen: import("./mobile-screen.js").MobileScreen): void {
    mobileState = mobileScreenReduce(mobileState, { type: "push", screen });
  }

  function mobileBack(): void {
    mobileState = mobileScreenReduce(mobileState, { type: "back" });
  }

  function mobileToggleProperties(): void {
    mobileState = mobileScreenReduce(mobileState, { type: "toggle-properties" });
  }

  let sidebarOpen = $state(false);

  // ── Command palette (shared between desktop keymap and mobile FAB) ───────────
  //
  // The palette Svelte component lives in App.svelte. AppShell's mobile FAB
  // and top-bar palette button register their own opener via setPaletteOpener,
  // replacing (but not conflicting with) App.svelte's registration since only
  // one caller at a time owns it. The FAB hides itself by tracking a local flag
  // that is set to false when the palette closes.

  let paletteOpen = $state(false);

  $effect(() => {
    // Register this shell's opener so ⌘K from the keymap and the FAB both work.
    setPaletteOpener(() => {
      paletteOpen = true;
    });
  });

  function openPalette(): void {
    paletteOpen = true;
  }

  // ── Action sheet (long-press entry row) ──────────────────────────────────────

  let actionSheetEntry = $state<{ id: string; title: string } | null>(null);

  function openActionSheet(id: string, title: string): void {
    actionSheetEntry = { id, title };
  }

  function closeActionSheet(): void {
    actionSheetEntry = null;
  }

  // ── Chip popover (tap-and-hold on chip) ──────────────────────────────────────

  let chipPopover = $state<{
    kind: "tag" | "mention";
    value: string;
    tagMeta: TagMeta | null;
    personMeta: PersonMeta | null;
  } | null>(null);

  function openChipPopover(
    kind: "tag" | "mention",
    value: string,
    tagMeta: TagMeta | null,
    personMeta: PersonMeta | null,
  ): void {
    chipPopover = { kind, value, tagMeta, personMeta };
  }

  function closeChipPopover(): void {
    chipPopover = null;
  }

  // ── Editor focus (for accessory bar) ─────────────────────────────────────────

  let editorFocused = $state(false);

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

  /** Which main-zone content to show: editor, person view, tag browser, settings, trash, or plugins. */
  type MainZone = "editor" | "person" | "tags" | "settings" | "trash" | "plugins";
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
      mobilePush("list");
    }
  }

  // ── Editor ────────────────────────────────────────────────────────────────────

  let selectedEntryId = $state<string | null>(null);
  let editorText = $state("");
  let panelChange = $state<ChangeSpec | null>(null);
  let propertiesVisible = $state(true);

  let writeTimer: ReturnType<typeof setTimeout> | undefined;

  // ── Conflict / external-edit tracking (spec 0006) ────────────────────────────

  let conflictTracker = $state(makeTracker());
  /** When non-null, the conflict banner is shown. diskText is the on-disk version. */
  let conflictDiskText = $state<string | null>(null);
  /**
   * When non-null, a full-document replace is pending for the editor (silent
   * reload or use-disk action). Passed as externalDocReplace to the Editor.
   */
  let fullDocReplace = $state<{ fullDoc: string } | null>(null);

  /**
   * Malformed-frontmatter warning for the open entry (spec 0002). Non-blocking;
   * shown as a dismissible badge in the editor header. Null when well-formed.
   */
  let parseWarning = $state<string | null>(null);

  async function selectEntry(id: string): Promise<void> {
    const result = await ipc.read_entry(id);
    if (result.ok) {
      selectedEntryId = id;
      editorText = result.value.text;
      parseWarning = result.value.parseWarning ?? null;
      conflictTracker = onLoaded(conflictTracker, id, result.value.text);
      conflictDiskText = null; // clear any pending conflict from a previous entry
      if (narrow) mobilePush("editor");
    } else {
      console.error("[shell] read_entry failed:", result.error.message);
    }
  }

  // ── Entry rename (spec 0002 §Identity — slug operation) ──────────────────────
  // Renaming changes the .md filename slug; the entry id and the H1 title are
  // unchanged. In-app references are rewritten by the core. We prompt for the new
  // slug, call rename_entry, then re-select the entry at its new id.

  async function renameEntry(id: string): Promise<void> {
    const oldSlug = id.split("/").at(-1) ?? id;
    const group = id.includes("/") ? id.split("/").slice(0, -1).join("/") : "";
    const input = window.prompt("Rename entry (new slug):", oldSlug);
    if (input === null) return;
    const newSlug = input.trim();
    if (!newSlug || newSlug === oldSlug) return;

    const path = `${id}.md`;
    const result = await ipc.rename_entry(path, newSlug);
    if (!result.ok) {
      console.error("[shell] rename_entry failed:", result.error.message);
      return;
    }
    await loadEntries(selectedGroupPath);
    loadGroups();
    // The slug may have been collision-suffixed; re-select by best guess and
    // fall back to refreshing the list if the exact id isn't present.
    const newId = group ? `${group}/${newSlug}` : newSlug;
    if (selectedEntryId === id) {
      await selectEntry(newId);
    }
  }

  function onEntrySelect(id: string): void {
    selectEntry(id);
  }

  function onDocChanged(text: string): void {
    editorText = text;
    conflictTracker = onEditorChange(conflictTracker);
    if (!selectedEntryId) return;
    clearTimeout(writeTimer);
    const id = selectedEntryId;
    writeTimer = setTimeout(async () => {
      const writeResult = await ipc.write_entry(id, text, conflictTracker.lastWriteToken ?? "");
      if (writeResult.ok) {
        conflictTracker = onWriteComplete(conflictTracker, writeResult.value.selfToken);
      }
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

  // ── index_changed → refresh lists + conflict detection (spec 0006) ───────────

  $effect(() => {
    const unsub = ipc.on("index_changed", async (event) => {
      // Always refresh lists and groups.
      loadEntries(selectedGroupPath);
      loadGroups();
      loadPeople();

      // Check each changed path for a conflict with the open buffer.
      for (const path of event.paths) {
        const decision = await onIndexChanged(
          conflictTracker,
          path,
          event.selfToken,
          async (id) => {
            const r = await ipc.read_entry(id);
            return r.ok ? r.value.text : null;
          },
          event.selfOriginated,
        );

        if (decision.action === "reload") {
          // Buffer was clean — silently re-read and replace via fullDocReplace.
          const r = await ipc.read_entry(conflictTracker.entryId!);
          if (r.ok) {
            editorText = r.value.text;
            fullDocReplace = { fullDoc: r.value.text };
            conflictTracker = onLoaded(conflictTracker, conflictTracker.entryId!, r.value.text);
          }
          break;
        } else if (decision.action === "banner") {
          // Buffer is dirty — show the banner.
          conflictDiskText = decision.diskText;
          break;
        }
        // "ignore" — do nothing for this path
      }
    });
    return unsub;
  });

  // ── Reconciler notifications → non-blocking notice (spec 0002 edge cases) ─────
  // Duplicate-id repair: the reconciler assigned a fresh id to a file whose id
  // collided with another live entry. Surface it non-blockingly; the user
  // dismisses it. Reuses the same event channel as index_changed.

  let dupNotice = $state<string | null>(null);

  $effect(() => {
    const unsub = ipc.on("reconcile_notification", (event) => {
      if (event.kind === "duplicate_id_resolved") {
        const where = event.path ? ` (${event.path})` : "";
        dupNotice = `A duplicate entry id was detected and a fresh id was assigned${where}.`;
      }
    });
    return unsub;
  });

  function dismissDupNotice(): void {
    dupNotice = null;
  }

  // ── Conflict banner actions ────────────────────────────────────────────────────

  async function conflictKeepMine(): Promise<void> {
    if (!selectedEntryId) return;
    // Write the current buffer over disk.
    const writeResult = await ipc.write_entry(
      selectedEntryId,
      editorText,
      conflictTracker.lastWriteToken ?? "",
    );
    if (writeResult.ok) {
      conflictTracker = onWriteComplete(conflictTracker, writeResult.value.selfToken);
      clearBufferBackup(selectedEntryId);
    }
    conflictDiskText = null;
  }

  function conflictUseDisk(): void {
    if (!selectedEntryId || conflictDiskText === null) return;
    // Stash local buffer before discarding (cheap insurance per spec 0006).
    stashBufferBackup(selectedEntryId, editorText);
    const diskText = conflictDiskText;
    conflictDiskText = null;
    // Replace the editor document with the disk content via fullDocReplace.
    editorText = diskText;
    fullDocReplace = { fullDoc: diskText };
    conflictTracker = onLoaded(conflictTracker, selectedEntryId, diskText);
  }

  function conflictDismiss(): void {
    conflictDiskText = null;
  }

  // ── Chip interaction (spec 0005 — chip click opens side panel) ───────────────
  // On mobile: chip tap → metadata popover (spec 0013 "hover → tap-and-hold").
  // The popover's navigation links can push to person/tags screens.

  function onTokenClick(kind: "tag" | "mention", value: string): void {
    if (narrow) {
      // Mobile: show metadata popover (spec 0013 "hover → tap").
      // For tags, metadata is in chips.ts's internal cache — we don't have it here;
      // pass null and let the popover show the name. For mentions, look up people.
      const personMeta = kind === "mention" ? (people.find((p) => p.slug === value) ?? null) : null;
      openChipPopover(kind, value, null, personMeta);
      return;
    }
    if (kind === "mention") {
      // Open person view in main zone (spec 0005: non-navigational chip click).
      selectedPersonSlug = value;
      mainZone = "person";
    } else {
      // Tag chip click: open tag browser.
      mainZone = "tags";
    }
  }

  function onPersonSelect(slug: string): void {
    selectedPersonSlug = slug;
    mainZone = "person";
    if (narrow) {
      sidebarOpen = false;
      mobilePush("person");
    }
  }

  function onTagsOpen(): void {
    mainZone = "tags";
    if (narrow) {
      sidebarOpen = false;
      mobilePush("tags");
    }
  }

  function onTrashOpen(): void {
    mainZone = "trash";
    if (narrow) {
      sidebarOpen = false;
      mobilePush("tags"); // reuse the tags full-screen slot for trash on mobile
    }
  }

  function onPluginsOpen(): void {
    mainZone = "plugins";
    if (narrow) {
      sidebarOpen = false;
      mobilePush("plugins");
    }
  }

  async function onTrashEntry(entryId: string): Promise<void> {
    const path = entryId.endsWith(".md") ? entryId : `${entryId}.md`;
    const res = await ipc.trash_entry(path);
    if (res.ok) {
      // Deselect if the trashed entry was open.
      if (selectedEntryId === entryId) {
        selectedEntryId = null;
        editorText = "";
      }
      loadEntries(selectedGroupPath);
      loadGroups();
    } else {
      console.error("[shell] trash_entry failed:", res.error.message);
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

  // Titlebar chrome (design TNDTitleBar). `boxed`/uppercase flags key off Mono.
  const boxed = $derived(themeStore.theme === "mono");
  const rootCrumb = $derived(
    selectedGroupPath ? selectedGroupPath.split("/")[0].replace(/^\w/, (c) => c.toUpperCase()) : "",
  );

  async function createEntry(): Promise<void> {
    const base = selectedGroupPath || "inbox";
    // Collision-suffixed slug: untitled, untitled-2, untitled-3, … checking the
    // entries already present in the target group (spec 0002 §Filename collisions).
    const existingSlugs = new Set(
      entries.filter((e) => (e.group || "") === base).map((e) => e.id.split("/").at(-1)),
    );
    let slug = "untitled";
    if (existingSlugs.has(slug)) {
      let n = 2;
      while (existingSlugs.has(`untitled-${n}`)) n += 1;
      slug = `untitled-${n}`;
    }
    const id = `${base}/${slug}`;
    const text = `# Untitled\n`;
    const r = await ipc.write_entry(id, text, "shell-self-tok");
    if (r.ok) {
      await loadEntries(selectedGroupPath);
      await selectEntry(id);
    }
  }

  /** Group path of the currently selected entry (for PropertiesPanel schema). */
  const selectedEntryGroup = $derived(
    selectedEntryId ? (entries.find((e) => e.id === selectedEntryId)?.group ?? null) : null,
  );

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

  // ── entry.rename via the command registry ──────────────────────────────────────
  // Re-register the seeded stub with the real handler that renames the open entry.

  $effect(() => {
    const seeded = registry.get("entry.rename");
    if (seeded) {
      registry.register({
        ...seeded,
        handler: () => {
          if (selectedEntryId) renameEntry(selectedEntryId);
        },
      });
    }
  });

  // ── app.settings via the command registry ─────────────────────────────────────
  // Re-register the seeded stub with the real handler that opens the settings view.

  function openSettings(): void {
    mainZone = "settings";
    if (narrow) mobilePush("settings");
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
    if (narrow) mobilePush("calendar");
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
  {#if dupNotice}
    <div class="dup-notice" role="status" aria-live="polite">
      <span class="dup-notice__icon" aria-hidden="true">ℹ</span>
      <span class="dup-notice__text">{dupNotice}</span>
      <button class="dup-notice__dismiss" onclick={dismissDupNotice} aria-label="Dismiss notice"
        >✕</button
      >
    </div>
  {/if}
  {#if narrow}
    <!-- ── Mobile layout ────────────────────────────────────────────────────── -->

    <!-- Consistent mobile top app bar (back/title/search/palette) -->
    <MobileTopBar
      title={mobilePropertiesOpen ? "Properties" : screenTitle(mobileScreen)}
      showBack={hasBack(mobileState)}
      onBack={mobileBack}
      showHamburger={!hasBack(mobileState)}
      onHamburger={() => {
        sidebarOpen = !sidebarOpen;
      }}
      onSearch={openSearch}
      onPalette={openPalette}
    />

    <!-- Sidebar as a slide-over (backdrop + panel) on mobile -->
    {#if sidebarOpen}
      <div class="sidebar-backdrop" role="presentation" onclick={() => (sidebarOpen = false)}></div>
      <div class="mobile-sidebar-panel">
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
          {onTrashOpen}
          trashOpen={mainZone === "trash"}
          {onPluginsOpen}
          pluginsOpen={mainZone === "plugins"}
          onGroupsChanged={() => {
            loadGroups();
            loadEntries(selectedGroupPath);
          }}
        />
      </div>
    {/if}

    <!-- Full-screen mobile body: one screen at a time -->
    <div class="app-body">
      <!-- list screen -->
      {#if mobileScreen === "list"}
        <EntryList
          groupName={groupDisplayName}
          {entries}
          selectedId={selectedEntryId}
          loading={entriesLoading}
          error={entriesError}
          {onEntrySelect}
          onLongPress={(id, title) => openActionSheet(id, title)}
        />
      {/if}

      <!-- editor screen -->
      {#if mobileScreen === "editor"}
        <main class="editor-zone" data-focus-zone="editor">
          {#if selectedEntryId}
            <!-- Editor toolbar: thin bar with Properties peek button -->
            <div class="mobile-editor-toolbar">
              <button
                class="mobile-editor-toolbar-btn"
                aria-label="Toggle properties"
                aria-pressed={mobilePropertiesOpen}
                onclick={mobileToggleProperties}
              >
                <!-- properties/panel icon -->
                <svg
                  viewBox="0 0 20 20"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <rect x="3" y="3" width="14" height="14" rx="2" />
                  <path d="M12 3v14" />
                </svg>
                Props
              </button>
            </div>
            {#if conflictDiskText !== null}
              <ConflictBanner
                diskText={conflictDiskText}
                bufferText={editorText}
                onKeepMine={conflictKeepMine}
                onUseDisk={conflictUseDisk}
                onDismiss={conflictDismiss}
              />
            {/if}
            {#if parseWarning}
              <div class="parse-warning" role="status">
                <span class="parse-warning__icon" aria-hidden="true">⚠</span>
                <span class="parse-warning__text">{parseWarning}</span>
                <button
                  class="parse-warning__dismiss"
                  onclick={() => (parseWarning = null)}
                  aria-label="Dismiss frontmatter warning">✕</button
                >
              </div>
            {/if}
            <Editor
              doc={editorText}
              {onDocChanged}
              {onTokenClick}
              {onNavigate}
              {onCreatePerson}
              entryPath={selectedEntryId}
              {blockCallbacks}
              externalChange={panelChange}
              externalDocReplace={fullDocReplace}
              groupPath={selectedEntryGroup}
            />
          {:else}
            <div class="editor-empty">Select an entry to begin editing</div>
          {/if}
        </main>
      {/if}

      <!-- calendar screen (full-screen on mobile) -->
      {#if mobileScreen === "calendar"}
        <main class="editor-zone" data-focus-zone="calendar">
          <CalendarView
            group={selectedGroupPath}
            onSelectEntry={(id) => {
              onCalendarSelectEntry(id);
              mobilePush("editor");
            }}
            onApplyEdit={onCalendarApplyEdit}
          />
        </main>
      {/if}

      <!-- person screen (full-screen on mobile) -->
      {#if mobileScreen === "person"}
        <main class="editor-zone" data-focus-zone="editor">
          {#if selectedPersonMeta}
            <PersonView
              person={selectedPersonMeta}
              onEntrySelect={(id) => {
                mainZone = "editor";
                selectEntry(id);
              }}
              {onPersonCreated}
            />
          {:else}
            <div class="editor-empty">No person selected</div>
          {/if}
        </main>
      {/if}

      <!-- tags / trash screen (full-screen on mobile) -->
      {#if mobileScreen === "tags"}
        <main class="editor-zone" data-focus-zone="editor">
          {#if mainZone === "trash"}
            <TrashView
              onRestored={() => {
                loadGroups();
                loadEntries(selectedGroupPath);
              }}
            />
          {:else}
            <TagBrowser
              onTagSelect={(name) => {
                console.log("[shell] tag selected:", name);
              }}
            />
          {/if}
        </main>
      {/if}

      <!-- settings screen (full-screen) -->
      {#if mobileScreen === "settings"}
        <main class="editor-zone">
          <SettingsView />
        </main>
      {/if}

      <!-- plugins screen (full-screen) -->
      {#if mobileScreen === "plugins"}
        <main class="editor-zone">
          <PluginManager />
        </main>
      {/if}

      <!-- sidebar screen (full-screen on mobile — accessible via hamburger push too) -->
      {#if mobileScreen === "sidebar"}
        <div style="flex:1;overflow:auto;">
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
            {onPluginsOpen}
            pluginsOpen={mainZone === "plugins"}
          />
        </div>
      {/if}
    </div>

    <!-- Properties bottom sheet (layered on top of editor screen) -->
    <PropertiesSheet
      open={mobilePropertiesOpen}
      docText={editorText}
      onEdit={onPanelEdit}
      onClose={() => (mobileState = mobileScreenReduce(mobileState, { type: "close-properties" }))}
      groupPath={selectedEntryGroup}
    />

    <!-- Action sheet (long-press entry row) -->
    <ActionSheet
      open={actionSheetEntry !== null}
      entryId={actionSheetEntry?.id ?? null}
      entryTitle={actionSheetEntry?.title ?? ""}
      onClose={closeActionSheet}
      onOpen={(id) => {
        selectEntry(id);
        closeActionSheet();
      }}
      onRename={(id) => {
        void renameEntry(id);
        closeActionSheet();
      }}
      onTrash={(id) => {
        void onTrashEntry(id);
        closeActionSheet();
      }}
    />

    <!-- Chip popover (tap-and-hold on chip) -->
    {#if chipPopover !== null}
      <ChipPopover
        open={true}
        kind={chipPopover.kind}
        value={chipPopover.value}
        tagMeta={chipPopover.tagMeta}
        personMeta={chipPopover.personMeta}
        onClose={closeChipPopover}
      />
    {/if}

    <!-- Floating palette button (persistent, narrow only) -->
    {#if !paletteOpen && actionSheetEntry === null && chipPopover === null && !mobilePropertiesOpen}
      <FloatingPaletteButton onTap={openPalette} />
    {/if}

    <!-- Editor accessory bar above software keyboard -->
    <EditorAccessoryBar {editorFocused} />

    <!-- Status bar (narrow: minimal zone label only) -->
    <footer class="statusbar">
      <span class="statusbar-zone">{screenTitle(mobileScreen).toUpperCase()}</span>
    </footer>
  {:else}
    <!-- ── Desktop layout ───────────────────────────────────────────────────── -->

    <!-- Title bar (ported from design TNDTitleBar) -->
    <header class="titlebar">
      <div class="titlebar-left">
        {#if boxed}
          <span class="titlebar-mono-root">~/library</span>
        {:else}
          <span class="titlebar-badge">T</span>
          <span class="titlebar-app-name">My Library</span>
          <svg class="titlebar-ico" viewBox="0 0 24 24" width="13" height="13"
            ><path
              d="M6 9l6 6 6-6"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            /></svg
          >
        {/if}
      </div>

      <div class="titlebar-divider"></div>

      <div class="titlebar-crumbs">
        <span class="titlebar-crumb-muted">{selectedGroupPath ? rootCrumb : "All entries"}</span>
        {#if selectedGroupPath}
          <svg class="titlebar-ico" viewBox="0 0 24 24" width="11" height="11"
            ><path
              d="M9 6l6 6-6 6"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            /></svg
          >
          <span class="titlebar-crumb">{groupDisplayName}</span>
        {/if}
      </div>

      <div class="titlebar-spacer"></div>

      <!-- Search box (opens the ⌘P overlay) -->
      <button class="titlebar-search" onclick={openSearch} aria-label="Search (⌘P)">
        <svg viewBox="0 0 24 24" width="14" height="14"
          ><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2" /><path
            d="M21 21l-4.3-4.3"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          /></svg
        >
        <span class="titlebar-search-label">Search…</span>
        <kbd class="titlebar-kbd">⌘P</kbd>
      </button>

      <!-- New entry -->
      <button class="titlebar-new" onclick={createEntry} aria-label="New entry">
        <svg viewBox="0 0 24 24" width="15" height="15"
          ><path
            d="M12 5v14M5 12h14"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
          /></svg
        >
        <span>{boxed ? "NEW" : "New entry"}</span>
      </button>

      <button
        class="titlebar-icon-btn"
        class:titlebar-btn--toggle={propertiesVisible}
        aria-label="Toggle properties panel"
        aria-pressed={propertiesVisible}
        onclick={() => (propertiesVisible = !propertiesVisible)}
        title="Properties"
      >
        <svg viewBox="0 0 24 24" width="16" height="16"
          ><rect
            x="3"
            y="4"
            width="18"
            height="16"
            rx="2"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
          /><path d="M15 4v16" stroke="currentColor" stroke-width="1.8" /></svg
        >
      </button>

      <!-- Light/dark toggle (the ☀ in the design titlebar) -->
      <button
        class="titlebar-icon-btn"
        aria-label="Toggle light/dark"
        onclick={() => themeStore.setMode(themeStore.mode === "dark" ? "light" : "dark")}
        title="Toggle light/dark"
      >
        {#if themeStore.mode === "dark"}
          <svg viewBox="0 0 24 24" width="16" height="16"
            ><path
              d="M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linejoin="round"
            /></svg
          >
        {:else}
          <svg viewBox="0 0 24 24" width="16" height="16"
            ><circle
              cx="12"
              cy="12"
              r="4.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
            /><path
              d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
            /></svg
          >
        {/if}
      </button>

      <button
        class="titlebar-icon-btn"
        class:titlebar-btn--toggle={mainZone === "settings"}
        aria-label="Open Settings (⌘,)"
        aria-pressed={mainZone === "settings"}
        onclick={openSettings}
        title="Settings (⌘,)"
      >
        <svg viewBox="0 0 24 24" width="16" height="16"
          ><circle
            cx="12"
            cy="12"
            r="3"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
          /><path
            d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          /></svg
        >
      </button>
    </header>

    <!-- Body: sidebar + entry-list + editor + properties -->
    <div class="app-body">
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
        {onTrashOpen}
        trashOpen={mainZone === "trash"}
        {onPluginsOpen}
        pluginsOpen={mainZone === "plugins"}
        onGroupsChanged={() => {
          loadGroups();
          loadEntries(selectedGroupPath);
        }}
      />

      <!-- Entry list -->
      <EntryList
        groupName={groupDisplayName}
        {entries}
        selectedId={selectedEntryId}
        loading={entriesLoading}
        error={entriesError}
        {onEntrySelect}
      />

      <!-- Editor / Person / Tags / Calendar zone -->
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
        {:else if mainZone === "trash"}
          <TrashView
            onRestored={() => {
              loadGroups();
              loadEntries(selectedGroupPath);
            }}
          />
        {:else if mainZone === "plugins"}
          <PluginManager />
        {:else if selectedEntryId}
          {#if conflictDiskText !== null}
            <ConflictBanner
              diskText={conflictDiskText}
              bufferText={editorText}
              onKeepMine={conflictKeepMine}
              onUseDisk={conflictUseDisk}
              onDismiss={conflictDismiss}
            />
          {/if}
          {#if parseWarning}
            <div class="parse-warning" role="status">
              <span class="parse-warning__icon" aria-hidden="true">⚠</span>
              <span class="parse-warning__text">{parseWarning}</span>
              <button
                class="parse-warning__dismiss"
                onclick={() => (parseWarning = null)}
                aria-label="Dismiss frontmatter warning">✕</button
              >
            </div>
          {/if}
          <Editor
            doc={editorText}
            {onDocChanged}
            {onTokenClick}
            {onNavigate}
            {onCreatePerson}
            entryPath={selectedEntryId}
            {blockCallbacks}
            externalChange={panelChange}
            externalDocReplace={fullDocReplace}
            groupPath={selectedEntryGroup}
          />
        {:else}
          <div class="editor-empty">Select an entry to begin editing</div>
        {/if}
      </main>

      <!-- Properties panel (desktop only when visible; not shown for person/tags views) -->
      {#if propertiesVisible && mainZone === "editor"}
        <aside class="properties-zone" data-focus-zone="properties">
          {#if selectedEntryId}
            <PropertiesPanel
              docText={editorText}
              onEdit={onPanelEdit}
              groupPath={selectedEntryGroup}
            />
          {:else}
            <div class="properties-empty">No entry selected</div>
          {/if}
        </aside>
      {/if}
    </div>

    <!-- Status bar (desktop: full hints) -->
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
  {/if}

  <!-- Search overlay (cmd+p) — shared between narrow and wide -->
  <SearchOverlay
    bind:this={searchOverlay}
    onSelectEntry={(id) => {
      selectEntry(id);
      if (narrow) mobilePush("editor");
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

  <!-- Command palette — rendered here so the FAB and ⌘K both work.
       AppShell's $effect registers the opener via setPaletteOpener, replacing
       App.svelte's registration; App.svelte's <Palette> stays dormant. -->
  <Palette bind:open={paletteOpen} />
</div>

<style>
  /* ── Non-blocking notices (spec 0002 edge cases) ─────────────────────────────── */

  .parse-warning,
  .dup-notice {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    font-size: 12px;
    flex-shrink: 0;
    background: var(--tnd-conflict-bg, var(--tnd-panel2));
    border-bottom: 1px solid var(--tnd-conflict-border, var(--tnd-line-strong));
    color: var(--tnd-conflict-text, var(--tnd-text));
  }

  .parse-warning__icon,
  .dup-notice__icon {
    flex-shrink: 0;
  }

  .parse-warning__text,
  .dup-notice__text {
    flex: 1;
    min-width: 0;
  }

  .parse-warning__dismiss,
  .dup-notice__dismiss {
    flex-shrink: 0;
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 12px;
    opacity: 0.7;
    padding: 2px 6px;
    border-radius: var(--tnd-radius, 4px);
  }

  .parse-warning__dismiss:hover,
  .dup-notice__dismiss:hover {
    opacity: 1;
  }

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
    height: 48px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 14px 0 16px;
    background: var(--tnd-panel);
    border-bottom: 1px solid var(--tnd-line);
    color: var(--tnd-text);
    font-family: var(--tnd-font-ui);
  }

  .titlebar-left {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    color: var(--tnd-text);
  }

  .titlebar-badge {
    width: 22px;
    height: 22px;
    border-radius: var(--tnd-radius);
    background: var(--tnd-accent);
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-weight: 800;
    font-size: 13px;
    flex-shrink: 0;
  }

  .titlebar-mono-root {
    font-family: var(--tnd-font-mono);
    color: var(--tnd-accent-text);
    font-weight: 700;
    font-size: 13px;
  }

  .titlebar-app-name {
    font-weight: 700;
    font-size: 14px;
    color: var(--tnd-text);
    letter-spacing: -0.01em;
    white-space: nowrap;
  }

  .titlebar-ico {
    color: var(--tnd-text-faint);
    flex-shrink: 0;
  }

  .titlebar-divider {
    width: 1px;
    height: 18px;
    background: var(--tnd-line);
    flex-shrink: 0;
  }

  .titlebar-crumbs {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--tnd-text-muted);
    font-size: 13px;
    font-weight: 500;
    min-width: 0;
    letter-spacing: var(--tnd-label-spacing);
    text-transform: var(--tnd-label-transform);
  }

  .titlebar-crumb-muted {
    color: var(--tnd-text-muted);
    white-space: nowrap;
  }

  .titlebar-crumb {
    color: var(--tnd-text);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 220px;
  }

  .titlebar-spacer {
    flex: 1;
  }

  .titlebar-search {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 10px 0 11px;
    border-radius: var(--tnd-radius);
    border: 1px solid var(--tnd-line);
    background: var(--tnd-panel2);
    color: var(--tnd-text-faint);
    font-size: 12.5px;
    font-family: var(--tnd-font-ui);
    min-width: 168px;
    cursor: pointer;
  }

  .titlebar-search:hover {
    border-color: var(--tnd-line-strong);
  }

  .titlebar-search-label {
    flex: 1;
    text-align: left;
  }

  .titlebar-kbd {
    font-family: var(--tnd-font-mono);
    font-size: 11px;
    color: var(--tnd-text-muted);
  }

  .titlebar-new {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 12px 0 9px;
    border-radius: var(--tnd-radius);
    border: none;
    background: var(--tnd-accent);
    color: #fff;
    font-family: var(--tnd-font-ui);
    font-size: 12.5px;
    font-weight: 700;
    cursor: pointer;
    white-space: nowrap;
    text-transform: var(--tnd-label-transform);
  }

  .titlebar-new:hover {
    filter: brightness(1.06);
  }

  .titlebar-icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: var(--tnd-radius);
    border: none;
    background: transparent;
    color: var(--tnd-text-muted);
    cursor: pointer;
    flex-shrink: 0;
  }

  .titlebar-icon-btn:hover {
    background: var(--tnd-panel2);
    color: var(--tnd-text);
  }

  .titlebar-btn--toggle[aria-pressed="true"] {
    background: var(--tnd-accent-soft);
    color: var(--tnd-accent-text);
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

  /* ── Mobile-specific layout ─────────────────────────────────────────────── */

  /* Sidebar slide-over panel on narrow */
  .mobile-sidebar-panel {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: min(280px, 85vw);
    background: var(--tnd-panel);
    z-index: 200;
    overflow-y: auto;
    box-shadow: var(--tnd-shadow, 2px 0 16px rgba(0, 0, 0, 0.18));
  }

  /* Mobile editor toolbar — thin peek bar for the Properties sheet toggle */
  .mobile-editor-toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    background: var(--tnd-panel2);
    border-bottom: 1px solid var(--tnd-line);
    flex-shrink: 0;
  }

  .mobile-editor-toolbar-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: var(--tnd-panel);
    border: 1px solid var(--tnd-line);
    color: var(--tnd-text-muted);
    font-size: 11.5px;
    font-family: var(--tnd-font-ui);
    font-weight: 600;
    padding: 4px 10px;
    border-radius: var(--tnd-radius);
    cursor: pointer;
    letter-spacing: var(--tnd-label-spacing, 0);
    text-transform: var(--tnd-label-transform, none);
  }

  .mobile-editor-toolbar-btn[aria-pressed="true"] {
    background: var(--tnd-accent-soft);
    color: var(--tnd-accent-text);
    border-color: var(--tnd-accent-soft);
  }

  /* ── Responsive ──────────────────────────────────────────────────────────── */

  @media (max-width: 699px) {
    .editor-zone {
      width: 100%;
    }
  }
</style>
