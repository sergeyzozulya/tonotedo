<script lang="ts">
  // CreatePersonDialog — small dialog for declaring a new person in _people.md
  // (spec 0005, issue #22).
  //
  // Fields: slug (required), displayName, description, color.
  // On confirm → calls ipc.set_person() via the facade, then emits onCreated(slug).
  // Slug validation: letters, digits, hyphens, underscores only (no slash).

  import { ipc } from "../ipc/index.js";
  import type { ChipColor } from "../ipc/types.js";

  interface Props {
    /** Pre-filled slug (from autocomplete onCreatePerson or declare button). */
    initialSlug?: string;
    /** Called when the dialog is dismissed without creating. */
    onClose: () => void;
    /** Called with the new slug after successful creation. */
    onCreated: (slug: string) => void;
  }

  let { initialSlug = "", onClose, onCreated }: Props = $props();

  // ── Form state ────────────────────────────────────────────────────────────────

  // Pre-fill: use the initial slug value. We capture it once on mount;
  // subsequent prop changes do not reset the field (user may have edited it).
  let slug = $state("");
  $effect.pre(() => {
    // Only run on first mount (when slug is still "").
    if (slug === "") slug = initialSlug;
  });
  let displayName = $state("");
  let description = $state("");
  let color = $state<ChipColor | "">("");
  let saving = $state(false);
  let error = $state<string | null>(null);

  const COLOR_OPTIONS: Array<{ value: ChipColor; label: string }> = [
    { value: "slate", label: "Slate" },
    { value: "red", label: "Red" },
    { value: "amber", label: "Amber" },
    { value: "green", label: "Green" },
    { value: "teal", label: "Teal" },
    { value: "blue", label: "Blue" },
    { value: "violet", label: "Violet" },
    { value: "pink", label: "Pink" },
  ];

  // ── Validation ────────────────────────────────────────────────────────────────

  function validateSlug(s: string): string | null {
    if (!s.trim()) return "Slug is required.";
    if (!/^[a-zA-Z0-9_-]+$/.test(s))
      return "Only letters, digits, hyphens, and underscores are allowed.";
    if (s.length > 64) return "Slug is too long (max 64 characters).";
    return null;
  }

  const slugError = $derived(slug ? validateSlug(slug) : null);
  const canSubmit = $derived(!saving && validateSlug(slug) === null);

  // ── Submit ────────────────────────────────────────────────────────────────────

  async function submit(): Promise<void> {
    const validationError = validateSlug(slug);
    if (validationError) {
      error = validationError;
      return;
    }
    saving = true;
    error = null;
    const result = await ipc.set_person({
      slug: slug.trim(),
      displayName: displayName.trim() || undefined,
      description: description.trim() || undefined,
      color: color || undefined,
    });
    saving = false;
    if (result.ok) {
      onCreated(slug.trim());
    } else {
      error = result.error.message;
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") onClose();
    if (e.key === "Enter" && canSubmit) submit();
  }
</script>

<!-- Backdrop -->
<div
  class="dialog-backdrop"
  role="presentation"
  onclick={(e) => e.target === e.currentTarget && onClose()}
  onkeydown={onKeydown}
>
  <div class="dialog" role="dialog" aria-modal="true" aria-label="Create person">
    <header class="dialog-header">
      <h3 class="dialog-title">Create person</h3>
      <button class="dialog-close" aria-label="Close" onclick={onClose}>✕</button>
    </header>

    <div class="dialog-body">
      <!-- Slug -->
      <div class="field">
        <label class="field-label" for="cp-slug">Slug <span class="required">*</span></label>
        <input
          id="cp-slug"
          class="field-input"
          class:field-input--error={!!slugError}
          type="text"
          placeholder="e.g. anna-k"
          bind:value={slug}
          autocomplete="off"
          spellcheck={false}
        />
        {#if slugError}
          <span class="field-error">{slugError}</span>
        {:else}
          <span class="field-hint">Used as @{slug || "slug"} in entries.</span>
        {/if}
      </div>

      <!-- Display name -->
      <div class="field">
        <label class="field-label" for="cp-name">Display name</label>
        <input
          id="cp-name"
          class="field-input"
          type="text"
          placeholder="e.g. Anna K."
          bind:value={displayName}
        />
      </div>

      <!-- Description -->
      <div class="field">
        <label class="field-label" for="cp-desc">Description</label>
        <input
          id="cp-desc"
          class="field-input"
          type="text"
          placeholder="Short note about this person"
          bind:value={description}
        />
      </div>

      <!-- Color -->
      <div class="field">
        <label class="field-label" for="cp-color">Color</label>
        <select id="cp-color" class="field-select" bind:value={color}>
          <option value="">None</option>
          {#each COLOR_OPTIONS as opt (opt.value)}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </div>

      {#if error}
        <div class="form-error">{error}</div>
      {/if}
    </div>

    <footer class="dialog-footer">
      <button class="btn btn--secondary" onclick={onClose}>Cancel</button>
      <button class="btn btn--primary" disabled={!canSubmit} onclick={submit}>
        {saving ? "Creating…" : "Create"}
      </button>
    </footer>
  </div>
</div>

<style>
  .dialog-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 500;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .dialog {
    background: var(--tnd-panel);
    border: 1px solid var(--tnd-line-strong);
    border-radius: var(--tnd-radius, 8px);
    box-shadow: var(--tnd-shadow);
    width: 380px;
    max-width: calc(100vw - 32px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* Header */
  .dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px 12px;
    border-bottom: 1px solid var(--tnd-line);
  }

  .dialog-title {
    font-size: 14px;
    font-weight: 700;
    color: var(--tnd-text);
    margin: 0;
  }

  .dialog-close {
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--tnd-text-faint);
    font-size: 14px;
    padding: 2px 6px;
    border-radius: 3px;
    line-height: 1;
    font-family: inherit;
  }

  .dialog-close:hover {
    background: var(--tnd-panel2);
    color: var(--tnd-text-muted);
  }

  /* Body */
  .dialog-body {
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  /* Fields */
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .field-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--tnd-text-muted);
    user-select: none;
    text-transform: var(--tnd-label-transform, none);
    letter-spacing: var(--tnd-label-spacing, 0);
    font-family: var(--tnd-font-ui);
  }

  .required {
    color: var(--tnd-chip-red-fg);
  }

  .field-input,
  .field-select {
    font-size: 13px;
    padding: 6px 8px;
    border: 1px solid var(--tnd-line-strong);
    border-radius: var(--tnd-radius, 4px);
    background: var(--tnd-bg);
    color: var(--tnd-text);
    font-family: var(--tnd-font-ui);
    outline: none;
    transition: border-color 0.1s;
  }

  .field-input:focus,
  .field-select:focus {
    border-color: var(--tnd-accent);
  }

  .field-input--error {
    border-color: var(--tnd-chip-red-fg);
  }

  .field-error {
    font-size: 11px;
    color: var(--tnd-chip-red-fg);
  }

  .field-hint {
    font-size: 11px;
    color: var(--tnd-text-faint);
  }

  .form-error {
    font-size: 12px;
    color: var(--tnd-chip-red-fg);
    padding: 6px 8px;
    background: var(--tnd-chip-red-bg);
    border-radius: 4px;
  }

  /* Footer */
  .dialog-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 18px 14px;
    border-top: 1px solid var(--tnd-line);
  }

  .btn {
    font-size: 13px;
    padding: 6px 16px;
    border-radius: var(--tnd-radius, 5px);
    cursor: pointer;
    font-family: var(--tnd-font-ui);
    font-weight: 600;
    border: 1px solid transparent;
    transition: background 0.08s;
  }

  .btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .btn--secondary {
    background: transparent;
    border-color: var(--tnd-line-strong);
    color: var(--tnd-text-muted);
  }

  .btn--secondary:hover:not(:disabled) {
    background: var(--tnd-panel2);
  }

  .btn--primary {
    background: var(--tnd-accent);
    color: #fff;
    border-color: var(--tnd-accent);
  }

  .btn--primary:hover:not(:disabled) {
    opacity: 0.9;
  }
</style>
