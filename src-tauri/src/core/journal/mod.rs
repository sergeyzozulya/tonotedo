// Journal module — journaled batch rewrites for tag/person rename and merge.
//
// Spec refs:
//   - docs/spec/0004-tags.md      §Operations (rename, merge)
//   - docs/spec/0005-mentions.md  §Operations (rename, merge)
//   - docs/tech/design-0001-index-and-reconciliation.md §"Batch journal"
//
// Design contract:
//
//   • Metadata files (_tags.md, _people.md) are NOT rewritten here — only
//     entry files discovered via the index.  The caller is responsible for
//     updating metadata after the batch returns.
//
//   • Trash exclusion: the index never indexes `.tonotedo/`, so
//     `paths_with_tag` / `paths_with_mention` will never return paths under
//     `.tonotedo/`.  We assert this invariant rather than re-filtering.
//
//   • Recovery model: forward-resume only (no rollback).  A crash mid-rename
//     leaves a recoverable state: on next launch `resume_pending` re-runs the
//     NOT-done files.  Rewrites are idempotent by construction — if the old
//     token no longer appears in the file (because it was already rewritten),
//     the rewrite is a no-op.  Rollback is not implemented because:
//       1. A partial rename is not harmful — entries that already have the new
//          tag are correct; entries that still have the old tag are reindexed
//          under the old name (still valid, just inconsistent) until resume.
//       2. True rollback would require writing back the old content, which
//          risks overwriting any subsequent user edits.
//
//   • Journal file format: `.tonotedo/journal/<ulid>.json`
//       {
//         "op": "rename_tag" | "merge_tag" | "rename_person" | "merge_person",
//         "old": "<slug>",
//         "new": "<slug>",
//         "files": ["path/a.md", ...],
//         "done":  ["path/a.md", ...]
//       }
//     After every successful per-file write, the path is appended to `done`
//     and the journal file is rewritten.  On completion the journal file is
//     deleted.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::core::frontmatter::{Entry, Value};
use crate::core::fswrite::{write_entry, TokenRegistry, WriteError};
use crate::core::index::{Index, IndexError};

// ── Error type ────────────────────────────────────────────────────────────────

/// Errors produced by the journal module.
#[derive(Debug)]
pub enum JournalError {
    Io(std::io::Error),
    Json(serde_json::Error),
    Index(IndexError),
    Write(WriteError),
}

impl std::fmt::Display for JournalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JournalError::Io(e) => write!(f, "journal I/O error: {e}"),
            JournalError::Json(e) => write!(f, "journal JSON error: {e}"),
            JournalError::Index(e) => write!(f, "journal index error: {e}"),
            JournalError::Write(e) => write!(f, "journal write error: {e}"),
        }
    }
}

impl std::error::Error for JournalError {}

impl From<std::io::Error> for JournalError {
    fn from(e: std::io::Error) -> Self {
        JournalError::Io(e)
    }
}

impl From<serde_json::Error> for JournalError {
    fn from(e: serde_json::Error) -> Self {
        JournalError::Json(e)
    }
}

impl From<IndexError> for JournalError {
    fn from(e: IndexError) -> Self {
        JournalError::Index(e)
    }
}

impl From<WriteError> for JournalError {
    fn from(e: WriteError) -> Self {
        JournalError::Write(e)
    }
}

// ── Journal file structures ───────────────────────────────────────────────────

/// Operation kind stored in the journal file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpKind {
    RenameTag,
    MergeTag,
    RenamePerson,
    MergePerson,
}

/// On-disk journal intent record.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct JournalRecord {
    op: OpKind,
    old: String,
    new: String,
    files: Vec<String>,
    done: Vec<String>,
}

// ── Summary returned to the caller ───────────────────────────────────────────

