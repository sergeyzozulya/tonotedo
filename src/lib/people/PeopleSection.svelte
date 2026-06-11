<script lang="ts">
  // PeopleSection — sidebar section listing declared and unmanaged people
  // (spec 0005, issue #22).
  //
  // Shows:
  //   • Declared people with count badge and avatar/initial indicator.
  //   • "Unmanaged" sub-group for undeclared but referenced slugs.
  //   • Selecting a person row calls onPersonSelect(slug).
  //   • Section header row for the Tags browser calls onTagsOpen().
  //
  // Design: per screens-dir.jsx — avatar rows with name/slug/role line,
  // mention count on the right. Avatar shape = square for Mono, circle otherwise.

  import { partitionPeople } from "./people-utils.js";
  import type { PersonMeta } from "../ipc/types.js";

  interface Props {
    /** Full list from people_index(). */
    people: PersonMeta[];
    /** Currently selected person slug (or null). */
    selectedSlug: string | null;
    /** Called when the user clicks a person row. */
    onPersonSelect: (slug: string) => void;
  }

  let { people, selectedSlug, onPersonSelect }: Props = $props();

  const partition = $derived(partitionPeople(people));

  // ── Avatar display helpers ────────────────────────────────────────────────────

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
</script>

<!-- Declared people -->
<div class="section-label">People</div>

{#if partition.declared.length === 0 && partition.unmanaged.length === 0}
  <div class="sidebar-row sidebar-row--placeholder" aria-disabled="true">
    <span class="row-label row-label--faint">No people yet</span>
  </div>
{/if}

{#each partition.declared as person (person.slug)}
  {@const selected = person.slug === selectedSlug}
  <div
    class="sidebar-row"
    class:sidebar-row--selected={selected}
    role="button"
    tabindex="0"
    onclick={() => onPersonSelect(person.slug)}
    onkeydown={(e) => (e.key === "Enter" || e.key === " ") && onPersonSelect(person.slug)}
    title={person.description ?? person.displayName}
  >
    {#if selected}
      <span class="accent-bar" aria-hidden="true"></span>
    {/if}
    <!-- Avatar: square in Mono, circle otherwise -->
    <span
      class="person-avatar"
      style="background: {chipBg(person)}; color: {chipFg(person)};"
      aria-hidden="true"
    >
      {initial(person)}
    </span>
    <span class="row-label">{person.displayName}</span>
    {#if person.count > 0}
      <span class="row-count">{person.count}</span>
    {/if}
  </div>
{/each}

<!-- Unmanaged sub-group -->
{#if partition.unmanaged.length > 0}
  <div class="section-sublabel">Unmanaged</div>
  {#each partition.unmanaged as person (person.slug)}
    {@const selected = person.slug === selectedSlug}
    <div
      class="sidebar-row sidebar-row--unmanaged"
      class:sidebar-row--selected={selected}
      role="button"
      tabindex="0"
      onclick={() => onPersonSelect(person.slug)}
      onkeydown={(e) => (e.key === "Enter" || e.key === " ") && onPersonSelect(person.slug)}
    >
      {#if selected}
        <span class="accent-bar" aria-hidden="true"></span>
      {/if}
      <span class="person-avatar person-avatar--unmanaged" aria-hidden="true">
        {initial(person)}
      </span>
      <span class="row-label row-label--faint">{person.slug}</span>
      {#if person.count > 0}
        <span class="row-count">{person.count}</span>
      {/if}
    </div>
  {/each}
{/if}

<style>
  .section-label {
    padding: 14px 13px 5px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: var(--tnd-label-spacing, 0.08em);
    text-transform: var(--tnd-label-transform, uppercase);
    color: var(--tnd-text-faint);
    user-select: none;
  }

  .section-sublabel {
    padding: 8px 13px 3px 22px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: var(--tnd-label-spacing, 0.07em);
    text-transform: var(--tnd-label-transform, uppercase);
    color: var(--tnd-text-faint);
    opacity: 0.7;
    user-select: none;
  }

  /* Row */
  .sidebar-row {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 30px;
    padding: 0 13px;
    cursor: pointer;
    position: relative;
    color: var(--tnd-text-muted);
    font-size: 13px;
    font-weight: 500;
    transition: background 0.08s;
    user-select: none;
    outline: none;
  }

  .sidebar-row:hover {
    background: var(--tnd-panel2);
  }

  .sidebar-row:focus-visible {
    outline: 2px solid var(--tnd-accent);
    outline-offset: -2px;
  }

  .sidebar-row--selected {
    background: var(--tnd-accent-soft);
    color: var(--tnd-accent-text);
    font-weight: 700;
  }

  .sidebar-row--placeholder {
    cursor: default;
  }

  .sidebar-row--placeholder:hover,
  .sidebar-row--unmanaged:hover {
    background: var(--tnd-panel2);
  }

  /* Active bar */
  .accent-bar {
    position: absolute;
    left: 0;
    top: 5px;
    bottom: 5px;
    width: 3px;
    border-radius: 0 2px 2px 0;
    background: var(--tnd-accent);
  }

  .row-label {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row-label--faint {
    color: var(--tnd-text-faint);
    font-size: 12px;
  }

  .row-count {
    font-size: 11px;
    color: var(--tnd-text-faint);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  /* Avatar — circle by default, square for Mono via :global override */
  .person-avatar {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    font-weight: 700;
    flex-shrink: 0;
    user-select: none;
  }

  /* Mono: square avatars (avatarShape = 'square') */
  :global([data-tnd-theme="mono"]) .person-avatar {
    border-radius: 0;
  }

  .person-avatar--unmanaged {
    background: var(--tnd-panel2) !important;
    color: var(--tnd-text-faint) !important;
    border: 1px dashed var(--tnd-line-strong);
  }
</style>
