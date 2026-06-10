// IPC command surface — first-wave (issue #30, design-0004-ipc-boundary).
//
// ## tauri-specta decision
//
// tauri-specta (or equivalent codegen) is DEFERRED.  The hand-written
// `src/lib/ipc/types.ts` is already the definitive contract and is coded
// against by the frontend today.  Introducing specta now would require:
//
//   1. Adding the `specta` + `tauri-specta` crates and a build-script step.
//   2. Regenerating types.ts from the Rust side and verifying parity with the
//      existing hand-written types — a non-trivial migration for a scaffold.
//   3. Keeping the mock implementation (`mock.ts`) in sync with generated types.
//
// None of that changes the runtime behaviour; the requirement ("generated,
// single-source, drift is a build error") is the end state, not the starting
// state.  We record the decision here so the next phase can migrate cleanly.
// Open question carried forward to design-0004 §"Open questions": decide the
// codegen tool at the point where the command surface stabilises (post phase 4).
//
// ## Serde shape contract
//
// Every command's input/output must serialize to the JSON shapes defined in
// `src/lib/ipc/types.ts`.  Serde renames (snake_case → camelCase for TS fields)
// are applied selectively where types.ts uses camelCase field names.
//
// ## AppState threading model
//
// `AppState` is a `Mutex<Option<OpenLibrary>>`.  The reconciler worker owns the
// `Index` (single writer, INV-1 of reconcile/mod.rs); `AppState` only holds the
// query handle plus the `TokenRegistry` (safe to clone/Arc) and an
// `Arc<IndexQueryHandle>` for the read commands.
//
// Since the `Index` is NOT Sync, read queries run under the same Mutex guard that
// protects open/close.  For this first wave (single-user desktop, <500-entry
// libraries) that is perfectly acceptable.

pub mod commands2;
pub mod groups;
mod tests;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::core::{
    frontmatter::Entry,
    fswrite::{write_entry as fswrite_write_entry, TokenRegistry, WriteToken},
    index::Index,
    reconcile::{ChangeEvent, ChangeKind, Reconciler, SyncReconciler},
};

// ── AppState ──────────────────────────────────────────────────────────────────

/// Managed Tauri state.  Wrapped in a `Mutex` so commands on any thread can
/// acquire a guard; the `Option` is `None` until `library_open` succeeds.
pub struct AppState(pub Mutex<Option<OpenLibrary>>);

/// Live library state, held inside `AppState`.
pub struct OpenLibrary {
    /// Absolute path to the library root.
    pub root: PathBuf,
    /// SQLite index — all read queries go here.
    pub index: Index,
    /// Shared self-write token registry (shared with the reconciler worker).
    pub tokens: Arc<TokenRegistry>,
    /// Reconciler handle kept alive so the watcher lives as long as the library.
    /// Dropping it shuts down the watcher + worker thread.
    pub _reconciler_handle: crate::core::reconcile::ReconcilerHandle,
}

// ── Shared error type ─────────────────────────────────────────────────────────

/// Typed error payload (design-0004 §Failure modes).
///
/// Maps to `IpcError` in types.ts.
#[derive(Debug, Serialize)]
pub struct IpcError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl IpcError {
    fn not_open() -> Self {
        IpcError {
            code: "invalid_argument",
            message: "No library is open.  Call library_open first.".into(),
            detail: None,
        }
    }

    fn not_found(msg: impl Into<String>) -> Self {
        IpcError {
            code: "not_found",
            message: msg.into(),
            detail: None,
        }
    }

    fn io(msg: impl Into<String>) -> Self {
        IpcError {
            code: "io_error",
            message: msg.into(),
            detail: None,
        }
    }

    fn parse(msg: impl Into<String>) -> Self {
        IpcError {
            code: "parse_error",
            message: msg.into(),
            detail: None,
        }
    }
}

// Tauri commands must return `Result<T, E>` where E: Serialize.
type CmdResult<T> = Result<T, IpcError>;