/// Summary of a completed batch operation.
#[derive(Debug, Clone)]
pub struct BatchSummary {
    /// Number of entry files that were modified.
    pub files_changed: usize,
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Rename every occurrence of tag `old` to `new` across all entry files.
///
/// `library_root` is the absolute path to the library directory.
/// `index` is used for pre-flight discovery of affected entry paths.
/// `registry` is the shared `TokenRegistry`; write tokens are issued via it.
///
/// Metadata files (_tags.md, _people.md) are NOT touched — that is the
/// caller's responsibility.
pub fn rename_tag(
    library_root: &Path,
    index: &Index,
    registry: &Arc<TokenRegistry>,
    old: &str,
    new: &str,
) -> Result<BatchSummary, JournalError> {
    run_batch(library_root, index, registry, OpKind::RenameTag, old, new)
}

/// Merge tag `src` into `dst`: rewrite every occurrence of `src` as `dst`.
///
/// Metadata removal (src's entry in _tags.md) is the caller's responsibility.
pub fn merge_tag(
    library_root: &Path,
    index: &Index,
    registry: &Arc<TokenRegistry>,
    src: &str,
    dst: &str,
) -> Result<BatchSummary, JournalError> {
    run_batch(library_root, index, registry, OpKind::MergeTag, src, dst)
}

/// Rename every occurrence of person slug `old` to `new` across all entry files.
///
/// Metadata files (_people.md) are NOT touched — that is the caller's
/// responsibility.
pub fn rename_person(
    library_root: &Path,
    index: &Index,
    registry: &Arc<TokenRegistry>,
    old: &str,
    new: &str,
) -> Result<BatchSummary, JournalError> {
    run_batch(
        library_root,
        index,
        registry,
        OpKind::RenamePerson,
        old,
        new,
    )
}

/// Merge person slug `src` into `dst`: rewrite every `@src` to `@dst`.
///
/// Metadata removal (src's entry in _people.md) is the caller's responsibility.
pub fn merge_person(
    library_root: &Path,
    index: &Index,
    registry: &Arc<TokenRegistry>,
    src: &str,
    dst: &str,
) -> Result<BatchSummary, JournalError> {
    run_batch(library_root, index, registry, OpKind::MergePerson, src, dst)
}

/// Resume any pending journal operations found in `.tonotedo/journal/`.
///
/// Called on startup.  For each journal file:
///   1. Re-runs the files NOT in `done` (skipping already-done ones).
///   2. Deletes the journal file on completion.
///
/// Rewrites are idempotent: if a file was already rewritten (old token no
/// longer present), the rewrite is a no-op.
pub fn resume_pending(
    library_root: &Path,
    registry: &Arc<TokenRegistry>,
) -> Result<(), JournalError> {
    let journal_dir = journal_dir_path(library_root);
    if !journal_dir.exists() {
        return Ok(());
    }

    for entry in std::fs::read_dir(&journal_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }

        let bytes = std::fs::read(&path)?;
        let record: JournalRecord = match serde_json::from_slice(&bytes) {
            Ok(r) => r,
            Err(_) => {
                // Unrecognizable journal file — skip (don't delete; leave for inspection).
                continue;
            }
        };

        let done_set: HashSet<&str> = record.done.iter().map(String::as_str).collect();
        let remaining: Vec<String> = record
            .files
            .iter()
            .filter(|f| !done_set.contains(f.as_str()))
            .cloned()
            .collect();

        let mut done = record.done.clone();
        for rel_path in &remaining {
            let abs_path = library_root.join(rel_path);
            if !abs_path.exists() {
                // File disappeared — skip; still mark done so resume terminates.
                done.push(rel_path.clone());
                let updated = JournalRecord {
                    op: record.op.clone(),
                    old: record.old.clone(),
                    new: record.new.clone(),
                    files: record.files.clone(),
                    done: done.clone(),
                };
                write_journal_file(&path, &updated)?;
                continue;
            }

            let bytes = std::fs::read(&abs_path)?;
            let entry = Entry::from_bytes(&bytes);
            let rewritten = rewrite_entry(&entry, &record.op, &record.old, &record.new);
            write_entry(&abs_path, &rewritten, &[], registry)?;

            done.push(rel_path.clone());
            let updated = JournalRecord {
                op: record.op.clone(),
                old: record.old.clone(),
                new: record.new.clone(),
                files: record.files.clone(),
                done: done.clone(),
            };
            write_journal_file(&path, &updated)?;
        }

        // All files processed — delete the journal file.
        std::fs::remove_file(&path)?;
    }

    Ok(())
}

// ── Core batch implementation ─────────────────────────────────────────────────

