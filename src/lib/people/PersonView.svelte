<script lang="ts">
  // PersonView — main-zone view for a single person (spec 0005, issue #22).
  //
  // Layout:
  //   • Metadata header: avatar/initial, full name, description, color chip,
  //     drag/paste zone for avatar upload.
  //   • Chronological mentions list (most-recent-first) linking back to entries.
  //   • Edit button for declared people (reopens CreatePersonDialog prefilled).
  //   • Rename / Merge-into dialogs (mirrors TagBrowser pattern).
  //   • "Tidy" button: scans _people/ for orphan avatar files and offers removal.
  //   • "Declare" button for unmanaged people (opens create-person dialog).
  //
  // Design: per screens-dir.jsx PeopleDesktop — large avatar (72px, square in
  // Mono/circle otherwise), name+slug row, role/description, mentions list with
  // entry title + date. Token-mapped colours.

  import { SvelteSet } from "svelte/reactivity";
  import { ipc } from "../ipc/index.js";
  import type { PersonMeta, EntrySummary, OrphanAvatar } from "../ipc/types.js";
  import CreatePersonDialog from "./CreatePersonDialog.svelte";

  interface Props {
    /** The person being viewed. */
    person: PersonMeta;
    /** Called when the user clicks a mention entry row. */
    onEntrySelect?: (id: string) => void;
    /** Called when a person is renamed (new slug). */
    onPersonRenamed?: (newSlug: string) => void;
    /** Called when a new person is created via the declare button. */
    onPersonCreated?: (slug: string) => void;
  }

  let { person, onEntrySelect, onPersonRenamed, onPersonCreated }: Props = $props();

  // ── Mentions list ─────────────────────────────────────────────────────────────

  let mentions = $state<EntrySummary[]>([]);
  let mentionsLoading = $state(false);
  let mentionsError = $state<string | null>(null);

  async function loadMentions(slug: string): Promise<void> {
    mentionsLoading = true;
    mentionsError = null;
    const result = await ipc.mentions_for(slug);
    mentionsLoading = false;
    if (result.ok) {
      mentions = result.value;
    } else {
      mentionsError = result.error.message;
    }
  }

  $effect(() => {
    loadMentions(person.slug);
  });

  // ── Avatar display ────────────────────────────────────────────────────────────

  let avatarUrl = $state<string | null>(null);

  $effect(() => {
    avatarUrl = null;
    if (person.avatarPath) {
      ipc.asset_url(person.avatarPath).then((r) => {
        if (r.ok) avatarUrl = r.value;
      });
    }
  });

  function chipBg(p: PersonMeta): string {
    if (!p.color) return "var(--tnd-chip-slate-bg)";
    const named = ["slate", "red", "amber", "green", "teal", "blue", "violet", "pink"];
    if (named.includes(p.color as string)) return `var(--tnd-chip-${p.color}-bg)`;
    return p.color as string;
  }

  function chipFg(p: PersonMeta): string {
    if (!p.color) return "var(--tnd-chip-slate-fg)";
    const named = ["slate", "red", "amber", "green", "teal", "blue", "violet", "pink"];
    if (named.includes(p.color as string)) return `var(--tnd-chip-${p.color}-fg)`;
    return p.color as string;
  }

  function initial(p: PersonMeta): string {
    return (p.displayName || p.slug).charAt(0).toUpperCase();
  }

  // ── Avatar drag/paste upload ──────────────────────────────────────────────────

  let dragOver = $state(false);

  async function handleFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!file.type.startsWith("image/")) return;

    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = file.name.split(".").pop() ?? "png";
    const assetName = `${person.slug}.${ext}`;

    const attachResult = await ipc.attach_file("_people.md", assetName, bytes);
    if (!attachResult.ok) {
      console.error("[PersonView] attach_file failed:", attachResult.error.message);
      return;
    }

    const setResult = await ipc.set_person({
      slug: person.slug,
      displayName: person.displayName,
      description: person.description,
      color: person.color as string | undefined,
      avatarPath: attachResult.value,
    });
    if (setResult.ok) {
      const urlResult = await ipc.asset_url(attachResult.value);
      if (urlResult.ok) avatarUrl = urlResult.value;
    }
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault();
    dragOver = false;
    handleFiles(e.dataTransfer?.files ?? null);
  }

  function onPaste(e: ClipboardEvent): void {
    handleFiles(e.clipboardData?.files ?? null);
  }

  function onDragOver(e: DragEvent): void {
    e.preventDefault();
    dragOver = true;
  }

  // ── Edit person metadata ──────────────────────────────────────────────────────

  let showEditDialog = $state(false);

  // ── Rename dialog ─────────────────────────────────────────────────────────────

  let renameOpen = $state(false);
  let renameInput = $state("");
  let renameBusy = $state(false);
  let renameError = $state<string | null>(null);

  function openRename(): void {
    renameInput = person.slug;
    renameError = null;
    renameOpen = true;
  }

  function closeRename(): void {
    renameOpen = false;
    renameError = null;
  }

  async function commitRename(): Promise<void> {
    const newSlug = renameInput.trim();
    if (!newSlug) {
      renameError = "New slug is required.";
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(newSlug)) {
      renameError = "Only letters, digits, hyphens, and underscores are allowed.";
      return;
    }
    if (newSlug === person.slug) {
      closeRename();
      return;
    }
    renameBusy = true;
    renameError = null;
    const result = await ipc.rename_person(person.slug, newSlug);
    renameBusy = false;
    if (result.ok) {
      closeRename();
      onPersonRenamed?.(newSlug);
    } else {
      renameError = result.error.message;
    }
  }

  // ── Merge dialog ──────────────────────────────────────────────────────────────

  let mergeOpen = $state(false);
  let mergeInput = $state("");
  let mergeBusy = $state(false);
  let mergeError = $state<string | null>(null);

  function openMerge(): void {
    mergeInput = "";
    mergeError = null;
    mergeOpen = true;
  }

  function closeMerge(): void {
    mergeOpen = false;
    mergeError = null;
  }

  async function commitMerge(): Promise<void> {
    const targetSlug = mergeInput.trim();
    if (!targetSlug) {
      mergeError = "Target person is required.";
      return;
    }
    mergeBusy = true;
    mergeError = null;
    const result = await ipc.merge_person(person.slug, targetSlug);
    mergeBusy = false;
    if (result.ok) {
      closeMerge();
      onPersonRenamed?.(targetSlug);
    } else {
      mergeError = result.error.message;
    }
  }

  // ── Tidy avatars ──────────────────────────────────────────────────────────────
  // Spec 0005 §Avatars: scan _people/ for files no longer referenced by any
  // declared person and offer removal with confirmation.

  let tidyOpen = $state(false);
  let orphans = $state<OrphanAvatar[]>([]);
  let tidyBusy = $state(false);
  let tidyError = $state<string | null>(null);
  let tidySelected = new SvelteSet<string>();

  async function openTidy(): Promise<void> {
    tidyBusy = true;
    tidyError = null;
    tidySelected.clear();
    const result = await ipc.list_orphan_avatars();
    tidyBusy = false;
    if (result.ok) {
      orphans = result.value;
      // Pre-select all orphans.
      for (const o of orphans) tidySelected.add(o.path);
    } else {
      tidyError = result.error.message;
    }
    tidyOpen = true;
  }

  function closeTidy(): void {
    tidyOpen = false;
    orphans = [];
    tidySelected.clear();
    tidyError = null;
  }

  async function commitTidy(): Promise<void> {
    tidyBusy = true;
    tidyError = null;
    const failedPaths: string[] = [];
    for (const path of tidySelected) {
      const r = await ipc.delete_orphan_avatar(path);
      if (r.ok) {
        // Remove successfully deleted file from the orphans list immediately.
        orphans = orphans.filter((o) => o.path !== path);
        tidySelected.delete(path);
      } else {
        failedPaths.push(path);
      }
    }
    tidyBusy = false;
    if (failedPaths.length > 0) {
      tidyError = `${failedPaths.length} file(s) could not be deleted.`;
    } else {
      closeTidy();
    }
  }

  function toggleOrphan(path: string): void {
    if (tidySelected.has(path)) tidySelected.delete(path);
    else tidySelected.add(path);
  }

  // ── Declare dialog ────────────────────────────────────────────────────────────

  let showDeclareDialog = $state(false);

  // ── Date formatting ───────────────────────────────────────────────────────────

  function formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch {
      return iso;
    }
  }