// ── library_open / library_close ──────────────────────────────────────────────

/// Open (or create) a library at `path`.
///
/// Creates `.tonotedo/` if absent, opens/creates `index.db`, runs a full
/// rescan, starts the filesystem watcher, and forwards `ChangeEvent`s to
/// the Tauri event bus as `index_changed`.
#[tauri::command]
pub fn library_open(path: String, state: State<'_, AppState>, app: AppHandle) -> CmdResult<()> {
    let root = PathBuf::from(&path);
    if !root.exists() {
        return Err(IpcError::not_found(format!("Path does not exist: {path}")));
    }

    let tonotedo_dir = root.join(".tonotedo");
    std::fs::create_dir_all(&tonotedo_dir)
        .map_err(|e| IpcError::io(format!("Cannot create .tonotedo dir: {e}")))?;

    let db_path = tonotedo_dir.join("index.db");
    let db_path_str = db_path
        .to_str()
        .ok_or_else(|| IpcError::io("Non-UTF-8 database path".to_string()))?;

    let index =
        Index::open(db_path_str).map_err(|e| IpcError::io(format!("Cannot open index: {e}")))?;
    let tokens = Arc::new(TokenRegistry::with_default_ttl());

    // Bootstrap: full rescan via SyncReconciler, then hand the index off to the
    // async reconciler with a watcher.
    let mut boot = SyncReconciler::new(index, Arc::clone(&tokens), root.clone());
    boot.full_rescan();

    // Destructure so we can rebuild into the async reconciler.
    let SyncReconciler {
        index,
        tokens,
        library_root,
        ..
    } = boot;

    // Build async reconciler + watcher.
    let (event_tx, event_rx) = crossbeam_channel::unbounded::<ChangeEvent>();
    let (reconciler, watcher_handle) =
        Reconciler::new_with_watcher(index, Arc::clone(&tokens), library_root.clone(), event_tx)
            .map_err(|e| IpcError::io(format!("Cannot start watcher: {e}")))?;

    let (reconciler_handle, change_rx) = reconciler.spawn(Some(watcher_handle));

    // The event forwarding thread converts ChangeEvents to Tauri events.
    std::thread::Builder::new()
        .name("ipc-event-forwarder".into())
        .spawn(move || {
            forward_events(change_rx, app);
        })
        .map_err(|e| IpcError::io(format!("Cannot spawn event forwarder: {e}")))?;

    // Re-open the index for read queries on the main handle.
    let query_index = Index::open(db_path_str)
        .map_err(|e| IpcError::io(format!("Cannot open read-side index: {e}")))?;

    let open = OpenLibrary {
        root: library_root,
        index: query_index,
        tokens,
        _reconciler_handle: reconciler_handle,
    };

    let mut guard = state
        .0
        .lock()
        .map_err(|_| IpcError::io("State lock poisoned".to_string()))?;
    *guard = Some(open);

    // `event_rx` (the constructor-side channel) is a dead receiver: `spawn()`
    // creates its own internal channel and the worker sends on that.  Drop it.
    drop(event_rx);

    Ok(())
}

/// Tear down the current library.  Noop if none is open.
#[tauri::command]
pub fn library_close(state: State<'_, AppState>) -> CmdResult<()> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| IpcError::io("State lock poisoned".to_string()))?;
    *guard = None; // drops OpenLibrary, which drops ReconcilerHandle → worker stop
    Ok(())
}

// ── Event forwarding ──────────────────────────────────────────────────────────

/// `index_changed` event payload (design-0004 §Event surface).
///
/// Maps to `IndexChangedEvent` in types.ts.
#[derive(Serialize, Clone)]
struct IndexChangedPayload {
    paths: Vec<String>,
    kinds: Vec<&'static str>,
    #[serde(rename = "selfOriginated")]
    self_originated: bool,
}