fn run_batch(
    library_root: &Path,
    index: &Index,
    registry: &Arc<TokenRegistry>,
    op: OpKind,
    old: &str,
    new: &str,
) -> Result<BatchSummary, JournalError> {
    // Discover affected paths via the index (union of both surfaces).
    // The index never indexes .tonotedo/, so no trash/journal exclusion needed.
    let paths = discover_paths(index, &op, old)?;

    // Assert the index contract: no .tonotedo/ paths should appear.
    for p in &paths {
        debug_assert!(
            !p.starts_with(".tonotedo/") && !p.contains("/.tonotedo/"),
            "index returned a .tonotedo/ path — index should never index this directory: {p}"
        );
    }

    // No-op: nothing to rewrite — do not create a journal file.
    if paths.is_empty() {
        return Ok(BatchSummary { files_changed: 0 });
    }

    // Write the journal intent file before touching any entry.
    let journal_path = create_journal_file(library_root, &op, old, new, &paths)?;

    let mut done: Vec<String> = Vec::with_capacity(paths.len());
    let mut files_changed: usize = 0;

    for rel_path in &paths {
        let abs_path = library_root.join(rel_path);

        // Missing file: skip and mark done (no crash, just a stale index entry).
        if !abs_path.exists() {
            done.push(rel_path.clone());
            let record = JournalRecord {
                op: op.clone(),
                old: old.to_string(),
                new: new.to_string(),
                files: paths.clone(),
                done: done.clone(),
            };
            write_journal_file(&journal_path, &record)?;
            continue;
        }

        let bytes = std::fs::read(&abs_path)?;
        let entry = Entry::from_bytes(&bytes);
        let rewritten = rewrite_entry(&entry, &op, old, new);

        // Check whether the rewrite actually changed anything (idempotency).
        let new_bytes = rewritten.to_bytes(&[]);
        if new_bytes != bytes {
            write_entry(&abs_path, &rewritten, &[], registry)?;
            files_changed += 1;
        }

        // Mark done and persist journal after each file — crash-recoverable invariant.
        done.push(rel_path.clone());
        let record = JournalRecord {
            op: op.clone(),
            old: old.to_string(),
            new: new.to_string(),
            files: paths.clone(),
            done: done.clone(),
        };
        write_journal_file(&journal_path, &record)?;
    }

    // All files processed — delete the journal file.
    std::fs::remove_file(&journal_path)?;

    Ok(BatchSummary { files_changed })
}

// ── Path discovery ────────────────────────────────────────────────────────────

fn discover_paths(index: &Index, op: &OpKind, old: &str) -> Result<Vec<String>, JournalError> {
    let paths = match op {
        OpKind::RenameTag | OpKind::MergeTag => index.paths_with_tag(old)?,
        OpKind::RenamePerson | OpKind::MergePerson => index.paths_with_mention(old)?,
    };
    Ok(paths)
}

// ── Entry rewrite ─────────────────────────────────────────────────────────────

/// Rewrite both surfaces of `entry`, replacing every occurrence of `old`
/// with `new` (case-insensitive match, case-preserving replacement with `new`).
///
/// The body is rewritten only where the scanner would have produced a real
/// token — word-boundary and code-fence rules apply.
fn rewrite_entry(entry: &Entry, op: &OpKind, old: &str, new: &str) -> Entry {
    let mut out = entry.clone();

    match op {
        OpKind::RenameTag | OpKind::MergeTag => {
            rewrite_frontmatter_array(&mut out, "tags", old, new);
            out.body = rewrite_body_tags(&out.body, old, new);
        }
        OpKind::RenamePerson | OpKind::MergePerson => {
            rewrite_frontmatter_array(&mut out, "mentions", old, new);
            out.body = rewrite_body_mentions(&out.body, old, new);
        }
    }

    out
}

// ── Frontmatter rewrite ───────────────────────────────────────────────────────

/// Replace any element in frontmatter array `key` that matches `old`
/// (case-insensitively) with `new`.  Other elements are preserved exactly.
fn rewrite_frontmatter_array(entry: &mut Entry, key: &str, old: &str, new: &str) {
    let old_lower = old.to_lowercase();
    if let Some(Value::Tags(tags)) = entry.properties.get_mut(key) {
        for tag in tags.iter_mut() {
            if tag.to_lowercase() == old_lower {
                *tag = new.to_string();
            }
        }
    }
}

// ── Body rewrite — tags ───────────────────────────────────────────────────────

/// Rewrite `#old` → `#new` in `body`, obeying scanner rules:
/// - Fenced code blocks are not rewritten.
/// - Inline code spans are not rewritten.
/// - Only exact-token matches: `#project` does NOT match inside `#project/atlas`.
///   (The tag ends at the first character that is not in [a-zA-Z0-9\-_/].)
/// - Word-boundary rule: `#` must not be preceded by a word character.
///
/// Match is case-insensitive; replacement uses the canonical `new` form.
fn rewrite_body_tags(body: &str, old: &str, new: &str) -> String {
    let old_lower = old.to_lowercase();
    let mut result = String::with_capacity(body.len());
    let mut in_fence = false;
    let mut fence_marker: Option<char> = None;

    for line in body.split_inclusive('\n') {
        let trimmed = line.trim_start();

        // Fence tracking (same logic as scanner).
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            let marker = trimmed.chars().next().unwrap();
            if !in_fence {
                in_fence = true;
                fence_marker = Some(marker);
            } else if fence_marker == Some(marker) {
                in_fence = false;
                fence_marker = None;
            }
            result.push_str(line);
            continue;
        }

        if in_fence {
            result.push_str(line);
            continue;
        }

        result.push_str(&rewrite_line_tags(line, &old_lower, new));
    }

    result
}

