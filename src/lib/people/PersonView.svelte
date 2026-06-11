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
  // Design: per screens-dir.jsx PeopleDesktop — large avatar (72px, square in
  // Mono/circle otherwise), name+slug row, role/description, mentions list with
  // entry title + date. Token-mapped colours.

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
</style>
