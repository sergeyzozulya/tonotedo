// Capability-injection support types and host-side enforcement logic
// (design-0002 §"Capability injection", spec 0010 §"Capabilities").
//
// This module holds the parts of capability handling that are independent of the JS
// engine: the constrained render output AST, the entries-owner path/conflict
// enforcement, and the per-plugin "last seen" map that drives the conflict check.
// The runtime module wires these into the injected JS functions.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::core::fswrite::{atomic_write, content_hash};

use super::error::PluginError;

// ── render-code-block constrained output ───────────────────────────────────────
//
// DECISION (design-0002 open question "sanitized HTML vs constrained AST"): we take the
// AST. A `render-code-block` plugin returns a tree of `RenderNode`s — never raw HTML.
// The host serializes this to the UI, which renders it in an isolated container with a
// fixed, whitelisted node→element mapping. A plugin therefore cannot inject arbitrary
// markup, scripts, or attributes: the node kinds below are the entire vocabulary.

/// A constrained render-output node. The closed set is the whitelist (design-0002).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RenderNode {
    /// Plain text run. Rendered as a text node (HTML-escaped by the UI).
    Text { text: String },
    /// Emphasis (italic).
    Emphasis { children: Vec<RenderNode> },
    /// Strong (bold).
    Strong { children: Vec<RenderNode> },
    /// Inline code span.
    Code { text: String },
    /// A block paragraph.
    Paragraph { children: Vec<RenderNode> },
    /// A heading, level clamped to 1..=6 by the host.
    Heading {
        level: u8,
        children: Vec<RenderNode>,
    },
    /// A line break.
    LineBreak,
    /// An unordered list.
    List { items: Vec<Vec<RenderNode>> },
}

/// The full result a `render-code-block` invocation returns to the host.
///
/// A renderer that wants the graceful-fallback path (0010 edge case "renders nothing")
/// returns an empty `nodes` vec; the host then leaves the original code block intact.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct RenderOutput {
    pub nodes: Vec<RenderNode>,
}

impl RenderOutput {
    /// Whether this output is empty (graceful-fallback signal).
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// Recursively clamp heading levels into 1..=6 and bound nesting depth so a
    /// malicious/buggy plugin cannot blow the UI's render stack. Depth over the cap is
    /// flattened to text. This is a host-side sanitization invariant: the UI trusts the
    /// returned tree only because the host already normalized it here.
    pub fn sanitize(&mut self) {
        const MAX_DEPTH: usize = 32;
        fn walk(nodes: &mut Vec<RenderNode>, depth: usize) {
            if depth >= MAX_DEPTH {
                // Collapse anything deeper into a single text marker.
                nodes.clear();
                nodes.push(RenderNode::Text {
                    text: "[render depth exceeded]".to_string(),
                });
                return;
            }
            for node in nodes.iter_mut() {
                match node {
                    RenderNode::Heading { level, children } => {
                        *level = (*level).clamp(1, 6);
                        walk(children, depth + 1);
                    }
                    RenderNode::Emphasis { children }
                    | RenderNode::Strong { children }
                    | RenderNode::Paragraph { children } => walk(children, depth + 1),
                    RenderNode::List { items } => {
                        for item in items.iter_mut() {
                            walk(item, depth + 1);
                        }
                    }
                    RenderNode::Text { .. } | RenderNode::Code { .. } | RenderNode::LineBreak => {}
                }
            }
        }
        walk(&mut self.nodes, 0);
    }
}

// ── command / view registration descriptors ───────────────────────────────────

/// A palette command a plugin registered (0010 §"command" capability).
///
/// The `id` is forced into the plugin's namespace by the runtime (design-0002): the
/// host prepends `<plugin-id>.` so a plugin cannot squat another's command id.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RegisteredCommand {
    /// Namespaced id, e.g. `com.example.git.commit`.
    pub id: String,
    /// Human-readable title for the palette.
    pub title: String,
}

/// A view a plugin registered (0010 §"view" capability).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RegisteredView {
    /// Namespaced view name addressable from a group's `view` property.
    pub name: String,
}

// ── entries-owner enforcement ──────────────────────────────────────────────────

/// The result of an entries-owner write attempt.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WriteOutcome {
    /// The write succeeded.
    Written,
    /// The target was user-modified since the plugin's last read; refused (0010 policy).
    Conflict,
}