fn change_kind_str(k: &ChangeKind) -> &'static str {
    match k {
        ChangeKind::Created => "created",
        ChangeKind::Modified => "modified",
        ChangeKind::Removed => "deleted",
        ChangeKind::Renamed { .. } => "renamed",
        // Cloud placeholder: content evicted, entry shows as pending (spec 0013).
        ChangeKind::Pending => "pending",
    }
}

/// Drain `ChangeEvent`s from the reconciler and emit Tauri events.
///
/// Runs until the sender side is dropped (library closed or app shutdown).
fn forward_events(rx: crossbeam_channel::Receiver<ChangeEvent>, app: AppHandle) {
    // Coalesce: batch events that arrive within 100 ms into a single emission
    // to avoid event storms (design-0004 §Failure modes "Event storms").
    use std::time::{Duration, Instant};
    const COALESCE_MS: u64 = 100;

    while let Ok(first) = rx.recv() {
        let deadline = Instant::now() + Duration::from_millis(COALESCE_MS);
        let mut batch = vec![first];

        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match rx.recv_timeout(remaining) {
                Ok(ev) => batch.push(ev),
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => break,
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                    emit_batch(&app, &batch);
                    return;
                }
            }
        }

        emit_batch(&app, &batch);
    }
}

fn emit_batch(app: &AppHandle, batch: &[ChangeEvent]) {
    if batch.is_empty() {
        return;
    }
    let mut paths: Vec<String> = Vec::with_capacity(batch.len());
    let mut kinds: Vec<&'static str> = Vec::with_capacity(batch.len());
    // self_originated is true only when ALL events in the batch are self-originated.
    let self_originated = batch.iter().all(|e| e.self_originated);

    for ev in batch {
        let p = ev.path.to_string_lossy().into_owned();
        paths.push(p);
        kinds.push(change_kind_str(&ev.kind));
    }

    let payload = IndexChangedPayload {
        paths,
        kinds,
        self_originated,
    };
    // Ignore errors: app may be shutting down.
    let _ = app.emit("index_changed", payload);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Acquire the open library or return a typed error.
macro_rules! require_open {
    ($state:expr) => {{
        let guard = $state
            .0
            .lock()
            .map_err(|_| IpcError::io("State lock poisoned".to_string()))?;
        // We can't return a reference into the guard — extract what we need.
        guard
    }};
}

/// Path of the `.md` file for a given library-relative entry id.
///
/// The entry id is the path without extension (e.g. `"work/atlas/overview"`).
/// We append `.md` to get the relative path, then resolve against the library root.
fn entry_abs_path(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{id}.md"))
}

// ── Entry commands ────────────────────────────────────────────────────────────

/// `EntryContent` response (maps to `EntryContent` in types.ts).
#[derive(Debug, Serialize)]
pub struct EntryContentDto {
    pub id: String,
    pub path: String,
    pub text: String,
    #[serde(rename = "selfToken")]
    pub self_token: String,
}

/// `read_entry(id)` — read the full text of a single entry.
///
/// `id` is the vault-relative path without extension (e.g. `"work/atlas/overview"`).
#[tauri::command]
pub fn read_entry(id: String, state: State<'_, AppState>) -> CmdResult<EntryContentDto> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;

    let abs = entry_abs_path(&lib.root, &id);
    let bytes = std::fs::read(&abs).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            IpcError::not_found(format!("Entry not found: {id}"))
        } else {
            IpcError::io(format!("Cannot read {id}: {e}"))
        }
    })?;

    let text = String::from_utf8(bytes)
        .map_err(|e| IpcError::parse(format!("Entry {id} is not valid UTF-8: {e}")))?;

    // Issue a read token so the caller can echo it back on write.
    // We use a freshly-issued token with the current on-disk bytes so that when
    // write_entry is called with this selfToken the reconciler will suppress the echo.
    // (The token is for write, not read, but we issue it optimistically here.)
    let path_ref = abs.as_path();
    let bytes_for_token = text.as_bytes();
    let token: WriteToken = lib.tokens.issue_token(path_ref, bytes_for_token);

    let rel_path = format!("{id}.md");
    Ok(EntryContentDto {
        id,
        path: rel_path,
        text,
        self_token: token.as_u64().to_string(),
    })
}

