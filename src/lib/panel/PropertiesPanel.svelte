<script lang="ts">
  // Properties panel (spec 0006 §Frontmatter UX, issue #15).
  //
  // Props:
  //   docText       — the current editor buffer text (re-derived on every change)
  //   onEdit        — callback: caller applies the ChangeSpec to the editor buffer
  //
  // Design notes:
  //   • Panel derives FmModel from docText on every change.
  //   • A focused-input guard prevents re-derive from clobbering an in-progress edit.
  //   • Raw view toggle shows a textarea of the raw frontmatter block; edits there
  //     replace the block verbatim (power-user path per 0006).
  //   • id shown only when advancedExpanded = true.
  //   • title never shown (derived).
  //   • created / updated shown as read-only.

  import { parseFrontmatter, applyPanelEdit, inferType } from "./frontmatter-view.js";
  import type { FmModel, FmEdit, ChangeSpec, SchemaPropDecl } from "./frontmatter-view.js";
  import { ipc } from "../ipc/index.js";
  import type { GroupPath, EntryId } from "../ipc/types.js";

  // ── Built-in view names (spec 0002 §Rendering) ───────────────────────────────
  const VIEW_OPTIONS = ["note", "task-list"] as const;

  interface Props {
    /** Full editor buffer text — re-derived on every doc change. */
    docText: string;
    /** Caller applies the returned ChangeSpec to the editor view. */
    onEdit?: (change: ChangeSpec) => void;
    /** Group path of the currently selected entry — used to load suggested properties. */
    groupPath?: GroupPath | null;
  }

  let { docText, onEdit, groupPath = null }: Props = $props();

  // ── Group schema (phase 6 / issue #28) ───────────────────────────────────────

  let schemaProps = $state<Record<string, SchemaPropDecl> | null>(null);

  $effect(() => {
    const path = groupPath;
    if (!path) {
      schemaProps = null;
      return;
    }
    ipc.effective_schema(path).then((result) => {
      if (result.ok && result.value) {
        try {
          schemaProps = JSON.parse(result.value) as Record<string, SchemaPropDecl>;
        } catch {
          schemaProps = null;
        }
      } else {
        schemaProps = null;
      }
    });
  });

  // ── Entry titles for ref/ref[] pickers ───────────────────────────────────────

  let entryTitles = $state<Record<EntryId, string>>({});

  $effect(() => {
    ipc.entry_titles().then((result) => {
      if (result.ok) entryTitles = result.value;
    });
  });

  // ── Derived model ─────────────────────────────────────────────────────────────

  let focusedKey = $state<string | null>(null);
  let focusedRaw = $state(false);

  // Re-derive model whenever docText or schema changes, but NOT while focused.
  let model = $derived.by((): FmModel => {
    if (focusedKey !== null || focusedRaw) {
      // Guard: don't re-parse while the user is typing in a panel input.
      // The model will refresh on the next blur.
      return model ?? parseFrontmatter(docText, schemaProps);
    }
    return parseFrontmatter(docText, schemaProps);
  });

  // ── Raw view toggle ───────────────────────────────────────────────────────────

  let showRaw = $state(false);
  let rawEditText = $state("");

  function enterRawView(): void {
    if (!model.hasFrontmatter) return;
    const lines = docText.split("\n");
    // Slice from openFenceLine to closeFenceLine (1-based, inclusive).
    rawEditText = lines.slice(model.openFenceLine - 1, model.closeFenceLine).join("\n");
    showRaw = true;
  }

  function exitRawView(): void {
    showRaw = false;
  }

  function onRawBlur(): void {
    focusedRaw = false;
    // On blur, commit the raw text as a replace-raw edit.
    commitEdit({ kind: "replace-raw", rawBlock: rawEditText });
  }

  // ── Advanced section ──────────────────────────────────────────────────────────

  let advancedExpanded = $state(false);

  // ── Edit dispatch ─────────────────────────────────────────────────────────────

  function commitEdit(edit: FmEdit): void {
    const change = applyPanelEdit(docText, model, edit);
    if (change) onEdit?.(change);
  }

  // ── Input handlers ────────────────────────────────────────────────────────────

  function onScalarInput(key: string, e: Event): void {
    const target = e.currentTarget as HTMLInputElement;
    const type = model.rows.find((r) => r.key === key)?.type ?? "string";
    let value: string | number | boolean = target.value;
    if (type === "number") value = parseFloat(target.value) || 0;
    commitEdit({ kind: "set-scalar", key, value });
  }

  function onBooleanChange(key: string, e: Event): void {
    const target = e.currentTarget as HTMLInputElement;
    commitEdit({ kind: "set-scalar", key, value: target.checked });
  }

  function onDateInput(key: string, e: Event): void {
    const target = e.currentTarget as HTMLInputElement;
    commitEdit({ kind: "set-scalar", key, value: target.value });
  }

  // ── Chip/token array editing ──────────────────────────────────────────────────

  let chipInputValues = $state<Record<string, string>>({});

  function removeToken(key: string, index: number): void {
    const row = model.rows.find((r) => r.key === key);
    if (!row || !Array.isArray(row.value)) return;
    const newValues = (row.value as string[]).filter((_, i) => i !== index);
    commitEdit({ kind: "set-array", key, values: newValues });
  }

  function addToken(key: string): void {
    const raw = (chipInputValues[key] ?? "").trim();
    if (!raw) return;
    const row = model.rows.find((r) => r.key === key);
    const existing = Array.isArray(row?.value) ? (row!.value as string[]) : [];
    commitEdit({ kind: "set-array", key, values: [...existing, raw] });
    chipInputValues = { ...chipInputValues, [key]: "" };
  }

  function onChipInputKeydown(key: string, e: KeyboardEvent): void {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addToken(key);
    } else if (e.key === "Backspace") {
      const row = model.rows.find((r) => r.key === key);
      if (
        (chipInputValues[key] ?? "") === "" &&
        Array.isArray(row?.value) &&
        (row!.value as string[]).length > 0
      ) {
        removeToken(key, (row!.value as string[]).length - 1);
      }
    }
  }

  // ── Ref/ref[] autocomplete ────────────────────────────────────────────────────
  // ref:   single entry slug stored as scalar string.
  // ref[]: chip list of entry slugs stored as array.
  //
  // Both use `entryTitles` for autocomplete suggestions.

  let refInputValues = $state<Record<string, string>>({});
  let refSuggestions = $state<Record<string, Array<{ id: string; title: string }>>>({});

  function getRefSuggestions(query: string): Array<{ id: string; title: string }> {
    const q = query.toLowerCase().trim();
    if (!q) return [];
    return Object.entries(entryTitles)
      .filter(([id, title]) => id.toLowerCase().includes(q) || title.toLowerCase().includes(q))
      .map(([id, title]) => ({ id, title }))
      .slice(0, 8);
  }

  function onRefInput(key: string, e: Event): void {
    const val = (e.currentTarget as HTMLInputElement).value;
    refInputValues = { ...refInputValues, [key]: val };
    refSuggestions = { ...refSuggestions, [key]: getRefSuggestions(val) };
  }

  function selectRef(key: string, slug: string): void {
    commitEdit({ kind: "set-scalar", key, value: slug });
    refInputValues = { ...refInputValues, [key]: "" };
    refSuggestions = { ...refSuggestions, [key]: [] };
  }

  function onRefBlur(key: string): void {
    // Small delay so click on suggestion fires first.
    setTimeout(() => {
      refSuggestions = { ...refSuggestions, [key]: [] };
      focusedKey = null;
    }, 150);
  }

  // ref[] — chip list of slugs
  function removeRefChip(key: string, index: number): void {
    const row = model.rows.find((r) => r.key === key);
    if (!row || !Array.isArray(row.value)) return;
    const newValues = (row.value as string[]).filter((_, i) => i !== index);
    commitEdit({ kind: "set-array", key, values: newValues });
  }

  function addRefChip(key: string, slug: string): void {
    if (!slug) return;
    const row = model.rows.find((r) => r.key === key);
    const existing = Array.isArray(row?.value) ? (row!.value as string[]) : [];
    if (existing.includes(slug)) return;
    commitEdit({ kind: "set-array", key, values: [...existing, slug] });
    refInputValues = { ...refInputValues, [key]: "" };
    refSuggestions = { ...refSuggestions, [key]: [] };
  }

  function onRefArrayInput(key: string, e: Event): void {
    const val = (e.currentTarget as HTMLInputElement).value;
    refInputValues = { ...refInputValues, [key]: val };
    refSuggestions = { ...refSuggestions, [key]: getRefSuggestions(val) };
  }

  function onRefArrayBlur(key: string): void {
    setTimeout(() => {
      refSuggestions = { ...refSuggestions, [key]: [] };
      focusedKey = null;
    }, 150);
  }

  // ── Add property ──────────────────────────────────────────────────────────────

  let newKey = $state("");
  let newValue = $state("");

  function addProperty(): void {
    const k = newKey.trim();
    const v = newValue.trim();
    if (!k) return;
    // Infer a sensible value type.
    let typedValue: string | number | boolean = v;
    const inferred = inferType(v, k);
    if (inferred === "number") typedValue = parseFloat(v) || 0;
    else if (inferred === "boolean") typedValue = v === "true";
    commitEdit({ kind: "add", key: k, value: typedValue });
    newKey = "";
    newValue = "";
  }

  function onAddKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      addProperty();
    }
  }

  // ── Remove property ───────────────────────────────────────────────────────────

  function removeProperty(key: string): void {
    commitEdit({ kind: "remove", key });
  }
