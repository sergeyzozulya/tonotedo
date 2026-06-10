// IPC surface types for the Rust ↔ TypeScript boundary (design-0004).
//
// First-wave commands: read_entry, write_entry, search, tag_index,
// people_index, entries_in_group, backlinks.
// Saved-search commands: saved_searches_get, saved_searches_set (spec 0009).
// Events: index_changed, file_conflict.
//
// Paged queries carry a cursor and return a bounded page. Typed Result errors
// (never string-typed across the boundary).

// ── Shared primitives ─────────────────────────────────────────────────────────

/** Opaque cursor for paged queries. A string token the caller echoes back. */
export type Cursor = string;

/** A page of results with an optional cursor for the next page. */
export interface Page<T> {
  items: T[];
  /** Present when there is a next page; absent when this is the last page. */
  nextCursor?: Cursor;
}

// ── Typed errors (design-0004 §Failure modes) ─────────────────────────────────

export type IpcErrorCode =
  | "not_found"
  | "conflict"
  | "io_error"
  | "parse_error"
  | "not_implemented"
  | "invalid_argument"
  | "version_skew";

export interface IpcError {
  code: IpcErrorCode;
  message: string;
  detail?: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: IpcError };

// ── Entry types ───────────────────────────────────────────────────────────────

/** A group path like "work/atlas" or "journal". */
export type GroupPath = string;

/** An entry identifier (vault-relative path without extension). */
export type EntryId = string;

/** Full entry content as read from disk. */
export interface EntryContent {
  id: EntryId;
  path: string;
  text: string;
  /** The self-write token recorded by the reconciler (design-0001). */
  selfToken: string;
}

/** Lightweight summary used in lists — no body text. */
export interface EntrySummary {
  id: EntryId;
  path: string;
  title: string;
  group: GroupPath;
  tags: string[];
  people: string[];
  modifiedAt: string; // ISO-8601
}

// ── Tag types ─────────────────────────────────────────────────────────────────

export type ChipColor = "slate" | "red" | "amber" | "green" | "teal" | "blue" | "violet" | "pink";

export interface TagMeta {
  name: string;
  color: ChipColor;
  count: number;
  /** Optional human-readable description (from _tags.md metadata). */
  description?: string;
  /** Optional icon (emoji or name) from _tags.md metadata. */
  icon?: string;
}

// ── People types ──────────────────────────────────────────────────────────────

export interface PersonMeta {
  slug: string;
  displayName: string;
  count: number;
  /** Chip color token (same palette as ChipColor) or a raw hex value. */
  color?: ChipColor | string;
  /** Vault-relative asset path to an avatar image, e.g. "_assets/anna.jpg". */
  avatarPath?: string;
  /** Whether this person has an explicit declaration in _people.md. */
  declared?: boolean;
  /** Optional description from _people.md metadata. */
  description?: string;
}

/** Fields for creating or updating a person declaration in _people.md. */
export interface PersonInput {
  slug: string;
  displayName?: string;
  description?: string;
  color?: ChipColor | string;
  avatarPath?: string;
}

// ── Search ────────────────────────────────────────────────────────────────────

export type SortOrder = "relevance" | "modified_desc" | "modified_asc" | "title_asc";

export interface SearchFilters {
  tags?: string[];
  people?: string[];
  group?: GroupPath;
}

export interface SearchQuery {
  text: string;
  filters?: SearchFilters;
  sort?: SortOrder;
  cursor?: Cursor;
}

// ── Backlinks ─────────────────────────────────────────────────────────────────

export interface Backlink {
  sourceId: EntryId;
  sourceTitle: string;
  /** The wikilink text as it appeared in the source entry. */
  linkText: string;
}

// ── Asset types (issue #13 — attachment/image blocks) ────────────────────────

/**
 * A vault-relative asset path, e.g. "work/atlas/_assets/report.pdf".
 * Always starts from the vault root (same form as EntryId).
 */
export type AssetPath = string;

// ── Group types ───────────────────────────────────────────────────────────────

/**
 * Lightweight group descriptor returned by list_groups().
 * `path` is the vault-relative folder path (e.g. "work/atlas").
 * `name` is the display name (from _group.md or the folder name).
 * `count` is the number of direct + descendant entries (non-archived).
 * `order` mirrors the `order` frontmatter field from _group.md (0003).
 */
