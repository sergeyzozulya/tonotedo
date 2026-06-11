<script lang="ts">
  // SettingsView — main-zone settings surface (spec 0011, issue #23).
  //
  // Sections:
  //   Appearance — theme × mode pickers, driven through themeStore
  //   Editor     — font size / line width passed to Editor's settings prop
  //   Keybindings — command list grouped by category; rebind flow with
  //                 conflict detection; reset-to-default; per-command capture
  //   Presets     — list all presets; apply with confirmation (import-once)
  //   Library     — primary date property (wired to getPrimaryDateProp/store);
  //                 asset folder display-only
  //
  // Edits apply immediately — no save button (spec 0011 §Settings UI).
  // Defaults are never written until the user changes a value.

  import { registry } from "../commands/registry.js";
  import {
    loadUserBindings,
    saveBinding,
    removeBindingOverride,
    savePreset,
    settings_get_user,
    settings_set_user,
    settings_get_library,
    settings_set_library,
  } from "../commands/settings.js";
  import {
    detectConflicts,
    buildBindingList,
    isOsReserved,
    normalizeChord,
  } from "../commands/keymap.js";
  import type { ConflictResult } from "../commands/keymap.js";
  import { loadPresets } from "../commands/presets.js";
  import type { PresetDefinition } from "../commands/presets.js";
  import { modalStore } from "../editor/vim/modal-store.svelte.js";
  import { themeStore } from "../shell/theme-store.svelte.js";
  import type { ThemeMode } from "../shell/theme-store.svelte.js";
  import themeMap from "../../styles/THEME-MAP.json";

  interface Props {
    /** Called when the view should close (e.g. pressing Escape). */
    onClose?: () => void;
  }

  let { onClose }: Props = $props();

  // ── Section navigation ────────────────────────────────────────────────────────

  type Section = "appearance" | "editor" | "keybindings" | "presets" | "library";
  let activeSection = $state<Section>("appearance");

  // ── Appearance section ────────────────────────────────────────────────────────

  const themeEntries = themeMap.themes.map((t) => ({
    key: t.key,
    name: t.name,
    tagline: t.tagline,
    // Use the current-mode accent for the swatch; fall back to light.
    accentLight: t.tokens.light.accent,
    accentDark: t.tokens.dark.accent,
    panelLight: t.tokens.light.panel,
    panelDark: t.tokens.dark.panel,
  }));

  // Reactive derived values from themeStore so pickers stay in sync with store.
  let currentTheme = $derived(themeStore.theme);
  let currentMode = $derived(themeStore.mode);

  function onThemeChange(key: string): void {
    themeStore.setTheme(key);
    settings_set_user("theme", key);
  }

  function onModeChange(mode: ThemeMode): void {
    themeStore.setMode(mode);
    settings_set_user("mode", mode);
  }

  // ── Editor section ────────────────────────────────────────────────────────────

  let fontSize = $state<number>(settings_get_user("fontSize") ?? 14);
  let lineWidth = $state<number>(settings_get_user("lineWidth") ?? 72);

  function onFontSizeChange(v: number): void {
    fontSize = v;
    settings_set_user("fontSize", v);
  }

  function onLineWidthChange(v: number): void {
    lineWidth = v;
    settings_set_user("lineWidth", v);
  }

  // ── Library section ───────────────────────────────────────────────────────────

  let primaryDatePropValue = $state<string>(settings_get_library("primaryDateProp") ?? "due");
  let assetFolderValue = $derived(settings_get_library("assetFolder") ?? "_assets");

  function onPrimaryDatePropChange(v: string): void {
    const trimmed = v.trim();
    if (!trimmed) return; // don't write empty
    primaryDatePropValue = trimmed;
    settings_set_library("primaryDateProp", trimmed);
  }

  // ── Keybindings section ───────────────────────────────────────────────────────

  type CommandCategory = "Navigation" | "Editor" | "Entry" | "Group" | "Tag" | "View" | "App";
  const CATEGORY_ORDER: CommandCategory[] = [
    "App",
    "Navigation",
    "Entry",
    "Editor",
    "View",
    "Group",
    "Tag",
  ];

  /** The keybinding state for a single command row. */
  interface BindingRow {
    commandId: string;
    name: string;
    description: string;
    category: CommandCategory;
    when: string;
    defaultBindings: readonly string[];
    effectiveBindings: string[]; // from user overrides or defaults
    isOverridden: boolean;
  }

  /**
   * Rebind flow state machine:
   *   idle         — no capture in progress
   *   capturing    — waiting for the user to press a key (chord capture mode)
   *   conflict     — a conflict was detected; waiting for resolution
   */
  type RebindState =
    | { phase: "idle" }
    | { phase: "capturing"; commandId: string }
    | {
        phase: "conflict";
        commandId: string;
        capturedChord: string;
        conflicts: ConflictResult[];
      };

  let rebindState = $state<RebindState>({ phase: "idle" });

  function buildRows(): BindingRow[] {
    const userBindings = loadUserBindings();
    const commands = registry.all();
    return commands.map((cmd) => {
      const user = userBindings.get(cmd.id);
      const effective = user ?? [...cmd.defaultBindings];
      return {
        commandId: cmd.id,
        name: cmd.name,
        description: cmd.description,
        category: cmd.category as CommandCategory,
        when: cmd.when,
        defaultBindings: cmd.defaultBindings,
        effectiveBindings: effective.map((c) => normalizeChord(c) ?? c),
        isOverridden: user !== undefined,
      };
    });
  }

  let rows = $state<BindingRow[]>(buildRows());

  function refreshRows(): void {
    rows = buildRows();
  }

  /** Group rows by category in display order. */
  function groupedRows(): Array<{ category: CommandCategory; rows: BindingRow[] }> {
    const buckets: Record<string, BindingRow[]> = {};
    for (const cat of CATEGORY_ORDER) {
      buckets[cat] = [];
    }
    for (const row of rows) {
      if (!buckets[row.category]) buckets[row.category] = [];
      buckets[row.category].push(row);
    }
    return CATEGORY_ORDER.filter((cat) => (buckets[cat]?.length ?? 0) > 0).map((category) => ({
      category,
      rows: buckets[category],
    }));
  }

  const commandGroups = $derived(groupedRows());

  /** Start the chord-capture flow for a command. */
  function startCapture(commandId: string): void {
    rebindState = { phase: "capturing", commandId };
  }

  /** Cancel an in-progress capture or conflict resolution. */
  function cancelCapture(): void {
    rebindState = { phase: "idle" };
  }

  /** Called when the hidden capture input emits a keydown. */
  function onCaptureKeyDown(e: KeyboardEvent): void {
    if (rebindState.phase !== "capturing") return;
    const commandId = rebindState.commandId; // capture for narrowing
    e.preventDefault();
    e.stopPropagation();

    // Ignore pure modifier presses.
    if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;
    if (e.key === "Escape") {
      cancelCapture();
      return;
    }

    const parts: string[] = [];
    if (e.metaKey) parts.push("meta");
    if (e.ctrlKey) parts.push("ctrl");
    if (e.altKey) parts.push("alt");
    if (e.shiftKey) parts.push("shift");
    parts.push(e.key.toLowerCase());
    const raw = parts.join("+");
    const canonical = normalizeChord(raw);
    if (!canonical) return;

    if (isOsReserved(canonical)) {
      alert(`"${canonical}" is an OS-reserved shortcut and cannot be bound.`);
      cancelCapture();
      return;
    }

    // Check conflicts against all commands except the one being rebound.
    const allCommands = registry.all();
    const userBindings = loadUserBindings();
    const allBindings = buildBindingList(allCommands, userBindings);
    const proposed = { commandId, chord: canonical, when: "" };
    const cmdBeingRebound = registry.get(commandId);
    const whenCtx = cmdBeingRebound?.when ?? "";
    const otherBindings = allBindings.filter((b) => b.commandId !== commandId);
    const conflicts = detectConflicts({ ...proposed, when: whenCtx }, otherBindings);

    if (conflicts.length > 0) {
      rebindState = {
        phase: "conflict",
        commandId,
        capturedChord: canonical,
        conflicts,
      };
      return;
    }

    commitRebind(commandId, canonical);
  }

  /** Commit a rebind after the user has resolved (or there were no) conflicts. */
  function commitRebind(commandId: string, chord: string): void {
    // Remove the conflicting command's binding first if there was a conflict.
    if (rebindState.phase === "conflict") {
      for (const c of rebindState.conflicts) {
        const conflictCmd = registry.get(c.existing.commandId);
        if (conflictCmd) {
          const userBindings = loadUserBindings();
          const existing = userBindings.get(c.existing.commandId) ?? [
            ...conflictCmd.defaultBindings,
          ];
          const updated = existing.filter((b) => normalizeChord(b) !== c.existing.chord);
          if (updated.length === 0) {
            removeBindingOverride(c.existing.commandId);
          } else {
            saveBinding(c.existing.commandId, updated);
          }
        }
      }
    }

    saveBinding(commandId, [chord]);
    rebindState = { phase: "idle" };
    refreshRows();
  }

  /** Reset a command's bindings to defaults. */
  function resetToDefault(commandId: string): void {
    removeBindingOverride(commandId);
    refreshRows();
  }

  // ── Presets section ───────────────────────────────────────────────────────────

  const presets = $derived(loadPresets());

  let appliedPresetId = $state<string | null>(
    (settings_get_user("preset") as string | null | undefined) ?? null,
  );
  let confirmPreset = $state<PresetDefinition | null>(null);

  function requestApplyPreset(preset: PresetDefinition): void {
    confirmPreset = preset;
  }

  function cancelApplyPreset(): void {
    confirmPreset = null;
  }

  function confirmApplyPreset(): void {
    if (!confirmPreset) return;
    const preset = confirmPreset;

    // Apply all bindings from the preset (import-once: overwrites current bindings).
    for (const b of preset.bindings) {
      if (b.chord === null) {
        removeBindingOverride(b.commandId);
      } else {
        saveBinding(b.commandId, [b.chord]);
      }
    }

    savePreset(preset.id as import("../commands/settings.js").PresetId, preset.modal);
    // Toggle the modal engine live (spec 0007: takes effect without restart).
    modalStore.set(preset.modal);
    appliedPresetId = preset.id;
    confirmPreset = null;
    refreshRows();
  }

  // ── Keyboard dismiss (Escape key) ─────────────────────────────────────────────

  function onViewKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape" && rebindState.phase === "idle") {
      onClose?.();
    }
  }

  // ── Section label helper ──────────────────────────────────────────────────────

  const SECTION_LABELS: Record<Section, string> = {
    appearance: "Appearance",
    editor: "Editor",
    keybindings: "Keybindings",
    presets: "Presets",
    library: "Library",
  };
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="settings-view" role="region" aria-label="Settings" onkeydown={onViewKeyDown}>
  <!-- Sidebar nav -->
  <nav class="settings-nav" aria-label="Settings sections">
    <div class="settings-nav-title">Settings</div>
    {#each ["appearance", "editor", "keybindings", "presets", "library"] as Section[] as section (section)}
      <button
        class="settings-nav-item"
        class:active={activeSection === section}
        onclick={() => (activeSection = section)}
      >
        {SECTION_LABELS[section]}
      </button>
    {/each}
  </nav>

  <!-- Content area -->
  <div class="settings-content">
    <!-- ── Appearance ──────────────────────────────────────────────────────── -->
    {#if activeSection === "appearance"}
      <div class="content-header">
        <span class="content-title">Appearance</span>
        <span
          class="content-close"
          role="button"
          tabindex="0"
          aria-label="Close settings"
          onclick={() => onClose?.()}
          onkeydown={(e) => e.key === "Enter" && onClose?.()}>✕</span
        >
      </div>

      <div class="section-body">
        <div class="field-group-label">THEME</div>
        <div class="theme-swatches">
          {#each themeEntries as t (t.key)}
            {@const isActive = currentTheme === t.key}
            {@const swatchAccent = currentMode === "dark" ? t.accentDark : t.accentLight}
            {@const swatchPanel = currentMode === "dark" ? t.panelDark : t.panelLight}
            <button
              class="theme-swatch"
              class:theme-swatch--active={isActive}
              onclick={() => onThemeChange(t.key)}
              title={t.tagline}
              aria-label="Select {t.name} theme"
              aria-pressed={isActive}
            >
              <span
                class="theme-swatch-dot"
                style="background: {swatchAccent}; box-shadow: 0 0 0 3px {swatchPanel}, 0 0 0 5px {swatchAccent};"
              ></span>
              <span class="theme-swatch-name">{t.name}</span>
            </button>
          {/each}
        </div>

        <div class="field-group-label" style="margin-top: 20px;">MODE</div>
        <div class="mode-toggle">
          {#each [["light", "Light"], ["dark", "Dark"], ["system", "System"]] as [val, label] (val)}
            <button
              class="mode-btn"
              class:mode-btn--active={currentMode === val}
              onclick={() => onModeChange(val as ThemeMode)}
              aria-pressed={currentMode === val}
            >
              {label}
            </button>
          {/each}
        </div>

        <div class="scope-note">User setting — follows you across libraries</div>

        <div class="field-group-label" style="margin-top: 20px;">PREVIEW</div>
        <div class="chip-preview">
          {#each ["slate", "red", "amber", "green", "teal", "blue", "violet", "pink"] as color (color)}
            <span class="chip chip--{color}">{color}</span>
          {/each}
        </div>
      </div>

      <!-- ── Editor ─────────────────────────────────────────────────────────── -->
    {:else if activeSection === "editor"}
      <div class="content-header">
        <span class="content-title">Editor</span>
        <span
          class="content-close"
          role="button"
          tabindex="0"
          aria-label="Close settings"
          onclick={() => onClose?.()}
          onkeydown={(e) => e.key === "Enter" && onClose?.()}>✕</span
        >
      </div>

      <div class="section-body">
        <div class="scope-note">User setting — follows you across libraries</div>

        <div class="field-group-label">FONT SIZE</div>
        <div class="inline-field">
          <input
            id="settings-font-size"
            class="num-input"
            type="number"
            min="10"
            max="24"
            step="1"
            value={fontSize}
            oninput={(e) => onFontSizeChange(Number((e.target as HTMLInputElement).value))}
          />
          <span class="field-unit">px</span>
          <span class="field-hint">Default: 14</span>
        </div>

        <div class="field-group-label" style="margin-top: 16px;">LINE WIDTH</div>
        <div class="inline-field">
          <input
            id="settings-line-width"
            class="num-input"
            type="number"
            min="40"
            max="200"
            step="4"
            value={lineWidth}
            oninput={(e) => onLineWidthChange(Number((e.target as HTMLInputElement).value))}
          />
          <span class="field-unit">chars</span>
          <span class="field-hint">Default: 72</span>
        </div>
      </div>

      <!-- ── Keybindings ────────────────────────────────────────────────────── -->
    {:else if activeSection === "keybindings"}
      <div class="content-header">
        <span class="content-title">Keymap</span>
        <span
          class="content-close"
          role="button"
          tabindex="0"
          aria-label="Close settings"
          onclick={() => onClose?.()}
          onkeydown={(e) => e.key === "Enter" && onClose?.()}>✕</span
        >
      </div>

      <div class="section-body section-body--wide">
        <div class="scope-note">
          User setting — follows you across libraries · bindings travel with you, not the library
        </div>

        {#if rebindState.phase === "capturing"}
          <div class="capture-banner">
            <span
              >Press a key combination for <strong class="capture-cmd"
                >{rebindState.commandId}</strong
              >…</span
            >
            <kbd class="capture-waiting">press keys…<span class="capture-cursor"></span></kbd>
            <button class="capture-cancel" onclick={cancelCapture}>Cancel</button>
            <!-- Hidden input captures the keystroke -->
            <!-- svelte-ignore a11y_autofocus -->
            <input
              class="capture-trap"
              type="text"
              autofocus
              readonly
              onkeydown={onCaptureKeyDown}
              onblur={cancelCapture}
              aria-label="Press key combination"
            />
          </div>
        {:else if rebindState.phase === "conflict"}
          <div class="conflict-banner">
            <div class="conflict-title">
              Conflict: <kbd class="kb-chip kb-chip--accent">{rebindState.capturedChord}</kbd> is already
              used
            </div>
            {#each rebindState.conflicts as c (c.existing.commandId + c.kind)}
              <div class="conflict-row">
                <span class="conflict-cmd">{c.existing.commandId}</span>
                <span class="conflict-kind"
                  >{c.kind === "exact" ? "exact match" : "chord prefix conflict"}</span
                >
              </div>
            {/each}
            <div class="conflict-actions">
              <button
                class="btn btn--primary"
                onclick={() =>
                  rebindState.phase === "conflict" &&
                  commitRebind(rebindState.commandId, rebindState.capturedChord)}
              >
                Remove conflicting binding and save
              </button>
              <button class="btn" onclick={cancelCapture}>Cancel</button>
            </div>
          </div>
        {/if}

        <div class="kb-hint-row">
          <span class="field-group-label" style="margin-bottom: 0;">BINDINGS</span>
          <span class="kb-hint-text">click a key to rebind · conflicts are flagged before save</span
          >
        </div>

        <div class="kb-table">
          {#each commandGroups as group (group.category)}
            <div class="kb-group-header">{group.category}</div>
            {#each group.rows as row (row.commandId)}
              <div
                class="kb-row"
                class:kb-row--overridden={row.isOverridden}
                class:kb-row--capturing={rebindState.phase === "capturing" &&
                  rebindState.commandId === row.commandId}
              >
                <span class="kb-cmd-id">{row.commandId}</span>
                <span class="kb-cmd-name">{row.name}</span>
                <span class="kb-bindings">
                  {#if rebindState.phase === "capturing" && rebindState.commandId === row.commandId}
                    <kbd class="kb-chip kb-chip--capturing"
                      >press keys…<span class="capture-cursor"></span></kbd
                    >
                  {:else if row.effectiveBindings.length > 0}
                    {#each row.effectiveBindings as chord (chord)}
                      <kbd
                        class="kb-chip"
                        class:kb-chip--overridden={row.isOverridden}
                        onclick={() => startCapture(row.commandId)}
                        title="Click to rebind"
                        role="button"
                        tabindex="0"
                        onkeydown={(e) => e.key === "Enter" && startCapture(row.commandId)}
                        aria-label="Rebind {row.name}: current binding {chord}">{chord}</kbd
                      >
                    {/each}
                  {:else}
                    <span
                      class="kb-no-binding"
                      onclick={() => startCapture(row.commandId)}
                      role="button"
                      tabindex="0"
                      onkeydown={(e) => e.key === "Enter" && startCapture(row.commandId)}
                      aria-label="Bind {row.name} (currently unbound)">—</span
                    >
                  {/if}
                </span>
                <span class="kb-actions">
                  <button
                    class="kb-btn"
                    onclick={() => startCapture(row.commandId)}
                    title="Rebind this command"
                    aria-label="Rebind {row.name}">Rebind</button
                  >
                  {#if row.isOverridden}
                    <button
                      class="kb-btn kb-btn--reset"
                      onclick={() => resetToDefault(row.commandId)}
                      title="Reset to default"
                      aria-label="Reset {row.name} to default binding">Reset</button
                    >
                  {/if}
                </span>
              </div>
            {/each}
          {/each}
        </div>
      </div>

      <!-- ── Presets ─────────────────────────────────────────────────────────── -->
    {:else if activeSection === "presets"}
      <div class="content-header">
        <span class="content-title">Presets</span>
        <span
          class="content-close"
          role="button"
          tabindex="0"
          aria-label="Close settings"
          onclick={() => onClose?.()}
          onkeydown={(e) => e.key === "Enter" && onClose?.()}>✕</span
        >
      </div>

      <div class="section-body">
        <div class="scope-note">
          Applying a preset overwrites all current keybindings. After applying, further edits are
          yours — presets are import-once.
        </div>

        {#if confirmPreset}
          <div class="preset-confirm">
            <div class="preset-confirm-msg">
              Apply <strong>{confirmPreset.name}</strong>? This will overwrite all current
              keybindings.
              {#if confirmPreset.modal}
                <span class="preset-modal-warning">Modal (vim-style) editing will be enabled.</span>
              {/if}
            </div>
            <div class="preset-confirm-actions">
              <button class="btn btn--primary" onclick={confirmApplyPreset}>Apply preset</button>
              <button class="btn" onclick={cancelApplyPreset}>Cancel</button>
            </div>
          </div>
        {/if}

        <div class="field-group-label">KEYMAP PRESETS</div>
        <div class="preset-list">
          {#each presets as preset (preset.id)}
            <div class="preset-row" class:preset-row--active={appliedPresetId === preset.id}>
              <div class="preset-info">
                <div class="preset-name">
                  {preset.name}
                  {#if appliedPresetId === preset.id}
                    <span class="preset-badge">applied</span>
                  {/if}
                </div>
                <div class="preset-desc">{preset.description}</div>
                {#if preset.modal}
                  <div class="preset-modal-tag">Enables modal editing</div>
                {/if}
              </div>
              <button
                class="btn btn--sm"
                onclick={() => requestApplyPreset(preset)}
                disabled={confirmPreset !== null}>Apply</button
              >
            </div>
          {/each}
        </div>
      </div>

      <!-- ── Library ─────────────────────────────────────────────────────────── -->
    {:else if activeSection === "library"}
      <div class="content-header">
        <span class="content-title">Library</span>
        <span
          class="content-close"
          role="button"
          tabindex="0"
          aria-label="Close settings"
          onclick={() => onClose?.()}
          onkeydown={(e) => e.key === "Enter" && onClose?.()}>✕</span
        >
      </div>

      <div class="section-body">
        <div class="scope-note">
          Library setting — stored in _settings.md, travels with the library
        </div>

        <div class="field-group-label">PRIMARY DATE PROPERTY</div>
        <div class="inline-field">
          <input
            id="settings-primary-date"
            class="mono-input"
            type="text"
            value={primaryDatePropValue}
            onchange={(e) => onPrimaryDatePropChange((e.target as HTMLInputElement).value)}
            placeholder="due"
            spellcheck={false}
          />
        </div>
        <div class="field-hint-block">
          The frontmatter field the calendar reads. Default: <code class="inline-code">due</code>.
        </div>

        <div class="field-group-label" style="margin-top: 16px; opacity: 0.5;">ASSET FOLDER</div>
        <div class="inline-field" style="opacity: 0.5;">
          <input
            id="settings-asset-folder"
            class="mono-input"
            type="text"
            value={assetFolderValue}
            disabled
            placeholder="_assets"
          />
        </div>
        <div class="field-hint-block" style="opacity: 0.5;">
          Display-only — editing not yet supported.
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  /* ── Root shell ──────────────────────────────────────────────────────────────── */

  .settings-view {
    display: flex;
    height: 100%;
    background: var(--tnd-panel);
    color: var(--tnd-text);
    font-family: var(--tnd-font-ui);
    font-size: 13px;
    overflow: hidden;
  }

  /* ── Sidebar nav ─────────────────────────────────────────────────────────────── */

  .settings-nav {
    width: 188px;
    flex-shrink: 0;
    background: var(--tnd-panel2);
    border-right: 1px solid var(--tnd-line-strong);
    padding: 14px 0;
    display: flex;
    flex-direction: column;
  }

  .settings-nav-title {
    font-family: var(--tnd-font-mono);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: var(--tnd-label-transform, uppercase);
    color: var(--tnd-text);
    padding: 0 16px 10px;
  }

  .settings-nav-item {
    background: none;
    border: none;
    border-left: 2px solid transparent;
    text-align: left;
    padding: 7px 16px;
    font-family: var(--tnd-font-ui);
    font-size: 12.5px;
    font-weight: 500;
    color: var(--tnd-text-muted);
    cursor: pointer;
    transition:
      background 0.1s,
      color 0.1s;
    display: flex;
    align-items: center;
    gap: 9px;
  }

  .settings-nav-item:hover {
    background: var(--tnd-accent-soft);
    color: var(--tnd-text);
  }

  .settings-nav-item.active {
    background: var(--tnd-accent-soft);
    color: var(--tnd-accent-text);
    font-weight: 700;
    border-left-color: var(--tnd-accent);
  }

  /* ── Content area ────────────────────────────────────────────────────────────── */

  .settings-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
  }

  /* Sticky content header row */
  .content-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 15px 20px;
    border-bottom: 1px solid var(--tnd-line-strong);
    flex-shrink: 0;
  }

  .content-title {
    font-family: var(--tnd-font-mono);
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-transform: var(--tnd-label-transform, uppercase);
    color: var(--tnd-text);
  }

  .content-close {
    font-family: var(--tnd-font-mono);
    font-size: 12px;
    color: var(--tnd-text-faint);
    cursor: pointer;
    padding: 2px 4px;
    user-select: none;
  }

  .content-close:hover {
    color: var(--tnd-text-muted);
  }

  /* Scrollable body below header */
  .section-body {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    max-width: 640px;
  }

  .section-body--wide {
    max-width: 900px;
  }

  /* ── Section label (group headings within panels) ────────────────────────────── */

  .field-group-label {
    font-family: var(--tnd-font-mono);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: var(--tnd-text-faint);
    text-transform: uppercase;
    margin-bottom: 9px;
  }

  .scope-note {
    font-family: var(--tnd-font-ui);
    font-size: 11.5px;
    color: var(--tnd-text-muted);
    margin-bottom: 18px;
    line-height: 1.5;
  }

  /* ── Theme swatches ──────────────────────────────────────────────────────────── */

  .theme-swatches {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 4px;
  }

  .theme-swatch {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 12px;
    background: var(--tnd-panel2);
    border: 1px solid var(--tnd-line-strong);
    border-radius: var(--tnd-radius);
    cursor: pointer;
    font-family: var(--tnd-font-ui);
    font-size: 12.5px;
    font-weight: 500;
    color: var(--tnd-text-muted);
    transition:
      border-color 0.12s,
      background 0.12s;
  }

  .theme-swatch:hover {
    border-color: var(--tnd-accent);
    color: var(--tnd-text);
  }

  .theme-swatch--active {
    border-color: var(--tnd-accent);
    background: var(--tnd-accent-soft);
    color: var(--tnd-accent-text);
    font-weight: 700;
  }

  .theme-swatch-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    flex-shrink: 0;
    display: inline-block;
  }

  .theme-swatch-name {
    white-space: nowrap;
  }

  /* ── Mode toggle ─────────────────────────────────────────────────────────────── */

  .mode-toggle {
    display: flex;
    border: 1px solid var(--tnd-line-strong);
    width: fit-content;
    margin-bottom: 4px;
    border-radius: var(--tnd-radius);
    overflow: hidden;
  }

  .mode-btn {
    padding: 6px 16px;
    background: transparent;
    border: none;
    border-right: 1px solid var(--tnd-line-strong);
    font-family: var(--tnd-font-ui);
    font-size: 12.5px;
    font-weight: 700;
    color: var(--tnd-text-muted);
    cursor: pointer;
    transition:
      background 0.1s,
      color 0.1s;
  }

  .mode-btn:last-child {
    border-right: none;
  }

  .mode-btn:hover {
    background: var(--tnd-panel2);
    color: var(--tnd-text);
  }

  .mode-btn--active {
    background: var(--tnd-accent);
    color: #fff;
  }

  .mode-btn--active:hover {
    background: var(--tnd-accent);
    opacity: 0.9;
  }

  /* ── Chip preview (appearance section) ──────────────────────────────────────── */

  .chip-preview {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: var(--tnd-tag-radius);
    font-family: var(--tnd-font-ui);
    font-size: 12px;
    font-weight: 500;
  }

  .chip--slate {
    color: var(--tnd-chip-slate-fg);
    background: var(--tnd-chip-slate-bg);
  }
  .chip--red {
    color: var(--tnd-chip-red-fg);
    background: var(--tnd-chip-red-bg);
  }
  .chip--amber {
    color: var(--tnd-chip-amber-fg);
    background: var(--tnd-chip-amber-bg);
  }
  .chip--green {
    color: var(--tnd-chip-green-fg);
    background: var(--tnd-chip-green-bg);
  }
  .chip--teal {
    color: var(--tnd-chip-teal-fg);
    background: var(--tnd-chip-teal-bg);
  }
  .chip--blue {
    color: var(--tnd-chip-blue-fg);
    background: var(--tnd-chip-blue-bg);
  }
  .chip--violet {
    color: var(--tnd-chip-violet-fg);
    background: var(--tnd-chip-violet-bg);
  }
  .chip--pink {
    color: var(--tnd-chip-pink-fg);
    background: var(--tnd-chip-pink-bg);
  }

  /* ── Inline field row (editor/library inputs) ────────────────────────────────── */

  .inline-field {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 4px;
  }

  .num-input {
    width: 80px;
    font-family: var(--tnd-font-mono);
    font-size: 13px;
    padding: 5px 8px;
    background: var(--tnd-panel2);
    color: var(--tnd-text);
    border: 1px solid var(--tnd-line-strong);
    border-radius: var(--tnd-radius);
    outline: none;
  }

  .num-input:focus {
    border-color: var(--tnd-accent);
  }

  .mono-input {
    min-width: 200px;
    max-width: 280px;
    font-family: var(--tnd-font-mono);
    font-size: 13px;
    padding: 5px 8px;
    background: var(--tnd-panel2);
    color: var(--tnd-text);
    border: 1px solid var(--tnd-line-strong);
    border-radius: var(--tnd-radius);
    outline: none;
  }

  .mono-input:focus {
    border-color: var(--tnd-accent);
  }

  .mono-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .field-unit {
    font-family: var(--tnd-font-mono);
    font-size: 11px;
    color: var(--tnd-text-faint);
  }

  .field-hint {
    font-family: var(--tnd-font-ui);
    font-size: 11.5px;
    color: var(--tnd-text-faint);
  }

  .field-hint-block {
    font-family: var(--tnd-font-ui);
    font-size: 11.5px;
    color: var(--tnd-text-faint);
    margin-bottom: 4px;
    line-height: 1.5;
  }

  .inline-code {
    font-family: var(--tnd-font-mono);
    font-size: 11px;
    background: var(--tnd-panel2);
    padding: 1px 4px;
    border-radius: 2px;
  }

  /* ── Keymap section ──────────────────────────────────────────────────────────── */

  .kb-hint-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 9px;
  }

  .kb-hint-text {
    font-family: var(--tnd-font-mono);
    font-size: 11px;
    color: var(--tnd-text-faint);
  }

  /* The bindings table: bordered container, rows separated by line */
  .kb-table {
    border: 1px solid var(--tnd-line);
  }

  .kb-group-header {
    font-family: var(--tnd-font-mono);
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--tnd-text-faint);
    padding: 6px 12px 4px;
    background: var(--tnd-panel2);
    border-bottom: 1px solid var(--tnd-line);
  }

  .kb-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--tnd-line);
    transition: background 0.1s;
  }

  .kb-row:last-child {
    border-bottom: none;
  }

  .kb-row:hover {
    background: var(--tnd-panel2);
  }

  .kb-row--capturing {
    background: var(--tnd-accent-soft);
  }

  /* Command ID column */
  .kb-cmd-id {
    width: 200px;
    flex-shrink: 0;
    font-family: var(--tnd-font-mono);
    font-size: 11.5px;
    color: var(--tnd-text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Human name column */
  .kb-cmd-name {
    flex: 1;
    font-family: var(--tnd-font-ui);
    font-size: 12.5px;
    color: var(--tnd-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .kb-row--overridden .kb-cmd-name {
    color: var(--tnd-accent-text);
    font-weight: 600;
  }

  /* Key chips */
  .kb-bindings {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
    align-items: center;
  }

  .kb-chip {
    display: inline-block;
    font-family: var(--tnd-font-mono);
    font-size: 11.5px;
    font-weight: 700;
    color: var(--tnd-text);
    padding: 3px 10px;
    border: 1px solid var(--tnd-line);
    background: var(--tnd-panel2);
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
    transition:
      border-color 0.1s,
      background 0.1s;
  }

  .kb-chip:hover {
    border-color: var(--tnd-accent);
    color: var(--tnd-accent-text);
  }

  .kb-chip--overridden {
    color: var(--tnd-accent-text);
    border-color: var(--tnd-line-strong);
  }

  .kb-chip--accent {
    color: var(--tnd-accent-text);
    border-color: var(--tnd-accent);
    background: var(--tnd-panel);
    cursor: default;
  }

  .kb-chip--capturing {
    color: var(--tnd-accent-text);
    border-color: var(--tnd-accent);
    background: var(--tnd-panel);
    cursor: default;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .kb-no-binding {
    font-family: var(--tnd-font-mono);
    font-size: 13px;
    color: var(--tnd-text-faint);
    cursor: pointer;
    padding: 3px 4px;
  }

  .kb-no-binding:hover {
    color: var(--tnd-accent-text);
  }

  /* Action buttons — hidden until row hover */
  .kb-actions {
    display: flex;
    gap: 4px;
    opacity: 0;
    flex-shrink: 0;
  }

  .kb-row:hover .kb-actions {
    opacity: 1;
  }

  .kb-btn {
    background: none;
    border: 1px solid var(--tnd-line-strong);
    color: var(--tnd-text-muted);
    font-family: var(--tnd-font-mono);
    font-size: 11px;
    padding: 2px 7px;
    cursor: pointer;
    white-space: nowrap;
    transition:
      background 0.1s,
      color 0.1s;
  }

  .kb-btn:hover {
    background: var(--tnd-panel2);
    color: var(--tnd-text);
  }

  .kb-btn--reset {
    color: var(--tnd-text-faint);
  }

  /* ── Capture/conflict banners ────────────────────────────────────────────────── */

  .capture-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    background: var(--tnd-accent-soft);
    border: 1px solid var(--tnd-accent);
    font-family: var(--tnd-font-ui);
    font-size: 13px;
    position: relative;
    margin-bottom: 16px;
  }

  .capture-cmd {
    font-family: var(--tnd-font-mono);
    color: var(--tnd-accent-text);
  }

  .capture-waiting {
    font-family: var(--tnd-font-mono);
    font-size: 11.5px;
    font-weight: 700;
    color: var(--tnd-accent-text);
    padding: 3px 10px;
    border: 1px solid var(--tnd-accent);
    background: var(--tnd-panel);
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .capture-cursor {
    display: inline-block;
    width: 1.5px;
    height: 12px;
    background: var(--tnd-accent);
    vertical-align: -2px;
    animation: blink 1s step-end infinite;
  }

  @keyframes blink {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0;
    }
  }

  .capture-cancel {
    margin-left: auto;
    background: none;
    border: 1px solid var(--tnd-line-strong);
    color: var(--tnd-text-muted);
    font-family: var(--tnd-font-mono);
    font-size: 11px;
    padding: 3px 10px;
    cursor: pointer;
  }

  .capture-trap {
    position: absolute;
    width: 0;
    height: 0;
    opacity: 0;
    pointer-events: none;
    border: none;
    outline: none;
  }

  .conflict-banner {
    padding: 12px 14px;
    background: var(--tnd-panel2);
    border: 1px solid var(--tnd-line-strong);
    font-family: var(--tnd-font-ui);
    font-size: 13px;
    margin-bottom: 16px;
  }

  .conflict-title {
    font-weight: 500;
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .conflict-row {
    display: flex;
    gap: 12px;
    margin-bottom: 4px;
    font-size: 12px;
    color: var(--tnd-text-muted);
  }

  .conflict-cmd {
    font-family: var(--tnd-font-mono);
    color: var(--tnd-text);
  }

  .conflict-kind {
    color: var(--tnd-text-faint);
  }

  .conflict-actions {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }

  /* ── Presets ─────────────────────────────────────────────────────────────────── */

  .preset-confirm {
    padding: 14px;
    background: var(--tnd-accent-soft);
    border: 1px solid var(--tnd-accent);
    margin-bottom: 16px;
    font-family: var(--tnd-font-ui);
    font-size: 13px;
  }

  .preset-confirm-msg {
    margin-bottom: 10px;
    line-height: 1.5;
  }

  .preset-modal-warning {
    color: var(--tnd-accent-text);
    font-weight: 500;
    margin-left: 4px;
  }

  .preset-confirm-actions {
    display: flex;
    gap: 8px;
  }

  .preset-list {
    display: flex;
    flex-direction: column;
    gap: 0;
    border: 1px solid var(--tnd-line-strong);
  }

  .preset-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--tnd-line);
    transition: background 0.1s;
  }

  .preset-row:last-child {
    border-bottom: none;
  }

  .preset-row:hover {
    background: var(--tnd-panel2);
  }

  .preset-row--active {
    background: var(--tnd-accent-soft);
  }

  .preset-info {
    flex: 1;
    min-width: 0;
  }

  .preset-name {
    font-family: var(--tnd-font-ui);
    font-size: 13.5px;
    font-weight: 600;
    color: var(--tnd-text);
    margin-bottom: 2px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .preset-badge {
    font-family: var(--tnd-font-mono);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 2px 6px;
    background: var(--tnd-accent);
    color: #fff;
  }

  .preset-desc {
    font-family: var(--tnd-font-ui);
    font-size: 12.5px;
    color: var(--tnd-text-muted);
  }

  .preset-modal-tag {
    font-family: var(--tnd-font-mono);
    font-size: 11px;
    color: var(--tnd-accent-text);
    margin-top: 3px;
  }

  /* ── Shared buttons ──────────────────────────────────────────────────────────── */

  .btn {
    background: var(--tnd-panel2);
    border: 1px solid var(--tnd-line-strong);
    color: var(--tnd-text-muted);
    font-family: var(--tnd-font-ui);
    font-size: 13px;
    padding: 5px 12px;
    cursor: pointer;
    white-space: nowrap;
    transition:
      background 0.1s,
      color 0.1s;
  }

  .btn:hover {
    background: var(--tnd-panel);
    color: var(--tnd-text);
  }

  .btn--primary {
    background: var(--tnd-accent);
    border-color: var(--tnd-accent);
    color: #fff;
  }

  .btn--primary:hover {
    opacity: 0.88;
  }

  .btn--sm {
    font-size: 12px;
    padding: 3px 10px;
  }

  .btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
</style>
