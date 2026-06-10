// fswrite — atomic write path and self-write token registry.
//
// Issue: #7 (atomic write path + self-write token).
// Spec: docs/spec/0006-markdown-editor.md
// Design: docs/tech/design-0001-index-and-reconciliation.md
//         docs/tech/design-0004-ipc-boundary.md
//
// Public API:
//   atomic_write(path, bytes)         — crash-safe write (temp + fsync + rename)
//   normalize_for_write(text)         — \n-normalize line endings (call only on edited buffers)
//   content_hash(bytes)               — xxh3-128 hash; shared with reconciler + index
//   TokenRegistry                     — thread-safe self-write token store
//   WriteToken                        — opaque token returned to the caller
//   write_entry(path, entry, schema)  — compose + atomic_write + issue_token
//   WriteError                        — error type for this module

mod atomic;
mod hash;
mod lineend;
mod token;

pub use atomic::atomic_write;
pub use hash::content_hash;
pub use lineend::normalize_for_write;
pub use token::{TokenRegistry, WriteToken, DEFAULT_TOKEN_TTL};

use std::path::Path;

use crate::core::frontmatter::Entry;

/// Error type for atomic write operations.
#[derive(Debug)]
pub enum WriteError {
    Io(std::io::Error),
}

impl std::fmt::Display for WriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WriteError::Io(e) => write!(f, "I/O error during atomic write: {e}"),
        }
    }
}

impl std::error::Error for WriteError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            WriteError::Io(e) => Some(e),
        }
    }
}

impl From<std::io::Error> for WriteError {
    fn from(e: std::io::Error) -> Self {
        WriteError::Io(e)
    }
}

/// Serialize `entry` to bytes, write atomically to `path`, and issue a self-write token.
///
/// `schema_order` is forwarded to `Entry::to_bytes` for canonical frontmatter key ordering
/// (pass `&[]` when no group schema is available).
///
/// `registry` must be the shared `TokenRegistry` used by the reconciler so that the token
/// issued here is the one the reconciler will test with `consume_if_match`.
///
/// Returns the issued `WriteToken`; forward it to the originating view so it can suppress
/// its own echo (design-0001 §"Interfaces", design-0004 §"Self-write token").
pub fn write_entry(
    path: &Path,
    entry: &Entry,
    schema_order: &[&str],
    registry: &TokenRegistry,
) -> Result<WriteToken, WriteError> {
    let bytes = entry.to_bytes(schema_order);
    atomic_write(path, &bytes)?;
    let token = registry.issue_token(path, &bytes);
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::frontmatter::Entry;
    use std::collections::BTreeMap;
    use tempfile::TempDir;

    fn tmpdir() -> TempDir {
        tempfile::tempdir().expect("failed to create temp dir")
    }

    // ── write_entry round-trip ───────────────────────────────────────────────

    #[test]
    fn write_entry_creates_parseable_file() {
        let dir = tmpdir();
        let path = dir.path().join("note.md");
        let registry = TokenRegistry::with_default_ttl();

        let src = b"---\nid: test123\ntags:\n  - rust\n---\n# Hello\n\nBody.\n";
        let entry = Entry::from_bytes(src);
        let token = write_entry(&path, &entry, &[], &registry).unwrap();

        // File must exist and be parseable.
        let bytes = std::fs::read(&path).unwrap();
        let parsed = Entry::from_bytes(&bytes);
        assert_eq!(parsed.id(), Some("test123"));
        assert_eq!(parsed.tags(), &["rust"]);

        // Token must be pending in registry.
        assert!(
            registry.consume_if_match(&path, &bytes),
            "token {token} must be consumable with matching hash"
        );
    }

    #[test]
    fn write_entry_issues_token_that_matches_written_bytes() {
        let dir = tmpdir();
        let path = dir.path().join("note.md");
        let registry = TokenRegistry::with_default_ttl();

        let entry = Entry {
            properties: BTreeMap::new(),
            body: "# Simple\n".to_string(),
            parse_warning: None,
        };
        write_entry(&path, &entry, &[], &registry).unwrap();

        let written = std::fs::read(&path).unwrap();
        // consume_if_match must succeed exactly once.
        assert!(registry.consume_if_match(&path, &written));
        assert!(!registry.consume_if_match(&path, &written)); // single-consume
    }

    #[test]
    fn write_entry_token_does_not_match_different_content() {
        let dir = tmpdir();
        let path = dir.path().join("note.md");
        let registry = TokenRegistry::with_default_ttl();

        let entry = Entry {
            properties: BTreeMap::new(),
            body: "# Hello\n".to_string(),
            parse_warning: None,
        };
        write_entry(&path, &entry, &[], &registry).unwrap();

        // Different content hash → not a self-write echo.
        assert!(!registry.consume_if_match(&path, b"completely different bytes"));
    }

    // ── WriteError display / source ──────────────────────────────────────────

    #[test]
    fn write_error_display() {
        let e = WriteError::Io(std::io::Error::new(std::io::ErrorKind::NotFound, "test"));
        let s = format!("{e}");
        assert!(s.contains("I/O error"));
    }

    #[test]
    fn write_error_source_is_io_error() {
        use std::error::Error;
        let e = WriteError::Io(std::io::Error::new(std::io::ErrorKind::NotFound, "test"));
        assert!(e.source().is_some());
    }
}
