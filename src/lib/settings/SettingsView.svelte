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

  const themeKeys = themeMap.themes.map((t) => t.key);
  const themeNames = Object.fromEntries(themeMap.themes.map((t) => [t.key, t.name]));

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
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="settings-view" role="region" aria-label="Settings" onkeydown={onViewKeyDown}>
  <!-- Sidebar nav -->
  <nav class="settings-nav" aria-label="Settings sections">
    <div class="settings-nav-header">Settings</div>
    {#each ["appearance", "editor", "keybindings", "presets", "library"] as Section[] as section (section)}
      <button
        class="settings-nav-item"
        class:active={activeSection === section}
        onclick={() => (activeSection = section)}
      >
        {section === "appearance"
          ? "Appearance"
          : section === "editor"
            ? "Editor"
            : section === "keybindings"
              ? "Keybindings"
              : section === "presets"
                ? "Presets"
                : "Library"}
      </button>
    {/each}
  </nav>

  <!-- Content area -->
  <div class="settings-content">
    <!-- ── Appearance ──────────────────────────────────────────────────────── -->
    {#if activeSection === "appearance"}
      <section class="settings-section">
        <h2 class="settings-section-title">Appearance</h2>
        <p class="settings-scope-label">User setting — follows you across libraries</p>

        <div class="settings-field">
          <label class="settings-label" for="settings-theme">Theme</label>
          <select
            id="settings-theme"
            class="settings-select"
            value={currentTheme}
            onchange={(e) => onThemeChange((e.target as HTMLSelectElement).value)}
          >
            {#each themeKeys as key (key)}
              <option value={key}>{themeNames[key]}</option>
            {/each}
          </select>
        </div>

        <div class="settings-field">
          <label class="settings-label" for="settings-mode">Mode</label>
          <select
            id="settings-mode"
            class="settings-select"
            value={currentMode}
            onchange={(e) => onModeChange((e.target as HTMLSelectElement).value as ThemeMode)}
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="system">System (follow OS)</option>
          </select>
        </div>

        <div class="settings-preview">
          <div class="settings-preview-label">Preview</div>
          <div class="settings-preview-chips">
            {#each ["slate", "red", "amber", "green", "teal", "blue", "violet", "pink"] as color (color)}
              <span class="chip chip--{color}">{color}</span>
            {/each}
          </div>
        </div>
      </section>

      <!-- ── Editor ─────────────────────────────────────────────────────────── -->
    {:else if activeSection === "editor"}
      <section class="settings-section">
        <h2 class="settings-section-title">Editor</h2>
        <p class="settings-scope-label">User setting — follows you across libraries</p>

        <div class="settings-field">
          <label class="settings-label" for="settings-font-size">
            Font size <span class="settings-unit">px</span>
          </label>
          <input
            id="settings-font-size"
            class="settings-number"
            type="number"
            min="10"
            max="24"
            step="1"
            value={fontSize}
            oninput={(e) => onFontSizeChange(Number((e.target as HTMLInputElement).value))}
          />
          <span class="settings-hint">Default: 14</span>
        </div>

        <div class="settings-field">
          <label class="settings-label" for="settings-line-width">
            Line width <span class="settings-unit">chars</span>
          </label>
          <input
            id="settings-line-width"
            class="settings-number"
            type="number"
            min="40"
            max="200"
            step="4"
            value={lineWidth}
            oninput={(e) => onLineWidthChange(Number((e.target as HTMLInputElement).value))}
          />
          <span class="settings-hint">Default: 72</span>
        </div>
      </section>

      <!-- ── Keybindings ────────────────────────────────────────────────────── -->
    {:else if activeSection === "keybindings"}
      <section class="settings-section settings-section--keybindings">
        <h2 class="settings-section-title">Keybindings</h2>
        <p class="settings-scope-label">User setting — follows you across libraries</p>

        {#if rebindState.phase === "capturing"}
          <div class="capture-banner">
            <span>Press a key combination for <strong>{rebindState.commandId}</strong>…</span>
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
              Conflict: <kbd>{rebindState.capturedChord}</kbd> is already used
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

        {#each commandGroups as group (group.category)}
          <div class="kb-group">
            <div class="kb-group-header">{group.category}</div>
            {#each group.rows as row (row.commandId)}
              <div class="kb-row" class:kb-row--overridden={row.isOverridden}>
                <div class="kb-name">
                  <span class="kb-command-name">{row.name}</span>
                  {#if row.when}
                    <span class="kb-when">{row.when}</span>
                  {/if}
                </div>
                <div class="kb-bindings">
                  {#if row.effectiveBindings.length > 0}
                    {#each row.effectiveBindings as chord (chord)}
                      <kbd class="kb-chord">{chord}</kbd>
                    {/each}
                  {:else}
                    <span class="kb-no-binding">—</span>
                  {/if}
                </div>
                <div class="kb-actions">
                  <button
                    class="kb-btn"
                    onclick={() => startCapture(row.commandId)}
                    title="Rebind this command"
                    aria-label="Rebind {row.name}"
                  >
                    Rebind
                  </button>
                  {#if row.isOverridden}
                    <button
                      class="kb-btn kb-btn--reset"
                      onclick={() => resetToDefault(row.commandId)}
                      title="Reset to default"
                      aria-label="Reset {row.name} to default binding"
                    >
                      Reset
                    </button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/each}
      </section>

      <!-- ── Presets ─────────────────────────────────────────────────────────── -->
    {:else if activeSection === "presets"}
      <section class="settings-section">
        <h2 class="settings-section-title">Keymap Presets</h2>
        <p class="settings-scope-label">User setting — follows you across libraries</p>
        <p class="settings-desc">
          Applying a preset overwrites all current keybindings. After applying, further edits are
          yours — presets are import-once.
        </p>

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

        <div class="preset-list">
          {#each presets as preset (preset.id)}
            <div class="preset-row" class:preset-row--active={appliedPresetId === preset.id}>
              <div class="preset-info">
                <div class="preset-name">
                  {preset.name}
                  {#if appliedPresetId === preset.id}
                    <span class="preset-applied-badge">applied</span>
                  {/if}
                </div>
                <div class="preset-description">{preset.description}</div>
                {#if preset.modal}
                  <div class="preset-modal-tag">Enables modal editing</div>
                {/if}
              </div>
              <button
                class="btn btn--sm"
                onclick={() => requestApplyPreset(preset)}
                disabled={confirmPreset !== null}
              >
                Apply
              </button>
            </div>
          {/each}
        </div>
      </section>

      <!-- ── Library ─────────────────────────────────────────────────────────── -->
    {:else if activeSection === "library"}
      <section class="settings-section">
        <h2 class="settings-section-title">Library</h2>
        <p class="settings-scope-label">
          Library setting — stored in _settings.md, travels with the library
        </p>

        <div class="settings-field">
          <label class="settings-label" for="settings-primary-date"> Primary date property </label>
          <input
            id="settings-primary-date"
            class="settings-text"
            type="text"
            value={primaryDatePropValue}
            onchange={(e) => onPrimaryDatePropChange((e.target as HTMLInputElement).value)}
            placeholder="due"
            spellcheck={false}
          />
          <span class="settings-hint">
            The frontmatter field the calendar reads. Default: <code>due</code>.
          </span>
        </div>

        <div class="settings-field settings-field--readonly">
          <label class="settings-label" for="settings-asset-folder"> Asset folder </label>
          <input
            id="settings-asset-folder"
            class="settings-text"
            type="text"
            value={assetFolderValue}
            disabled
            placeholder="_assets"
          />
          <span class="settings-hint">Display-only — editing not yet supported.</span>
        </div>
      </section>
    {/if}
  </div>
</div>

<style>
  /* ── Shell ──────────────────────────────────────────────────────────────────── */

  .settings-view {
    display: flex;
    height: 100%;
    background: var(--tnd-bg);
    color: var(--tnd-text);
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 13.5px;
  }

  /* ── Sidebar nav ────────────────────────────────────────────────────────────── */

  .settings-nav {
    width: 160px;
    flex-shrink: 0;
    background: var(--tnd-panel);
    border-right: 1px solid var(--tnd-line-strong);
    padding: 20px 0 12px;
    display: flex;
    flex-direction: column;
  }

  .settings-nav-header {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--tnd-text-faint);
    padding: 0 16px 10px;
  }

  .settings-nav-item {
    background: none;
    border: none;
    text-align: left;
    padding: 7px 16px;
    font-size: 13px;
    color: var(--tnd-text-muted);
    cursor: pointer;
    border-radius: 0;
    font-family: inherit;
    transition: background 0.1s;
  }

  .settings-nav-item:hover {
    background: var(--tnd-panel2);
    color: var(--tnd-text);
  }

  .settings-nav-item.active {
    background: var(--tnd-accent-soft);
    color: var(--tnd-accent-text);
    font-weight: 500;
  }

  /* ── Content area ───────────────────────────────────────────────────────────── */

  .settings-content {
    flex: 1;
    overflow-y: auto;
    padding: 28px 32px;
    min-width: 0;
  }

  .settings-section {
    max-width: 580px;
  }

  .settings-section-title {
    font-size: 17px;
    font-weight: 600;
    color: var(--tnd-text);
    margin: 0 0 4px;
  }

  .settings-scope-label {
    font-size: 11.5px;
    color: var(--tnd-text-faint);
    margin: 0 0 20px;
    font-style: italic;
  }

  .settings-desc {
    font-size: 13px;
    color: var(--tnd-text-muted);
    margin: 0 0 16px;
    line-height: 1.5;
  }

  /* ── Form controls ──────────────────────────────────────────────────────────── */

  .settings-field {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 14px;
    flex-wrap: wrap;
  }

  .settings-field--readonly {
    opacity: 0.6;
  }

  .settings-label {
    width: 160px;
    flex-shrink: 0;
    font-size: 13px;
    color: var(--tnd-text-muted);
    font-weight: 500;
  }

  .settings-unit {
    font-weight: 400;
    color: var(--tnd-text-faint);
    font-size: 11px;
  }

  .settings-select {
    font-size: 13px;
    padding: 4px 8px;
    background: var(--tnd-panel2);
    color: var(--tnd-text);
    border: 1px solid var(--tnd-line-strong);
    border-radius: 4px;
    outline: none;
    cursor: pointer;
    font-family: inherit;
  }

  .settings-select:focus {
    border-color: var(--tnd-accent);
  }

  .settings-number {
    width: 80px;
    font-size: 13px;
    padding: 4px 8px;
    background: var(--tnd-panel2);
    color: var(--tnd-text);
    border: 1px solid var(--tnd-line-strong);
    border-radius: 4px;
    outline: none;
    font-family: inherit;
  }

  .settings-number:focus {
    border-color: var(--tnd-accent);
  }

  .settings-text {
    flex: 1;
    min-width: 0;
    max-width: 240px;
    font-size: 13px;
    padding: 4px 8px;
    background: var(--tnd-panel2);
    color: var(--tnd-text);
    border: 1px solid var(--tnd-line-strong);
    border-radius: 4px;
    outline: none;
    font-family: ui-monospace, monospace;
  }

  .settings-text:focus {
    border-color: var(--tnd-accent);
  }

  .settings-text:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .settings-hint {
    font-size: 11.5px;
    color: var(--tnd-text-faint);
    width: 100%;
    margin-left: 170px;
  }

  /* ── Appearance preview ─────────────────────────────────────────────────────── */

  .settings-preview {
    margin-top: 24px;
    padding: 14px 16px;
    background: var(--tnd-panel2);
    border: 1px solid var(--tnd-line);
    border-radius: 6px;
  }

  .settings-preview-label {
    font-size: 11px;
    color: var(--tnd-text-faint);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 8px;
  }

  .settings-preview-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 10px;
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

  /* ── Keybindings ────────────────────────────────────────────────────────────── */

  .settings-section--keybindings {
    max-width: 720px;
  }

  .capture-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    background: var(--tnd-accent-soft);
    border: 1px solid var(--tnd-accent);
    border-radius: 6px;
    margin-bottom: 16px;
    font-size: 13px;
    position: relative;
  }

  .capture-cancel {
    margin-left: auto;
    background: none;
    border: 1px solid var(--tnd-line-strong);
    color: var(--tnd-text-muted);
    font-size: 12px;
    padding: 3px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
  }

  /* Hidden trap input for key capture */
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
    border-radius: 6px;
    margin-bottom: 16px;
    font-size: 13px;
  }

  .conflict-title {
    font-weight: 500;
    margin-bottom: 8px;
  }

  .conflict-row {
    display: flex;
    gap: 12px;
    margin-bottom: 4px;
    font-size: 12px;
    color: var(--tnd-text-muted);
  }

  .conflict-cmd {
    font-family: ui-monospace, monospace;
  }

  .conflict-kind {
    color: var(--tnd-text-faint);
  }

  .conflict-actions {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }

  .kb-group {
    margin-bottom: 20px;
  }

  .kb-group-header {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--tnd-text-faint);
    padding: 4px 0;
    border-bottom: 1px solid var(--tnd-line);
    margin-bottom: 4px;
  }

  .kb-row {
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    gap: 12px;
    padding: 5px 6px;
    border-radius: 4px;
  }

  .kb-row:hover {
    background: var(--tnd-panel2);
  }

  .kb-row--overridden .kb-command-name {
    font-weight: 500;
    color: var(--tnd-accent-text);
  }

  .kb-name {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .kb-command-name {
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .kb-when {
    font-size: 10.5px;
    color: var(--tnd-text-faint);
    font-family: ui-monospace, monospace;
    flex-shrink: 0;
  }

  .kb-bindings {
    display: flex;
    gap: 4px;
  }

  .kb-chord {
    display: inline-block;
    background: var(--tnd-panel2);
    border: 1px solid var(--tnd-line-strong);
    border-radius: 3px;
    padding: 1px 5px;
    font-size: 11.5px;
    font-family: ui-monospace, monospace;
    white-space: nowrap;
  }

  .kb-no-binding {
    color: var(--tnd-text-faint);
    font-size: 13px;
  }

  .kb-actions {
    display: flex;
    gap: 4px;
    opacity: 0;
  }

  .kb-row:hover .kb-actions {
    opacity: 1;
  }

  .kb-btn {
    background: none;
    border: 1px solid var(--tnd-line-strong);
    color: var(--tnd-text-muted);
    font-size: 11.5px;
    padding: 2px 7px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    white-space: nowrap;
  }

  .kb-btn:hover {
    background: var(--tnd-panel2);
    color: var(--tnd-text);
  }

  .kb-btn--reset {
    color: var(--tnd-text-faint);
  }

  /* ── Presets ────────────────────────────────────────────────────────────────── */

  .preset-confirm {
    padding: 14px;
    background: var(--tnd-accent-soft);
    border: 1px solid var(--tnd-accent);
    border-radius: 6px;
    margin-bottom: 16px;
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
    gap: 8px;
  }

  .preset-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    background: var(--tnd-panel);
    border: 1px solid var(--tnd-line);
    border-radius: 6px;
  }

  .preset-row--active {
    border-color: var(--tnd-accent);
    background: var(--tnd-accent-soft);
  }

  .preset-info {
    flex: 1;
    min-width: 0;
  }

  .preset-name {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--tnd-text);
    margin-bottom: 2px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .preset-applied-badge {
    font-size: 10.5px;
    font-weight: 500;
    padding: 1px 6px;
    background: var(--tnd-accent);
    color: #fff;
    border-radius: 10px;
  }

  .preset-description {
    font-size: 12.5px;
    color: var(--tnd-text-muted);
  }

  .preset-modal-tag {
    font-size: 11.5px;
    color: var(--tnd-accent-text);
    margin-top: 3px;
  }

  /* ── Shared buttons ─────────────────────────────────────────────────────────── */

  .btn {
    background: var(--tnd-panel2);
    border: 1px solid var(--tnd-line-strong);
    color: var(--tnd-text-muted);
    font-size: 13px;
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    white-space: nowrap;
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
