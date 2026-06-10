<script lang="ts">
  // PersonView — main-zone view for a single person (spec 0005, issue #22).
  //
  // Layout:
  //   • Metadata header: avatar/initial, full name, description, color chip,
  //     drag/paste zone for avatar upload.
  //   • Chronological mentions list (most-recent-first) linking back to entries.
  //   • "Tidy" stub button for avatar rename (emits onTidy callback).
  //   • "Declare" button for unmanaged people (opens create-person dialog).
  //
  // Avatar drag/paste:
  //   Drops/pastes an image → calls ipc.attach_file on the "_people/" path,
  //   then calls ipc.set_person with the new avatarPath (facade mock implementation).
  //   The "tidy" command = stub that emits onTidy(slug) for follow-up (#22).

  import { ipc } from "../ipc/index.js";
  import type { PersonMeta, EntrySummary } from "../ipc/types.js";
  import CreatePersonDialog from "./CreatePersonDialog.svelte";

  interface Props {
    /** The person being viewed. */
    person: PersonMeta;
    /** Called when the user clicks a mention entry row. */
    onEntrySelect?: (id: string) => void;
    /** Called when the avatar "tidy" rename stub is triggered. */
    onTidy?: (slug: string) => void;
    /** Called when a new person is created via the declare button. */
    onPersonCreated?: (slug: string) => void;
  }

  let { person, onEntrySelect, onTidy, onPersonCreated }: Props = $props();

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

    // Use the attach_file command targeting the "_people/" directory.
    const attachResult = await ipc.attach_file("_people.md", assetName, bytes);
    if (!attachResult.ok) {
      console.error("[PersonView] attach_file failed:", attachResult.error.message);
      return;
    }

    // Write the avatar path back via set_person.
    const setResult = await ipc.set_person({
      slug: person.slug,
      displayName: person.displayName,
      description: person.description,
      color: person.color as string | undefined,
      avatarPath: attachResult.value,
    });
    if (setResult.ok) {
      // Refresh avatar URL.
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

  // ── Tidy stub ─────────────────────────────────────────────────────────────────

  function triggerTidy(): void {
    console.log(`[PersonView] tidy avatar for @${person.slug} — stub (refs #22)`);
    onTidy?.(person.slug);
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
    <!-- Avatar / drag zone -->
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
      <h2 class="person-name">{person.displayName}</h2>
      <span class="person-slug">@{person.slug}</span>
      {#if !person.declared}
        <span class="person-badge person-badge--unmanaged">Unmanaged</span>
      {/if}
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
        {#if person.avatarPath}
          <button class="action-btn" onclick={triggerTidy} title="Rename avatar file to match slug">
            Tidy avatar
          </button>
        {/if}
        {#if !person.declared}
          <button class="action-btn action-btn--primary" onclick={() => (showDeclareDialog = true)}>
            Declare person
          </button>
        {/if}
      </div>
    </div>
  </header>

  <!-- Mentions list -->
  <section class="mentions-section">
    <div class="mentions-header">
      <span class="mentions-title">Mentions</span>
      <span class="mentions-count">{person.count}</span>
    </div>

    {#if mentionsLoading}
      <div class="mentions-loading">Loading…</div>
    {:else if mentionsError}
      <div class="mentions-error">{mentionsError}</div>
    {:else if mentions.length === 0}
      <div class="mentions-empty">No entries mention @{person.slug} yet.</div>
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

<!-- Declare / create person dialog -->
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

<style>
  .person-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow-y: auto;
    background: var(--tnd-bg);
    padding: 0;
  }

  /* ── Header ──────────────────────────────────────────────────────────────── */

  .person-header {
    display: flex;
    gap: 20px;
    padding: 24px 28px 20px;
    border-bottom: 1px solid var(--tnd-line);
    background: var(--tnd-panel);
    align-items: flex-start;
  }

  /* Avatar zone */
  .avatar-zone {
    position: relative;
    width: 72px;
    height: 72px;
    flex-shrink: 0;
    border-radius: 50%;
    overflow: hidden;
    cursor: pointer;
    transition: opacity 0.12s;
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
    font-size: 26px;
    font-weight: 700;
    border-radius: 50%;
  }

  .avatar-hint {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9.5px;
    text-align: center;
    padding: 4px;
    border-radius: 50%;
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

  .person-name {
    font-size: 22px;
    font-weight: 700;
    color: var(--tnd-text);
    margin: 0 0 2px;
    line-height: 1.2;
  }

  .person-slug {
    font-size: 12px;
    color: var(--tnd-text-faint);
    font-family: ui-monospace, monospace;
  }

  .person-badge {
    display: inline-block;
    margin-left: 8px;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 10.5px;
    font-weight: 600;
  }

  .person-badge--unmanaged {
    background: var(--tnd-chip-amber-bg);
    color: var(--tnd-chip-amber-fg);
  }

  .person-color-chip {
    display: inline-block;
    margin-left: 8px;
    padding: 1px 8px;
    border-radius: 10px;
    font-size: 10.5px;
    font-weight: 600;
  }

  .person-description {
    margin: 8px 0 0;
    font-size: 13px;
    color: var(--tnd-text-muted);
    line-height: 1.5;
  }

  .person-actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
    flex-wrap: wrap;
  }

  .action-btn {
    background: transparent;
    border: 1px solid var(--tnd-line-strong);
    color: var(--tnd-text-muted);
    font-size: 12px;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
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

  /* ── Mentions section ────────────────────────────────────────────────────── */

  .mentions-section {
    flex: 1;
    padding: 0 28px 20px;
    overflow-y: auto;
  }

  .mentions-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 16px 0 8px;
    border-bottom: 1px solid var(--tnd-line);
    margin-bottom: 4px;
  }

  .mentions-title {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--tnd-text-faint);
  }

  .mentions-count {
    font-size: 11px;
    color: var(--tnd-text-faint);
    font-variant-numeric: tabular-nums;
    background: var(--tnd-panel2);
    padding: 1px 5px;
    border-radius: 3px;
  }

  .mentions-loading,
  .mentions-empty,
  .mentions-error {
    padding: 16px 0;
    font-size: 13px;
    color: var(--tnd-text-faint);
  }

  .mentions-error {
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
    font-family: inherit;
    text-align: left;
    color: inherit;
    transition: background 0.08s;
    border-radius: 4px;
  }

  .mention-btn:hover {
    background: var(--tnd-panel2);
    padding-inline: 6px;
  }

  .mention-title {
    flex: 1;
    font-size: 13.5px;
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
    font-family: ui-monospace, monospace;
  }

  .mention-date {
    font-size: 11px;
    color: var(--tnd-text-faint);
    font-variant-numeric: tabular-nums;
  }
</style>