</script>

<aside class="tnd-panel" aria-label="Properties panel">
  <header class="tnd-panel-header">
    <span class="tnd-panel-title">Properties</span>
    <div class="tnd-panel-header-actions">
      {#if model.hasFrontmatter}
        <button
          class="tnd-panel-btn tnd-panel-btn--ghost"
          onclick={showRaw ? exitRawView : enterRawView}
          title={showRaw ? "Typed view" : "Raw YAML view"}
        >
          {showRaw ? "Typed" : "Raw"}
        </button>
      {/if}
    </div>
  </header>

  {#if showRaw && model.hasFrontmatter}
    <!-- Power-user raw frontmatter view -->
    <textarea
      class="tnd-panel-raw"
      bind:value={rawEditText}
      onfocus={() => {
        focusedRaw = true;
      }}
      onblur={onRawBlur}
      spellcheck={false}
      aria-label="Raw frontmatter YAML"
    ></textarea>
  {:else if !model.hasFrontmatter}
    <!-- No frontmatter yet -->
    <div class="tnd-panel-empty">
      <p class="tnd-panel-empty-msg">No properties yet.</p>
      <div class="tnd-panel-add-row">
        <input
          class="tnd-panel-input tnd-panel-input--key"
          placeholder="key"
          bind:value={newKey}
          onfocus={() => {
            focusedKey = "__add__";
          }}
          onblur={() => {
            focusedKey = null;
          }}
          onkeydown={onAddKeydown}
          aria-label="New property key"
        />
        <input
          class="tnd-panel-input tnd-panel-input--val"
          placeholder="value"
          bind:value={newValue}
          onfocus={() => {
            focusedKey = "__add__";
          }}
          onblur={() => {
            focusedKey = null;
          }}
          onkeydown={onAddKeydown}
          aria-label="New property value"
        />
        <button class="tnd-panel-btn tnd-panel-btn--add" onclick={addProperty} title="Add property"
          >+</button
        >
      </div>
    </div>
  {:else}
    <!-- Typed property rows -->
    <div class="tnd-panel-body">
      {#each model.rows as row (row.key)}
        <div class="tnd-panel-row">
          <span class="tnd-panel-key" title={row.key}>{row.key}</span>
          <div class="tnd-panel-value">
            {#if row.type === "boolean"}
              <input
                type="checkbox"
                class="tnd-panel-checkbox"
                checked={row.value === true}
                onfocus={() => {
                  focusedKey = row.key;
                }}
                onblur={() => {
                  focusedKey = null;
                }}
                onchange={(e) => onBooleanChange(row.key, e)}
                aria-label={row.key}
              />
            {:else if row.type === "number"}
              <input
                type="number"
                class="tnd-panel-input"
                value={typeof row.value === "number" ? row.value : ""}
                onfocus={() => {
                  focusedKey = row.key;
                }}
                onblur={() => {
                  focusedKey = null;
                }}
                oninput={(e) => onScalarInput(row.key, e)}
                aria-label={row.key}
              />
            {:else if row.type === "date"}
              <input
                type="date"
                class="tnd-panel-input"
                value={typeof row.value === "string" ? row.value : ""}
                onfocus={() => {
                  focusedKey = row.key;
                }}
                onblur={() => {
                  focusedKey = null;
                }}
                oninput={(e) => onDateInput(row.key, e)}
                aria-label={row.key}
              />
            {:else if row.type === "datetime"}
              <!-- datetime with offset: only the offset-aware display is read-only
                   per spec 0002; we show a datetime-local input and a read-only
                   offset badge derived from the raw value. -->
              <input
                type="datetime-local"
                class="tnd-panel-input"
                value={typeof row.value === "string"
                  ? row.value.slice(0, 16).replace(" ", "T")
                  : ""}
                onfocus={() => {
                  focusedKey = row.key;
                }}
                onblur={() => {
                  focusedKey = null;
                }}
                oninput={(e) => onDateInput(row.key, e)}
                aria-label={row.key}
              />
              {#if typeof row.value === "string" && row.value.length > 16}
                <span class="tnd-panel-tz" title="Timezone offset (read-only)"
                  >{row.value.slice(16)}</span
                >
              {/if}
            {:else if row.type === "range"}
              <!-- Range: read-only raw display with a note; calendar UI edits this. -->
              <span class="tnd-panel-raw-val" title={row.rawValue}>{row.rawValue}</span>
            {:else if row.type === "enum"}
              <!-- Enum: select populated from schema-declared values -->
              <select
                class="tnd-panel-input tnd-panel-select"
                value={typeof row.value === "string" ? row.value : ""}
                onfocus={() => {
                  focusedKey = row.key;
                }}
                onblur={() => {
                  focusedKey = null;
                }}
                onchange={(e) =>
                  commitEdit({
                    kind: "set-scalar",
                    key: row.key,
                    value: (e.currentTarget as HTMLSelectElement).value,
                  })}
                aria-label={row.key}
              >
                <option value="">—</option>
                {#each row.enumValues ?? [] as opt (opt)}
                  <option value={opt}>{opt}</option>
                {/each}
              </select>
            {:else if row.type === "ref"}
              <!-- Ref: entry slug with autocomplete -->
              <div class="tnd-panel-ref-wrap">
                <input
                  type="text"
                  class="tnd-panel-input"
                  value={refInputValues[row.key] ??
                    (typeof row.value === "string" ? row.value : "")}
                  placeholder="search entries…"
                  onfocus={() => {
                    focusedKey = row.key;
                    refInputValues = {
                      ...refInputValues,
                      [row.key]: typeof row.value === "string" ? row.value : "",
                    };
                  }}
                  onblur={() => onRefBlur(row.key)}
                  oninput={(e) => onRefInput(row.key, e)}
                  aria-label={row.key}
                  aria-autocomplete="list"
                  aria-haspopup="listbox"
                />
                {#if (refSuggestions[row.key] ?? []).length > 0}
                  <ul class="tnd-panel-ref-suggestions" role="listbox">
                    {#each refSuggestions[row.key] as s (s.id)}
                      <li role="option" aria-selected={false}>
                        <button
                          class="tnd-panel-ref-suggestion-btn"
                          onmousedown={(e) => {
                            e.preventDefault();
                            selectRef(row.key, s.id);
                          }}
                        >
                          <span class="tnd-panel-ref-title">{s.title}</span>
                          <span class="tnd-panel-ref-id">{s.id}</span>
                        </button>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {:else if row.type === "ref[]"}
              <!-- Ref[]: chip list of entry slugs with autocomplete -->
              <div
                class="tnd-panel-chips tnd-panel-ref-array"
                role="group"
                aria-label={`${row.key} refs`}
              >
                {#each Array.isArray(row.value) ? (row.value as string[]) : [] as slug, i (slug + i)}
                  <span class="tnd-panel-chip">
                    <span class="tnd-panel-chip-label" title={entryTitles[slug] ?? slug}>
                      {entryTitles[slug] ?? slug}
                    </span>
                    <button
                      class="tnd-panel-chip-remove"
                      onclick={() => removeRefChip(row.key, i)}
                      aria-label={`Remove ${slug}`}
                      title={`Remove ${slug}`}>×</button
                    >
                  </span>
                {/each}
                <div class="tnd-panel-ref-wrap">
                  <input
                    class="tnd-panel-chip-input"
                    type="text"
                    placeholder="add ref…"
                    value={refInputValues[row.key] ?? ""}
                    onfocus={() => {
                      focusedKey = row.key;
                    }}
                    onblur={() => onRefArrayBlur(row.key)}
                    oninput={(e) => onRefArrayInput(row.key, e)}
                    aria-label={`Add ref to ${row.key}`}
                  />
                  {#if (refSuggestions[row.key] ?? []).length > 0}
                    <ul class="tnd-panel-ref-suggestions" role="listbox">
                      {#each refSuggestions[row.key] as s (s.id)}
                        <li role="option" aria-selected={false}>
                          <button
                            class="tnd-panel-ref-suggestion-btn"
                            onmousedown={(e) => {
                              e.preventDefault();
                              addRefChip(row.key, s.id);
                            }}
                          >
                            <span class="tnd-panel-ref-title">{s.title}</span>
                            <span class="tnd-panel-ref-id">{s.id}</span>
                          </button>
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </div>
              </div>
            {:else if row.key === "view" && row.type === "string"}
              <!-- Well-known `view` property: select of built-in views (spec 0002 §Rendering) -->
              <select
                class="tnd-panel-input tnd-panel-select"
                value={typeof row.value === "string" ? row.value : ""}
                onfocus={() => {
                  focusedKey = row.key;
                }}
                onblur={() => {
                  focusedKey = null;
                }}
                onchange={(e) =>
                  commitEdit({
                    kind: "set-scalar",
                    key: "view",
                    value: (e.currentTarget as HTMLSelectElement).value,
                  })}
                aria-label="view"
              >
                <option value="">—</option>
                {#each VIEW_OPTIONS as v (v)}
                  <option value={v}>{v}</option>
                {/each}
              </select>
            {:else if row.type === "tags" || (row.type === "complex" && row.key === "tags")}
              <!-- Chip/token editor for tags and mentions arrays -->
              <div class="tnd-panel-chips" role="group" aria-label={`${row.key} chips`}>
                {#each Array.isArray(row.value) ? (row.value as string[]) : [] as token, i (token + i)}
                  <span class="tnd-panel-chip">
                    <span class="tnd-panel-chip-label">{token}</span>
                    <button
                      class="tnd-panel-chip-remove"
                      onclick={() => removeToken(row.key, i)}
                      aria-label={`Remove ${token}`}
                      title={`Remove ${token}`}>×</button
                    >
                  </span>
                {/each}
                <input
                  class="tnd-panel-chip-input"
                  type="text"
                  placeholder="add…"
                  value={chipInputValues[row.key] ?? ""}
                  onfocus={() => {
                    focusedKey = row.key;
                  }}
                  onblur={() => {
                    focusedKey = null;
                    addToken(row.key);
                  }}
                  oninput={(e) => {
                    chipInputValues = {
                      ...chipInputValues,
                      [row.key]: (e.currentTarget as HTMLInputElement).value,
                    };
                  }}
                  onkeydown={(e) => onChipInputKeydown(row.key, e)}
                  aria-label={`Add ${row.key}`}
                />
              </div>
            {:else if row.type === "complex"}
              <!-- Unknown/complex shape: read-only raw display -->
              <span class="tnd-panel-raw-val tnd-panel-raw-val--complex" title={row.rawValue}
                >{row.rawValue}</span
              >
            {:else}
              <!-- string -->
              <input
                type="text"
                class="tnd-panel-input"
                value={typeof row.value === "string" ? row.value : ""}
                onfocus={() => {
                  focusedKey = row.key;
                }}
                onblur={() => {
                  focusedKey = null;
                }}
                oninput={(e) => onScalarInput(row.key, e)}
                aria-label={row.key}
              />
            {/if}
          </div>
          {#if !row.readOnly}
            <button
              class="tnd-panel-btn tnd-panel-btn--remove"
              onclick={() => removeProperty(row.key)}
              title={`Remove ${row.key}`}
              aria-label={`Remove property ${row.key}`}>×</button
            >
          {/if}
        </div>
      {/each}

      <!-- Read-only built-ins (created / updated) -->
      {#each model.builtinRows as row (row.key)}
        <div class="tnd-panel-row tnd-panel-row--readonly">
          <span class="tnd-panel-key tnd-panel-key--builtin" title={row.key}>{row.key}</span>
          <span class="tnd-panel-raw-val" title={row.rawValue}>{row.rawValue}</span>
        </div>
      {/each}

      <!-- Add property row -->
      <div class="tnd-panel-add-row">
        <input
          class="tnd-panel-input tnd-panel-input--key"
          placeholder="key"
          bind:value={newKey}
          onfocus={() => {
            focusedKey = "__add__";
          }}
          onblur={() => {
            focusedKey = null;
          }}
          onkeydown={onAddKeydown}
          aria-label="New property key"
        />
        <input
          class="tnd-panel-input tnd-panel-input--val"
          placeholder="value"
          bind:value={newValue}
          onfocus={() => {
            focusedKey = "__add__";
          }}
          onblur={() => {
            focusedKey = null;
          }}
          onkeydown={onAddKeydown}
          aria-label="New property value"
        />
        <button class="tnd-panel-btn tnd-panel-btn--add" onclick={addProperty} title="Add property"
          >+</button
        >
      </div>

      <!-- Suggested properties from group schema (phase 6) -->
      {#if schemaProps}
        {@const existingKeys = new Set(model.rows.map((r) => r.key))}
        {@const suggested = Object.entries(schemaProps).filter(([k]) => !existingKeys.has(k))}
        {#if suggested.length > 0}
          <div class="tnd-panel-suggested">
            <span class="tnd-panel-suggested-label">Suggested</span>
            {#each suggested as [key, prop] (key)}
              <button
                class="tnd-panel-btn tnd-panel-btn--ghost tnd-panel-suggested-key"
                title="Add {key} ({prop.type})"
                onclick={() => {
                  const defaultVal =
                    prop.default !== undefined
                      ? String(prop.default)
                      : prop.type === "number"
                        ? "0"
                        : prop.type === "boolean"
                          ? "false"
                          : "";
                  commitEdit({ kind: "add", key, value: defaultVal });
                }}>{key}</button
              >
            {/each}
          </div>
        {/if}
      {/if}

      <!-- Advanced (id) -->
      {#if model.advancedRows.length > 0}
        <div class="tnd-panel-advanced">
          <button
            class="tnd-panel-btn tnd-panel-btn--ghost tnd-panel-advanced-toggle"
            onclick={() => {
              advancedExpanded = !advancedExpanded;
            }}
            aria-expanded={advancedExpanded}
          >
            {advancedExpanded ? "▾" : "▸"} Advanced
          </button>
          {#if advancedExpanded}
            {#each model.advancedRows as row (row.key)}
              <div class="tnd-panel-row tnd-panel-row--readonly">
                <span class="tnd-panel-key tnd-panel-key--builtin" title={row.key}>{row.key}</span>
                <span class="tnd-panel-raw-val" title={row.rawValue}>{row.rawValue}</span>
              </div>
            {/each}
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</aside>

<style>
  .tnd-panel {
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

  .tnd-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--tnd-line);
    flex-shrink: 0;
    background: var(--tnd-panel2);
  }

  .tnd-panel-title {
    font-weight: 600;
    font-size: 0.75rem;
    color: var(--tnd-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .tnd-panel-header-actions {
    display: flex;
    gap: 0.25rem;
  }

  .tnd-panel-body {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 0;
  }

  .tnd-panel-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 0.75rem;
    gap: 0.5rem;
  }

  .tnd-panel-empty-msg {
    margin: 0;
    color: var(--tnd-text-faint);
    font-size: 0.75rem;
  }

  /* Row layout */
  .tnd-panel-row {
    display: grid;
    grid-template-columns: 6rem 1fr auto;
    align-items: center;
    gap: 0.35rem;
    padding: 0.25rem 0.75rem;
    min-height: 2rem;
  }

  .tnd-panel-row--readonly {
    grid-template-columns: 6rem 1fr;
    opacity: 0.75;
  }

  .tnd-panel-key {
    font-size: 0.72rem;
    color: var(--tnd-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    user-select: none;
  }

  .tnd-panel-key--builtin {
    color: var(--tnd-text-faint);
    font-style: italic;
  }

  .tnd-panel-value {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    min-width: 0;
  }

  /* Inputs */
  .tnd-panel-input {
    width: 100%;
    min-width: 0;
    font-size: 0.8rem;
    font-family: inherit;
    padding: 0.2rem 0.4rem;
    background: var(--tnd-panel2);
    color: var(--tnd-text);
    border: 1px solid var(--tnd-line);
    border-radius: 3px;
    outline: none;
    box-sizing: border-box;
  }

  .tnd-panel-input:focus {
    border-color: var(--tnd-accent);
  }

  .tnd-panel-input--key {
    width: 5.5rem;
    flex-shrink: 0;
  }

  .tnd-panel-input--val {
    flex: 1;
    min-width: 0;
  }

  .tnd-panel-checkbox {
    accent-color: var(--tnd-accent);
    width: 1rem;
    height: 1rem;
    cursor: pointer;
  }

  /* Timezone badge */
  .tnd-panel-tz {
    font-size: 0.68rem;
    color: var(--tnd-text-faint);
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* Read-only raw value display */
  .tnd-panel-raw-val {
    font-size: 0.72rem;
    color: var(--tnd-text-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }

  .tnd-panel-raw-val--complex {
    color: var(--tnd-text-faint);
    font-style: italic;
  }

  /* Chip token editors */
  .tnd-panel-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    align-items: center;
    min-width: 0;
    flex: 1;
  }

  .tnd-panel-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.15rem;
    background: var(--tnd-accent-soft);
    color: var(--tnd-accent-text);
    border-radius: 3px;
    padding: 0.1rem 0.3rem;
    font-size: 0.7rem;
  }

  .tnd-panel-chip-label {
    max-width: 8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tnd-panel-chip-remove {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: inherit;
    opacity: 0.6;
    font-size: 0.9rem;
    line-height: 1;
    display: flex;
    align-items: center;
  }

  .tnd-panel-chip-remove:hover {
    opacity: 1;
  }

  .tnd-panel-chip-input {
    font-size: 0.72rem;
    font-family: inherit;
    background: transparent;
    border: none;
    outline: none;
    color: var(--tnd-text);
    min-width: 4rem;
    padding: 0.1rem 0.2rem;
  }

  .tnd-panel-chip-input::placeholder {
    color: var(--tnd-text-faint);
  }

  /* Action buttons */
  .tnd-panel-btn {
    font-size: 0.72rem;
    font-family: inherit;
    cursor: pointer;
    border-radius: 3px;
    padding: 0.15rem 0.4rem;
    border: 1px solid transparent;
    background: none;
    color: var(--tnd-text-muted);
    flex-shrink: 0;
  }

  .tnd-panel-btn--ghost {
    border-color: var(--tnd-line);
    background: var(--tnd-panel2);
  }

  .tnd-panel-btn--ghost:hover {
    border-color: var(--tnd-accent);
    color: var(--tnd-accent-text);
  }

  .tnd-panel-btn--add {
    background: var(--tnd-accent-soft);
    color: var(--tnd-accent-text);
    border-color: transparent;
    font-size: 1rem;
    line-height: 1;
    padding: 0.1rem 0.4rem;
  }

  .tnd-panel-btn--add:hover {
    background: var(--tnd-accent);
    color: var(--tnd-panel);
  }

  .tnd-panel-btn--remove {
    color: var(--tnd-text-faint);
    font-size: 1rem;
    line-height: 1;
    padding: 0.05rem 0.25rem;
  }

  .tnd-panel-btn--remove:hover {
    color: var(--tnd-chip-red-fg);
  }

  /* Add property row */
  .tnd-panel-add-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.4rem 0.75rem;
    border-top: 1px solid var(--tnd-line);
    margin-top: 0.25rem;
  }

  /* Raw textarea */
  .tnd-panel-raw {
    flex: 1;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.75rem;
    padding: 0.75rem;
    background: var(--tnd-panel2);
    color: var(--tnd-text);
    border: none;
    outline: none;
    resize: none;
    line-height: 1.5;
  }

  /* Advanced section */
  .tnd-panel-advanced {
    border-top: 1px solid var(--tnd-line);
    margin-top: 0.25rem;
    padding-top: 0.25rem;
  }

  .tnd-panel-advanced-toggle {
    margin: 0.25rem 0.75rem;
    font-size: 0.7rem;
  }

  .tnd-panel-suggested {
    border-top: 1px solid var(--tnd-line);
    margin-top: 0.25rem;
    padding: 0.25rem 0.75rem;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
  }

  .tnd-panel-suggested-label {
    font-size: 0.65rem;
    color: var(--tnd-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-right: 0.25rem;
    flex-shrink: 0;
  }

  .tnd-panel-suggested-key {
    font-size: 0.7rem;
    padding: 0.1rem 0.4rem;
    border: 1px dashed var(--tnd-line);
    border-radius: 3px;
    cursor: pointer;
  }

  /* Enum/view select widget */
  .tnd-panel-select {
    width: 100%;
    min-width: 0;
    font-size: 0.8rem;
    font-family: inherit;
    padding: 0.2rem 0.3rem;
    background: var(--tnd-panel2);
    color: var(--tnd-text);
    border: 1px solid var(--tnd-line);
    border-radius: 3px;
    outline: none;
    cursor: pointer;
    box-sizing: border-box;
  }

  .tnd-panel-select:focus {
    border-color: var(--tnd-accent);
  }

  /* Ref / ref[] autocomplete */
  .tnd-panel-ref-wrap {
    position: relative;
    flex: 1;
    min-width: 0;
  }

  .tnd-panel-ref-array {
    flex-wrap: wrap;
    flex: 1;
  }

  .tnd-panel-ref-suggestions {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: 100;
    background: var(--tnd-panel);
    border: 1px solid var(--tnd-line);
    border-top: none;
    border-radius: 0 0 4px 4px;
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 10rem;
    overflow-y: auto;
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.12);
  }

  .tnd-panel-ref-suggestion-btn {
    display: flex;
    flex-direction: column;
    width: 100%;
    padding: 0.3rem 0.5rem;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    font-family: inherit;
  }

  .tnd-panel-ref-suggestion-btn:hover {
    background: var(--tnd-accent-soft);
  }

  .tnd-panel-ref-title {
    font-size: 0.75rem;
    color: var(--tnd-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tnd-panel-ref-id {
    font-size: 0.65rem;
    color: var(--tnd-text-faint);
    font-family: ui-monospace, monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
