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
  /**
   * When non-null, this tag is scoped to the given group path (and its
   * descendants). Null = global tag visible everywhere.
   */
  scopePath?: string | null;
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

// ── Trash types (spec 0002 §Lifecycle, spec 0003 §Operations) ────────────────

export type TrashItemKind = "entry" | "group";

/** Metadata for a single item in the trash bin. */
export interface TrashManifest {
  trashId: string;
  originalRelPath: string;
  trashedAt: string; // ISO-8601 UTC
  kind: TrashItemKind;
}

/** Result of a trash_entry or trash_group operation. */
export interface TrashOpResult {
  trashId: string;
}

/** Result of a trash_restore operation. */
export interface RestoreResult {
  /** The final path (relative to library root) where the item was restored. */
  path: string;
  /** True when a -restored-N suffix was added due to a collision. */
  hadCollision: boolean;
}

// ── Plugins (issue #25, spec 0010, design-0002) ───────────────────────────────

/** Lifecycle status surfaced to the plugin manager (#26). */
export type PluginStatus = "active" | "permissions-pending" | "failed" | "suspended";

/** Typed setting field kinds (0010 §"Settings"). */
export type PluginSettingType = "string" | "boolean" | "number" | "enum" | "secret";

/** A single declared settings field. */
export interface PluginSettingField {
  key: string;
  type: PluginSettingType;
  label: string;
  description?: string;
  default?: string;
  /** Allowed values for `enum` fields. */
  options?: string[];
}

/** A palette command a plugin registered (namespaced id). */
export interface PluginCommand {
  id: string;
  title: string;
}

/** A view a plugin registered (namespaced name). */
export interface PluginView {
  name: string;
}