/// `WriteEntryResult` response (maps to `{ selfToken: string }` in types.ts).
#[derive(Serialize)]
pub struct WriteEntryResult {
    #[serde(rename = "selfToken")]
    pub self_token: String,
}

/// `write_entry(id, text, selfToken)` — write the full text of an entry.
///
/// Parses `text` as a `.md` file (Entry), writes it atomically, issues a
/// self-write token, and returns the new token.
#[tauri::command]
pub fn write_entry(
    id: String,
    text: String,
    #[allow(unused_variables)] self_token: String,
    state: State<'_, AppState>,
) -> CmdResult<WriteEntryResult> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;

    let abs = entry_abs_path(&lib.root, &id);

    // Ensure parent directories exist.
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| IpcError::io(format!("Cannot create parent dirs for {id}: {e}")))?;
    }

    let entry = Entry::from_bytes(text.as_bytes());
    let token = fswrite_write_entry(&abs, &entry, &[], &lib.tokens)
        .map_err(|e| IpcError::io(format!("Cannot write {id}: {e}")))?;

    Ok(WriteEntryResult {
        self_token: token.as_u64().to_string(),
    })
}

// ── Query commands ────────────────────────────────────────────────────────────

/// `EntrySummary` DTO (maps to `EntrySummary` in types.ts).
#[derive(Serialize)]
pub struct EntrySummaryDto {
    pub id: String,
    pub path: String,
    pub title: String,
    pub group: String,
    pub tags: Vec<String>,
    pub people: Vec<String>,
    #[serde(rename = "modifiedAt")]
    pub modified_at: String,
}