/// Rewrite `#old` tokens on a single (non-fenced) line.
fn rewrite_line_tags(line: &str, old_lower: &str, new: &str) -> String {
    // Walk the line, tracking inline-code spans.
    let chars: Vec<char> = line.chars().collect();
    let n = chars.len();
    let mut result = String::with_capacity(line.len());
    let mut i = 0;
    // Inline code suppression: when we hit a backtick, push the entire span
    // verbatim (including delimiters) and advance past it.  Tokens inside are
    // thus never matched.

    while i < n {
        if chars[i] == '`' {
            // Find matching close backtick.
            let mut j = i + 1;
            while j < n && chars[j] != '`' {
                j += 1;
            }
            if j < n {
                // Push the entire code span verbatim.
                let span: String = chars[i..=j].iter().collect();
                result.push_str(&span);
                i = j + 1;
            } else {
                // Unclosed backtick — push rest verbatim.
                let rest: String = chars[i..].iter().collect();
                result.push_str(&rest);
                i = n;
            }
            continue;
        }

        // Look for `#`.
        if chars[i] == '#' {
            let preceded_by_word = i > 0 && is_word_char(chars[i - 1]);
            if !preceded_by_word {
                // Collect the tag token.
                let start = i + 1;
                let mut j = start;
                while j < n && is_tag_char(chars[j]) {
                    j += 1;
                }
                if j > start {
                    let token: String = chars[start..j].iter().collect();
                    if token.to_lowercase() == old_lower {
                        // Exact match — replace.
                        result.push('#');
                        result.push_str(new);
                        i = j;
                        continue;
                    } else {
                        // Not a match (different tag, or hierarchical child like project/atlas).
                        // Push verbatim.
                        result.push('#');
                        result.push_str(&token);
                        i = j;
                        continue;
                    }
                }
            }
        }

        result.push(chars[i]);
        i += 1;
    }

    result
}

// ── Body rewrite — mentions ───────────────────────────────────────────────────

/// Rewrite `@old` → `@new` in `body`, obeying scanner rules:
/// - Fenced code blocks are not rewritten.
/// - Inline code spans are not rewritten.
/// - Word-boundary rule: `@` must not be preceded by a word character.
///
/// Match is case-insensitive; replacement uses the canonical `new` form.
fn rewrite_body_mentions(body: &str, old: &str, new: &str) -> String {
    let old_lower = old.to_lowercase();
    let mut result = String::with_capacity(body.len());
    let mut in_fence = false;
    let mut fence_marker: Option<char> = None;

    for line in body.split_inclusive('\n') {
        let trimmed = line.trim_start();

        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            let marker = trimmed.chars().next().unwrap();
            if !in_fence {
                in_fence = true;
                fence_marker = Some(marker);
            } else if fence_marker == Some(marker) {
                in_fence = false;
                fence_marker = None;
            }
            result.push_str(line);
            continue;
        }

        if in_fence {
            result.push_str(line);
            continue;
        }

        result.push_str(&rewrite_line_mentions(line, &old_lower, new));
    }

    result
}

/// Rewrite `@old` tokens on a single (non-fenced) line.
fn rewrite_line_mentions(line: &str, old_lower: &str, new: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let n = chars.len();
    let mut result = String::with_capacity(line.len());
    let mut i = 0;

    while i < n {
        if chars[i] == '`' {
            // Inline code span — push verbatim.
            let mut j = i + 1;
            while j < n && chars[j] != '`' {
                j += 1;
            }
            if j < n {
                let span: String = chars[i..=j].iter().collect();
                result.push_str(&span);
                i = j + 1;
            } else {
                let rest: String = chars[i..].iter().collect();
                result.push_str(&rest);
                i = n;
            }
            continue;
        }

        if chars[i] == '@' {
            let preceded_by_word = i > 0 && is_word_char(chars[i - 1]);
            if !preceded_by_word {
                let start = i + 1;
                let mut j = start;
                while j < n && is_mention_char(chars[j]) {
                    j += 1;
                }
                if j > start {
                    let token: String = chars[start..j].iter().collect();
                    if token.to_lowercase() == old_lower {
                        result.push('@');
                        result.push_str(new);
                        i = j;
                        continue;
                    } else {
                        result.push('@');
                        result.push_str(&token);
                        i = j;
                        continue;
                    }
                }
            }
        }

        result.push(chars[i]);
        i += 1;
    }

    result
}

// ── Character class helpers (mirror scanner rules) ────────────────────────────

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || c == '-' || c == '_' || c == '/'
}

fn is_mention_char(c: char) -> bool {
    c.is_alphanumeric() || c == '-' || c == '_'
}

// ── Journal file helpers ──────────────────────────────────────────────────────

fn journal_dir_path(library_root: &Path) -> PathBuf {
    library_root.join(".tonotedo").join("journal")
}

