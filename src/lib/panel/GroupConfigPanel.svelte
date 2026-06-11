<script lang="ts">
  // GroupConfigPanel — edit display name, icon, color, default view, and the
  // local property schema for a selected group (spec 0003 §Group metadata).
  //
  // • Writes go through ipc.update_group_config(), which writes the _group.md
  //   frontmatter via the normal write path (spec 0003: _group.md is a valid entry).
  // • Schema inheritance is advisory: this editor shows only the LOCAL group's
  //   declarations; inherited ones (from parent groups) are shown read-only.
  // • After a successful write, `onChanged` is called so the parent can refresh
  //   the group tree (icon/color appear in sidebar immediately).

  import { ipc } from "../ipc/index.js";
  import type { GroupConfigInput, SchemaPropertyDecl } from "../ipc/types.js";
  import type { GroupPath } from "../ipc/types.js";

  // ── Supported property types (spec 0002) ─────────────────────────────────────
  const PROP_TYPES = [
    "string",
    "text",
    "number",
    "boolean",
    "date",
    "datetime",
    "range",
    "tag",
    "tag[]",
    "enum",
    "ref",
    "ref[]",
  ] as const;

  // ── Theme palette for the color swatch picker ─────────────────────────────────
  const COLOR_PALETTE = [
    "#4a90d9",
    "#e8a050",
    "#6ab06a",
    "#9a70c8",
    "#e05060",
    "#50b8c0",
    "#c87840",
    "#808090",
    "#60a870",
    "#d07898",
    "#7898d0",
    "#a8c050",
  ];

  // ── Built-in view names (spec 0002 §Rendering) + plugin-registered views ─────
  // The spec lists note and task-list as v1 built-ins; plugins can add more.
  // We check src/lib/plugins/ for a plugin view registry — none exists yet, so
  // we use the two built-ins.
  const BUILTIN_VIEWS = ["note", "task-list"] as const;

  interface Props {
    /** The group path being configured. */
    groupPath: GroupPath;
    /** Called after a successful config write so the parent can refresh. */
    onChanged?: () => void;
    /** Called to dismiss the panel. */
    onClose?: () => void;
  }

  let { groupPath, onChanged, onClose }: Props = $props();

  // ── Local state (loaded from ipc.get_group_config) ────────────────────────────

  let loading = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);

  // Editable fields
  let localName = $state("");
  let localIcon = $state("");
  let localColor = $state("");
  let localView = $state("");

  // Inherited schema rows (read-only display)
  let inheritedSchema = $state<Record<string, SchemaPropertyDecl>>({});

  // Local schema rows (editable)
  let localSchema = $state<Array<{ key: string; decl: SchemaPropertyDecl }>>([]);

  // New property row
  let newPropKey = $state("");
  let newPropType = $state<string>("string");
  let newPropDefault = $state("");
  let newPropEnumValues = $state("");

  // ── Load config on mount / path change ───────────────────────────────────────

  $effect(() => {
    const path = groupPath;
    loading = true;
    error = null;
    void loadConfig(path);
  });

  async function loadConfig(path: GroupPath): Promise<void> {
    // Load local config.
    const localRes = await ipc.get_group_config(path);
    if (!localRes.ok) {
      error = localRes.error.message;
      loading = false;
      return;
    }
    const cfg = localRes.value;
    localName = cfg.name ?? "";
    localIcon = cfg.icon ?? "";
    localColor = cfg.color ?? "";
    localView = cfg.view ?? "";
    localSchema = Object.entries(cfg.schema ?? {}).map(([key, decl]) => ({
      key,
      decl: { ...decl, enumValues: decl.enumValues ? [...decl.enumValues] : undefined },
    }));

    // Load effective schema and compute inherited (parent-only) properties.
    const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
    if (parentPath) {
      const effectiveRes = await ipc.effective_schema(parentPath);
      if (effectiveRes.ok && effectiveRes.value) {
        try {
          const effective = JSON.parse(effectiveRes.value) as Record<string, SchemaPropertyDecl>;
          const localKeys = new Set(localSchema.map((r) => r.key));
          const inherited: Record<string, SchemaPropertyDecl> = {};
          for (const [k, v] of Object.entries(effective)) {
            if (!localKeys.has(k)) inherited[k] = v;
          }
          inheritedSchema = inherited;
        } catch {
          inheritedSchema = {};
        }
      } else {
        inheritedSchema = {};
      }
    } else {
      inheritedSchema = {};
    }

    loading = false;
  }

  // ── Save ──────────────────────────────────────────────────────────────────────

  async function save(): Promise<void> {
    saving = true;
    error = null;

    // Build schema from local rows.
    const schema: Record<string, SchemaPropertyDecl> = {};
    for (const row of localSchema) {
      const k = row.key.trim();
      if (!k) continue;
      schema[k] = { ...row.decl };
    }

    const config: GroupConfigInput = {};
    if (localName.trim()) config.name = localName.trim();
    if (localIcon.trim()) config.icon = localIcon.trim();
    if (localColor.trim()) config.color = localColor.trim();
    if (localView) config.view = localView;
    if (Object.keys(schema).length > 0) config.schema = schema;

    const res = await ipc.update_group_config(groupPath, config);
    saving = false;
    if (!res.ok) {
      error = res.error.message;
      return;
    }
    onChanged?.();
  }

  // ── Schema row manipulation ───────────────────────────────────────────────────

  function addSchemaProp(): void {
    const k = newPropKey.trim();
    if (!k) return;
    // Avoid duplicates.
    if (localSchema.some((r) => r.key === k)) return;
    const decl: SchemaPropertyDecl = { type: newPropType };
    if (newPropDefault.trim()) decl.default = newPropDefault.trim();
    if (newPropType === "enum" && newPropEnumValues.trim()) {
      decl.enumValues = newPropEnumValues
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
    }
    localSchema = [...localSchema, { key: k, decl }];
    newPropKey = "";
    newPropType = "string";
    newPropDefault = "";
    newPropEnumValues = "";
  }

  function removeSchemaProp(index: number): void {
    localSchema = localSchema.filter((_, i) => i !== index);
  }

  function movePropUp(index: number): void {
    if (index === 0) return;
    const arr = [...localSchema];
    [arr[index - 1], arr[index]] = [arr[index]!, arr[index - 1]!];
    localSchema = arr;
  }

  function movePropDown(index: number): void {
    if (index >= localSchema.length - 1) return;
    const arr = [...localSchema];
    [arr[index], arr[index + 1]] = [arr[index + 1]!, arr[index]!];
    localSchema = arr;
  }

  function updatePropType(index: number, newType: string): void {
    localSchema = localSchema.map((row, i) =>
      i === index
        ? {
            ...row,
            decl: {
              ...row.decl,
              type: newType,
              enumValues: newType !== "enum" ? undefined : row.decl.enumValues,
            },
          }
        : row,
    );
  }

  function updatePropDefault(index: number, value: string): void {
    localSchema = localSchema.map((row, i) =>
      i === index ? { ...row, decl: { ...row.decl, default: value || undefined } } : row,
    );
  }

  function updatePropEnumValues(index: number, raw: string): void {
    const vals = raw
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    localSchema = localSchema.map((row, i) =>
      i === index
        ? { ...row, decl: { ...row.decl, enumValues: vals.length > 0 ? vals : undefined } }
        : row,
    );
  }

  function onAddKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      addSchemaProp();
    }
  }