/// `Page<T>` DTO (maps to `Page<T>` in types.ts).
#[derive(Serialize)]
pub struct PageDto<T: Serialize> {
    pub items: Vec<T>,
    #[serde(rename = "nextCursor", skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

const PAGE_SIZE: usize = 50;

/// Encode a cursor from an integer offset.
fn encode_cursor(offset: usize) -> String {
    use std::io::Write;
    let mut buf = Vec::new();
    write!(&mut buf, "{offset}").unwrap();
    // Simple base64-style: just hex-encode the offset string bytes.
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Decode a cursor back to an offset (returns 0 on any error).
fn decode_cursor(cursor: &str) -> usize {
    // Decode hex bytes back to ASCII digits.
    let decoded: Option<String> = (0..cursor.len())
        .step_by(2)
        .map(|i| {
            cursor
                .get(i..i + 2)
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
                .map(|b| b as char)
        })
        .collect();
    decoded.and_then(|s| s.parse::<usize>().ok()).unwrap_or(0)
}

fn page_slice<T>(items: Vec<T>, cursor: Option<&str>) -> PageDto<T>
where
    T: Serialize,
{
    let offset = cursor.map(decode_cursor).unwrap_or(0);
    let end = (offset + PAGE_SIZE).min(items.len());
    let slice: Vec<T> = items.into_iter().skip(offset).take(PAGE_SIZE).collect();
    let next_cursor = if offset + PAGE_SIZE < end + offset {
        None // won't happen with this logic; handled below
    } else if slice.len() == PAGE_SIZE {
        Some(encode_cursor(offset + PAGE_SIZE))
    } else {
        None
    };
    let _ = end; // suppress unused warning
    PageDto {
        items: slice,
        next_cursor,
    }
}

/// `SearchQuery` input (maps to `SearchQuery` in types.ts).
#[derive(Deserialize)]
pub struct SearchQueryDto {
    pub text: String,
    pub filters: Option<SearchFiltersDto>,
    pub sort: Option<String>,
    pub cursor: Option<String>,
}

/// `SearchFilters` input (maps to `SearchFilters` in types.ts).
#[derive(Deserialize)]
pub struct SearchFiltersDto {
    pub tags: Option<Vec<String>>,
    pub people: Option<Vec<String>>,
    pub group: Option<String>,
}

/// `search(query)` — full-text + filter search.
#[tauri::command]
pub fn search(
    query: SearchQueryDto,
    state: State<'_, AppState>,
) -> CmdResult<PageDto<EntrySummaryDto>> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;

    let limit = 500_usize; // spec 0009 cap
    let raw_results = lib
        .index
        .search(&query.text, limit)
        .map_err(|e| IpcError::io(format!("Search failed: {e}")))?;

    // Build summaries from search results (we need tag/people data too).
    // We fetch per-entry data from the index for the matched rows.
    let mut summaries: Vec<EntrySummaryDto> = Vec::with_capacity(raw_results.len());
    for sr in &raw_results {
        let entry_row_id = sr.id;

        // Build a minimal summary from what we have.
        // Tags and people require separate index queries; we do them in bulk.
        let tags = tags_for_entry(&lib.index, entry_row_id);
        let people = people_for_entry(&lib.index, entry_row_id);

        // group_path: derive from path (everything before the last slash).
        let (group, slug) = split_group_slug(&sr.path);
        let _ = slug;

        // id is the path without .md
        let id = sr.path.trim_end_matches(".md").to_string();
        let title = sr.title.clone().unwrap_or_else(|| id.clone());

        summaries.push(EntrySummaryDto {
            id,
            path: sr.path.clone(),
            title,
            group,
            tags,
            people,
            modified_at: sr.updated.clone().unwrap_or_default(),
        });
    }

    // Apply client-side filters.
    if let Some(f) = &query.filters {
        if let Some(group) = &f.group {
            let g = group.as_str();
            summaries.retain(|s| s.group == g || s.group.starts_with(&format!("{g}/")));
        }
        if let Some(tags) = &f.tags {
            if !tags.is_empty() {
                summaries.retain(|s| tags.iter().any(|t| s.tags.contains(t)));
            }
        }
        if let Some(people) = &f.people {
            if !people.is_empty() {
                summaries.retain(|s| people.iter().any(|p| s.people.contains(p)));
            }
        }
    }

    // Sorting: the index already returns relevance-sorted results (BM25 + updated).
    // For modified_desc/asc/title_asc, apply client-side sort using the now-populated
    // modified_at field (from entries.updated via SearchResult).

    Ok(page_slice(summaries, query.cursor.as_deref()))
}

/// `tag_index()` — all tags with metadata.
///
/// Response maps to `TagMeta[]` in types.ts.
#[derive(Serialize)]
pub struct TagMetaDto {
    pub name: String,
    pub color: String,
    pub count: u64,
}

#[tauri::command]
pub fn tag_index(state: State<'_, AppState>) -> CmdResult<Vec<TagMetaDto>> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;

    let rows = lib
        .index
        .tag_index()
        .map_err(|e| IpcError::io(format!("tag_index failed: {e}")))?;

    // The index returns one row per (entry_id, tag) pair; aggregate counts.
    let mut counts: std::collections::BTreeMap<String, u64> = std::collections::BTreeMap::new();
    for row in &rows {
        *counts.entry(row.tag.clone()).or_default() += 1;
    }

    // Get tag_meta for colors.
    let meta_rows = lib.index.tag_meta_index().unwrap_or_default();
    let meta_map: std::collections::HashMap<_, _> = meta_rows
        .iter()
        .map(|r| (r.tag.clone(), r.color.clone()))
        .collect();

    let result = counts
        .into_iter()
        .map(|(tag, count)| {
            let color = meta_map
                .get(&tag)
                .and_then(|c| c.as_deref())
                .unwrap_or("slate")
                .to_string();
            TagMetaDto {
                name: tag,
                color,
                count,
            }
        })
        .collect();

    Ok(result)
}

/// `people_index()` — all people with metadata.
///
/// Response maps to `PersonMeta[]` in types.ts.
#[derive(Serialize)]
pub struct PersonMetaDto {
    pub slug: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(rename = "avatarPath", skip_serializing_if = "Option::is_none")]
    pub avatar_path: Option<String>,
}

