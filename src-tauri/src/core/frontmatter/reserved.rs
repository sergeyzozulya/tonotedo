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
}
