<script lang="ts">
  // TagBrowser — main-zone view for browsing and managing the tag hierarchy
  // (spec 0004, issue #22).
  //
  // Design: per screens-dir.jsx TagsDesktop — section labels GLOBAL/SCOPED,
  // bar charts per-count on global tags, scoped tags with tree indent + "└"
  // markers, scope badges, count on right. Per-theme tag rendering follows the
  // same flag conventions as EntryList tag chips (#/bracket/caps/pill).
  //
  // New in this PR: edit tag metadata (color/description/icon), declare new tag
  // (global or scoped with group picker). Existing rename/merge/delete stay.

  import { ipc } from "../ipc/index.js";
  import { buildTagTree, flattenTagTree, isNonCanonical } from "./tag-utils.js";
  import type { TagNode } from "./tag-utils.js";
  import type { TagMeta, TagInput, GroupMeta, ChipColor } from "../ipc/types.js";

  interface Props {
    /** Called when a tag row is clicked (for future entry filtering). */
    onTagSelect?: (tagName: string) => void;
  }

  let { onTagSelect }: Props = $props();

  // ── Data loading ──────────────────────────────────────────────────────────────

  let tags = $state<TagMeta[]>([]);
  let groups = $state<GroupMeta[]>([]);
  let loading = $state(false);
  let loadError = $state<string | null>(null);

  async function loadTags(): Promise<void> {
    loading = true;
    loadError = null;
    const [tagRes, groupRes] = await Promise.all([ipc.tag_index(), ipc.list_groups()]);
    loading = false;
    if (tagRes.ok) tags = tagRes.value;
    else loadError = tagRes.error.message;
    if (groupRes.ok) groups = groupRes.value;
  }

  $effect(() => {
    loadTags();
    const unsub = ipc.on("index_changed", loadTags);
    return unsub;
  });

  // ── Tree ──────────────────────────────────────────────────────────────────────

  const tree = $derived(buildTagTree(tags));
  const flat = $derived(flattenTagTree(tree));

  // Partition into global (no scopePath) and scoped
  const globalNodes = $derived(flat.filter((n) => !n.meta?.scopePath && n.depth === 0));
  const scopedNodes = $derived(flat.filter((n) => n.meta?.scopePath || n.depth > 0));
  const maxCount = $derived(
    globalNodes.length > 0 ? Math.max(...globalNodes.map((n) => n.meta?.count ?? 0), 1) : 1,
  );

  // ── Collapsed state ───────────────────────────────────────────────────────────

  const collapsed = $state(new Map<string, boolean>());

  function isCollapsed(name: string): boolean {
    return collapsed.get(name) ?? false;
  }

  function toggleCollapsed(name: string): void {
    collapsed.set(name, !isCollapsed(name));
  }

  function isVisible(node: TagNode): boolean {
    const parts = node.name.split("/");
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join("/");
      if (isCollapsed(ancestor)) return false;
    }
    return true;
  }

  // ── Color palette ─────────────────────────────────────────────────────────────

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

  // ── Actions (rename / merge / delete) ────────────────────────────────────────

  let actionTarget = $state<string | null>(null);
  let actionMode = $state<"rename" | "merge" | "delete" | null>(null);
  let actionInput = $state("");
  let actionError = $state<string | null>(null);
  let actionBusy = $state(false);

  function openAction(mode: "rename" | "merge" | "delete", tagName: string): void {
    actionTarget = tagName;
    actionMode = mode;
    actionInput = mode === "rename" ? tagName : "";
    actionError = null;
    closeMetaDialog();
  }

  function closeAction(): void {
    actionTarget = null;
    actionMode = null;
    actionInput = "";
    actionError = null;
  }

  async function commitAction(): Promise<void> {
    if (!actionTarget || !actionMode) return;
    actionBusy = true;
    actionError = null;

    let result: { ok: boolean; error?: { message: string } };
    if (actionMode === "rename") {
      if (!actionInput.trim()) {
        actionError = "New name is required.";
        actionBusy = false;
        return;
      }
      result = await ipc.rename_tag(actionTarget, actionInput.trim());
    } else if (actionMode === "merge") {
      if (!actionInput.trim()) {
        actionError = "Target tag is required.";
        actionBusy = false;
        return;
      }
      result = await ipc.merge_tag(actionTarget, actionInput.trim());
    } else {
      result = await ipc.delete_tag(actionTarget);
    }

    actionBusy = false;
    if (result.ok) {
      closeAction();
      await loadTags();
    } else {
      actionError = (result as { ok: false; error: { message: string } }).error.message;
    }
  }

  // ── Edit metadata dialog ──────────────────────────────────────────────────────

  // Used for both editing an existing tag and declaring a new one.
  let metaDialogOpen = $state(false);
  let metaIsNew = $state(false); // true = declare-new, false = edit-existing
  let metaName = $state("");
  let metaColor = $state<ChipColor | "">("");
  let metaDescription = $state("");
  let metaIcon = $state("");
  let metaScopePath = $state(""); // "" = global
  let metaBusy = $state(false);
  let metaError = $state<string | null>(null);

  function openEditMeta(node: TagNode): void {
    metaIsNew = false;
    metaName = node.name;
    metaColor = (node.meta?.color ?? "") as ChipColor | "";
    metaDescription = node.meta?.description ?? "";
    metaIcon = node.meta?.icon ?? "";
    metaScopePath = node.meta?.scopePath ?? "";
    metaError = null;
    metaDialogOpen = true;
    closeAction();
  }

  function openDeclareMeta(): void {
    metaIsNew = true;
    metaName = "";
    metaColor = "";
    metaDescription = "";
    metaIcon = "";
    metaScopePath = "";
    metaError = null;
    metaDialogOpen = true;
    closeAction();
  }

  function closeMetaDialog(): void {
    metaDialogOpen = false;
    metaError = null;
  }

  function validateTagName(name: string): string | null {
    if (!name.trim()) return "Tag name is required.";
    if (!/^[a-zA-Z0-9_\-/]+$/.test(name)) return "Only letters, digits, -, _, / are allowed.";
    if (name.length > 128) return "Too long (max 128 characters).";
    return null;
  }

  const metaNameError = $derived(metaName ? validateTagName(metaName) : null);
  const metaCanSubmit = $derived(!metaBusy && validateTagName(metaName) === null);

  async function commitMeta(): Promise<void> {
    const nameErr = validateTagName(metaName);
    if (nameErr) {
      metaError = nameErr;
      return;
    }
    metaBusy = true;
    metaError = null;

    const input: TagInput = {
      name: metaName.trim(),
      color: metaColor || undefined,
      description: metaDescription.trim() || undefined,
      icon: metaIcon.trim() || undefined,
      scopePath: metaScopePath || undefined,
    };
    const result = await ipc.set_tag(input);
    metaBusy = false;
    if (result.ok) {
      closeMetaDialog();
      await loadTags();
    } else {
      metaError = result.error.message;
    }
  }