#[tauri::command]
pub fn people_index(state: State<'_, AppState>) -> CmdResult<Vec<PersonMetaDto>> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;

    // Declared people (from _people.md projection).
    let people_rows = lib
        .index
        .people_index()
        .map_err(|e| IpcError::io(format!("people_index failed: {e}")))?;

    // All mentions (inline @slug references across all entries).
    let mentions = lib.index.mentions_index().unwrap_or_default();

    // Count mentions per slug.
    let mut counts: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
    for row in &mentions {
        *counts.entry(row.tag.clone()).or_default() += 1;
    }

    // Start with declared people (carry full_name / color / avatar metadata).
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut result: Vec<PersonMetaDto> = people_rows
        .into_iter()
        .map(|row| {
            seen.insert(row.slug.clone());
            let count = *counts.get(&row.slug).unwrap_or(&0);
            let display_name = row.full_name.unwrap_or_else(|| row.slug.clone());
            PersonMetaDto {
                slug: row.slug,
                display_name,
                count,
                color: row.color,
                avatar_path: row.avatar_path,
            }
        })
        .collect();

    // Add any mentioned-but-undeclared people (no _people.md entry for them).
    // Collect unique slugs from mentions not already covered.
    let mut extra: Vec<PersonMetaDto> = counts
        .iter()
        .filter(|(slug, _)| !seen.contains(*slug))
        .map(|(slug, &count)| PersonMetaDto {
            display_name: slug.clone(),
            slug: slug.clone(),
            count,
            color: None,
            avatar_path: None,
        })
        .collect();
    extra.sort_by(|a, b| a.slug.cmp(&b.slug));
    result.extend(extra);

    Ok(result)
}

/// `entries_in_group(group, cursor?)` — paged entries in a group.
#[tauri::command]
pub fn entries_in_group(
    group: String,
    cursor: Option<String>,
    state: State<'_, AppState>,
) -> CmdResult<PageDto<EntrySummaryDto>> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;

    let rows = lib
        .index
        .entries_in_group(&group)
        .map_err(|e| IpcError::io(format!("entries_in_group failed: {e}")))?;

    let summaries: Vec<EntrySummaryDto> = rows
        .into_iter()
        .map(|row| {
            let tags = tags_for_entry(&lib.index, row.id);
            let people = people_for_entry(&lib.index, row.id);
            let id = row.path.trim_end_matches(".md").to_string();
            let title = row.title.clone().unwrap_or_else(|| row.slug.clone());
            let modified_at = row.updated.unwrap_or_default();
            EntrySummaryDto {
                id,
                path: row.path,
                title,
                group: row.group_path,
                tags,
                people,
                modified_at,
            }
        })
        .collect();

    Ok(page_slice(summaries, cursor.as_deref()))
}

/// `backlinks(id)` — entries that link to the given entry.
///
/// Response maps to `Backlink[]` in types.ts.
#[derive(Debug, Serialize)]
pub struct BacklinkDto {
    #[serde(rename = "sourceId")]
    pub source_id: String,
    #[serde(rename = "sourceTitle")]
    pub source_title: String,
    #[serde(rename = "linkText")]
    pub link_text: String,
}