/// Per-plugin map of `entries-owner` paths → the content hash the plugin last observed.
///
/// The conflict policy (0010, fixed, non-overridable) is: a plugin may only overwrite an
/// entry whose on-disk content still matches what the plugin last read. If the on-disk
/// hash differs from the recorded last-seen hash, the user (or another process) edited
/// it, and the write is refused with `Conflict`. A fresh create (no prior read, file
/// absent) is allowed.
#[derive(Debug, Default)]
pub struct LastSeenMap {
    inner: Mutex<HashMap<PathBuf, u128>>,
}

impl LastSeenMap {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record the hash observed when the plugin read `path`.
    pub fn observe(&self, path: &Path, hash: u128) {
        if let Ok(mut g) = self.inner.lock() {
            g.insert(path.to_path_buf(), hash);
        }
    }

    /// The last-seen hash for `path`, if any.
    fn last_seen(&self, path: &Path) -> Option<u128> {
        self.inner.lock().ok().and_then(|g| g.get(path).copied())
    }

    /// Forget a path (after a delete).
    fn forget(&self, path: &Path) {
        if let Ok(mut g) = self.inner.lock() {
            g.remove(path);
        }
    }
}

/// The entries-owner API surface, host side. Owns the path prefix (absolute) and the
/// last-seen map; every operation re-checks the prefix.
pub struct EntriesOwner {
    /// Absolute path to the library root.
    library_root: PathBuf,
    /// Library-relative owned subtree (normalized, no slashes at ends).
    owned_prefix: String,
    last_seen: LastSeenMap,
}

impl EntriesOwner {
    pub fn new(library_root: PathBuf, owned_prefix: String) -> Self {
        Self {
            library_root,
            owned_prefix,
            last_seen: LastSeenMap::new(),
        }
    }

    /// Resolve a plugin-supplied library-relative path against the owned subtree, hard-
    /// checking the prefix. Returns the absolute path or `PathOutsidePrefix`.
    ///
    /// INVARIANT: rejects traversal (`..`), absolute inputs, and anything not under the
    /// declared prefix. This is the filesystem boundary for providers (0010 edge case
    /// "writes outside declared paths → refused").
    fn resolve(&self, rel: &str) -> Result<PathBuf, PluginError> {
        let rel = rel.trim_start_matches('/');
        if rel.is_empty() || rel.contains("..") {
            return Err(PluginError::path_outside_prefix(rel));
        }
        // Must be the prefix itself or a descendant of it.
        let under_prefix =
            rel == self.owned_prefix || rel.starts_with(&format!("{}/", self.owned_prefix));
        if !under_prefix {
            return Err(PluginError::path_outside_prefix(rel));
        }
        Ok(self.library_root.join(rel))
    }