/// Create a new journal intent file and return its path.
fn create_journal_file(
    library_root: &Path,
    op: &OpKind,
    old: &str,
    new: &str,
    files: &[String],
) -> Result<PathBuf, JournalError> {
    let dir = journal_dir_path(library_root);
    std::fs::create_dir_all(&dir)?;

    let id = ulid::Ulid::new().to_string();
    let path = dir.join(format!("{id}.json"));

    let record = JournalRecord {
        op: op.clone(),
        old: old.to_string(),
        new: new.to_string(),
        files: files.to_vec(),
        done: Vec::new(),
    };

    write_journal_file(&path, &record)?;
    Ok(path)
}

/// Atomically overwrite the journal file with the updated record.
///
/// We use a simple write here (not the fswrite atomic path) because the
/// journal directory `.tonotedo/journal/` is managed exclusively by this
/// module, and the journal file itself is the crash-recovery artifact —
/// it doesn't need to be watched by the reconciler.
fn write_journal_file(path: &Path, record: &JournalRecord) -> Result<(), JournalError> {
    let json = serde_json::to_string_pretty(record)?;
    // Write to a temp file next to the journal file, then rename (atomic on POSIX).
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, json.as_bytes())?;
    std::fs::rename(&tmp_path, path)?;
    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::frontmatter::Value;
    use crate::core::index::Index;
    use std::collections::BTreeMap;
    use tempfile::TempDir;

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn make_registry() -> Arc<TokenRegistry> {
        Arc::new(TokenRegistry::with_default_ttl())
    }

    /// Create a temp library dir with a `.tonotedo/` subdir.
    fn make_library() -> TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join(".tonotedo")).unwrap();
        dir
    }

    /// Build an in-memory index and register `entry` at `rel_path`.
    fn index_entry(idx: &mut Index, library_root: &Path, rel_path: &str, entry: &Entry) {
        let abs = library_root.join(rel_path);
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let bytes = entry.to_bytes(&[]);
        std::fs::write(&abs, &bytes).unwrap();

        let slug = Path::new(rel_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(rel_path);
        let group = Path::new(rel_path)
            .parent()
            .and_then(|p| p.to_str())
            .unwrap_or("")
            .trim_start_matches('/')
            .to_string();
        // group stays as-is; keep for clarity.
        idx.upsert_entry(rel_path, slug, &group, entry, 0, 0, "h")
            .expect("upsert");
    }

    fn entry_with_tags(tags: &[&str], body: &str) -> Entry {
        let mut props = BTreeMap::new();
        props.insert(
            "tags".to_string(),
            Value::Tags(tags.iter().map(|s| s.to_string()).collect()),
        );
        Entry {
            properties: props,
            body: body.to_string(),
            parse_warning: None,
        }
    }

    fn entry_with_mentions(mentions: &[&str], body: &str) -> Entry {
        let mut props = BTreeMap::new();
        props.insert(
            "mentions".to_string(),
            Value::Tags(mentions.iter().map(|s| s.to_string()).collect()),
        );
        Entry {
            properties: props,
            body: body.to_string(),
            parse_warning: None,
        }
    }

    fn entry_body_only(body: &str) -> Entry {
        Entry {
            properties: BTreeMap::new(),
            body: body.to_string(),
            parse_warning: None,
        }
    }

    fn read_entry(library_root: &Path, rel_path: &str) -> Entry {
        let bytes = std::fs::read(library_root.join(rel_path)).expect("read entry");
        Entry::from_bytes(&bytes)
    }

    // ── 1. Frontmatter-only rename ────────────────────────────────────────────

    #[test]
    fn rename_tag_frontmatter_only() {
        let lib = make_library();
        let mut idx = Index::open_in_memory().unwrap();
        let registry = make_registry();

        let e1 = entry_with_tags(&["followup", "work"], "body text");
        let e2 = entry_with_tags(&["work"], "other");
        index_entry(&mut idx, lib.path(), "a.md", &e1);
        index_entry(&mut idx, lib.path(), "b.md", &e2);

        let summary = rename_tag(lib.path(), &idx, &registry, "followup", "follow-up").unwrap();
        assert_eq!(summary.files_changed, 1);

        let a = read_entry(lib.path(), "a.md");
        assert!(a.tags().contains(&"follow-up".to_string()));
        assert!(!a.tags().contains(&"followup".to_string()));
        // Other tags preserved.
        assert!(a.tags().contains(&"work".to_string()));

        // b.md unchanged (no followup tag).
        let b = read_entry(lib.path(), "b.md");
        assert_eq!(b.tags(), &["work"]);
    }

    // ── 2. Body-only rename ───────────────────────────────────────────────────

    #[test]
    fn rename_tag_body_only() {
        let lib = make_library();
        let mut idx = Index::open_in_memory().unwrap();
        let registry = make_registry();

        let e = entry_body_only("tagged as #oldname today");
        index_entry(&mut idx, lib.path(), "note.md", &e);

        rename_tag(lib.path(), &idx, &registry, "oldname", "newname").unwrap();

        let out = read_entry(lib.path(), "note.md");
        assert!(out.body.contains("#newname"));
        assert!(!out.body.contains("#oldname"));
    }

    // ── 3. Both surfaces renamed ──────────────────────────────────────────────

    #[test]
    fn rename_tag_both_surfaces() {
        let lib = make_library();
        let mut idx = Index::open_in_memory().unwrap();
        let registry = make_registry();

        let e = entry_with_tags(&["mytag"], "see #mytag for details");
        index_entry(&mut idx, lib.path(), "both.md", &e);

        rename_tag(lib.path(), &idx, &registry, "mytag", "newtag").unwrap();

        let out = read_entry(lib.path(), "both.md");
        assert!(out.tags().contains(&"newtag".to_string()));
        assert!(!out.tags().contains(&"mytag".to_string()));
        assert!(out.body.contains("#newtag"));
        assert!(!out.body.contains("#mytag"));
    }

    // ── 4. Fenced-code suppression ────────────────────────────────────────────

    #[test]
    fn rename_tag_no_rewrite_inside_fence() {
        let lib = make_library();
        let mut idx = Index::open_in_memory().unwrap();
        let registry = make_registry();

        let body = "before\n```\n#target\n```\nafter #target";
        // Only the body occurrence outside the fence is indexed; but we also
        // want to ensure the fence line is not rewritten.
        let e = entry_body_only(body);
        index_entry(&mut idx, lib.path(), "fence.md", &e);

        rename_tag(lib.path(), &idx, &registry, "target", "replaced").unwrap();

        let out = read_entry(lib.path(), "fence.md");
        // Inside fence: unchanged.
        assert!(out.body.contains("```\n#target\n```"));
        // Outside fence: replaced.
        assert!(out.body.contains("#replaced"));
    }

    // ── 5. Inline-code suppression ────────────────────────────────────────────

    #[test]
    fn rename_tag_no_rewrite_inside_inline_code() {
        // The scanner won't index the inline code occurrence, so no paths found.
        // Test directly with rewrite_body_tags to ensure the rewriter respects
        // inline code spans.
        let body = "use `#target` as config flag and see #target elsewhere";
        assert!(
            rewrite_body_tags(body, "target", "replaced").contains("`#target`"),
            "inline code span must not be rewritten"
        );
        assert!(
            rewrite_body_tags(body, "target", "replaced").contains("#replaced"),
            "real body token must be replaced"
        );
    }

    // ── 6. Hierarchical non-match ─────────────────────────────────────────────

    #[test]
    fn rename_tag_no_match_hierarchical_child() {
        // Renaming `project` must NOT touch `#project/atlas`.
        let body = "see #project/atlas for details and #project separately";
        let result = rewrite_body_tags(body, "project", "work");
        // project/atlas must survive unchanged.
        assert!(
            result.contains("#project/atlas"),
            "hierarchical child must not be renamed"
        );
        // bare #project must be replaced.
        assert!(
            result.contains("#work"),
            "exact match #project must be replaced"
        );
    }

    // ── 7. Case-insensitive frontmatter match ─────────────────────────────────

    #[test]
    fn rename_tag_case_insensitive_frontmatter() {
        let lib = make_library();
        let mut idx = Index::open_in_memory().unwrap();
        let registry = make_registry();

        // Stored as "Followup" (mixed case) — should still be replaced.
        let e = entry_with_tags(&["Followup", "work"], "body");
        index_entry(&mut idx, lib.path(), "ci.md", &e);

        rename_tag(lib.path(), &idx, &registry, "followup", "follow-up").unwrap();

        let out = read_entry(lib.path(), "ci.md");
        assert!(out.tags().contains(&"follow-up".to_string()));
        assert!(!out.tags().iter().any(|t| t.to_lowercase() == "followup"));
        assert!(out.tags().contains(&"work".to_string()));
    }

    // ── 8. Merge tag ─────────────────────────────────────────────────────────

    #[test]
    fn merge_tag_rewrites_src_as_dst() {
        let lib = make_library();
        let mut idx = Index::open_in_memory().unwrap();
        let registry = make_registry();

        let e1 = entry_with_tags(&["wip", "work"], "#wip in body");
        let e2 = entry_with_tags(&["done"], "no wip here");
        index_entry(&mut idx, lib.path(), "m1.md", &e1);
        index_entry(&mut idx, lib.path(), "m2.md", &e2);

        merge_tag(lib.path(), &idx, &registry, "wip", "done").unwrap();

        let out = read_entry(lib.path(), "m1.md");
        assert!(out.tags().contains(&"done".to_string()));
        assert!(!out.tags().contains(&"wip".to_string()));
        assert!(out.body.contains("#done"));
        assert!(!out.body.contains("#wip"));
    }

    // ── 9. Mention rename ─────────────────────────────────────────────────────

    #[test]
    fn rename_person_frontmatter_and_body() {
        let lib = make_library();
        let mut idx = Index::open_in_memory().unwrap();
        let registry = make_registry();

        let e = entry_with_mentions(&["sergey"], "had lunch with @sergey today");
        index_entry(&mut idx, lib.path(), "person.md", &e);

        rename_person(lib.path(), &idx, &registry, "sergey", "sergey-k").unwrap();

        let out = read_entry(lib.path(), "person.md");
        assert!(out.mentions().contains(&"sergey-k".to_string()));
        assert!(!out.mentions().contains(&"sergey".to_string()));
        assert!(out.body.contains("@sergey-k"));
        assert!(!out.body.contains("@sergey "));
    }

    // ── 10. Email address not a mention ───────────────────────────────────────

    #[test]
    fn rename_person_email_not_rewritten() {
        let body = "contact email@sergey.com for details @sergey is different";
        let result = rewrite_body_mentions(body, "sergey", "sergey-k");
        // The email@ is NOT a mention (preceded by word char).
        assert!(
            result.contains("email@sergey.com"),
            "email must not be rewritten"
        );
        // The free-standing @sergey IS a mention.
        assert!(result.contains("@sergey-k"));
    }

    // ── 11. Merge person ──────────────────────────────────────────────────────

    #[test]
    fn merge_person_rewrites_src_as_dst() {
        let lib = make_library();
        let mut idx = Index::open_in_memory().unwrap();
        let registry = make_registry();

        let e = entry_with_mentions(&["alice"], "meeting with @alice");
        index_entry(&mut idx, lib.path(), "mp.md", &e);

        merge_person(lib.path(), &idx, &registry, "alice", "anna").unwrap();

        let out = read_entry(lib.path(), "mp.md");
        assert!(out.mentions().contains(&"anna".to_string()));
        assert!(!out.mentions().contains(&"alice".to_string()));
        assert!(out.body.contains("@anna"));
        assert!(!out.body.contains("@alice"));
    }

    // ── 12. Crash simulation / resume ────────────────────────────────────────

    #[test]
    fn resume_pending_completes_partial_batch() {
        let lib = make_library();
        let registry = make_registry();

        // Create two files: file1 was "already done", file2 was NOT yet processed.
        let body1 = "see #oldtag here\n";
        let body2 = "also #oldtag there\n";
        std::fs::write(lib.path().join("file1.md"), body1).unwrap();
        std::fs::write(lib.path().join("file2.md"), body2).unwrap();

        // Simulate a crash: file1 done, file2 not done.
        // file1 body has already been rewritten (as would happen in the first pass).
        let rewritten1 = "see #newtag here\n";
        std::fs::write(lib.path().join("file1.md"), rewritten1).unwrap();

        // Write the journal file manually (simulating crash after file1 write).
        let journal_dir = lib.path().join(".tonotedo").join("journal");
        std::fs::create_dir_all(&journal_dir).unwrap();
        let record = JournalRecord {
            op: OpKind::RenameTag,
            old: "oldtag".to_string(),
            new: "newtag".to_string(),
            files: vec!["file1.md".to_string(), "file2.md".to_string()],
            done: vec!["file1.md".to_string()],
        };
        let journal_path = journal_dir.join("01JTEST000000000000000000.json");
        std::fs::write(&journal_path, serde_json::to_string(&record).unwrap()).unwrap();

        resume_pending(lib.path(), &registry).unwrap();

        // file2 must now be rewritten.
        let file2 = std::fs::read_to_string(lib.path().join("file2.md")).unwrap();
        assert!(
            file2.contains("#newtag"),
            "file2 must be rewritten by resume"
        );
        assert!(!file2.contains("#oldtag"));

        // file1 was already rewritten — idempotent rewrite should leave it as-is.
        let file1 = std::fs::read_to_string(lib.path().join("file1.md")).unwrap();
        assert!(file1.contains("#newtag"));
        // (file1 was skipped since it was in 'done'; content unchanged)

        // Journal file must be deleted after completion.
        assert!(
            !journal_path.exists(),
            "journal file must be deleted on completion"
        );
    }

    // ── 13. Resume idempotency ────────────────────────────────────────────────

    #[test]
    fn resume_idempotent_already_rewritten_file() {
        let lib = make_library();
        let registry = make_registry();

        // file already has the new tag (was rewritten before crash).
        let body = "see #newtag here\n";
        std::fs::write(lib.path().join("already.md"), body).unwrap();

        // Journal says this file was NOT done yet (simulating a partial crash
        // where the file was written but the journal update didn't persist).
        let journal_dir = lib.path().join(".tonotedo").join("journal");
        std::fs::create_dir_all(&journal_dir).unwrap();
        let record = JournalRecord {
            op: OpKind::RenameTag,
            old: "oldtag".to_string(),
            new: "newtag".to_string(),
            files: vec!["already.md".to_string()],
            done: vec![],
        };
        let journal_path = journal_dir.join("01JIDEM000000000000000000.json");
        std::fs::write(&journal_path, serde_json::to_string(&record).unwrap()).unwrap();

        resume_pending(lib.path(), &registry).unwrap();

        // File content must be unchanged (old token not present → no-op).
        let out = std::fs::read_to_string(lib.path().join("already.md")).unwrap();
        assert_eq!(out, body);

        // Journal file deleted.
        assert!(!journal_path.exists());
    }

    // ── 14. Journal deleted on completion ─────────────────────────────────────

    #[test]
    fn journal_file_deleted_on_completion() {
        let lib = make_library();
        let mut idx = Index::open_in_memory().unwrap();
        let registry = make_registry();

        let e = entry_with_tags(&["cleanup"], "body");
        index_entry(&mut idx, lib.path(), "del.md", &e);

        rename_tag(lib.path(), &idx, &registry, "cleanup", "done").unwrap();

        // No journal files should remain.
        let journal_dir = lib.path().join(".tonotedo").join("journal");
        if journal_dir.exists() {
            let remaining: Vec<_> = std::fs::read_dir(&journal_dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.path()
                        .extension()
                        .and_then(|x| x.to_str())
                        .map(|x| x == "json")
                        .unwrap_or(false)
                })
                .collect();
            assert!(
                remaining.is_empty(),
                "journal files must be deleted on completion; found: {remaining:?}"
            );
        }
    }

    // ── 15. Empty result — no journal file created ────────────────────────────

    #[test]
    fn no_journal_file_for_empty_result() {
        let lib = make_library();
        let mut idx = Index::open_in_memory().unwrap();
        let registry = make_registry();

        // No entries carry the tag.
        let e = entry_with_tags(&["unrelated"], "body");
        index_entry(&mut idx, lib.path(), "noop.md", &e);

        let summary = rename_tag(lib.path(), &idx, &registry, "nonexistent", "whatever").unwrap();
        assert_eq!(summary.files_changed, 0);

        let journal_dir = lib.path().join(".tonotedo").join("journal");
        if journal_dir.exists() {
            let count = std::fs::read_dir(&journal_dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.path()
                        .extension()
                        .and_then(|x| x.to_str())
                        .map(|x| x == "json")
                        .unwrap_or(false)
                })
                .count();
            assert_eq!(
                count, 0,
                "no journal file must be created for a no-op batch"
            );
        }
    }

    // ── 16. Multi-file rename across files ────────────────────────────────────

    #[test]
    fn rename_tag_multi_file() {
        let lib = make_library();
        let mut idx = Index::open_in_memory().unwrap();
        let registry = make_registry();

        for i in 0..5u32 {
            let e = entry_with_tags(&["batch"], &format!("file {i} #batch"));
            index_entry(&mut idx, lib.path(), &format!("f{i}.md"), &e);
        }

        let summary = rename_tag(lib.path(), &idx, &registry, "batch", "batched").unwrap();
        assert_eq!(summary.files_changed, 5);

        for i in 0..5u32 {
            let out = read_entry(lib.path(), &format!("f{i}.md"));
            assert!(out.tags().contains(&"batched".to_string()));
            assert!(!out.tags().contains(&"batch".to_string()));
            assert!(out.body.contains("#batched"));
        }
    }

    // ── 17. Hierarchical child in frontmatter not matched ─────────────────────

    #[test]
    fn rename_tag_frontmatter_no_match_child() {
        // Frontmatter has ["project/atlas", "project"] — renaming "project"
        // must only touch the exact "project" element, not "project/atlas".
        let mut entry = entry_with_tags(&["project/atlas", "project"], "body");
        rewrite_frontmatter_array(&mut entry, "tags", "project", "work");
        let tags = entry.tags();
        assert!(
            tags.contains(&"project/atlas".to_string()),
            "project/atlas must not be renamed"
        );
        assert!(tags.contains(&"work".to_string()));
        assert!(!tags.contains(&"project".to_string()));
    }

    // ── 18. Mention — word boundary (email not rewritten) ─────────────────────

    #[test]
    fn rename_person_word_boundary_in_body() {
        let body = "talk to @sergey and email user@sergey.com today";
        let result = rewrite_body_mentions(body, "sergey", "sergey-k");
        // @sergey → replaced
        assert!(result.contains("@sergey-k"));
        // email@sergey.com → NOT replaced (@ preceded by word char)
        assert!(result.contains("user@sergey.com"));
    }
}