</script>

<div class="tag-browser">
  <!-- Screen head -->
  <header class="tb-head">
    <div class="tb-head-main">
      <h2 class="tb-title">Tags</h2>
      <span class="tb-subtitle">global + scoped</span>
    </div>
    <span class="tb-total">{tags.length} tags</span>
    <button
      class="tb-declare-btn"
      onclick={openDeclareMeta}
      title="Declare a new tag with metadata"
    >
      + Declare
    </button>
  </header>

  {#if loading}
    <div class="tb-status">Loading…</div>
  {:else if loadError}
    <div class="tb-status tb-status--error">{loadError}</div>
  {:else if flat.length === 0}
    <div class="tb-status">No tags yet.</div>
  {:else}
    <div class="tb-body">
      <div class="tb-content">
        <!-- ── GLOBAL section ─────────────────────────────────────────────── -->
        {#if globalNodes.length > 0}
          <div class="tb-section-label">Global</div>
          {#each globalNodes as node (node.name)}
            {@const nonCanon = isNonCanonical(node.name)}
            {@const count = node.meta?.count ?? 0}
            <div
              class="tb-global-row"
              class:tb-row--selected={actionTarget === node.name}
              role="button"
              tabindex="0"
              onclick={() => onTagSelect?.(node.name)}
              onkeydown={(e) => (e.key === "Enter" || e.key === " ") && onTagSelect?.(node.name)}
            >
              <!-- Tag name chip -->
              <span class="tb-tag-name">
                <span class="tb-tag-hash">#</span>{node.label}
                {#if nonCanon}
                  <span class="tb-badge tb-badge--noncanon">!</span>
                {/if}
                {#if node.synthesised}
                  <span class="tb-badge tb-badge--synth">virtual</span>
                {/if}
              </span>
              <!-- Count bar -->
              <span class="tb-bar-track">
                <span class="tb-bar-fill" style="width: {Math.round((count / maxCount) * 100)}%;"
                ></span>
              </span>
              <!-- Count -->
              <span class="tb-count-num">{count}</span>
              <!-- Actions (hover) -->
              <span class="tb-actions" role="group" aria-label="Actions for {node.name}">
                <button
                  class="tb-action-btn"
                  onclick={(e) => {
                    e.stopPropagation();
                    openEditMeta(node);
                  }}
                  title="Edit metadata"
                  aria-label="Edit metadata for {node.name}">edit</button
                >
                <button
                  class="tb-action-btn"
                  onclick={(e) => {
                    e.stopPropagation();
                    openAction("rename", node.name);
                  }}
                  title="Rename"
                  aria-label="Rename {node.name}">rn</button
                >
                <button
                  class="tb-action-btn"
                  onclick={(e) => {
                    e.stopPropagation();
                    openAction("merge", node.name);
                  }}
                  title="Merge"
                  aria-label="Merge {node.name}">→</button
                >
                <button
                  class="tb-action-btn tb-action-btn--delete"
                  onclick={(e) => {
                    e.stopPropagation();
                    openAction("delete", node.name);
                  }}
                  title="Delete"
                  aria-label="Delete {node.name}">✕</button
                >
              </span>
            </div>
          {/each}
        {/if}

        <!-- ── SCOPED section ─────────────────────────────────────────────── -->
        {#if scopedNodes.length > 0}
          <div class="tb-section-label tb-section-label--scoped">Scoped</div>
          {#each scopedNodes as node (node.name)}
            {#if isVisible(node)}
              {@const hasChildren = node.children.length > 0}
              {@const open = hasChildren && !isCollapsed(node.name)}
              {@const nonCanon = isNonCanonical(node.name)}
              {@const isChild = node.depth > 0}
              <div
                class="tb-scoped-row"
                class:tb-scoped-row--child={isChild}
                class:tb-row--selected={actionTarget === node.name}
                role="treeitem"
                aria-selected={actionTarget === node.name}
                aria-expanded={hasChildren ? open : undefined}
                style="--depth: {node.depth};"
                tabindex="0"
                onclick={() => onTagSelect?.(node.name)}
                onkeydown={(e) => (e.key === "Enter" || e.key === " ") && onTagSelect?.(node.name)}
              >
                <!-- Tree indent + connector -->
                {#if isChild}
                  <span class="tb-tree-connector" aria-hidden="true">└</span>
                {/if}

                <!-- Collapse chevron for parents -->
                {#if hasChildren}
                  <button
                    class="tb-chevron"
                    onclick={(e) => {
                      e.stopPropagation();
                      toggleCollapsed(node.name);
                    }}
                    aria-label={open ? "Collapse" : "Expand"}
                    tabindex="-1">{open ? "▾" : "▸"}</button
                  >
                {/if}

                <!-- Tag name -->
                <button
                  class="tb-scoped-label-btn"
                  onclick={(e) => {
                    e.stopPropagation();
                    onTagSelect?.(node.name);
                  }}
                  title={node.meta?.description ?? node.name}
                  tabindex="-1"
                >
                  <span class="tb-tag-hash">#</span>{node.label}
                  {#if node.synthesised}
                    <span class="tb-badge tb-badge--synth">virtual</span>
                  {/if}
                  {#if nonCanon}
                    <span class="tb-badge tb-badge--noncanon">!</span>
                  {/if}
                </button>

                <!-- Scope badge -->
                {#if node.meta?.scopePath}
                  <span class="tb-scope-badge" title="Scoped to: {node.meta.scopePath}">
                    {node.meta.scopePath.split("/").at(-1)}
                  </span>
                {/if}

                <div class="tb-spacer"></div>

                <!-- Count -->
                {#if (node.meta?.count ?? 0) > 0}
                  <span class="tb-count-num">{node.meta!.count}</span>
                {/if}

                <!-- Actions (hover) -->
                <span class="tb-actions" role="group" aria-label="Actions for {node.name}">
                  <button
                    class="tb-action-btn"
                    onclick={(e) => {
                      e.stopPropagation();
                      openEditMeta(node);
                    }}
                    title="Edit metadata"
                    aria-label="Edit metadata for {node.name}">edit</button
                  >
                  <button
                    class="tb-action-btn"
                    onclick={(e) => {
                      e.stopPropagation();
                      openAction("rename", node.name);
                    }}
                    title="Rename"
                    aria-label="Rename {node.name}">rn</button
                  >
                  <button
                    class="tb-action-btn"
                    onclick={(e) => {
                      e.stopPropagation();
                      openAction("merge", node.name);
                    }}
                    title="Merge"
                    aria-label="Merge {node.name}">→</button
                  >
                  <button
                    class="tb-action-btn tb-action-btn--delete"
                    onclick={(e) => {
                      e.stopPropagation();
                      openAction("delete", node.name);
                    }}
                    title="Delete"
                    aria-label="Delete {node.name}">✕</button
                  >
                </span>
              </div>
            {/if}
          {/each}
        {/if}
      </div>
    </div>
  {/if}
</div>

<!-- Metadata edit / declare dialog -->
{#if metaDialogOpen}
  <div
    class="action-backdrop"
    role="presentation"
    onclick={(e) => e.target === e.currentTarget && closeMetaDialog()}
  >
    <div class="action-dialog meta-dialog" role="dialog" aria-modal="true">
      <header class="action-dialog-header">
        <span class="action-dialog-title">
          {#if metaIsNew}Declare tag{:else}Edit <code>{metaName}</code>{/if}
        </span>
        <button class="dialog-close-btn" aria-label="Cancel" onclick={closeMetaDialog}>✕</button>
      </header>

      <div class="action-dialog-body">
        <!-- Name (editable for new; read-only for existing) -->
        <div class="meta-field">
          <label class="al" for="meta-name"
            >Name {#if metaIsNew}<span class="required">*</span>{/if}</label
          >
          {#if metaIsNew}
            <input
              id="meta-name"
              class="action-input"
              class:action-input--error={!!metaNameError}
              type="text"
              bind:value={metaName}
              placeholder="e.g. followup or project/atlas"
              autocomplete="off"
              spellcheck={false}
            />
            {#if metaNameError}
              <span class="field-error">{metaNameError}</span>
            {/if}
          {:else}
            <span class="meta-name-display"><span class="tb-tag-hash">#</span>{metaName}</span>
          {/if}
        </div>

        <!-- Color -->
        <div class="meta-field">
          <label class="al" for="meta-color">Color</label>
          <select id="meta-color" class="action-input action-select" bind:value={metaColor}>
            <option value="">None</option>
            {#each COLOR_OPTIONS as opt (opt.value)}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
        </div>

        <!-- Description -->
        <div class="meta-field">
          <label class="al" for="meta-desc">Description</label>
          <input
            id="meta-desc"
            class="action-input"
            type="text"
            bind:value={metaDescription}
            placeholder="Short note about this tag"
          />
        </div>

        <!-- Icon -->
        <div class="meta-field">
          <label class="al" for="meta-icon">Icon</label>
          <input
            id="meta-icon"
            class="action-input"
            type="text"
            bind:value={metaIcon}
            placeholder="emoji or icon name"
          />
        </div>

        <!-- Scope (only for new; for existing, show read-only) -->
        {#if metaIsNew}
          <div class="meta-field">
            <label class="al" for="meta-scope">Scope (optional)</label>
            <select id="meta-scope" class="action-input action-select" bind:value={metaScopePath}>
              <option value="">Global (visible everywhere)</option>
              {#each groups as g (g.path)}
                <option value={g.path}>{g.path}</option>
              {/each}
            </select>
            {#if metaScopePath}
              <span class="field-hint"
                >Visible only within <code>{metaScopePath}</code> and descendants.</span
              >
            {/if}
          </div>
        {:else if metaScopePath}
          <div class="meta-field">
            <span class="al">Scope</span>
            <span class="tb-scope-badge" style="font-size: 12px;">{metaScopePath}</span>
          </div>
        {/if}

        {#if metaError}
          <div class="action-error">{metaError}</div>
        {/if}
      </div>

      <footer class="action-dialog-footer">
        <button class="btn btn--secondary" onclick={closeMetaDialog}>Cancel</button>
        <button class="btn btn--primary" disabled={!metaCanSubmit} onclick={commitMeta}>
          {#if metaBusy}Saving…{:else if metaIsNew}Declare{:else}Save{/if}
        </button>
      </footer>
    </div>
  </div>
{/if}

<!-- Action dialog -->
{#if actionMode && actionTarget}
  <div
    class="action-backdrop"
    role="presentation"
    onclick={(e) => e.target === e.currentTarget && closeAction()}
  >
    <div class="action-dialog" role="dialog" aria-modal="true">
      <header class="action-dialog-header">
        <span class="action-dialog-title">
          {#if actionMode === "rename"}Rename <code>{actionTarget}</code>{/if}
          {#if actionMode === "merge"}Merge <code>{actionTarget}</code> into…{/if}
          {#if actionMode === "delete"}Delete <code>{actionTarget}</code>?{/if}
        </span>
        <button class="dialog-close-btn" aria-label="Cancel" onclick={closeAction}>✕</button>
      </header>

      <div class="action-dialog-body">
        {#if actionMode === "rename"}
          <label class="al" for="action-input">New name</label>
          <input
            id="action-input"
            class="action-input"
            type="text"
            bind:value={actionInput}
            placeholder="new-tag-name"
            autocomplete="off"
            spellcheck={false}
          />
        {:else if actionMode === "merge"}
          <label class="al" for="action-input">Target tag</label>
          <input
            id="action-input"
            class="action-input"
            type="text"
            bind:value={actionInput}
            placeholder="existing-tag-name"
            autocomplete="off"
            spellcheck={false}
          />
          <p class="action-note">
            All entries tagged <code>{actionTarget}</code> will be retagged as the target.
          </p>
        {:else if actionMode === "delete"}
          <p class="action-note">
            The tag metadata will be removed. Entries that carry <code>{actionTarget}</code> will keep
            the string; it will reappear as "unmanaged" in the browser.
          </p>
        {/if}

        {#if actionError}
          <div class="action-error">{actionError}</div>
        {/if}
      </div>

      <footer class="action-dialog-footer">
        <button class="btn btn--secondary" onclick={closeAction}>Cancel</button>
        <button
          class="btn"
          class:btn--danger={actionMode === "delete"}
          class:btn--primary={actionMode !== "delete"}
          disabled={actionBusy}
          onclick={commitAction}
        >
          {#if actionBusy}Working…{:else if actionMode === "rename"}Rename{:else if actionMode === "merge"}Merge{:else}Delete{/if}
        </button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .tag-browser {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--tnd-bg);
    overflow: hidden;
  }

  /* ── Screen head ──────────────────────────────────────────────────────────── */

  .tb-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 20px 24px 14px;
    border-bottom: 1px solid var(--tnd-line);
    background: var(--tnd-panel);
    flex-shrink: 0;
  }

  .tb-head-main {
    flex: 1;
    min-width: 0;
  }

  .tb-title {
    font-size: 17px;
    font-weight: var(--tnd-title-weight, 700);
    color: var(--tnd-text);
    margin: 0;
    font-family: var(--tnd-font-ui);
    line-height: 1.2;
  }

  .tb-subtitle {
    font-size: 11px;
    color: var(--tnd-text-faint);
    font-family: var(--tnd-font-mono);
    display: block;
    margin-top: 1px;
  }

  .tb-total {
    font-size: 11px;
    color: var(--tnd-text-faint);
    font-variant-numeric: tabular-nums;
    font-family: var(--tnd-font-ui);
    flex-shrink: 0;
  }

  /* ── Status ───────────────────────────────────────────────────────────────── */

  .tb-status {
    padding: 24px;
    font-size: 13px;
    color: var(--tnd-text-faint);
    font-family: var(--tnd-font-ui);
  }

  .tb-status--error {
    color: var(--tnd-chip-red-fg);
  }

  /* ── Body scroll ──────────────────────────────────────────────────────────── */

  .tb-body {
    flex: 1;
    overflow-y: auto;
    padding: 18px 0;
  }

  .tb-content {
    max-width: 700px;
    margin: 0 auto;
    padding: 0 24px;
  }

  /* ── Section label ────────────────────────────────────────────────────────── */

  .tb-section-label {
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: var(--tnd-label-spacing, 0.06em);
    text-transform: var(--tnd-label-transform, uppercase);
    color: var(--tnd-text-faint);
    margin-bottom: 10px;
    font-family: var(--tnd-font-ui);
    user-select: none;
  }

  .tb-section-label--scoped {
    margin-top: 24px;
  }

  /* ── Global rows (tag + bar + count) ─────────────────────────────────────── */

  .tb-global-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 7px 0;
    cursor: pointer;
    position: relative;
  }

  .tb-global-row:hover .tb-actions {
    opacity: 1;
  }

  .tb-global-row:focus-visible {
    outline: 2px solid var(--tnd-accent);
    outline-offset: 2px;
    border-radius: var(--tnd-radius, 3px);
  }

  /* Tag name column (fixed width) */
  .tb-tag-name {
    width: 150px;
    flex-shrink: 0;
    font-family: var(--tnd-font-ui);
    font-size: 13px;
    font-weight: 700;
    color: var(--tnd-accent-text);
    display: inline-flex;
    align-items: center;
    gap: 3px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Count bar */
  .tb-bar-track {
    flex: 1;
    height: 7px;
    background: var(--tnd-panel2);
    position: relative;
    display: block;
    border-radius: var(--tnd-radius, 0px);
    overflow: hidden;
  }

  .tb-bar-fill {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    background: var(--tnd-accent);
    transition: width 0.3s ease;
  }

  /* ── Scoped rows ──────────────────────────────────────────────────────────── */

  .tb-scoped-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 0;
    border-bottom: 1px solid var(--tnd-line);
    cursor: pointer;
    position: relative;
  }

  .tb-scoped-row--child {
    padding-left: calc(var(--depth, 1) * 20px);
  }

  .tb-scoped-row:hover .tb-actions {
    opacity: 1;
  }

  .tb-scoped-row:focus-visible {
    outline: 2px solid var(--tnd-accent);
    outline-offset: 2px;
  }

  /* Tree connector "└" */
  .tb-tree-connector {
    color: var(--tnd-text-faint);
    font-size: 12px;
    flex-shrink: 0;
    line-height: 1;
    user-select: none;
  }

  /* Chevron for parents */
  .tb-chevron {
    width: 14px;
    flex-shrink: 0;
    font-size: 10px;
    color: var(--tnd-text-faint);
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
    line-height: 1;
    user-select: none;
  }

  /* Scoped label button */
  .tb-scoped-label-btn {
    flex: 0 0 auto;
    background: transparent;
    border: none;
    cursor: pointer;
    font-family: var(--tnd-font-ui);
    font-size: 13px;
    font-weight: 700;
    color: var(--tnd-chip-amber-fg, var(--tnd-accent-text));
    text-align: left;
    padding: 0;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    white-space: nowrap;
  }

  .tb-scoped-label-btn:hover {
    color: var(--tnd-accent-text);
  }

  /* Scope badge */
  .tb-scope-badge {
    font-size: 10px;
    color: var(--tnd-text-faint);
    font-family: var(--tnd-font-mono);
    flex-shrink: 0;
    white-space: nowrap;
  }

  .tb-spacer {
    flex: 1;
  }

  /* ── Shared: tag hash prefix ──────────────────────────────────────────────── */

  /* Default (Paper/Editorial hash) — the hash is part of the label */
  .tb-tag-hash {
    opacity: 1;
  }

  /* Mono → bracket style: mono font on the hash too */
  :global([data-tnd-theme="mono"]) .tb-tag-name,
  :global([data-tnd-theme="mono"]) .tb-scoped-label-btn {
    font-family: var(--tnd-font-mono);
  }

  /* Editorial → caps: uppercase, mono, hairline underline, no hash */
  :global([data-tnd-theme="editorial"]) .tb-tag-name,
  :global([data-tnd-theme="editorial"]) .tb-scoped-label-btn {
    font-family: var(--tnd-font-mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    border-bottom: 1px solid var(--tnd-line-strong);
    padding-bottom: 1px;
    color: var(--tnd-text);
    gap: 0;
  }

  :global([data-tnd-theme="editorial"]) .tb-tag-hash {
    display: none;
  }

  /* Fog + Soft → pill: padded chip */
  :global([data-tnd-theme="fog"]) .tb-tag-name,
  :global([data-tnd-theme="soft"]) .tb-tag-name {
    background: var(--tnd-panel2);
    color: var(--tnd-text-muted);
    border: 1px solid var(--tnd-line);
    border-radius: var(--tnd-tag-radius);
    padding: 1px 8px;
    width: auto;
  }

  :global([data-tnd-theme="fog"]) .tb-scoped-label-btn,
  :global([data-tnd-theme="soft"]) .tb-scoped-label-btn {
    background: var(--tnd-accent-soft);
    color: var(--tnd-accent-text);
    border: none;
    border-radius: var(--tnd-tag-radius);
    padding: 1px 8px;
  }

  :global([data-tnd-theme="fog"]) .tb-tag-hash,
  :global([data-tnd-theme="soft"]) .tb-tag-hash {
    opacity: 0.5;
  }

  /* ── Badges ───────────────────────────────────────────────────────────────── */

  .tb-badge {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 1px 4px;
    border-radius: var(--tnd-tag-radius, 3px);
    text-transform: uppercase;
    flex-shrink: 0;
  }

  .tb-badge--synth {
    background: var(--tnd-panel2);
    color: var(--tnd-text-faint);
  }

  .tb-badge--noncanon {
    background: var(--tnd-chip-amber-bg);
    color: var(--tnd-chip-amber-fg);
  }

  /* ── Count ────────────────────────────────────────────────────────────────── */

  .tb-count-num {
    font-size: 12px;
    color: var(--tnd-text-muted);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
    width: 32px;
    text-align: right;
    font-family: var(--tnd-font-ui);
  }

  /* ── Actions ──────────────────────────────────────────────────────────────── */

  .tb-actions {
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity 0.1s;
    flex-shrink: 0;
  }

  .tb-action-btn {
    background: transparent;
    border: none;
    cursor: pointer;
    font-size: 10px;
    padding: 2px 5px;
    border-radius: var(--tnd-radius, 3px);
    color: var(--tnd-text-faint);
    font-family: var(--tnd-font-ui);
    line-height: 1;
    transition: background 0.07s;
  }

  .tb-action-btn:hover {
    background: var(--tnd-panel2);
    color: var(--tnd-text-muted);
  }

  .tb-action-btn--delete:hover {
    background: var(--tnd-chip-red-bg);
    color: var(--tnd-chip-red-fg);
  }

  /* Row hover shows actions */
  .tb-global-row:hover .tb-actions,
  .tb-scoped-row:hover .tb-actions {
    opacity: 1;
  }

  .tb-row--selected {
    background: var(--tnd-accent-soft);
  }

  /* ── Action dialog ────────────────────────────────────────────────────────── */

  .action-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 500;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .action-dialog {
    background: var(--tnd-panel);
    border: 1px solid var(--tnd-line-strong);
    border-radius: var(--tnd-radius, 8px);
    box-shadow: var(--tnd-shadow);
    width: 360px;
    max-width: calc(100vw - 32px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .action-dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--tnd-line);
  }

  .action-dialog-title {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--tnd-text);
    font-family: var(--tnd-font-ui);
  }

  .action-dialog-title code {
    font-family: var(--tnd-font-mono);
    font-size: 12px;
    background: var(--tnd-panel2);
    padding: 1px 4px;
    border-radius: var(--tnd-tag-radius, 3px);
  }

  .dialog-close-btn {
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--tnd-text-faint);
    font-size: 13px;
    padding: 2px 6px;
    border-radius: var(--tnd-radius, 3px);
    font-family: var(--tnd-font-ui);
  }

  .dialog-close-btn:hover {
    background: var(--tnd-panel2);
  }

  .action-dialog-body {
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .al {
    font-size: 11px;
    font-weight: 600;
    color: var(--tnd-text-muted);
    user-select: none;
    font-family: var(--tnd-font-ui);
    text-transform: var(--tnd-label-transform, none);
    letter-spacing: var(--tnd-label-spacing, 0);
  }

  .action-input {
    font-size: 13px;
    padding: 6px 8px;
    border: 1px solid var(--tnd-line-strong);
    border-radius: var(--tnd-radius, 4px);
    background: var(--tnd-bg);
    color: var(--tnd-text);
    font-family: var(--tnd-font-ui);
    outline: none;
  }

  .action-input:focus {
    border-color: var(--tnd-accent);
  }

  .action-note {
    font-size: 12px;
    color: var(--tnd-text-faint);
    margin: 0;
    line-height: 1.5;
    font-family: var(--tnd-font-ui);
  }

  .action-note code {
    font-family: var(--tnd-font-mono);
    background: var(--tnd-panel2);
    padding: 1px 3px;
    border-radius: var(--tnd-tag-radius, 2px);
  }

  .action-error {
    font-size: 12px;
    color: var(--tnd-chip-red-fg);
    background: var(--tnd-chip-red-bg);
    padding: 6px 8px;
    border-radius: var(--tnd-radius, 4px);
  }

  .action-dialog-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 16px 14px;
    border-top: 1px solid var(--tnd-line);
  }

  .btn {
    font-size: 13px;
    padding: 5px 14px;
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

  .btn--danger {
    background: var(--tnd-chip-red-bg);
    color: var(--tnd-chip-red-fg);
    border-color: var(--tnd-chip-red-fg);
  }

  .btn--danger:hover:not(:disabled) {
    background: var(--tnd-chip-red-fg);
    color: #fff;
  }

  /* ── Declare button in header ────────────────────────────────────────────── */

  .tb-declare-btn {
    font-size: 11.5px;
    padding: 4px 10px;
    border: 1px solid var(--tnd-line-strong);
    border-radius: var(--tnd-radius, 4px);
    background: transparent;
    color: var(--tnd-text-muted);
    cursor: pointer;
    font-family: var(--tnd-font-ui);
    font-weight: 600;
    flex-shrink: 0;
    transition: background 0.08s;
  }

  .tb-declare-btn:hover {
    background: var(--tnd-accent-soft);
    color: var(--tnd-accent-text);
    border-color: var(--tnd-accent);
  }

  /* ── Meta dialog extras ───────────────────────────────────────────────────── */

  .meta-dialog {
    width: 400px;
  }

  .meta-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .action-input--error {
    border-color: var(--tnd-chip-red-fg);
  }

  .action-select {
    appearance: auto;
  }

  .meta-name-display {
    font-family: var(--tnd-font-ui);
    font-size: 13px;
    font-weight: 700;
    color: var(--tnd-accent-text);
    padding: 4px 0;
  }

  .field-error {
    font-size: 11px;
    color: var(--tnd-chip-red-fg);
  }

  .field-hint {
    font-size: 11px;
    color: var(--tnd-text-faint);
  }

  .field-hint code {
    font-family: var(--tnd-font-mono);
    background: var(--tnd-panel2);
    padding: 1px 3px;
    border-radius: var(--tnd-tag-radius, 2px);
  }

  .required {
    color: var(--tnd-chip-red-fg);
  }
</style>
