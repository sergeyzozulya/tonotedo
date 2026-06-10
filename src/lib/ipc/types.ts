// IPC surface types for the Rust ↔ TypeScript boundary (design-0004).
//
// First-wave commands: read_entry, write_entry, search, tag_index,
// people_index, entries_in_group, backlinks.
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