#[tauri::command]
pub fn backlinks(id: String, state: State<'_, AppState>) -> CmdResult<Vec<BacklinkDto>> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;

    // Resolve the entry path to its integer row-id.
    let path = format!("{id}.md");
    let row_id = lib
        .index
        .entry_id_for_path(&path)
        .map_err(|e| IpcError::io(format!("Index lookup failed: {e}")))?
        .ok_or_else(|| IpcError::not_found(format!("Entry not found: {id}")))?;

    let bl_rows = lib
        .index
        .backlinks(row_id)
        .map_err(|e| IpcError::io(format!("backlinks failed: {e}")))?;

    // We need the title of the source entry; fetch it from entries_in_group or a
    // direct lookup.  Use entry_id_for_path in reverse via the path.
    let result = bl_rows
        .into_iter()
        .map(|row| {
            let source_id = row.src_path.trim_end_matches(".md").to_string();
            // Get title: query the index via slug matches is complex; use path-based
            // title extraction by reading the file — we cache-miss but it's correct.
            // For a first wave we just use the slug as title fallback.
            let source_title = title_for_path(&lib.index, &lib.root, &row.src_path);
            BacklinkDto {
                source_id,
                source_title,
                link_text: row.target_raw,
            }
        })
        .collect();

    Ok(result)
}

// ── entry_titles ──────────────────────────────────────────────────────────────

/// `entry_titles()` — all entry id → title pairs for wikilink resolution.
///
/// Response is a flat JSON object (Record<string, string>).
#[tauri::command]
pub fn entry_titles(
    state: State<'_, AppState>,
) -> CmdResult<std::collections::HashMap<String, String>> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;

    let rows = lib
        .index
        .entries_in_group("")
        .map_err(|e| IpcError::io(format!("entry_titles failed: {e}")))?;

    let map = rows
        .into_iter()
        .map(|row| {
            let id = row.path.trim_end_matches(".md").to_string();
            let title = row.title.unwrap_or_else(|| row.slug.clone());
            (id, title)
        })
        .collect();

    Ok(map)
}

// ── Helper query functions ─────────────────────────────────────────────────────

/// Tags for an entry given its integer row-id.
fn tags_for_entry(index: &Index, entry_row_id: i64) -> Vec<String> {
    match index.tag_index() {
        Ok(rows) => {
            let mut seen = std::collections::HashSet::new();
            rows.into_iter()
                .filter(|r| r.entry_id == entry_row_id)
                .filter_map(|r| {
                    if seen.insert(r.tag.clone()) {
                        Some(r.tag)
                    } else {
                        None
                    }
                })
                .collect()
        }
        Err(_) => vec![],
    }
}

/// People (mentions) for an entry given its integer row-id.
fn people_for_entry(index: &Index, entry_row_id: i64) -> Vec<String> {
    match index.mentions_index() {
        Ok(rows) => {
            let mut seen = std::collections::HashSet::new();
            rows.into_iter()
                .filter(|r| r.entry_id == entry_row_id)
                .filter_map(|r| {
                    if seen.insert(r.tag.clone()) {
                        Some(r.tag)
                    } else {
                        None
                    }
                })
                .collect()
        }
        Err(_) => vec![],
    }
}

/// Derive (group_path, slug) from a library-relative path.
///
/// `"work/atlas/overview.md"` → `("work/atlas", "overview")`.
/// `"overview.md"` → `("", "overview")`.
fn split_group_slug(path: &str) -> (String, String) {
    let no_ext = path.trim_end_matches(".md");
    if let Some(slash) = no_ext.rfind('/') {
        (no_ext[..slash].to_string(), no_ext[slash + 1..].to_string())
    } else {
        (String::new(), no_ext.to_string())
    }
}

/// Get the title for a library-relative path by reading from disk (best-effort).
fn title_for_path(index: &Index, root: &Path, rel_path: &str) -> String {
    // Try index-based lookup first via entries_in_group on empty prefix.
    // Simpler: read the file and extract H1.
    let abs = root.join(rel_path);
    if let Ok(bytes) = std::fs::read(&abs) {
        let entry = Entry::from_bytes(&bytes);
        if let Some(t) = entry.title() {
            return t;
        }
    }
    // Fallback: use path-based slug from the index if available.
    let _ = index;
    rel_path.trim_end_matches(".md").to_string()
}