</script>

<aside class="gcfg-panel" aria-label="Group configuration">
  <header class="gcfg-header">
    <span class="gcfg-title">Configure Group</span>
    {#if onClose}
      <button class="gcfg-close" onclick={onClose} aria-label="Close" title="Close">×</button>
    {/if}
  </header>

  {#if loading}
    <div class="gcfg-loading">Loading…</div>
  {:else}
    <div class="gcfg-body">
      <!-- ── Identity ─────────────────────────────────────────────────────── -->
      <section class="gcfg-section">
        <div class="gcfg-section-label">Identity</div>

        <div class="gcfg-field-row">
          <label class="gcfg-label" for="gcfg-name">Display name</label>
          <input
            id="gcfg-name"
            class="gcfg-input"
            type="text"
            placeholder={groupPath.split("/").at(-1) ?? groupPath}
            bind:value={localName}
            aria-label="Display name"
          />
        </div>

        <div class="gcfg-field-row">
          <label class="gcfg-label" for="gcfg-icon">Icon</label>
          <input
            id="gcfg-icon"
            class="gcfg-input gcfg-input--short"
            type="text"
            placeholder="emoji"
            bind:value={localIcon}
            aria-label="Icon (emoji)"
          />
        </div>

        <div class="gcfg-field-row gcfg-field-row--swatch">
          <span class="gcfg-label">Color</span>
          <div class="gcfg-swatches" role="radiogroup" aria-label="Color">
            {#each COLOR_PALETTE as c (c)}
              <button
                class="gcfg-swatch"
                class:gcfg-swatch--selected={localColor === c}
                style="background: {c};"
                onclick={() => {
                  localColor = localColor === c ? "" : c;
                }}
                aria-label={c}
                aria-pressed={localColor === c}
                title={c}
              ></button>
            {/each}
          </div>
        </div>
      </section>

      <!-- ── Default view ─────────────────────────────────────────────────── -->
      <section class="gcfg-section">
        <div class="gcfg-section-label">Default view</div>
        <div class="gcfg-field-row">
          <label class="gcfg-label" for="gcfg-view">View</label>
          <select id="gcfg-view" class="gcfg-select" bind:value={localView} aria-label="View">
            <option value="">— inherit —</option>
            {#each BUILTIN_VIEWS as v (v)}
              <option value={v}>{v}</option>
            {/each}
          </select>
        </div>
      </section>

      <!-- ── Local schema ─────────────────────────────────────────────────── -->
      <section class="gcfg-section gcfg-section--schema">
        <div class="gcfg-section-label">Property schema</div>

        {#if Object.keys(inheritedSchema).length > 0}
          <div class="gcfg-inherited-label">Inherited (read-only)</div>
          {#each Object.entries(inheritedSchema) as [k, decl] (k)}
            <div class="gcfg-schema-row gcfg-schema-row--inherited">
              <span class="gcfg-schema-key">{k}</span>
              <span class="gcfg-schema-type">{decl.type}</span>
              {#if decl.default !== undefined}
                <span class="gcfg-schema-default">{decl.default}</span>
              {/if}
            </div>
          {/each}
        {/if}

        {#if localSchema.length > 0}
          <div class="gcfg-local-label">Local declarations</div>
        {/if}

        {#each localSchema as row, i (row.key + i)}
          <div class="gcfg-schema-row">
            <span class="gcfg-schema-key">{row.key}</span>
            <select
              class="gcfg-select gcfg-select--sm"
              value={row.decl.type}
              onchange={(e) => updatePropType(i, (e.currentTarget as HTMLSelectElement).value)}
              aria-label="Property type for {row.key}"
            >
              {#each PROP_TYPES as t (t)}
                <option value={t}>{t}</option>
              {/each}
            </select>
            <input
              class="gcfg-input gcfg-input--sm"
              type="text"
              placeholder="default"
              value={row.decl.default !== undefined ? String(row.decl.default) : ""}
              oninput={(e) => updatePropDefault(i, (e.currentTarget as HTMLInputElement).value)}
              aria-label="Default value for {row.key}"
            />
            {#if row.decl.type === "enum"}
              <input
                class="gcfg-input gcfg-input--sm gcfg-input--enum"
                type="text"
                placeholder="a, b, c"
                value={row.decl.enumValues?.join(", ") ?? ""}
                oninput={(e) =>
                  updatePropEnumValues(i, (e.currentTarget as HTMLInputElement).value)}
                aria-label="Enum values for {row.key}"
                title="Comma-separated enum values"
              />
            {/if}
            <div class="gcfg-schema-actions">
              <button
                class="gcfg-icon-btn"
                onclick={() => movePropUp(i)}
                disabled={i === 0}
                aria-label="Move up"
                title="Move up">↑</button
              >
              <button
                class="gcfg-icon-btn"
                onclick={() => movePropDown(i)}
                disabled={i === localSchema.length - 1}
                aria-label="Move down"
                title="Move down">↓</button
              >
              <button
                class="gcfg-icon-btn gcfg-icon-btn--danger"
                onclick={() => removeSchemaProp(i)}
                aria-label="Remove {row.key}"
                title="Remove">×</button
              >
            </div>
          </div>
        {/each}

        <!-- Add new property row -->
        <div class="gcfg-add-row">
          <input
            class="gcfg-input gcfg-input--key"
            type="text"
            placeholder="prop name"
            bind:value={newPropKey}
            onkeydown={onAddKeydown}
            aria-label="New property name"
          />
          <select
            class="gcfg-select gcfg-select--sm"
            bind:value={newPropType}
            aria-label="New property type"
          >
            {#each PROP_TYPES as t (t)}
              <option value={t}>{t}</option>
            {/each}
          </select>
          <input
            class="gcfg-input gcfg-input--sm"
            type="text"
            placeholder="default"
            bind:value={newPropDefault}
            onkeydown={onAddKeydown}
            aria-label="New property default"
          />
          {#if newPropType === "enum"}
            <input
              class="gcfg-input gcfg-input--sm gcfg-input--enum"
              type="text"
              placeholder="a, b, c"
              bind:value={newPropEnumValues}
              onkeydown={onAddKeydown}
              aria-label="Enum values"
              title="Comma-separated enum values"
            />
          {/if}
          <button
            class="gcfg-btn gcfg-btn--add"
            onclick={addSchemaProp}
            aria-label="Add property"
            title="Add property">+</button
          >
        </div>
      </section>

      <!-- ── Error and save ───────────────────────────────────────────────── -->
      {#if error}
        <div class="gcfg-error" role="alert">{error}</div>
      {/if}

      <div class="gcfg-footer">
        <button class="gcfg-btn gcfg-btn--save" onclick={save} disabled={saving} aria-busy={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  {/if}
</aside>

<style>
  .gcfg-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--tnd-panel);
    border-left: 1px solid var(--tnd-line);
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 0.8rem;
    color: var(--tnd-text);
    overflow: hidden;
  }

  .gcfg-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--tnd-line);
    flex-shrink: 0;
    background: var(--tnd-panel2);
  }

  .gcfg-title {
    font-weight: 600;
    font-size: 0.75rem;
    color: var(--tnd-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .gcfg-close {
    background: none;
    border: none;
    font-size: 1.1rem;
    color: var(--tnd-text-faint);
    cursor: pointer;
    line-height: 1;
    padding: 0.1rem 0.25rem;
    border-radius: 3px;
    font-family: inherit;
  }

  .gcfg-close:hover {
    color: var(--tnd-text);
    background: var(--tnd-panel);
  }

  .gcfg-loading {
    padding: 1rem;
    color: var(--tnd-text-faint);
    font-size: 0.75rem;
  }

  .gcfg-body {
    flex: 1;
    overflow-y: auto;
    padding: 0;
  }

  /* Sections */
  .gcfg-section {
    border-bottom: 1px solid var(--tnd-line);
    padding: 0.5rem 0.75rem 0.6rem;
  }

  .gcfg-section-label {
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--tnd-text-faint);
    margin-bottom: 0.4rem;
  }

  /* Field rows */
  .gcfg-field-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.35rem;
  }

  .gcfg-field-row--swatch {
    align-items: flex-start;
    gap: 0.5rem;
  }

  .gcfg-label {
    font-size: 0.7rem;
    color: var(--tnd-text-muted);
    width: 5.5rem;
    flex-shrink: 0;
  }

  /* Inputs */
  .gcfg-input {
    flex: 1;
    min-width: 0;
    font-size: 0.78rem;
    font-family: inherit;
    padding: 0.2rem 0.4rem;
    background: var(--tnd-panel2);
    color: var(--tnd-text);
    border: 1px solid var(--tnd-line);
    border-radius: 3px;
    outline: none;
    box-sizing: border-box;
  }

  .gcfg-input:focus {
    border-color: var(--tnd-accent);
  }

  .gcfg-input--short {
    max-width: 6rem;
  }

  .gcfg-input--key {
    width: 6rem;
    flex: 0 0 auto;
  }

  .gcfg-input--sm {
    flex: 1;
    min-width: 4rem;
  }

  .gcfg-input--enum {
    flex: 2;
    min-width: 6rem;
  }

  /* Select */
  .gcfg-select {
    flex: 1;
    min-width: 0;
    font-size: 0.78rem;
    font-family: inherit;
    padding: 0.2rem 0.3rem;
    background: var(--tnd-panel2);
    color: var(--tnd-text);
    border: 1px solid var(--tnd-line);
    border-radius: 3px;
    outline: none;
    cursor: pointer;
  }

  .gcfg-select:focus {
    border-color: var(--tnd-accent);
  }

  .gcfg-select--sm {
    flex: 0 1 6rem;
  }

  /* Color swatches */
  .gcfg-swatches {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    flex: 1;
  }

  .gcfg-swatch {
    width: 1.2rem;
    height: 1.2rem;
    border-radius: 3px;
    border: 2px solid transparent;
    cursor: pointer;
    padding: 0;
    outline: none;
    flex-shrink: 0;
  }

  .gcfg-swatch:focus-visible {
    outline: 2px solid var(--tnd-accent);
    outline-offset: 1px;
  }

  .gcfg-swatch--selected {
    border-color: var(--tnd-text);
    box-shadow: 0 0 0 1px var(--tnd-panel);
  }

  /* Schema section */
  .gcfg-section--schema {
    padding-bottom: 0.5rem;
  }

  .gcfg-inherited-label,
  .gcfg-local-label {
    font-size: 0.65rem;
    color: var(--tnd-text-faint);
    margin-bottom: 0.2rem;
    font-style: italic;
  }

  .gcfg-schema-row {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    margin-bottom: 0.25rem;
    min-height: 1.6rem;
  }

  .gcfg-schema-row--inherited {
    opacity: 0.65;
  }

  .gcfg-schema-key {
    font-size: 0.72rem;
    color: var(--tnd-text-muted);
    font-weight: 600;
    width: 5.5rem;
    flex-shrink: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .gcfg-schema-type {
    font-size: 0.68rem;
    color: var(--tnd-text-faint);
    font-family: ui-monospace, monospace;
  }

  .gcfg-schema-default {
    font-size: 0.68rem;
    color: var(--tnd-text-faint);
    font-family: ui-monospace, monospace;
    margin-left: 0.25rem;
  }

  .gcfg-schema-actions {
    display: flex;
    gap: 0.15rem;
    margin-left: auto;
    flex-shrink: 0;
  }

  /* Add row */
  .gcfg-add-row {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    margin-top: 0.4rem;
    padding-top: 0.4rem;
    border-top: 1px dashed var(--tnd-line);
  }

  /* Buttons */
  .gcfg-btn {
    font-size: 0.72rem;
    font-family: inherit;
    cursor: pointer;
    border-radius: 3px;
    padding: 0.2rem 0.5rem;
    border: 1px solid transparent;
    background: none;
    color: var(--tnd-text-muted);
  }

  .gcfg-btn--add {
    background: var(--tnd-accent-soft);
    color: var(--tnd-accent-text);
    font-size: 1rem;
    line-height: 1;
    padding: 0.1rem 0.35rem;
    flex-shrink: 0;
  }

  .gcfg-btn--add:hover {
    background: var(--tnd-accent);
    color: var(--tnd-panel);
  }

  .gcfg-btn--save {
    background: var(--tnd-accent);
    color: var(--tnd-panel);
    border-color: transparent;
    padding: 0.3rem 1rem;
    font-size: 0.78rem;
    font-weight: 600;
    cursor: pointer;
  }

  .gcfg-btn--save:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .gcfg-icon-btn {
    background: none;
    border: 1px solid var(--tnd-line);
    border-radius: 3px;
    font-size: 0.72rem;
    font-family: inherit;
    color: var(--tnd-text-faint);
    cursor: pointer;
    padding: 0.05rem 0.25rem;
    line-height: 1.2;
  }

  .gcfg-icon-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .gcfg-icon-btn:not(:disabled):hover {
    color: var(--tnd-text);
    background: var(--tnd-panel2);
  }

  .gcfg-icon-btn--danger:not(:disabled):hover {
    color: var(--tnd-chip-red-fg, #c0392b);
  }

  /* Error */
  .gcfg-error {
    margin: 0.5rem 0.75rem;
    padding: 0.4rem 0.6rem;
    background: rgba(192, 57, 43, 0.08);
    border: 1px solid rgba(192, 57, 43, 0.25);
    border-radius: 4px;
    font-size: 0.72rem;
    color: var(--tnd-chip-red-fg, #c0392b);
  }

  /* Footer */
  .gcfg-footer {
    padding: 0.6rem 0.75rem;
    display: flex;
    justify-content: flex-end;
  }
</style>