/** A plugin descriptor for the manager UI (`plugins_list`). */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  status: PluginStatus;
  /** provider / processor (a plugin can be both). */
  shape: string[];
  /** Declared capabilities (closed v1 set). */
  capabilities: string[];
  /** All permission entries the manifest requests. */
  permissions: string[];
  /** The subset of `permissions` currently granted by the user. */
  granted: string[];
  settings: PluginSettingField[];
  /** Namespaced command ids registered (empty unless active). */
  commands: PluginCommand[];
  /** Namespaced view names registered (empty unless active). */
  views: PluginView[];
  /** Failure strikes this session (0 unless something failed). */
  strikes: number;
  /** Activation-failure detail, when `status === "failed"`. */
  failure?: string;
  /** The plugin's README (manifest body). Empty string when the manifest has no body. */
  readme: string;
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

  // ── Group mutation commands (phase 6 / issue #28) ─────────────────────────

  /**
   * Create a new group folder at `path` (library-relative, single level).
   * Returns conflict if the folder already exists; not_found if the parent
   * doesn't exist; invalid_argument if any component is a reserved name.
   */
  create_group(path: GroupPath): Promise<Result<void>>;

  /**
   * Rename the last component of `oldPath` to `newName` (single component).
   * Returns conflict on sibling collision; invalid_argument on reserved name.
   */
  rename_group(oldPath: GroupPath, newName: string): Promise<Result<void>>;

  /**
   * Move the group at `srcPath` under `dstParent` (library-relative, or ""
   * for root). Rejects circular moves and sibling collisions.
   */
  move_group(srcPath: GroupPath, dstParent: GroupPath): Promise<Result<void>>;

  /**
   * Move the entry at `path` (library-relative .md path) into `dstGroup`.
   * Entry id is unchanged; the reconciler handles index update via rename-detection.
   */
  move_entry(path: string, dstGroup: GroupPath): Promise<Result<void>>;

  // ── Trash commands (phase 6 / issue #28) ──────────────────────────────────

  /**
   * Move a single entry (.md file) to the library trash.
   * Returns the trash slot id.
   */
  trash_entry(path: string): Promise<Result<TrashOpResult>>;

  /**
   * Move an entire group folder (and all descendants) to the library trash.
   * Returns the trash slot id.
   */
  trash_group(path: GroupPath): Promise<Result<TrashOpResult>>;

  /** List all trashed items, newest first. */
  trash_list(): Promise<Result<TrashManifest[]>>;

  /**
   * Restore a trashed item to its original location.
   * If the original path is occupied, a -restored-N suffix is added.
   */
  trash_restore(id: string): Promise<Result<RestoreResult>>;

  /** Permanently delete a single trash slot. Idempotent on missing id. */
  trash_purge(id: string): Promise<Result<void>>;

  /**
   * Return the effective property schema for a group (merged ancestor chain,
   * child overrides parent). Returns null when no group in the chain has a
   * schema defined. The JSON shape is `{ [propName]: { type: string, default?: unknown } }`.
   */
  effective_schema(groupPath: GroupPath): Promise<Result<string | null>>;

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

  // ── Plugins (issue #25; serve the #26 manager UI) ──────────────────────────

  /**
   * The plugin inventory for the open library: id, name, version, status,
   * declared capabilities/permissions, the granted subset, registrations, and
   * per-plugin warnings. Empty when no library is open.
   */
  plugins_list(): Promise<Result<PluginInfo[]>>;

  /**
   * Re-discover plugin manifests and reconcile grants for the open library, then
   * return the refreshed inventory. Used by the manager's reload affordance; picks
   * up newly-dropped plugin folders and version changes without a restart.
   */
  plugins_reload(): Promise<Result<PluginInfo[]>>;

  /**
   * Grant or revoke a single permission for a plugin. Granting the last missing
   * permission activates the plugin; revoking a live one knocks it back to
   * permissions-pending (its capabilities stop immediately).
   */
  plugins_set_grant(plugin: string, perm: string, granted: boolean): Promise<Result<void>>;

  /**
   * Invoke a registered command on an active plugin. `argsJson` is a JSON string
   * passed to the plugin's handler; the result is the handler's JSON return value
   * as a string. Errors (deadline, exception, suspended, …) come back as IpcError.
   */
  plugins_invoke_command(
    plugin: string,
    commandId: string,
    argsJson: string,
  ): Promise<Result<string>>;

  // ── Settings (spec 0011) ────────────────────────────────────────────────────

  /**
   * Read user settings from the platform config dir (`settings.json`).
   * Returns `{}` when the file does not exist (all defaults apply).
   * Unknown keys round-trip (spec 0011 §Edge cases).
   */
  settings_get_user(): Promise<Result<Record<string, unknown>>>;

  /**
   * Merge `patch` into the user settings file.
   * Only top-level keys in `patch` are written; unknown keys are preserved.
   */
  settings_set_user(patch: Record<string, unknown>): Promise<Result<void>>;

  /**
   * Read library settings from `_settings.md` frontmatter.
   * Returns `{}` when the file does not exist (all defaults apply).
   */
  settings_get_library(): Promise<Result<Record<string, unknown>>>;

  /**
   * Merge `patch` into `_settings.md`, preserving unknown keys and body text.
   * Creates the file when the first non-default setting is written.
   */
  settings_set_library(patch: Record<string, unknown>): Promise<Result<void>>;

  /**
   * Read per-plugin settings for the given `pluginId` from device-local storage
   * (same location as grants — never inside the synced library).
   * Returns `{}` when no settings have been saved yet.
   */
  plugin_settings_get(pluginId: string): Promise<Result<Record<string, string>>>;

  /**
   * Write per-plugin settings for `pluginId` atomically to device-local storage.
   * The full values map replaces any previous values for this plugin.
   */
  plugin_settings_set(pluginId: string, values: Record<string, string>): Promise<Result<void>>;
}

// ── Event surface (core → UI, design-0004 §Event surface) ─────────────────────

export type IndexChangedKind = "created" | "modified" | "deleted" | "renamed";

export interface IndexChangedEvent {
  paths: string[];
  kinds: IndexChangedKind[];
  /**
   * When the change was originated by the app's own write_entry call, this
   * carries the selfToken that write_entry returned.  The UI uses it to
   * suppress false conflict banners for self-writes (design-0001 §self-write
   * token).  Absent for external changes (e.g. vim saves).
   */
  selfToken?: string;
  /**
   * True when ALL changes in this batch originated from the app's own writes
   * (reconciler consumed the self-write token). The desktop backend sets this;
   * it does not echo individual tokens (design-0001).
   */
  selfOriginated?: boolean;
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