export interface GroupMeta {
  path: GroupPath;
  name: string;
  count: number;
  /** Explicit ordering hint from _group.md (0003). Absent if not set. */
  order?: number;
  /** Optional color hint from _group.md. */
  color?: string;
}

// ── Saved searches (spec 0009) ────────────────────────────────────────────────

/**
 * A single structured filter chip value.
 * The `kind` discriminator future-proofs the schema — new chip types can be
 * added without migrating existing `_searches.md` files (spec 0009).
 */
export type SavedSearchFilter = { kind: "tag"; values: string[] } | { kind: "group"; path: string };

/** A persisted search combining free-text and chip state (spec 0009). */
export interface SavedSearch {
  /** Display name shown in the sidebar. */
  name: string;
  /** Free-text query (empty string = no text filter). */
  text: string;
  /** Chip state — may be empty. */
  filters: SavedSearchFilter[];
}

// ── Calendar types (issue #21) ────────────────────────────────────────────────

/** A single calendar item returned by calendar_window. */
export interface CalendarWindowItem {
  entryId: string;
  title: string;
  /** The primary-date property value as a string (YYYY-MM-DD / datetime / range). */
  dateValue: string;
  group: string;
  groupColor?: string;
  tags: string[];
  /** ISO date YYYY-MM-DD for recurring occurrences; absent for non-recurring. */
  occurrenceKey?: string;
  isOccurrence: boolean;
}

export interface CalendarWindowResult {
  items: CalendarWindowItem[];
}

// ── Command surface (design-0004 §Command surface) ────────────────────────────

export interface IpcCommands {
  /** Read the full text of a single entry. */
  read_entry(id: EntryId): Promise<Result<EntryContent>>;

  /**
   * Write the full text of an entry. Pass the selfToken received from the last
   * read_entry to let the reconciler filter the resulting index_changed echo.
   */
  write_entry(id: EntryId, text: string, selfToken: string): Promise<Result<{ selfToken: string }>>;

  /** Full-text + filter search (capped at 500 results per spec 0009). */
  search(query: SearchQuery): Promise<Result<Page<EntrySummary>>>;

  /** All tags in the library with metadata. */
  tag_index(): Promise<Result<TagMeta[]>>;

  /** All people in the library with metadata. */
  people_index(): Promise<Result<PersonMeta[]>>;

  /** Entries belonging to a group, paged. */
  entries_in_group(group: GroupPath, cursor?: Cursor): Promise<Result<Page<EntrySummary>>>;

  /** Entries that link to the given entry. */
  backlinks(id: EntryId): Promise<Result<Backlink[]>>;

  /** Returns the Rust core version string. The only command implemented today. */
  core_version(): Promise<Result<string>>;

  // ── Asset commands (issue #13) ─────────────────────────────────────────────

  /**
   * Copy `bytes` into the entry's `_assets/` folder under the given `name`
   * (collision-safe rename is handled by the implementation). Returns the
   * vault-relative AssetPath of the stored file.
   *
   * In the browser/mock implementation this keeps the bytes in memory so the
   * /dev demo works fully without Tauri.
   */
  attach_file(entryPath: string, name: string, bytes: Uint8Array): Promise<Result<AssetPath>>;

  /**
   * Returns a URL that can be used in an <img src="…"> to render the asset.
   * Real: a Tauri asset protocol URL (asset:// or convertFileSrc).
   * Mock: an object URL or data URL constructed from in-memory bytes.
   */
  asset_url(assetPath: AssetPath): Promise<Result<string>>;

  /**
   * Returns true when the asset file exists on disk / in mock memory.
   * Used by the attachment block to detect broken state.
   */
  asset_exists(assetPath: AssetPath): Promise<Result<boolean>>;

  /**
   * Remove the asset file from disk / mock memory.
   * Called by the editor when the user confirms deleting an attachment.
   * refs #30 for Rust implementation.
   */
  remove_asset(assetPath: AssetPath): Promise<Result<void>>;

  /**
   * Returns a flat map of all entry id → display title for wikilink resolution.
   * Used by the chips layer; callers should refresh on index_changed events.
   */
  entry_titles(): Promise<Result<Record<EntryId, string>>>;

