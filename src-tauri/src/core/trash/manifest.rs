// Trash manifest: sidecar JSON stored alongside each trashed item.
//
// Layout per trashed item:
//   <library_root>/.tonotedo/trash/<trash_id>/
//       manifest.json            — this struct, serialised
//       <original file or folder name>
//
// The manifest is the source of truth for restore: it carries the original
// relative path (so the item can go back to the right place) and enough
// metadata to display the trash list.

use serde::{Deserialize, Serialize};

/// What kind of item was trashed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrashKind {
    Entry,
    Group,
}

/// Sidecar manifest stored as `manifest.json` inside each trash slot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrashManifest {
    /// Unique identifier for this trash slot (ULID string).
    pub trash_id: String,
    /// Original path relative to the library root (e.g. `work/project/note.md`).
    pub original_rel_path: String,
    /// UTC timestamp of when the item was trashed, RFC 3339 string.
    pub trashed_at: String,
    /// Whether this was a single entry (.md file) or a group (folder).
    pub kind: TrashKind,
}

impl TrashManifest {
    /// Deserialise from JSON bytes.
    pub fn from_json(bytes: &[u8]) -> Result<Self, serde_json::Error> {
        serde_json::from_slice(bytes)
    }

    /// Serialise to a pretty-printed JSON string.
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_round_trip() {
        let m = TrashManifest {
            trash_id: "01ABCDEFGHJKMNPQRSTVWXYZ01".to_string(),
            original_rel_path: "work/project/note.md".to_string(),
            trashed_at: "2026-06-10T12:00:00Z".to_string(),
            kind: TrashKind::Entry,
        };
        let json = m.to_json().expect("serialise");
        let m2 = TrashManifest::from_json(json.as_bytes()).expect("deserialise");
        assert_eq!(m2.trash_id, m.trash_id);
        assert_eq!(m2.original_rel_path, m.original_rel_path);
        assert_eq!(m2.trashed_at, m.trashed_at);
        assert_eq!(m2.kind, TrashKind::Entry);
    }

    #[test]
    fn manifest_round_trip_group() {
        let m = TrashManifest {
            trash_id: "01ABCDEFGHJKMNPQRSTVWXYZ02".to_string(),
            original_rel_path: "work/project".to_string(),
            trashed_at: "2026-06-10T13:00:00Z".to_string(),
            kind: TrashKind::Group,
        };
        let json = m.to_json().expect("serialise");
        let m2 = TrashManifest::from_json(json.as_bytes()).expect("deserialise");
        assert_eq!(m2.kind, TrashKind::Group);
        assert_eq!(m2.original_rel_path, "work/project");
    }

    #[test]
    fn manifest_kind_serialises_snake_case() {
        let m = TrashManifest {
            trash_id: "x".to_string(),
            original_rel_path: "a/b.md".to_string(),
            trashed_at: "2026-01-01T00:00:00Z".to_string(),
            kind: TrashKind::Entry,
        };
        let json = m.to_json().unwrap();
        assert!(
            json.contains("\"entry\""),
            "kind must serialise as snake_case"
        );
    }
}
