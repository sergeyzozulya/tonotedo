// Reserved-name helpers per spec 0002 §"Reserved names".
//
// Files/folders whose names start with `_` or `.` are app metadata, not entries.
// The one exception: `_group.md` is openable/editable (but still excluded from lists).
//
// Note: this module operates on *file/folder names* (basenames), not on property keys.

/// Returns `true` if the given filename or folder name is a reserved app-metadata name.
///
/// Reserved: names starting with `_` or `.`.
/// Exception: `_group.md` is reserved but *openable* — `is_reserved` still returns `true`
/// for it; callers use `is_openable_reserved` to handle the distinction.
pub fn is_reserved(name: &str) -> bool {
    name.starts_with('_') || name.starts_with('.')
}

/// Returns `true` if the name is reserved but still openable and editable as an entry
/// (currently only `_group.md` per spec 0002 and spec 0003).
pub fn is_openable_reserved(name: &str) -> bool {
    name == "_group.md"
}

/// Returns `true` if `rel_path` (a `/`-separated library-relative path) contains
/// any reserved (`_`- or `.`-prefixed) path COMPONENT — at any depth.
///
/// This is the gate used by the walker, the watcher, and the reconcile upsert
/// guard: a file is NOT an entry if it (or any ancestor directory under the
/// library root) is reserved.  Examples that are reserved: `_people/sergey.md`,
/// `sub/_group.md`, `.trash/x.md`, `_searches.md`.
///
/// The two root-level projection files (`_tags.md`, `_people.md`) ARE reserved
/// by this predicate; the reconciler special-cases them BEFORE consulting it.
pub fn has_reserved_component(rel_path: &str) -> bool {
    rel_path
        .split('/')
        .filter(|c| !c.is_empty())
        .any(is_reserved)
}

/// Validate a user-supplied, library-relative path before it is joined onto the
/// library root for a filesystem operation (security: final-review F1–F4).
///
/// Rejects anything that could escape the library or touch app metadata:
///   - empty
///   - absolute (`/foo`, leading `\`, or a Windows drive prefix)
///   - any `..` component (parent traversal)
///   - any reserved component (`_`- or `.`-prefixed — app metadata, never entries)
///
/// With absolute paths and `..` both rejected, `library_root.join(path)` is
/// guaranteed to stay lexically under `library_root`, so no post-join
/// canonicalization is needed for the boundary guarantee.
pub fn is_safe_rel_path(rel_path: &str) -> bool {
    if rel_path.is_empty() {
        return false;
    }
    if rel_path.starts_with('/')
        || rel_path.starts_with('\\')
        || std::path::Path::new(rel_path).is_absolute()
    {
        return false;
    }
    for comp in rel_path.split(['/', '\\']) {
        if comp.is_empty() || comp == ".." || is_reserved(comp) {
            return false;
        }
    }
    true
}

/// Like [`is_safe_rel_path`] but WITHOUT the reserved-component rejection.
///
/// For commands that legitimately operate on app-metadata files — `_group.md`
/// is openable/editable as an entry (spec 0003) and avatars live under
/// `_people/` — but must still never escape the library root. Rejects:
///   - empty
///   - absolute (`/foo`, leading `\`, or a Windows drive prefix)
///   - any empty, `.`, or `..` component
///
/// Same lexical-containment guarantee as `is_safe_rel_path`: with absolute
/// paths and `..` rejected, `library_root.join(path)` stays under the root.
pub fn is_traversal_safe_rel_path(rel_path: &str) -> bool {
    if rel_path.is_empty() {
        return false;
    }
    if rel_path.starts_with('/')
        || rel_path.starts_with('\\')
        || std::path::Path::new(rel_path).is_absolute()
    {
        return false;
    }
    for comp in rel_path.split(['/', '\\']) {
        if comp.is_empty() || comp == "." || comp == ".." {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn underscore_prefix_is_reserved() {
        assert!(is_reserved("_group.md"));
        assert!(is_reserved("_tags.md"));
        assert!(is_reserved("_people.md"));
        assert!(is_reserved("_people"));
        assert!(is_reserved("_settings.md"));
        assert!(is_reserved("_assets"));
        assert!(is_reserved("_searches.md"));
    }

    #[test]
    fn dot_prefix_is_reserved() {
        assert!(is_reserved(".hidden"));
        assert!(is_reserved(".DS_Store"));
        assert!(is_reserved(".tonotedo"));
    }

    #[test]
    fn normal_names_not_reserved() {
        assert!(!is_reserved("my-note.md"));
        assert!(!is_reserved("recipes"));
        assert!(!is_reserved("group.md"));
        assert!(!is_reserved("README.md"));
    }

    #[test]
    fn group_md_is_reserved() {
        // _group.md IS reserved (excluded from lists/search).
        assert!(is_reserved("_group.md"));
    }

    #[test]
    fn group_md_is_openable() {
        // _group.md is the only openable-reserved name.
        assert!(is_openable_reserved("_group.md"));
        assert!(!is_openable_reserved("_tags.md"));
        assert!(!is_openable_reserved("_people.md"));
        assert!(!is_openable_reserved("normal.md"));
    }

    #[test]
    fn empty_name_not_reserved() {
        assert!(!is_reserved(""));
    }

    #[test]
    fn reserved_component_detected_at_any_depth() {
        assert!(has_reserved_component("_people/sergey.md"));
        assert!(has_reserved_component("sub/_group.md"));
        assert!(has_reserved_component("a/b/_searches.md"));
        assert!(has_reserved_component(".trash/x.md"));
        assert!(has_reserved_component("_tags.md"));
    }

    #[test]
    fn reserved_component_absent_for_normal_paths() {
        assert!(!has_reserved_component("note.md"));
        assert!(!has_reserved_component("Work/Atlas/note.md"));
        assert!(!has_reserved_component("a/b/c.md"));
    }

    #[test]
    fn traversal_safe_rejects_escapes() {
        assert!(!is_traversal_safe_rel_path(""));
        assert!(!is_traversal_safe_rel_path("/tmp/evil"));
        assert!(!is_traversal_safe_rel_path("\\tmp\\evil"));
        assert!(!is_traversal_safe_rel_path("../../../../tmp/evil"));
        assert!(!is_traversal_safe_rel_path("work/../../../evil"));
        assert!(!is_traversal_safe_rel_path("work/./note"));
        assert!(!is_traversal_safe_rel_path("work//note"));
        assert!(!is_traversal_safe_rel_path("work\\..\\evil"));
    }

    #[test]
    fn traversal_safe_allows_reserved_components() {
        // Unlike is_safe_rel_path: _group.md opens as an entry (spec 0003) and
        // avatars live under _people/ — these must pass.
        assert!(is_traversal_safe_rel_path("work/_group"));
        assert!(is_traversal_safe_rel_path("_people.md"));
        assert!(is_traversal_safe_rel_path("_people/sergey.png"));
        assert!(is_traversal_safe_rel_path("work/atlas/overview"));
        assert!(is_traversal_safe_rel_path("note"));
    }
}