  /**
   * Returns all groups in the library as a flat list.
   * The sidebar builds the tree by splitting paths on "/".
   * Sorted per spec 0003: explicit `order` first (ascending), then alphabetical
   * within the same parent — but the mock returns a flat unsorted list;
   * the UI performs the sort/tree-building itself.
   */
  list_groups(): Promise<Result<GroupMeta[]>>;

  // ── Saved searches (spec 0009) ─────────────────────────────────────────────

  /**
   * Read all saved searches from `_searches.md` at the library root.
   * Returns an empty array when the file does not exist.
   */
  saved_searches_get(): Promise<Result<SavedSearch[]>>;

  /**
   * Overwrite the saved-searches list in `_searches.md`.
   * The implementation serialises the exact YAML shape from spec 0009.
   */
  saved_searches_set(searches: SavedSearch[]): Promise<Result<void>>;
  // ── People mutation commands (issue #22) ──────────────────────────────────────

  /**
   * Add or update a person declaration in _people.md.
   * If the slug already exists, its metadata is overwritten.
   * refs #22 — Rust side is a stub returning not_implemented.
   */
  set_person(person: PersonInput): Promise<Result<void>>;

  /**
   * Remove a person declaration from _people.md.
   * Existing @slug references in entries are NOT rewritten — they become
   * "unmanaged" until the user cleans them up.
   * refs #22 — Rust side is a stub returning not_implemented.
   */
  delete_person(slug: string): Promise<Result<void>>;

  /**
   * All entries that mention a person (union of frontmatter + body surfaces),
   * sorted most-recent-first (spec 0005 §People view).
   */
  mentions_for(slug: string): Promise<Result<EntrySummary[]>>;

  // ── Tag mutation commands (issue #22) ─────────────────────────────────────────

  /**
   * Rename a tag: rewrite every entry that references oldName to newName.
   * Confirmed batch operation. refs #22 — Rust stub returns not_implemented.
   */
  rename_tag(oldName: string, newName: string): Promise<Result<void>>;

  /**
   * Merge tag sourceTag into targetTag: rewrite all occurrences of sourceTag
   * to targetTag, then remove sourceTag's metadata.
   * refs #22 — Rust stub returns not_implemented.
   */
  merge_tag(sourceTag: string, targetTag: string): Promise<Result<void>>;

  /**
   * Delete a tag from metadata (_tags.md). Entries that carry the tag string
   * are NOT rewritten — the tag becomes "unmanaged" until cleaned up.
   * refs #22 — Rust stub returns not_implemented.
   */
  delete_tag(name: string): Promise<Result<void>>;
  // ── Calendar facade (issue #21) ────────────────────────────────────────────

  /**
   * Return all calendar items (entries with a primary date property) whose
   * placement overlaps [from, to] inclusive.  RRULE expansion is performed:
   *   - Mock: minimal TS expansion (daily/weekly FREQ, COUNT, UNTIL, BYDAY).
   *   - Real: stub returning not_implemented — full fidelity via Rust
   *     core::recurrence in issue #23.
   *
   * `from` and `to` are ISO date strings "YYYY-MM-DD".
   * `group` is an optional group filter (exact prefix match).
   */
  calendar_window(from: string, to: string, group?: string): Promise<Result<CalendarWindowResult>>;
}

// ── Event surface (core → UI, design-0004 §Event surface) ─────────────────────

export type IndexChangedKind = "created" | "modified" | "deleted" | "renamed";

export interface IndexChangedEvent {
  paths: string[];
  kinds: IndexChangedKind[];
}

export interface FileConflictEvent {
  path: string;
}

export interface IpcEvents {
  index_changed: IndexChangedEvent;
  file_conflict: FileConflictEvent;
}

export type IpcEventName = keyof IpcEvents;
export type IpcEventPayload<E extends IpcEventName> = IpcEvents[E];

export type IpcUnsubscribe = () => void;

export interface IpcEventBus {
  on<E extends IpcEventName>(
    event: E,
    handler: (payload: IpcEventPayload<E>) => void,
  ): IpcUnsubscribe;
}

// ── Full IPC facade ───────────────────────────────────────────────────────────

export interface Ipc extends IpcCommands, IpcEventBus {}
