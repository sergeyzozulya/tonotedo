// Frontmatter parser and entry file model — spec docs/spec/0002-entries.md, issue #4.
//
// Public API surface:
//   - `Entry`          — parsed .md file (properties + body)
//   - `Value`          — typed property value
//   - `generate_id`    — ULID ID generation
//   - `is_reserved`    — reserved-name predicate
//   - `is_openable_reserved`

mod entry;
mod id;
mod parse;
mod reserved;
mod serialize;
mod value;

pub use entry::Entry;
pub use id::generate_id;
pub use reserved::{has_reserved_component, is_openable_reserved, is_reserved};
pub use serialize::{serialize_frontmatter, BUILTIN_ORDER};
pub use value::{DatetimeValue, RangeEndpoint, RangeValue, Value};

// Re-export parse utilities used by the reconciler (design-0001).
pub use parse::{infer_value, parse_date, parse_datetime, parse_range};
// Raw frontmatter split — used by the plugin host (design-0002) to parse a plugin
// manifest's `plugin.md` frontmatter directly (its schema differs from an entry's).
pub use parse::{split_frontmatter, RawSplit};
pub use serialize::{format_date, format_datetime, format_range};
