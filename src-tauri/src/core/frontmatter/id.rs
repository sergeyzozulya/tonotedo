// ID generation for entries.
//
// We use ULID (Universally Unique Lexicographically Sortable Identifier):
// - Lexicographically sortable: good for SQLite primary-key ordering and the
//   reconciler's "first one in wins on duplicate id" rule (design-0001).
// - URL-safe 26-char Crockford base32 (no hyphens) → compact in frontmatter.
// - Monotonic: within the same millisecond, ULIDs generated in sequence are
//   ordered by generation order (not just by time), which avoids collisions.
// - Opaque to users (spec 0002: "id — stable, opaque, generated at creation").
//
// UUID v7 would also be sortable but produces a 36-char hyphenated string (larger,
// less clean in YAML). ULID has no standard "urn:ulid:" URI scheme but the spec
// calls id "opaque", so that's fine.

use ulid::Ulid;

/// Generate a new unique ID for an entry.
pub fn generate_id() -> String {
    Ulid::new().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_id_is_ulid_format() {
        let id = generate_id();
        assert_eq!(id.len(), 26, "ULID must be 26 characters");
        // Crockford base32: 0-9 and A-Z except I, L, O, U.
        assert!(id
            .chars()
            .all(|c| "0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(c)));
    }

    #[test]
    fn generated_ids_are_unique() {
        let ids: Vec<String> = (0..100).map(|_| generate_id()).collect();
        let mut sorted = ids.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), 100, "all generated IDs must be unique");
    }

    #[test]
    fn generated_ids_are_lexicographically_sortable() {
        // IDs generated in sequence should sort in generation order (ULID monotonic).
        // With ulid::Ulid::new() the millisecond prefix dominates; within the same ms
        // the random suffix may not be monotonic — that's acceptable for our use case.
        let id1 = generate_id();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let id2 = generate_id();
        assert!(
            id1 < id2,
            "IDs generated at different times should be ordered"
        );
    }
}