</script>

<div class="person-view" onpaste={onPaste}>
  <!-- Metadata header -->
  <header class="person-header">
    <!-- Avatar / drag zone — square in Mono, circle otherwise -->
    <div
      class="avatar-zone"
      class:avatar-zone--drag={dragOver}
      role="img"
      aria-label="Avatar for {person.displayName}. Drag or paste an image to update."
      ondrop={onDrop}
      ondragover={onDragOver}
      ondragleave={() => (dragOver = false)}
    >
      {#if avatarUrl}
        <img class="avatar-img" src={avatarUrl} alt={person.displayName} />
      {:else}
        <span class="avatar-initial" style="background: {chipBg(person)}; color: {chipFg(person)};">
          {initial(person)}
        </span>
      {/if}
      <span class="avatar-hint">Drop / paste image</span>
    </div>

    <!-- Person info -->
    <div class="person-info">
      <div class="person-name-row">
        <h2 class="person-name">{person.displayName}</h2>
        <span class="person-slug">@{person.slug}</span>
        {#if !person.declared}
          <span class="person-badge person-badge--unmanaged">Unmanaged</span>
        {/if}
      </div>
      {#if person.color}
        <span
          class="person-color-chip"
          style="background: {chipBg(person)}; color: {chipFg(person)};"
        >
          {person.color}
        </span>
      {/if}
      {#if person.description}
        <p class="person-description">{person.description}</p>
      {/if}
      <div class="person-actions">
        {#if person.declared}
          <button class="action-btn action-btn--primary" onclick={() => (showEditDialog = true)}>
            Edit
          </button>
          <button class="action-btn" onclick={openRename}>Rename</button>
          <button class="action-btn" onclick={openMerge}>Merge into…</button>
        {:else}
          <button class="action-btn action-btn--primary" onclick={() => (showDeclareDialog = true)}>
            Declare person
          </button>
        {/if}
        <button
          class="action-btn"
          onclick={openTidy}
          title="Remove orphan avatar files from _people/"
        >
          Tidy avatars
        </button>
      </div>
    </div>

    <!-- Mention count (right side, per design) -->
    <div class="person-stat">
      <div class="person-stat-count">{person.count}</div>
      <div class="person-stat-label">MENTIONS</div>
    </div>
  </header>

  <!-- Mentions list -->
  <section class="mentions-section">
    <div class="mentions-header">
      <span class="mentions-title">Mentions</span>
      <span class="mentions-count">{person.count}</span>
    </div>

    {#if mentionsLoading}
      <div class="mentions-status">Loading…</div>
    {:else if mentionsError}
      <div class="mentions-status mentions-status--error">{mentionsError}</div>
    {:else if mentions.length === 0}
      <div class="mentions-status">No entries mention @{person.slug} yet.</div>
    {:else}
      <ul class="mentions-list" role="list">
        {#each mentions as entry (entry.id)}
          <li class="mention-row" role="listitem">
            <button class="mention-btn" onclick={() => onEntrySelect?.(entry.id)}>
              <span class="mention-title">{entry.title}</span>
              <span class="mention-meta">
                <span class="mention-group">{entry.group}</span>
                <span class="mention-date">{formatDate(entry.modifiedAt)}</span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<!-- Edit person metadata dialog (for declared people) -->
{#if showEditDialog}
  <CreatePersonDialog
    initialSlug={person.slug}
    onClose={() => (showEditDialog = false)}
    onCreated={(slug) => {
      showEditDialog = false;
      onPersonCreated?.(slug);
    }}
  />
{/if}

<!-- Declare / create person dialog (for unmanaged people) -->
{#if showDeclareDialog}
  <CreatePersonDialog
    initialSlug={person.slug}
    onClose={() => (showDeclareDialog = false)}
    onCreated={(slug) => {
      showDeclareDialog = false;
      onPersonCreated?.(slug);
    }}
  />
{/if}

<!-- Rename dialog -->
{#if renameOpen}
  <div
    class="pv-backdrop"
    role="presentation"
    onclick={(e) => e.target === e.currentTarget && closeRename()}
  >
    <div class="pv-dialog" role="dialog" aria-modal="true">
      <header class="pv-dialog-header">
        <span class="pv-dialog-title">Rename <code>@{person.slug}</code></span>
        <button class="pv-close-btn" aria-label="Cancel" onclick={closeRename}>✕</button>
      </header>
      <div class="pv-dialog-body">
        <label class="pv-label" for="rename-input">New slug</label>
        <input
          id="rename-input"
          class="pv-input"
          type="text"
          bind:value={renameInput}
          placeholder="new-slug"
          autocomplete="off"
          spellcheck={false}
        />
        <p class="pv-note">
          All entries that reference <code>@{person.slug}</code> will be rewritten to the new slug.
        </p>
        {#if renameError}
          <div class="pv-error">{renameError}</div>
        {/if}
      </div>
      <footer class="pv-dialog-footer">
        <button class="pv-btn pv-btn--secondary" onclick={closeRename}>Cancel</button>
        <button class="pv-btn pv-btn--primary" disabled={renameBusy} onclick={commitRename}>
          {renameBusy ? "Renaming…" : "Rename"}
        </button>
      </footer>
    </div>
  </div>
{/if}

<!-- Merge dialog -->
{#if mergeOpen}
  <div
    class="pv-backdrop"
    role="presentation"
    onclick={(e) => e.target === e.currentTarget && closeMerge()}
  >
    <div class="pv-dialog" role="dialog" aria-modal="true">
      <header class="pv-dialog-header">
        <span class="pv-dialog-title">Merge <code>@{person.slug}</code> into…</span>
        <button class="pv-close-btn" aria-label="Cancel" onclick={closeMerge}>✕</button>
      </header>
      <div class="pv-dialog-body">
        <label class="pv-label" for="merge-input">Target person slug</label>
        <input
          id="merge-input"
          class="pv-input"
          type="text"
          bind:value={mergeInput}
          placeholder="target-person"
          autocomplete="off"
          spellcheck={false}
        />
        <p class="pv-note">
          All entries mentioning <code>@{person.slug}</code> will be rewritten to the target. The source
          metadata will be removed.
        </p>
        {#if mergeError}
          <div class="pv-error">{mergeError}</div>
        {/if}
      </div>
      <footer class="pv-dialog-footer">
        <button class="pv-btn pv-btn--secondary" onclick={closeMerge}>Cancel</button>
        <button class="pv-btn pv-btn--danger" disabled={mergeBusy} onclick={commitMerge}>
          {mergeBusy ? "Merging…" : "Merge"}
        </button>
      </footer>
    </div>
  </div>
{/if}

<!-- Tidy avatars dialog -->
{#if tidyOpen}
  <div
    class="pv-backdrop"
    role="presentation"
    onclick={(e) => e.target === e.currentTarget && closeTidy()}
  >
    <div class="pv-dialog" role="dialog" aria-modal="true">
      <header class="pv-dialog-header">
        <span class="pv-dialog-title">Tidy avatars</span>
        <button class="pv-close-btn" aria-label="Cancel" onclick={closeTidy}>✕</button>
      </header>
      <div class="pv-dialog-body">
        {#if tidyBusy && orphans.length === 0}
          <p class="pv-note">Scanning…</p>
        {:else if orphans.length === 0}
          <p class="pv-note">No orphan avatar files found in <code>_people/</code>.</p>
        {:else}
          <p class="pv-note">
            Select files to delete. These are in <code>_people/</code> but not referenced by any declared
            person.
          </p>
          <ul class="pv-orphan-list">
            {#each orphans as o (o.path)}
              <li class="pv-orphan-row">
                <label class="pv-orphan-label">
                  <input
                    type="checkbox"
                    checked={tidySelected.has(o.path)}
                    onchange={() => toggleOrphan(o.path)}
                  />
                  <code class="pv-orphan-path">{o.path}</code>
                </label>
              </li>
            {/each}
          </ul>
        {/if}
        {#if tidyError}
          <div class="pv-error">{tidyError}</div>
        {/if}
      </div>
      <footer class="pv-dialog-footer">
        <button class="pv-btn pv-btn--secondary" onclick={closeTidy}>Close</button>
        {#if orphans.length > 0}
          <button
            class="pv-btn pv-btn--danger"
            disabled={tidyBusy || tidySelected.size === 0}
            onclick={commitTidy}
          >
            {tidyBusy ? "Deleting…" : `Delete ${tidySelected.size} file(s)`}
          </button>
        {/if}
      </footer>
    </div>
  </div>
{/if}

<style>
  .person-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow-y: auto;
    background: var(--tnd-bg);
  }

  /* ── Header ──────────────────────────────────────────────────────────────── */

  .person-header {
    display: flex;
    gap: 14px;
    padding: 20px 24px 16px;
    border-bottom: 1px solid var(--tnd-line);
    background: var(--tnd-panel);
    align-items: flex-start;
    max-width: 720px;
    width: 100%;
    box-sizing: border-box;
  }

  /* Avatar zone — circle by default */
  .avatar-zone {
    position: relative;
    width: 64px;
    height: 64px;
    flex-shrink: 0;
    border-radius: 50%;
    overflow: hidden;
    cursor: pointer;
    transition: opacity 0.12s;
  }

  /* Mono: square avatar */
  :global([data-tnd-theme="mono"]) .avatar-zone {
    border-radius: 0;
  }

  .avatar-zone--drag {
    outline: 2px dashed var(--tnd-accent);
    outline-offset: 2px;
    opacity: 0.8;
  }

  .avatar-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .avatar-initial {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 24px;
    font-weight: 700;
    font-family: var(--tnd-font-ui);
  }

  .avatar-hint {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    text-align: center;
    padding: 4px;
    opacity: 0;
    transition: opacity 0.12s;
    pointer-events: none;
  }

  .avatar-zone:hover .avatar-hint {
    opacity: 1;
  }

  /* Person info */
  .person-info {
    flex: 1;
    min-width: 0;
  }

  .person-name-row {
    display: flex;
    align-items: baseline;
    gap: 9px;
    flex-wrap: wrap;
  }

  .person-name {
    font-size: 16px;
    font-weight: var(--tnd-title-weight, 700);
    color: var(--tnd-text);
    margin: 0;
    line-height: 1.2;
    font-family: var(--tnd-font-ui);
  }

  .person-slug {
    font-size: 12px;
    color: var(--tnd-accent-text);
    font-family: var(--tnd-font-mono);
  }

  .person-badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: var(--tnd-tag-radius, 3px);
    font-size: 10px;
    font-weight: 600;
    text-transform: var(--tnd-label-transform, uppercase);
    letter-spacing: var(--tnd-label-spacing, 0.04em);
  }

  .person-badge--unmanaged {
    background: var(--tnd-chip-amber-bg);
    color: var(--tnd-chip-amber-fg);
  }

  .person-color-chip {
    display: inline-block;
    margin-top: 5px;
    padding: 1px 8px;
    border-radius: var(--tnd-tag-radius, 10px);
    font-size: 10.5px;
    font-weight: 600;
  }

  .person-description {
    margin: 6px 0 0;
    font-size: 12px;
    color: var(--tnd-text-muted);
    line-height: 1.5;
  }

  .person-actions {
    display: flex;
    gap: 8px;
    margin-top: 10px;
    flex-wrap: wrap;
  }

  .action-btn {
    background: transparent;
    border: 1px solid var(--tnd-line-strong);
    color: var(--tnd-text-muted);
    font-size: 11.5px;
    padding: 3px 10px;
    border-radius: var(--tnd-radius, 4px);
    cursor: pointer;
    font-family: var(--tnd-font-ui);
    transition: background 0.08s;
  }

  .action-btn:hover {
    background: var(--tnd-panel2);
  }

  .action-btn--primary {
    background: var(--tnd-accent-soft);
    color: var(--tnd-accent-text);
    border-color: var(--tnd-accent);
    font-weight: 600;
  }

  .action-btn--primary:hover {
    background: var(--tnd-accent);
    color: #fff;
  }

  /* Right-side stat block */
  .person-stat {
    text-align: right;
    flex-shrink: 0;
  }

  .person-stat-count {
    font-size: 18px;
    font-weight: 700;
    color: var(--tnd-text);
    font-family: var(--tnd-font-ui);
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }

  .person-stat-label {
    font-size: 10px;
    color: var(--tnd-text-faint);
    letter-spacing: 0.05em;
    text-transform: uppercase;
    margin-top: 2px;
    font-family: var(--tnd-font-ui);
  }

  /* ── Mentions section ────────────────────────────────────────────────────── */

  .mentions-section {
    flex: 1;
    padding: 0 24px 20px;
    overflow-y: auto;
    max-width: 720px;
    width: 100%;
    box-sizing: border-box;
  }

  .mentions-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 14px 0 8px;
    border-bottom: 1px solid var(--tnd-line);
    margin-bottom: 2px;
  }

  .mentions-title {
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: var(--tnd-label-spacing, 0.08em);
    text-transform: var(--tnd-label-transform, uppercase);
    color: var(--tnd-text-faint);
  }

  .mentions-count {
    font-size: 11px;
    color: var(--tnd-text-faint);
    font-variant-numeric: tabular-nums;
    background: var(--tnd-panel2);
    padding: 1px 5px;
    border-radius: var(--tnd-tag-radius, 3px);
  }

  .mentions-status {
    padding: 16px 0;
    font-size: 13px;
    color: var(--tnd-text-faint);
  }

  .mentions-status--error {
    color: var(--tnd-chip-red-fg);
  }

  .mentions-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .mention-row {
    border-bottom: 1px solid var(--tnd-line);
  }

  .mention-btn {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 0;
    background: transparent;
    border: none;
    cursor: pointer;
    font-family: var(--tnd-font-ui);
    text-align: left;
    color: inherit;
    transition: background 0.08s;
    border-radius: var(--tnd-radius, 4px);
  }

  .mention-btn:hover {
    background: var(--tnd-panel2);
    padding-inline: 6px;
  }

  .mention-title {
    flex: 1;
    font-size: 13px;
    color: var(--tnd-text);
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .mention-meta {
    display: flex;
    gap: 10px;
    flex-shrink: 0;
  }

  .mention-group {
    font-size: 11px;
    color: var(--tnd-text-faint);
    font-family: var(--tnd-font-mono);
  }

  .mention-date {
    font-size: 11px;
    color: var(--tnd-text-faint);
    font-variant-numeric: tabular-nums;
  }

  /* ── Rename / Merge / Tidy dialogs ────────────────────────────────────────── */

  .pv-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 500;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .pv-dialog {
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

  .pv-dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--tnd-line);
  }

  .pv-dialog-title {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--tnd-text);
    font-family: var(--tnd-font-ui);
  }

  .pv-dialog-title code {
    font-family: var(--tnd-font-mono);
    font-size: 12px;
    background: var(--tnd-panel2);
    padding: 1px 4px;
    border-radius: var(--tnd-tag-radius, 3px);
  }

  .pv-close-btn {
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--tnd-text-faint);
    font-size: 13px;
    padding: 2px 6px;
    border-radius: var(--tnd-radius, 3px);
    font-family: var(--tnd-font-ui);
  }

  .pv-close-btn:hover {
    background: var(--tnd-panel2);
  }

  .pv-dialog-body {
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .pv-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--tnd-text-muted);
    font-family: var(--tnd-font-ui);
    text-transform: var(--tnd-label-transform, none);
  }

  .pv-input {
    font-size: 13px;
    padding: 6px 8px;
    border: 1px solid var(--tnd-line-strong);
    border-radius: var(--tnd-radius, 4px);
    background: var(--tnd-bg);
    color: var(--tnd-text);
    font-family: var(--tnd-font-ui);
    outline: none;
  }

  .pv-input:focus {
    border-color: var(--tnd-accent);
  }

  .pv-note {
    font-size: 12px;
    color: var(--tnd-text-faint);
    margin: 0;
    line-height: 1.5;
    font-family: var(--tnd-font-ui);
  }

  .pv-note code {
    font-family: var(--tnd-font-mono);
    background: var(--tnd-panel2);
    padding: 1px 3px;
    border-radius: var(--tnd-tag-radius, 2px);
  }

  .pv-error {
    font-size: 12px;
    color: var(--tnd-chip-red-fg);
    background: var(--tnd-chip-red-bg);
    padding: 6px 8px;
    border-radius: var(--tnd-radius, 4px);
  }

  .pv-dialog-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 16px 14px;
    border-top: 1px solid var(--tnd-line);
  }

  .pv-btn {
    font-size: 13px;
    padding: 5px 14px;
    border-radius: var(--tnd-radius, 5px);
    cursor: pointer;
    font-family: var(--tnd-font-ui);
    font-weight: 600;
    border: 1px solid transparent;
    transition: background 0.08s;
  }

  .pv-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .pv-btn--secondary {
    background: transparent;
    border-color: var(--tnd-line-strong);
    color: var(--tnd-text-muted);
  }

  .pv-btn--secondary:hover:not(:disabled) {
    background: var(--tnd-panel2);
  }

  .pv-btn--primary {
    background: var(--tnd-accent);
    color: #fff;
    border-color: var(--tnd-accent);
  }

  .pv-btn--primary:hover:not(:disabled) {
    opacity: 0.9;
  }

  .pv-btn--danger {
    background: var(--tnd-chip-red-bg);
    color: var(--tnd-chip-red-fg);
    border-color: var(--tnd-chip-red-fg);
  }

  .pv-btn--danger:hover:not(:disabled) {
    background: var(--tnd-chip-red-fg);
    color: #fff;
  }

  /* Orphan list */
  .pv-orphan-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 200px;
    overflow-y: auto;
  }

  .pv-orphan-label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-family: var(--tnd-font-ui);
  }

  .pv-orphan-path {
    font-family: var(--tnd-font-mono);
    font-size: 12px;
    color: var(--tnd-text-muted);
  }
</style>