    /// Read an owned entry's bytes, recording the observed content hash so a later write
    /// can detect external modification.
    pub fn read(&self, rel: &str) -> Result<Vec<u8>, PluginError> {
        let abs = self.resolve(rel)?;
        let bytes = std::fs::read(&abs).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                PluginError::new(
                    super::error::PluginErrorCode::NotRegistered,
                    format!("entry `{rel}` does not exist"),
                )
            } else {
                PluginError::host_internal(format!("read {rel}: {e}"))
            }
        })?;
        self.last_seen.observe(&abs, content_hash(&bytes));
        Ok(bytes)
    }

    /// Write an owned entry atomically, enforcing the conflict policy.
    ///
    /// Returns `WriteOutcome::Conflict` (NOT an error) when the on-disk content differs
    /// from what the plugin last read — the plugin cannot override this (0010).
    pub fn write(&self, rel: &str, bytes: &[u8]) -> Result<WriteOutcome, PluginError> {
        let abs = self.resolve(rel)?;

        // Conflict check: if the file exists, its current hash must match what the plugin
        // last saw. A file the plugin never read but that exists on disk is also a
        // conflict (the plugin would be clobbering content it never observed).
        if let Ok(existing) = std::fs::read(&abs) {
            let current = content_hash(&existing);
            match self.last_seen.last_seen(&abs) {
                Some(seen) if seen == current => { /* unchanged since read → ok */ }
                _ => return Ok(WriteOutcome::Conflict),
            }
        }

        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| PluginError::host_internal(format!("mkdir for {rel}: {e}")))?;
        }
        atomic_write(&abs, bytes)
            .map_err(|e| PluginError::host_internal(format!("write {rel}: {e}")))?;
        // Record the just-written hash so a subsequent write in the same session is allowed.
        self.last_seen.observe(&abs, content_hash(bytes));
        Ok(WriteOutcome::Written)
    }

    /// Delete an owned entry, enforcing the same conflict policy.
    pub fn delete(&self, rel: &str) -> Result<WriteOutcome, PluginError> {
        let abs = self.resolve(rel)?;
        match std::fs::read(&abs) {
            Ok(existing) => {
                let current = content_hash(&existing);
                match self.last_seen.last_seen(&abs) {
                    Some(seen) if seen == current => {}
                    _ => return Ok(WriteOutcome::Conflict),
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // Already gone — treat as a successful no-op delete.
                return Ok(WriteOutcome::Written);
            }
            Err(e) => return Err(PluginError::host_internal(format!("stat {rel}: {e}"))),
        }
        std::fs::remove_file(&abs)
            .map_err(|e| PluginError::host_internal(format!("delete {rel}: {e}")))?;
        self.last_seen.forget(&abs);
        Ok(WriteOutcome::Written)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn owner(dir: &TempDir) -> EntriesOwner {
        EntriesOwner::new(dir.path().to_path_buf(), "Calendar/Google".to_string())
    }

    #[test]
    fn write_inside_prefix_succeeds() {
        let dir = TempDir::new().unwrap();
        let o = owner(&dir);
        let out = o.write("Calendar/Google/event-1.md", b"# Event\n").unwrap();
        assert_eq!(out, WriteOutcome::Written);
        assert!(dir.path().join("Calendar/Google/event-1.md").exists());
    }

    #[test]
    fn write_outside_prefix_refused() {
        let dir = TempDir::new().unwrap();
        let o = owner(&dir);
        let err = o.write("Other/x.md", b"x").unwrap_err();
        assert_eq!(
            err.code,
            super::super::error::PluginErrorCode::PathOutsidePrefix
        );
    }

    #[test]
    fn traversal_refused() {
        let dir = TempDir::new().unwrap();
        let o = owner(&dir);
        assert!(o.write("Calendar/Google/../../escape.md", b"x").is_err());
    }

    #[test]
    fn conflict_when_file_modified_externally() {
        let dir = TempDir::new().unwrap();
        let o = owner(&dir);
        let rel = "Calendar/Google/event-1.md";
        // Plugin writes, then reads (records hash).
        o.write(rel, b"# Original\n").unwrap();
        o.read(rel).unwrap();
        // External modification.
        std::fs::write(dir.path().join(rel), b"# User edited\n").unwrap();
        // Plugin tries to overwrite → Conflict.
        let out = o.write(rel, b"# Plugin update\n").unwrap();
        assert_eq!(out, WriteOutcome::Conflict);
        // The user's content is untouched.
        let on_disk = std::fs::read(dir.path().join(rel)).unwrap();
        assert_eq!(on_disk, b"# User edited\n");
    }

    #[test]
    fn no_conflict_when_unchanged_since_read() {
        let dir = TempDir::new().unwrap();
        let o = owner(&dir);
        let rel = "Calendar/Google/event-1.md";
        o.write(rel, b"# Original\n").unwrap();
        o.read(rel).unwrap();
        // Overwrite without external change → Written.
        let out = o.write(rel, b"# Updated\n").unwrap();
        assert_eq!(out, WriteOutcome::Written);
    }

    #[test]
    fn write_to_unread_existing_file_is_conflict() {
        let dir = TempDir::new().unwrap();
        let o = owner(&dir);
        let rel = "Calendar/Google/event-1.md";
        std::fs::create_dir_all(dir.path().join("Calendar/Google")).unwrap();
        std::fs::write(dir.path().join(rel), b"# Pre-existing\n").unwrap();
        // Plugin never read it → cannot clobber.
        assert_eq!(o.write(rel, b"x").unwrap(), WriteOutcome::Conflict);
    }

    #[test]
    fn sanitize_clamps_heading_level() {
        let mut out = RenderOutput {
            nodes: vec![RenderNode::Heading {
                level: 99,
                children: vec![RenderNode::Text { text: "x".into() }],
            }],
        };
        out.sanitize();
        if let RenderNode::Heading { level, .. } = &out.nodes[0] {
            assert_eq!(*level, 6);
        } else {
            panic!("expected heading");
        }
    }
}
