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
    ///
    /// SECURITY (review C1): a *lexical* prefix check is insufficient — an in-tree
    /// directory or file symlink under the owned subtree lets a plugin read/write/delete
    /// arbitrary locations outside the library. We therefore canonicalize the deepest
    /// EXISTING ancestor and lexically join the remaining (not-yet-created) components,
    /// then require the canonical result to live under `canonicalize(library_root)/prefix`.
    /// Additionally, ANY existing path component under the prefix that is itself a symlink
    /// is rejected outright (no following symlinks at all within the owned subtree).
    fn resolve(&self, rel: &str) -> Result<PathBuf, PluginError> {
        let rel = rel.trim_start_matches('/');
        if rel.is_empty() || rel.contains("..") {
            return Err(PluginError::path_outside_prefix(rel));
        }
        // RULING (review m4): refuse reserved-component names (`_`/`.`-prefixed) anywhere
        // in the path. Per spec 0002 §"Reserved names" these are app metadata, never
        // entries; an entries-owner plugin must not create or touch them (e.g. a write to
        // `Calendar/Google/_group.md` or a `.`-dotfile). The owned prefix itself is
        // operator-declared and already excludes `.tonotedo` (manifest normalization), so
        // we only screen the plugin-supplied path here.
        if crate::core::frontmatter::has_reserved_component(rel) {
            return Err(PluginError::path_outside_prefix(rel));
        }
        // Must be the prefix itself or a descendant of it (cheap lexical pre-check).
        let under_prefix =
            rel == self.owned_prefix || rel.starts_with(&format!("{}/", self.owned_prefix));
        if !under_prefix {
            return Err(PluginError::path_outside_prefix(rel));
        }

        // The lexical (non-canonical) absolute target.
        let lexical = self.library_root.join(rel);

        // Reject if any EXISTING component under the prefix is a symlink. We walk from the
        // library root down the lexical path and `symlink_metadata` each component; a
        // symlink anywhere is refused (don't follow links inside the owned subtree at all).
        {
            let mut probe = self.library_root.clone();
            for comp in Path::new(rel).components() {
                let std::path::Component::Normal(seg) = comp else {
                    // `..`/absolute were already rejected; only Normal is expected here.
                    return Err(PluginError::path_outside_prefix(rel));
                };
                probe.push(seg);
                match std::fs::symlink_metadata(&probe) {
                    Ok(md) if md.file_type().is_symlink() => {
                        return Err(PluginError::path_outside_prefix(rel));
                    }
                    Ok(_) => {}
                    // Component doesn't exist yet (and nothing beyond it can either): stop.
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                    Err(_) => return Err(PluginError::path_outside_prefix(rel)),
                }
            }
        }

        // Canonicalize the deepest existing ancestor, then lexically re-join the remainder
        // (the tail that does not yet exist). This collapses any symlink the library_root
        // itself may sit behind while still producing a path for not-yet-created files.
        let canon_root = self
            .library_root
            .canonicalize()
            .map_err(|_| PluginError::path_outside_prefix(rel))?;
        let mut existing = lexical.clone();
        let mut tail: Vec<std::ffi::OsString> = Vec::new();
        let resolved = loop {
            match existing.canonicalize() {
                Ok(c) => {
                    let mut out = c;
                    for seg in tail.iter().rev() {
                        out.push(seg);
                    }
                    break out;
                }
                Err(_) => {
                    // Pop the last component into `tail` and retry on the parent.
                    let Some(name) = existing.file_name().map(|n| n.to_os_string()) else {
                        return Err(PluginError::path_outside_prefix(rel));
                    };
                    tail.push(name);
                    if !existing.pop() {
                        return Err(PluginError::path_outside_prefix(rel));
                    }
                }
            }
        };

        // Final containment: the canonical result must be the owned subtree or under it.
        let canon_prefix = canon_root.join(&self.owned_prefix);
        if resolved != canon_prefix && !resolved.starts_with(&canon_prefix) {
            return Err(PluginError::path_outside_prefix(rel));
        }
        Ok(resolved)
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

    // ── C1: directory/file symlink escape from the owned subtree ────────────────
    //
    // These reproduce the reviewer's exploit: an in-tree symlink whose target is OUTSIDE
    // the library lets a plugin read/write/delete arbitrary locations through a path that
    // is lexically under the owned prefix. The fix canonicalizes + refuses symlink
    // components, so each operation is refused with PathOutsidePrefix.

    #[cfg(unix)]
    fn symlink(src: &Path, dst: &Path) {
        std::os::unix::fs::symlink(src, dst).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn dir_symlink_escape_read_refused() {
        let lib = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        // Secret file outside the library.
        std::fs::write(outside.path().join("secret.md"), b"TOP SECRET\n").unwrap();
        // In-tree directory symlink under the owned prefix → points outside the library.
        std::fs::create_dir_all(lib.path().join("Calendar")).unwrap();
        symlink(outside.path(), &lib.path().join("Calendar/Google"));

        let o = owner(&lib);
        let err = o.read("Calendar/Google/secret.md").unwrap_err();
        assert_eq!(
            err.code,
            super::super::error::PluginErrorCode::PathOutsidePrefix
        );
    }

    #[cfg(unix)]
    #[test]
    fn dir_symlink_escape_write_refused() {
        let lib = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        std::fs::create_dir_all(lib.path().join("Calendar")).unwrap();
        symlink(outside.path(), &lib.path().join("Calendar/Google"));

        let o = owner(&lib);
        let err = o.write("Calendar/Google/pwned.md", b"x").unwrap_err();
        assert_eq!(
            err.code,
            super::super::error::PluginErrorCode::PathOutsidePrefix
        );
        assert!(!outside.path().join("pwned.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn dir_symlink_escape_delete_refused() {
        let lib = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        std::fs::write(outside.path().join("victim.md"), b"keep me\n").unwrap();
        std::fs::create_dir_all(lib.path().join("Calendar")).unwrap();
        symlink(outside.path(), &lib.path().join("Calendar/Google"));

        let o = owner(&lib);
        let err = o.delete("Calendar/Google/victim.md").unwrap_err();
        assert_eq!(
            err.code,
            super::super::error::PluginErrorCode::PathOutsidePrefix
        );
        // The outside file is untouched.
        assert!(outside.path().join("victim.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn file_symlink_write_refused() {
        // The target file itself is a symlink pointing outside the library. A naive write
        // would follow it (atomic_write's rename only *accidentally* masks some cases — we
        // must not rely on that). The symlink-component check refuses it explicitly.
        let lib = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        std::fs::write(outside.path().join("target.md"), b"original\n").unwrap();
        std::fs::create_dir_all(lib.path().join("Calendar/Google")).unwrap();
        symlink(
            &outside.path().join("target.md"),
            &lib.path().join("Calendar/Google/link.md"),
        );

        let o = owner(&lib);
        let err = o.write("Calendar/Google/link.md", b"pwned\n").unwrap_err();
        assert_eq!(
            err.code,
            super::super::error::PluginErrorCode::PathOutsidePrefix
        );
        // The outside target is unchanged.
        assert_eq!(
            std::fs::read(outside.path().join("target.md")).unwrap(),
            b"original\n"
        );
    }

    #[test]
    fn normal_nested_paths_still_work() {
        // The hardening must not break ordinary nested writes/reads under the prefix.
        let dir = TempDir::new().unwrap();
        let o = owner(&dir);
        let rel = "Calendar/Google/2026/06/event.md";
        assert_eq!(o.write(rel, b"# Event\n").unwrap(), WriteOutcome::Written);
        assert_eq!(o.read(rel).unwrap(), b"# Event\n".to_vec());
        assert_eq!(o.delete(rel).unwrap(), WriteOutcome::Written);
    }

    #[test]
    fn reserved_component_refused() {
        // m4: `_`/`.`-prefixed components are app metadata, never plugin entries.
        let dir = TempDir::new().unwrap();
        let o = owner(&dir);
        for rel in [
            "Calendar/Google/_group.md",
            "Calendar/Google/.hidden.md",
            "Calendar/Google/_sub/x.md",
        ] {
            let err = o.write(rel, b"x").unwrap_err();
            assert_eq!(
                err.code,
                super::super::error::PluginErrorCode::PathOutsidePrefix,
                "{rel}"
            );
        }
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
