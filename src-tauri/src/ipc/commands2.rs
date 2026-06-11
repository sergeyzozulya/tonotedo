// IPC second wave — issue #32.
//
// Commands implemented here:
//   Group 1 — Assets:         attach_file, asset_url, asset_exists, remove_asset
//   Group 2 — Saved searches: saved_searches_get, saved_searches_set
//   Group 3 — People/tags:    set_person, delete_person, mentions_for,
//                              rename_tag, merge_tag, delete_tag,
//                              rename_person, merge_person
//   Group 4 — Calendar:       calendar_window
//   Group 5 — Settings:       settings_get_user, set_user, settings_get_library, set_library
//   Group 6 — Groups:         list_groups
//
// Testing pattern: same as ipc/tests.rs — a `Fixture2` helper calls functions
// directly without going through the Tauri runtime.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use saphyr::{LoadableYamlNode, MappingOwned, YamlOwned};

use crate::core::{
    frontmatter::Entry,
    fswrite::atomic_write,
    index::Index,
    journal,
    recurrence::{
        overrides::expand_with_overrides,
        parse_rrule,
        types::{ParseResult, StartDate},
    },
};

use super::{AppState, IpcError, OpenLibrary};

// Re-use the summary DTO and helper types from the parent module.
use super::{people_for_entry, split_group_slug, tags_for_entry, EntrySummaryDto};

type CmdResult<T> = Result<T, IpcError>;

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Acquire the guard and return a typed error when no library is open.
macro_rules! require_open {
    ($state:expr) => {{
        $state
            .0
            .lock()
            .map_err(|_| IpcError::io("State lock poisoned".to_string()))?
    }};
}

// ── Group 6: list_groups ──────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct GroupMetaDto {
    pub path: String,
    pub name: String,
    pub count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// `list_groups()` — all groups in the library as a flat list.
///
/// Derived from the `entries.group_path` column in the index.  Intermediate
/// path segments (ancestors) are included even if they have no direct entries.
#[tauri::command]
pub fn list_groups(state: State<'_, AppState>) -> CmdResult<Vec<GroupMetaDto>> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    list_groups_inner(lib)
}

pub fn list_groups_inner(lib: &OpenLibrary) -> CmdResult<Vec<GroupMetaDto>> {
    let rows = lib
        .index
        .entries_in_group("")
        .map_err(|e| IpcError::io(format!("list_groups failed: {e}")))?;

    // Collect counts per exact group_path.
    let mut counts: std::collections::BTreeMap<String, u64> = std::collections::BTreeMap::new();
    for row in &rows {
        *counts.entry(row.group_path.clone()).or_default() += 1;
    }

    // Also register intermediate path segments.
    let group_paths: Vec<String> = counts.keys().cloned().collect();
    for path in &group_paths {
        let parts: Vec<&str> = path.split('/').collect();
        for i in 1..parts.len() {
            let ancestor = parts[..i].join("/");
            counts.entry(ancestor).or_default();
        }
    }

    // Augment with group_meta data (name/color/order from _group.md).
    let all_meta = lib.index.all_group_meta().unwrap_or_default();
    let meta_map: std::collections::HashMap<String, crate::core::index::GroupMetaRow> =
        all_meta.into_iter().map(|r| (r.path.clone(), r)).collect();

    let result = counts
        .into_iter()
        .filter(|(p, _)| !p.is_empty())
        .map(|(path, count)| {
            let default_name = path.split('/').next_back().unwrap_or(&path).to_string();
            let (name, color, order) = if let Some(meta) = meta_map.get(&path) {
                (
                    meta.name.clone().unwrap_or(default_name),
                    meta.color.clone(),
                    meta.sort_order,
                )
            } else {
                (default_name, None, None)
            };
            GroupMetaDto {
                path,
                name,
                count,
                order,
                color,
            }
        })
        .collect();

    Ok(result)
}

// ── effective_schema ──────────────────────────────────────────────────────────

/// `effective_schema(group_path)` — merged property schema for a group's
/// ancestor chain.  Child overrides parent.
///
/// Returns the JSON-encoded property schema map, or `null` when no group in
/// the chain has a schema defined.
#[tauri::command]
pub fn effective_schema(
    group_path: String,
    state: State<'_, AppState>,
) -> CmdResult<Option<String>> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    lib.index
        .effective_schema(&group_path)
        .map_err(|e| IpcError::io(format!("effective_schema failed: {e}")))
}

// ── Group 1: Assets ───────────────────────────────────────────────────────────

/// `attach_file(entryPath, name, bytes)` — write bytes into `<group>/<assetFolder>/` with
/// collision-safe naming (append -2, -3, … before the extension).
/// The asset folder name is read from `_settings.md` (key `asset_folder`; default `_assets`).
///
/// Returns the vault-relative `AssetPath`.
#[tauri::command]
pub fn attach_file(
    entry_path: String,
    name: String,
    bytes: Vec<u8>,
    state: State<'_, AppState>,
) -> CmdResult<String> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    let folder = get_asset_folder_name(&lib.root);
    attach_file_inner(&lib.root, &entry_path, &name, &bytes, &folder)
}

pub fn attach_file_inner(
    root: &Path,
    entry_path: &str,
    name: &str,
    bytes: &[u8],
    asset_folder: &str,
) -> CmdResult<String> {
    // Validate the asset folder name: must not be empty, must not contain
    // path separators or start with reserved chars.
    if asset_folder.is_empty()
        || asset_folder.contains('/')
        || asset_folder.contains('\\')
        || asset_folder.contains("..")
    {
        return Err(IpcError::invalid_argument(format!(
            "Invalid asset folder name: {asset_folder:?}"
        )));
    }

    // Derive the entry's group directory.
    let group_dir = if entry_path.contains('/') {
        let slash = entry_path.rfind('/').unwrap();
        &entry_path[..slash]
    } else {
        ""
    };
    let assets_rel = if group_dir.is_empty() {
        asset_folder.to_string()
    } else {
        format!("{group_dir}/{asset_folder}")
    };
    let assets_abs = root.join(&assets_rel);
    std::fs::create_dir_all(&assets_abs)
        .map_err(|e| IpcError::io(format!("Cannot create {asset_folder} dir: {e}")))?;

    // Collision-safe candidate selection.
    let candidate_rel = collision_safe_path(&assets_rel, name, |rel| root.join(rel).exists());

    let abs_dest = root.join(&candidate_rel);
    atomic_write(&abs_dest, bytes).map_err(|e| IpcError::io(format!("Cannot write asset: {e}")))?;

    Ok(candidate_rel)
}

/// Read the asset folder name from `_settings.md` (key `asset_folder`).
/// Returns `"_assets"` when the file is missing or the key is not set.
fn get_asset_folder_name(root: &Path) -> String {
    settings_get_library_inner(root)
        .ok()
        .and_then(|v| {
            v.get("asset_folder")
                .and_then(|v| v.as_str().map(|s| s.to_string()))
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "_assets".to_string())
}

/// Build a collision-safe asset path: if `<assets>/<name>` exists, try
/// `<assets>/<base>-2.<ext>`, `-3`, … until a free slot is found.
fn collision_safe_path(assets_rel: &str, name: &str, exists: impl Fn(&str) -> bool) -> String {
    let candidate = format!("{assets_rel}/{name}");
    if !exists(&candidate) {
        return candidate;
    }
    let dot = name.rfind('.');
    let (base, ext) = if let Some(d) = dot {
        (&name[..d], &name[d..])
    } else {
        (name, "")
    };
    let mut n: u32 = 2;
    loop {
        let c = format!("{assets_rel}/{base}-{n}{ext}");
        if !exists(&c) {
            return c;
        }
        n += 1;
    }
}

/// `asset_url(assetPath)` — return the absolute filesystem path.
///
/// The frontend calls `convertFileSrc(path)` to convert this to a Tauri
/// asset-protocol URL before using it in `<img src>`.
///
/// Per design-0004 §"asset binary rule", binary data never crosses IPC.
/// The frontend uses the asset protocol to load the file directly.
#[tauri::command]
pub fn asset_url(asset_path: String, state: State<'_, AppState>) -> CmdResult<String> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    asset_url_inner(&lib.root, &asset_path)
}

pub fn asset_url_inner(root: &Path, asset_path: &str) -> CmdResult<String> {
    let abs = root.join(asset_path);
    if !abs.exists() {
        return Err(IpcError::not_found(format!(
            "Asset not found: {asset_path}"
        )));
    }
    abs.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| IpcError::io("Asset path is not valid UTF-8".to_string()))
}

/// `asset_exists(assetPath)` — true when the file is present on disk.
#[tauri::command]
pub fn asset_exists(asset_path: String, state: State<'_, AppState>) -> CmdResult<bool> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    Ok(lib.root.join(&asset_path).exists())
}

/// `remove_asset(assetPath)` — delete the asset file from disk.
#[tauri::command]
pub fn remove_asset(asset_path: String, state: State<'_, AppState>) -> CmdResult<()> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    remove_asset_inner(&lib.root, &asset_path)
}

pub fn remove_asset_inner(root: &Path, asset_path: &str) -> CmdResult<()> {
    let abs = root.join(asset_path);
    if !abs.exists() {
        return Err(IpcError::not_found(format!(
            "Asset not found: {asset_path}"
        )));
    }
    std::fs::remove_file(&abs)
        .map_err(|e| IpcError::io(format!("Cannot remove asset {asset_path}: {e}")))?;
    Ok(())
}

// ── Group 2: Saved searches ───────────────────────────────────────────────────

/// A single saved-search filter (matches types.ts `SavedSearchFilter`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SavedSearchFilterDto {
    Tag { values: Vec<String> },
    Group { path: String },
}

/// A saved search (matches types.ts `SavedSearch`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SavedSearchDto {
    pub name: String,
    pub text: String,
    pub filters: Vec<SavedSearchFilterDto>,
}

/// `saved_searches_get()` — read `_searches.md` frontmatter.
///
/// Returns an empty list when the file does not exist.
#[tauri::command]
pub fn saved_searches_get(state: State<'_, AppState>) -> CmdResult<Vec<SavedSearchDto>> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    saved_searches_get_inner(&lib.root)
}

pub fn saved_searches_get_inner(root: &Path) -> CmdResult<Vec<SavedSearchDto>> {
    let path = root.join("_searches.md");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes =
        std::fs::read(&path).map_err(|e| IpcError::io(format!("Cannot read _searches.md: {e}")))?;
    let entry = Entry::from_bytes(&bytes);
    parse_saved_searches_from_entry(&entry)
}

fn parse_saved_searches_from_entry(entry: &Entry) -> CmdResult<Vec<SavedSearchDto>> {
    // The `searches` property is stored as an Opaque or Tags value depending on shape.
    use crate::core::frontmatter::Value;
    let prop = entry.properties.get("searches");
    if prop.is_none() {
        return Ok(Vec::new());
    }
    // Arrays-of-maps are stored as Value::Tags(["{...}", "..."]) by infer_value.
    let yaml_text = match prop.unwrap() {
        Value::Opaque(s) => s.clone(),
        Value::Tags(items) => format!("[{}]", items.join(", ")),
        _ => return Ok(Vec::new()),
    };
    parse_searches_yaml(&yaml_text)
        .map_err(|e| IpcError::parse(format!("Cannot parse _searches.md searches: {e}")))
}

fn parse_searches_yaml(yaml: &str) -> Result<Vec<SavedSearchDto>, String> {
    let docs = YamlOwned::load_from_str(yaml).map_err(|e| format!("YAML parse error: {e}"))?;
    let doc = match docs.into_iter().next() {
        Some(d) => d,
        None => return Ok(Vec::new()),
    };
    let items = match doc.as_vec() {
        Some(v) => v.clone(),
        None => return Ok(Vec::new()),
    };
    let mut result = Vec::new();
    for item in &items {
        let map = match item.as_mapping() {
            Some(m) => m,
            None => continue,
        };
        let name = yaml_str_owned(map, "name").unwrap_or_default();
        let text = yaml_str_owned(map, "text").unwrap_or_default();
        let filters_raw = map
            .iter()
            .find(|(k, _)| k.as_str() == Some("filters"))
            .and_then(|(_, v)| v.as_vec().cloned());
        let mut filters = Vec::new();
        if let Some(farr) = filters_raw {
            for f in &farr {
                if let Some(filter) = parse_filter_yaml_owned(f) {
                    filters.push(filter);
                }
            }
        }
        result.push(SavedSearchDto {
            name,
            text,
            filters,
        });
    }
    Ok(result)
}

fn parse_filter_yaml_owned(v: &YamlOwned) -> Option<SavedSearchFilterDto> {
    let map = v.as_mapping()?;
    let kind = yaml_str_owned(map, "kind")?;
    match kind.as_str() {
        "tag" => {
            let values = map
                .iter()
                .find(|(k, _)| k.as_str() == Some("values"))
                .and_then(|(_, v)| v.as_vec().cloned())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            Some(SavedSearchFilterDto::Tag { values })
        }
        "group" => {
            let path = yaml_str_owned(map, "path")?;
            Some(SavedSearchFilterDto::Group { path })
        }
        _ => None,
    }
}

fn yaml_str_owned(map: &MappingOwned, key: &str) -> Option<String> {
    map.iter()
        .find(|(k, _)| k.as_str() == Some(key))
        .and_then(|(_, v)| v.as_str().map(|s| s.to_string()))
}

/// `saved_searches_set(searches)` — overwrite `_searches.md` frontmatter.
///
/// Preserves any existing body text; creates the file if it doesn't exist.
/// Writes the exact 0009 YAML shape.
#[tauri::command]
pub fn saved_searches_set(
    searches: Vec<SavedSearchDto>,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    saved_searches_set_inner(&lib.root, &searches)
}

pub fn saved_searches_set_inner(root: &Path, searches: &[SavedSearchDto]) -> CmdResult<()> {
    let path = root.join("_searches.md");

    // Preserve existing body text.
    let existing_body = if path.exists() {
        let bytes = std::fs::read(&path)
            .map_err(|e| IpcError::io(format!("Cannot read _searches.md: {e}")))?;
        let entry = Entry::from_bytes(&bytes);
        entry.body.clone()
    } else {
        String::new()
    };

    let yaml = serialize_searches_yaml(searches);
    let content = format!("---\nsearches:\n{yaml}---\n{existing_body}");
    atomic_write(&path, content.as_bytes())
        .map_err(|e| IpcError::io(format!("Cannot write _searches.md: {e}")))?;
    Ok(())
}

fn serialize_searches_yaml(searches: &[SavedSearchDto]) -> String {
    if searches.is_empty() {
        return "  []\n".to_string();
    }
    let mut out = String::new();
    for s in searches {
        out.push_str(&format!("  - name: {}\n", yaml_quote(&s.name)));
        out.push_str(&format!("    text: {}\n", yaml_quote(&s.text)));
        if s.filters.is_empty() {
            out.push_str("    filters: []\n");
        } else {
            out.push_str("    filters:\n");
            for f in &s.filters {
                match f {
                    SavedSearchFilterDto::Tag { values } => {
                        let vals = values
                            .iter()
                            .map(|v| yaml_quote(v))
                            .collect::<Vec<_>>()
                            .join(", ");
                        out.push_str(&format!("      - {{ kind: tag, values: [{vals}] }}\n"));
                    }
                    SavedSearchFilterDto::Group { path } => {
                        out.push_str(&format!(
                            "      - {{ kind: group, path: {} }}\n",
                            yaml_quote(path)
                        ));
                    }
                }
            }
        }
    }
    out
}

/// Minimal YAML quoting: if the string contains special chars, wrap in quotes.
fn yaml_quote(s: &str) -> String {
    if s.is_empty() {
        return "\"\"".to_string();
    }
    let needs_quote = s.chars().any(|c| {
        matches!(
            c,
            ':' | '#'
                | '\''
                | '"'
                | '{'
                | '}'
                | '['
                | ']'
                | ','
                | '&'
                | '*'
                | '?'
                | '|'
                | '-'
                | '<'
                | '>'
                | '='
                | '!'
                | '%'
                | '@'
                | '`'
                | '\n'
                | '\r'
        )
    });
    if needs_quote || s.starts_with(' ') || s.ends_with(' ') {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        s.to_string()
    }
}

// ── Group 3: People/tags ──────────────────────────────────────────────────────

/// `PersonInput` DTO (maps to `PersonInput` in types.ts).
#[derive(Debug, Deserialize)]
pub struct PersonInputDto {
    pub slug: String,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub color: Option<String>,
    #[serde(rename = "avatarPath")]
    pub avatar_path: Option<String>,
}

/// `set_person(person)` — upsert a person declaration in `_people.md`.
///
/// If the slug already exists, its metadata is overwritten.
/// Other entries and the body are preserved.
#[tauri::command]
pub fn set_person(person: PersonInputDto, state: State<'_, AppState>) -> CmdResult<()> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    set_person_inner(&lib.root, &person)?;
    // Re-index _people.md into the index.
    Ok(())
}

pub fn set_person_inner(root: &Path, person: &PersonInputDto) -> CmdResult<()> {
    let path = root.join("_people.md");
    let mut people = read_people_list(&path)?;
    // Upsert: replace existing entry for this slug.
    let existing = people.iter().position(|p| p.slug == person.slug);
    let new_row = PersonDecl {
        slug: person.slug.clone(),
        full_name: person.display_name.clone(),
        description: person.description.clone(),
        color: person.color.clone(),
        avatar_path: person.avatar_path.clone(),
    };
    if let Some(idx) = existing {
        people[idx] = new_row;
    } else {
        people.push(new_row);
    }
    write_people_file(root, &path, &people)
}

/// `delete_person(slug)` — remove a person declaration from `_people.md`.
#[tauri::command]
pub fn delete_person(slug: String, state: State<'_, AppState>) -> CmdResult<()> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    delete_person_inner(&lib.root, &slug)
}

pub fn delete_person_inner(root: &Path, slug: &str) -> CmdResult<()> {
    let path = root.join("_people.md");
    let mut people = read_people_list(&path)?;
    let before = people.len();
    people.retain(|p| p.slug != slug);
    if people.len() == before {
        return Err(IpcError::not_found(format!("Person not found: {slug}")));
    }
    write_people_file(root, &path, &people)
}

#[derive(Debug, Clone)]
struct PersonDecl {
    slug: String,
    full_name: Option<String>,
    description: Option<String>,
    color: Option<String>,
    avatar_path: Option<String>,
}

fn read_people_list(path: &Path) -> CmdResult<Vec<PersonDecl>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes =
        std::fs::read(path).map_err(|e| IpcError::io(format!("Cannot read _people.md: {e}")))?;
    let entry = Entry::from_bytes(&bytes);
    parse_people_from_entry(&entry)
}

fn parse_people_from_entry(entry: &Entry) -> CmdResult<Vec<PersonDecl>> {
    use crate::core::frontmatter::Value;
    let prop = entry.properties.get("people");
    if prop.is_none() {
        return Ok(Vec::new());
    }
    // Arrays-of-maps are stored as Value::Tags(["{...}", "..."]) by infer_value
    // (it converts all sequences to Tags using yaml_owned_to_string on each item).
    // Each tag string is the compact inline YAML of the mapping.
    let yaml_text = match prop.unwrap() {
        Value::Opaque(s) => s.clone(),
        Value::Tags(items) => {
            // Re-assemble the items as an inline YAML sequence so parse_people_yaml
            // can parse them uniformly.
            format!("[{}]", items.join(", "))
        }
        _ => return Ok(Vec::new()),
    };
    parse_people_yaml(&yaml_text)
        .map_err(|e| IpcError::parse(format!("Cannot parse _people.md: {e}")))
}

fn parse_people_yaml(yaml: &str) -> Result<Vec<PersonDecl>, String> {
    let docs = YamlOwned::load_from_str(yaml).map_err(|e| format!("YAML error: {e}"))?;
    let doc = match docs.into_iter().next() {
        Some(d) => d,
        None => return Ok(Vec::new()),
    };
    let items = match doc.as_vec() {
        Some(v) => v.clone(),
        None => return Ok(Vec::new()),
    };
    let mut result = Vec::new();
    for item in &items {
        let map = match item.as_mapping() {
            Some(m) => m,
            None => continue,
        };
        let slug = yaml_str_owned(map, "name")
            .or_else(|| yaml_str_owned(map, "slug"))
            .unwrap_or_default();
        if slug.is_empty() {
            continue;
        }
        result.push(PersonDecl {
            slug,
            full_name: yaml_str_owned(map, "full_name"),
            description: yaml_str_owned(map, "description"),
            color: yaml_str_owned(map, "color"),
            avatar_path: yaml_str_owned(map, "avatar")
                .or_else(|| yaml_str_owned(map, "avatar_path")),
        });
    }
    Ok(result)
}

fn write_people_file(root: &Path, path: &Path, people: &[PersonDecl]) -> CmdResult<()> {
    // Preserve existing body text.
    let existing_body = if path.exists() {
        let bytes = std::fs::read(path)
            .map_err(|e| IpcError::io(format!("Cannot read _people.md: {e}")))?;
        let entry = Entry::from_bytes(&bytes);
        entry.body.clone()
    } else {
        String::new()
    };

    let yaml = serialize_people_yaml(people);
    let content = if people.is_empty() {
        format!("---\npeople: []\n---\n{existing_body}")
    } else {
        format!("---\npeople:\n{yaml}---\n{existing_body}")
    };
    atomic_write(path, content.as_bytes())
        .map_err(|e| IpcError::io(format!("Cannot write _people.md: {e}")))?;

    // Re-index the _people.md projection into the index.
    // The reconciler will pick up the change via the file watcher for the
    // live app; in tests the caller must re-index manually if needed.
    let _ = root; // available for future use
    Ok(())
}

fn serialize_people_yaml(people: &[PersonDecl]) -> String {
    let mut out = String::new();
    for p in people {
        out.push_str(&format!("  - name: {}\n", yaml_quote(&p.slug)));
        if let Some(n) = &p.full_name {
            out.push_str(&format!("    full_name: {}\n", yaml_quote(n)));
        }
        if let Some(d) = &p.description {
            out.push_str(&format!("    description: {}\n", yaml_quote(d)));
        }
        if let Some(c) = &p.color {
            out.push_str(&format!("    color: {}\n", yaml_quote(c)));
        }
        if let Some(a) = &p.avatar_path {
            out.push_str(&format!("    avatar: {}\n", yaml_quote(a)));
        }
    }
    out
}

/// `mentions_for(slug)` — all entries that mention a person (union surfaces), recency desc.
#[tauri::command]
pub fn mentions_for(slug: String, state: State<'_, AppState>) -> CmdResult<Vec<EntrySummaryDto>> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    mentions_for_inner(lib, &slug)
}

pub fn mentions_for_inner(lib: &OpenLibrary, slug: &str) -> CmdResult<Vec<EntrySummaryDto>> {
    // Use the index mentions query: entries that carry the slug in either surface.
    let paths = lib
        .index
        .paths_with_mention(slug)
        .map_err(|e| IpcError::io(format!("mentions_for failed: {e}")))?;

    let mut summaries: Vec<EntrySummaryDto> = Vec::new();
    for rel_path in &paths {
        // Resolve to an entry row for metadata.
        let row_id = lib
            .index
            .entry_id_for_path(rel_path)
            .map_err(|e| IpcError::io(format!("lookup failed: {e}")))?;
        if let Some(id) = row_id {
            let tags = tags_for_entry(&lib.index, id);
            let people = people_for_entry(&lib.index, id);
            let (group, _slug) = split_group_slug(rel_path);
            let entry_id = rel_path.trim_end_matches(".md").to_string();
            let title = super::title_for_path(&lib.index, &lib.root, rel_path);
            // Get the modified_at from entries table via a search result approach.
            let modified_at = get_modified_at(&lib.index, id);
            summaries.push(EntrySummaryDto {
                id: entry_id,
                path: rel_path.clone(),
                title,
                group,
                tags,
                people,
                modified_at,
            });
        }
    }

    // Sort recency desc (modified_at as string ISO sort).
    summaries.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(summaries)
}

/// Get `updated` for an entry by its row id via a direct SQL query.
fn get_modified_at(index: &Index, entry_row_id: i64) -> String {
    // We query the entries table directly.
    // This uses the same connection as the index.
    let rows = index.entries_in_group("").unwrap_or_default();
    rows.into_iter()
        .find(|r| r.id == entry_row_id)
        .and_then(|r| r.updated)
        .unwrap_or_default()
}

/// `rename_tag(oldName, newName)` — journaled batch rename via core::journal.
#[tauri::command]
pub fn rename_tag(old_name: String, new_name: String, state: State<'_, AppState>) -> CmdResult<()> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    journal::rename_tag(&lib.root, &lib.index, &lib.tokens, &old_name, &new_name)
        .map_err(|e| IpcError::io(format!("rename_tag failed: {e}")))?;
    Ok(())
}

/// `merge_tag(sourceTag, targetTag)` — journaled batch merge via core::journal.
#[tauri::command]
pub fn merge_tag(
    source_tag: String,
    target_tag: String,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    journal::merge_tag(&lib.root, &lib.index, &lib.tokens, &source_tag, &target_tag)
        .map_err(|e| IpcError::io(format!("merge_tag failed: {e}")))?;
    Ok(())
}

/// `delete_tag(name)` — remove from `_tags.md` metadata only; entries are NOT rewritten.
#[tauri::command]
pub fn delete_tag(name: String, state: State<'_, AppState>) -> CmdResult<()> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    delete_tag_inner(&lib.root, &name)
}

pub fn delete_tag_inner(root: &Path, name: &str) -> CmdResult<()> {
    let path = root.join("_tags.md");
    if !path.exists() {
        // Nothing to remove — not an error.
        return Ok(());
    }
    let bytes =
        std::fs::read(&path).map_err(|e| IpcError::io(format!("Cannot read _tags.md: {e}")))?;
    let entry = Entry::from_bytes(&bytes);
    let body = entry.body.clone();

    // Read the current tag list, remove the named entry.
    let tags = read_tags_meta(&entry);
    let filtered: Vec<_> = tags.into_iter().filter(|t| t.name != name).collect();
    let yaml = serialize_tags_meta_yaml(&filtered);
    let content = if filtered.is_empty() {
        format!("---\ntags: []\n---\n{body}")
    } else {
        format!("---\ntags:\n{yaml}---\n{body}")
    };
    atomic_write(&path, content.as_bytes())
        .map_err(|e| IpcError::io(format!("Cannot write _tags.md: {e}")))?;
    Ok(())
}

/// `rename_person(oldSlug, newSlug)` — journaled batch rename via core::journal.
#[tauri::command]
pub fn rename_person(
    old_slug: String,
    new_slug: String,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    journal::rename_person(&lib.root, &lib.index, &lib.tokens, &old_slug, &new_slug)
        .map_err(|e| IpcError::io(format!("rename_person failed: {e}")))?;
    Ok(())
}

/// `merge_person(sourceSlug, targetSlug)` — journaled batch merge via core::journal.
#[tauri::command]
pub fn merge_person(
    source_slug: String,
    target_slug: String,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    journal::merge_person(
        &lib.root,
        &lib.index,
        &lib.tokens,
        &source_slug,
        &target_slug,
    )
    .map_err(|e| IpcError::io(format!("merge_person failed: {e}")))?;
    Ok(())
}

// ── _tags.md helpers ─────────────────────────────────────────────────────────

struct TagMetaDecl {
    name: String,
    description: Option<String>,
    color: Option<String>,
    icon: Option<String>,
}

fn read_tags_meta(entry: &Entry) -> Vec<TagMetaDecl> {
    use crate::core::frontmatter::Value;
    let prop = entry.properties.get("tags");
    if prop.is_none() {
        return Vec::new();
    }
    // Arrays-of-maps are stored as Value::Tags(["{...}", "..."]) by infer_value.
    let yaml_text = match prop.unwrap() {
        Value::Opaque(s) => s.clone(),
        Value::Tags(items) => format!("[{}]", items.join(", ")),
        _ => return Vec::new(),
    };
    parse_tags_meta_yaml(&yaml_text).unwrap_or_default()
}

fn parse_tags_meta_yaml(yaml: &str) -> Result<Vec<TagMetaDecl>, String> {
    let docs = YamlOwned::load_from_str(yaml).map_err(|e| format!("YAML error: {e}"))?;
    let doc = match docs.into_iter().next() {
        Some(d) => d,
        None => return Ok(Vec::new()),
    };
    let items = match doc.as_vec() {
        Some(v) => v.clone(),
        None => return Ok(Vec::new()),
    };
    let mut result = Vec::new();
    for item in &items {
        let map = match item.as_mapping() {
            Some(m) => m,
            None => continue,
        };
        let name = yaml_str_owned(map, "name").unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        result.push(TagMetaDecl {
            name,
            description: yaml_str_owned(map, "description"),
            color: yaml_str_owned(map, "color"),
            icon: yaml_str_owned(map, "icon"),
        });
    }
    Ok(result)
}

fn serialize_tags_meta_yaml(tags: &[TagMetaDecl]) -> String {
    let mut out = String::new();
    for t in tags {
        out.push_str(&format!("  - name: {}\n", yaml_quote(&t.name)));
        if let Some(d) = &t.description {
            out.push_str(&format!("    description: {}\n", yaml_quote(d)));
        }
        if let Some(c) = &t.color {
            out.push_str(&format!("    color: {}\n", yaml_quote(c)));
        }
        if let Some(i) = &t.icon {
            out.push_str(&format!("    icon: {}\n", yaml_quote(i)));
        }
    }
    out
}

// ── Group 4: Calendar ─────────────────────────────────────────────────────────

/// A single calendar item DTO (matches `CalendarWindowItem` in types.ts).
#[derive(Debug, Serialize, PartialEq)]
pub struct CalendarWindowItemDto {
    #[serde(rename = "entryId")]
    pub entry_id: String,
    pub title: String,
    #[serde(rename = "dateValue")]
    pub date_value: String,
    pub group: String,
    #[serde(rename = "groupColor", skip_serializing_if = "Option::is_none")]
    pub group_color: Option<String>,
    pub tags: Vec<String>,
    #[serde(rename = "occurrenceKey", skip_serializing_if = "Option::is_none")]
    pub occurrence_key: Option<String>,
    #[serde(rename = "isOccurrence")]
    pub is_occurrence: bool,
}

/// `CalendarWindowResult` DTO (matches `CalendarWindowResult` in types.ts).
#[derive(Debug, Serialize)]
pub struct CalendarWindowResultDto {
    pub items: Vec<CalendarWindowItemDto>,
}

/// `calendar_window(from, to, group?)` — expand recurring and single-date entries
/// within the window, using the primary date property from library settings
/// (default `due`).
#[tauri::command]
pub fn calendar_window(
    from: String,
    to: String,
    group: Option<String>,
    state: State<'_, AppState>,
) -> CmdResult<CalendarWindowResultDto> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    calendar_window_inner(lib, &from, &to, group.as_deref())
}

pub fn calendar_window_inner(
    lib: &OpenLibrary,
    from: &str,
    to: &str,
    group: Option<&str>,
) -> CmdResult<CalendarWindowResultDto> {
    use crate::core::frontmatter::Value;

    let win_from: jiff::civil::Date = from.parse().map_err(|_| IpcError {
        code: "invalid_argument",
        message: format!("Invalid date: {from}"),
        detail: None,
    })?;
    let win_to: jiff::civil::Date = to.parse().map_err(|_| IpcError {
        code: "invalid_argument",
        message: format!("Invalid date: {to}"),
        detail: None,
    })?;

    // Read the primary date property name from library settings (default "due").
    let primary_prop = get_library_primary_date_prop(lib);

    // Enumerate all entries (we need their file content for date props).
    let rows = lib
        .index
        .entries_in_group(group.unwrap_or(""))
        .map_err(|e| IpcError::io(format!("calendar_window: index query failed: {e}")))?;

    let mut items: Vec<CalendarWindowItemDto> = Vec::new();

    for row in &rows {
        // Apply group filter (prefix match, consistent with mock).
        if let Some(g) = group {
            if row.group_path != g && !row.group_path.starts_with(&format!("{g}/")) {
                continue;
            }
        }

        // Read the file to access frontmatter date properties.
        let abs = lib.root.join(&row.path);
        let bytes = match std::fs::read(&abs) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let entry = Entry::from_bytes(&bytes);

        // Get the primary date value.
        let date_val = match entry.properties.get(&primary_prop) {
            Some(v) => v.clone(),
            None => continue,
        };

        let tags = tags_for_entry(&lib.index, row.id);
        let entry_id = row.path.trim_end_matches(".md").to_string();
        let title = row.title.clone().unwrap_or_else(|| row.slug.clone());

        // Check for a repeat/RRULE.
        if let Some(Value::String(repeat_str)) = entry.properties.get("repeat") {
            let rrule_str = repeat_str.trim_start_matches('"').trim_end_matches('"');
            if let ParseResult::Ok(rule) = parse_rrule(rrule_str) {
                let start_date = value_to_start_date(&date_val);
                if let Some(start) = start_date {
                    // Parse overrides.
                    let raw_overrides = read_overrides_map(&entry);
                    let overrides_map =
                        crate::core::recurrence::overrides::parse_overrides(&raw_overrides);
                    let result =
                        expand_with_overrides(&rule, start, win_from, win_to, &overrides_map);
                    for occ in result.occurrences {
                        let key = occ.effective.to_string();
                        items.push(CalendarWindowItemDto {
                            entry_id: entry_id.clone(),
                            title: title.clone(),
                            date_value: key.clone(),
                            group: row.group_path.clone(),
                            group_color: None,
                            tags: tags.clone(),
                            occurrence_key: Some(key),
                            is_occurrence: true,
                        });
                    }
                    continue;
                }
            }
        }

        // Single-date entry: check window overlap.
        let (start_date, end_date) = value_to_date_range(&date_val);
        if let Some(start) = start_date {
            let end = end_date.unwrap_or(start);
            // Overlap: start <= win_to AND end >= win_from.
            if start > win_to || end < win_from {
                continue;
            }
            // dateValue: use the raw string representation of the property.
            let date_value = format_value_as_string(&date_val);
            items.push(CalendarWindowItemDto {
                entry_id,
                title,
                date_value,
                group: row.group_path.clone(),
                group_color: None,
                tags,
                occurrence_key: None,
                is_occurrence: false,
            });
        }
    }

    Ok(CalendarWindowResultDto { items })
}

fn get_library_primary_date_prop(lib: &OpenLibrary) -> String {
    let settings_path = lib.root.join("_settings.md");
    if settings_path.exists() {
        if let Ok(bytes) = std::fs::read(&settings_path) {
            let entry = Entry::from_bytes(&bytes);
            if let Some(crate::core::frontmatter::Value::String(prop)) =
                entry.properties.get("primary_date_property")
            {
                return prop.clone();
            }
        }
    }
    "due".to_string()
}

fn value_to_start_date(val: &crate::core::frontmatter::Value) -> Option<StartDate> {
    use crate::core::frontmatter::{RangeEndpoint, Value};
    match val {
        Value::Date(d) => Some(StartDate::Date(*d)),
        Value::Datetime(dt) => Some(StartDate::DateTime(dt.civil)),
        Value::Range(r) => match &r.start {
            RangeEndpoint::Date(d) => Some(StartDate::Date(*d)),
            RangeEndpoint::Datetime(dt) => Some(StartDate::DateTime(dt.civil)),
        },
        _ => None,
    }
}

fn value_to_date_range(
    val: &crate::core::frontmatter::Value,
) -> (Option<jiff::civil::Date>, Option<jiff::civil::Date>) {
    use crate::core::frontmatter::{RangeEndpoint, Value};
    match val {
        Value::Date(d) => (Some(*d), None),
        Value::Datetime(dt) => (Some(dt.civil.date()), None),
        Value::Range(r) => {
            let start = match &r.start {
                RangeEndpoint::Date(d) => Some(*d),
                RangeEndpoint::Datetime(dt) => Some(dt.civil.date()),
            };
            let end = match &r.end {
                RangeEndpoint::Date(d) => Some(*d),
                RangeEndpoint::Datetime(dt) => Some(dt.civil.date()),
            };
            (start, end)
        }
        _ => (None, None),
    }
}

fn format_value_as_string(val: &crate::core::frontmatter::Value) -> String {
    use crate::core::frontmatter::{RangeEndpoint, Value};
    match val {
        Value::Date(d) => d.to_string(),
        Value::Datetime(dt) => {
            if let Some(offset) = dt.offset_seconds {
                let h = offset / 3600;
                let m = (offset.abs() % 3600) / 60;
                let sign = if h >= 0 { "+" } else { "-" };
                format!(
                    "{}T{:02}:{:02}{sign}{:02}:{:02}",
                    dt.civil.date(),
                    dt.civil.hour(),
                    dt.civil.minute(),
                    h.abs(),
                    m
                )
            } else {
                format!(
                    "{}T{:02}:{:02}",
                    dt.civil.date(),
                    dt.civil.hour(),
                    dt.civil.minute()
                )
            }
        }
        Value::Range(r) => {
            let start = match &r.start {
                RangeEndpoint::Date(d) => d.to_string(),
                RangeEndpoint::Datetime(dt) => dt.civil.date().to_string(),
            };
            let end = match &r.end {
                RangeEndpoint::Date(d) => d.to_string(),
                RangeEndpoint::Datetime(dt) => dt.civil.date().to_string(),
            };
            format!("{start}..{end}")
        }
        _ => String::new(),
    }
}

/// Extract the `overrides` frontmatter map as `HashMap<String, String>`.
fn read_overrides_map(entry: &Entry) -> std::collections::HashMap<String, String> {
    use crate::core::frontmatter::Value;
    if let Some(Value::Opaque(yaml)) = entry.properties.get("overrides") {
        if let Ok(parsed) = parse_overrides_yaml(yaml) {
            return parsed;
        }
    }
    std::collections::HashMap::new()
}

fn parse_overrides_yaml(yaml: &str) -> Result<std::collections::HashMap<String, String>, String> {
    let docs = YamlOwned::load_from_str(yaml).map_err(|e| format!("{e}"))?;
    let doc = match docs.into_iter().next() {
        Some(d) => d,
        None => return Ok(std::collections::HashMap::new()),
    };
    let mapping = match doc.as_mapping() {
        Some(m) => m.clone(),
        None => return Ok(std::collections::HashMap::new()),
    };
    let mut result = std::collections::HashMap::new();
    for (k, v) in mapping.iter() {
        let key = match k.as_str() {
            Some(s) => s.to_string(),
            None => continue,
        };
        let val = match v.as_str() {
            Some(s) => s.to_string(),
            None => continue,
        };
        result.insert(key, val);
    }
    Ok(result)
}

// ── Group 5: Settings ─────────────────────────────────────────────────────────

/// `settings_get_user()` — read user settings JSON from the app config dir.
///
/// Returns an empty object `{}` when the file doesn't exist.
#[tauri::command]
pub fn settings_get_user(app: AppHandle) -> CmdResult<serde_json::Value> {
    let path = user_settings_path(&app)?;
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let bytes = std::fs::read(&path)
        .map_err(|e| IpcError::io(format!("Cannot read user settings: {e}")))?;
    serde_json::from_slice(&bytes)
        .map_err(|e| IpcError::parse(format!("Cannot parse user settings: {e}")))
}

/// `settings_set_user(patch)` — merge `patch` into user settings, preserving unknown keys.
#[tauri::command]
pub fn settings_set_user(patch: serde_json::Value, app: AppHandle) -> CmdResult<()> {
    let path = user_settings_path(&app)?;
    let mut existing = if path.exists() {
        let bytes = std::fs::read(&path)
            .map_err(|e| IpcError::io(format!("Cannot read user settings: {e}")))?;
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    // Deep merge the patch into existing (top-level keys only, per 0011).
    if let (Some(obj), Some(patch_obj)) = (existing.as_object_mut(), patch.as_object()) {
        for (k, v) in patch_obj {
            obj.insert(k.clone(), v.clone());
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| IpcError::io(format!("Cannot create config dir: {e}")))?;
    }
    let json = serde_json::to_vec_pretty(&existing)
        .map_err(|e| IpcError::io(format!("Cannot serialize user settings: {e}")))?;
    atomic_write(&path, &json)
        .map_err(|e| IpcError::io(format!("Cannot write user settings: {e}")))?;
    Ok(())
}

fn user_settings_path(app: &AppHandle) -> CmdResult<PathBuf> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("settings.json"))
        .map_err(|e| IpcError::io(format!("Cannot resolve app config dir: {e}")))
}

/// `settings_get_library()` — read `_settings.md` frontmatter.
///
/// Returns an empty object when the file doesn't exist.
#[tauri::command]
pub fn settings_get_library(state: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    settings_get_library_inner(&lib.root)
}

pub fn settings_get_library_inner(root: &Path) -> CmdResult<serde_json::Value> {
    let path = root.join("_settings.md");
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let bytes =
        std::fs::read(&path).map_err(|e| IpcError::io(format!("Cannot read _settings.md: {e}")))?;
    let entry = Entry::from_bytes(&bytes);
    // Convert all properties to a JSON object.
    frontmatter_to_json(&entry)
}

fn frontmatter_to_json(entry: &Entry) -> CmdResult<serde_json::Value> {
    use crate::core::frontmatter::Value;
    let mut map = serde_json::Map::new();
    for (k, v) in &entry.properties {
        let jv = match v {
            Value::String(s) => serde_json::Value::String(s.clone()),
            Value::Number(n) => serde_json::Value::Number(
                serde_json::Number::from_f64(*n).unwrap_or(serde_json::Number::from(0)),
            ),
            Value::Boolean(b) => serde_json::Value::Bool(*b),
            Value::Date(d) => serde_json::Value::String(d.to_string()),
            Value::Datetime(dt) => serde_json::Value::String(dt.civil.to_string()),
            Value::Tags(tags) => serde_json::Value::Array(
                tags.iter()
                    .map(|t| serde_json::Value::String(t.clone()))
                    .collect(),
            ),
            Value::Opaque(s) => serde_json::Value::String(s.clone()),
            _ => serde_json::Value::Null,
        };
        map.insert(k.clone(), jv);
    }
    Ok(serde_json::Value::Object(map))
}

/// `settings_set_library(patch)` — merge `patch` into `_settings.md`, preserving
/// unknown keys and body text.
#[tauri::command]
pub fn settings_set_library(patch: serde_json::Value, state: State<'_, AppState>) -> CmdResult<()> {
    let guard = require_open!(state);
    let lib = guard.as_ref().ok_or_else(IpcError::not_open)?;
    settings_set_library_inner(&lib.root, &patch)
}

pub fn settings_set_library_inner(root: &Path, patch: &serde_json::Value) -> CmdResult<()> {
    let path = root.join("_settings.md");

    // Read existing entry to preserve body and unknown keys.
    let (existing_props, existing_body) = if path.exists() {
        let bytes = std::fs::read(&path)
            .map_err(|e| IpcError::io(format!("Cannot read _settings.md: {e}")))?;
        let entry = Entry::from_bytes(&bytes);
        let body = entry.body.clone();
        (entry, body)
    } else {
        (
            Entry {
                properties: std::collections::BTreeMap::new(),
                body: String::new(),
                parse_warning: None,
            },
            String::new(),
        )
    };

    // Build merged frontmatter YAML by serializing existing properties then
    // layering the patch on top (string values only in the patch).
    let mut props = existing_props.properties.clone();
    if let Some(obj) = patch.as_object() {
        for (k, v) in obj {
            let val = json_to_value(v);
            props.insert(k.clone(), val);
        }
    }
    let merged_entry = Entry {
        properties: props,
        body: existing_body,
        parse_warning: None,
    };
    let bytes = merged_entry.to_bytes(&[]);
    atomic_write(&path, &bytes)
        .map_err(|e| IpcError::io(format!("Cannot write _settings.md: {e}")))?;
    Ok(())
}

fn json_to_value(v: &serde_json::Value) -> crate::core::frontmatter::Value {
    use crate::core::frontmatter::Value;
    match v {
        serde_json::Value::String(s) => Value::String(s.clone()),
        serde_json::Value::Number(n) => Value::Number(n.as_f64().unwrap_or(0.0)),
        serde_json::Value::Bool(b) => Value::Boolean(*b),
        serde_json::Value::Array(arr) => Value::Tags(
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect(),
        ),
        _ => Value::String(v.to_string()),
    }
}

// ── Group 5b: Plugin settings ─────────────────────────────────────────────────
//
// Per-plugin settings are stored device-locally in the app config dir alongside
// grants (same security rationale: never sync with the library — see grants.rs).
// Path: <app_config_dir>/plugins/settings-<plugin_id_sanitized>.json
// Shape: JSON object { [fieldKey: string]: string }
//
// All field values are stored as strings; the frontend/plugin side handles
// type coercion per the declared PluginSettingField schema.

/// `plugin_settings_get(plugin_id)` — read settings for one plugin.
///
/// Returns `{}` when no settings have been written for this plugin.
#[tauri::command]
pub fn plugin_settings_get(
    plugin_id: String,
    app: AppHandle,
) -> CmdResult<std::collections::HashMap<String, String>> {
    let path = plugin_settings_path(&app, &plugin_id)?;
    plugin_settings_get_inner(&path)
}

pub fn plugin_settings_get_inner(
    path: &Path,
) -> CmdResult<std::collections::HashMap<String, String>> {
    if !path.exists() {
        return Ok(std::collections::HashMap::new());
    }
    let bytes = std::fs::read(path)
        .map_err(|e| IpcError::io(format!("Cannot read plugin settings: {e}")))?;
    serde_json::from_slice(&bytes)
        .map_err(|e| IpcError::parse(format!("Cannot parse plugin settings: {e}")))
}

/// `plugin_settings_set(plugin_id, values)` — atomically write settings for one plugin.
///
/// Replaces the entire settings map (not a merge); the frontend sends the full map.
#[tauri::command]
pub fn plugin_settings_set(
    plugin_id: String,
    values: std::collections::HashMap<String, String>,
    app: AppHandle,
) -> CmdResult<()> {
    let path = plugin_settings_path(&app, &plugin_id)?;
    plugin_settings_set_inner(&path, &values)
}

pub fn plugin_settings_set_inner(
    path: &Path,
    values: &std::collections::HashMap<String, String>,
) -> CmdResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| IpcError::io(format!("Cannot create plugin settings dir: {e}")))?;
    }
    let json = serde_json::to_vec_pretty(values)
        .map_err(|e| IpcError::io(format!("Cannot serialize plugin settings: {e}")))?;
    atomic_write(path, &json)
        .map_err(|e| IpcError::io(format!("Cannot write plugin settings: {e}")))?;
    Ok(())
}

/// Device-local path for a plugin's settings file.
///
/// Uses a sanitized plugin id as the filename so it is human-readable in the
/// config dir. The plugin id namespace (e.g. `com.example.mermaid`) is safe
/// for filenames on all platforms after replacing `/` with `_`.
fn plugin_settings_path(app: &AppHandle, plugin_id: &str) -> CmdResult<PathBuf> {
    // Validate: plugin ids are dot-separated reverse-domain segments.
    // Reject anything that would escape the directory.
    if plugin_id.is_empty()
        || plugin_id.contains('/')
        || plugin_id.contains('\\')
        || plugin_id.contains("..")
    {
        return Err(IpcError::invalid_argument(format!(
            "Invalid plugin id: {plugin_id:?}"
        )));
    }
    let safe_id = plugin_id.replace([':', '*'], "_");
    app.path()
        .app_config_dir()
        .map(|d| d.join("plugins").join(format!("settings-{safe_id}.json")))
        .map_err(|e| IpcError::io(format!("Cannot resolve app config dir: {e}")))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;

    use crate::core::{fswrite::TokenRegistry, index::Index, reconcile::SyncReconciler};
    use crate::ipc::{AppState, OpenLibrary};

    // ── Fixture ───────────────────────────────────────────────────────────────

    pub struct Fixture {
        _dir: TempDir,
        pub root: PathBuf,
        pub state: AppState,
    }

    impl Default for Fixture {
        fn default() -> Self {
            Self::new()
        }
    }

    impl Fixture {
        pub fn new() -> Self {
            let dir = tempfile::tempdir().expect("tempdir");
            let root = dir.path().to_path_buf();
            let dot = root.join(".tonotedo");
            std::fs::create_dir_all(&dot).unwrap();
            let db = dot.join("index.db");
            let index = Index::open(db.to_str().unwrap()).expect("index open");
            let tokens = Arc::new(TokenRegistry::with_default_ttl());
            let mut boot = SyncReconciler::new(index, Arc::clone(&tokens), root.clone());
            boot.full_rescan();
            let SyncReconciler {
                index,
                tokens,
                library_root,
                ..
            } = boot;
            let db2 = library_root.join(".tonotedo").join("index.db");
            let query_index = Index::open(db2.to_str().unwrap()).expect("query index");
            use crate::core::reconcile::{Reconciler, WatcherHandle};
            let (event_tx, _event_rx) = crossbeam_channel::unbounded();
            let reconciler = Reconciler::new_without_watcher(
                index,
                Arc::clone(&tokens),
                library_root.clone(),
                event_tx,
            );
            let (reconciler_handle, _change_rx) = reconciler.spawn(None::<WatcherHandle>);
            let open = OpenLibrary {
                root: library_root,
                index: query_index,
                tokens,
                _reconciler_handle: reconciler_handle,
            };
            Fixture {
                _dir: dir,
                root: root.clone(),
                state: AppState(Mutex::new(Some(open))),
            }
        }

        /// Write a .md file and index it.
        pub fn write_md(&self, rel_path: &str, content: &str) {
            let abs = self.root.join(rel_path);
            if let Some(parent) = abs.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&abs, content).unwrap();
            let mut guard = self.state.0.lock().unwrap();
            if let Some(lib) = guard.as_mut() {
                use crate::core::frontmatter::Entry;
                use crate::core::fswrite::content_hash;
                let bytes = std::fs::read(&abs).unwrap();
                let entry = Entry::from_bytes(&bytes);
                let (group, slug) = crate::ipc::split_group_slug(rel_path);
                let meta = std::fs::metadata(&abs).unwrap();
                let mtime = meta
                    .modified()
                    .map(|t| {
                        t.duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs() as i64
                    })
                    .unwrap_or(0);
                let size = meta.len() as i64;
                let hash = format!("{:032x}", content_hash(&bytes));
                lib.index
                    .upsert_entry(rel_path, &slug, &group, &entry, mtime, size, &hash)
                    .expect("upsert");
                lib.index.resolve_links().expect("resolve_links");
            }
        }

        pub fn lib(&self) -> std::sync::MutexGuard<'_, Option<OpenLibrary>> {
            self.state.0.lock().unwrap()
        }
    }

    // ── Group 6: list_groups ──────────────────────────────────────────────────

    #[test]
    fn list_groups_empty_library() {
        let fix = Fixture::new();
        let guard = fix.lib();
        let lib = guard.as_ref().unwrap();
        let groups = list_groups_inner(lib).unwrap();
        assert!(groups.is_empty());
    }

    #[test]
    fn list_groups_returns_all_ancestors() {
        let fix = Fixture::new();
        fix.write_md("work/atlas/overview.md", "---\nid: ov\n---\n# Overview\n");
        fix.write_md("journal/today.md", "---\nid: j1\n---\n# Today\n");
        let guard = fix.lib();
        let lib = guard.as_ref().unwrap();
        let groups = list_groups_inner(lib).unwrap();
        let paths: Vec<&str> = groups.iter().map(|g| g.path.as_str()).collect();
        assert!(paths.contains(&"work"), "work ancestor must appear");
        assert!(paths.contains(&"work/atlas"), "work/atlas must appear");
        assert!(paths.contains(&"journal"), "journal must appear");
    }

    // ── Group 1: Assets ───────────────────────────────────────────────────────

    #[test]
    fn attach_file_round_trip() {
        let fix = Fixture::new();
        let bytes = b"fake png bytes";
        let asset_path = attach_file_inner(
            &fix.root,
            "work/atlas/entry.md",
            "image.png",
            bytes,
            "_assets",
        )
        .unwrap();
        assert_eq!(asset_path, "work/atlas/_assets/image.png");
        let abs = fix.root.join(&asset_path);
        assert!(abs.exists());
        assert_eq!(std::fs::read(&abs).unwrap(), bytes);
    }

    #[test]
    fn attach_file_collision_suffix() {
        let fix = Fixture::new();
        let bytes1 = b"first";
        let bytes2 = b"second";
        let p1 = attach_file_inner(
            &fix.root,
            "work/atlas/entry.md",
            "file.pdf",
            bytes1,
            "_assets",
        )
        .unwrap();
        let p2 = attach_file_inner(
            &fix.root,
            "work/atlas/entry.md",
            "file.pdf",
            bytes2,
            "_assets",
        )
        .unwrap();
        assert_eq!(p1, "work/atlas/_assets/file.pdf");
        assert_eq!(p2, "work/atlas/_assets/file-2.pdf");
        assert_eq!(std::fs::read(fix.root.join(&p1)).unwrap(), bytes1);
        assert_eq!(std::fs::read(fix.root.join(&p2)).unwrap(), bytes2);
    }

    #[test]
    fn attach_file_no_group() {
        let fix = Fixture::new();
        let path =
            attach_file_inner(&fix.root, "root-note.md", "doc.txt", b"text", "_assets").unwrap();
        assert_eq!(path, "_assets/doc.txt");
    }

    #[test]
    fn asset_url_returns_absolute_path() {
        let fix = Fixture::new();
        attach_file_inner(&fix.root, "notes/entry.md", "img.png", b"data", "_assets").unwrap();
        let url = asset_url_inner(&fix.root, "notes/_assets/img.png").unwrap();
        assert!(std::path::Path::new(&url).is_absolute());
        assert!(url.ends_with("img.png"));
    }

    #[test]
    fn asset_url_not_found() {
        let fix = Fixture::new();
        let err = asset_url_inner(&fix.root, "nope.png").unwrap_err();
        assert_eq!(err.code, "not_found");
    }

    #[test]
    fn asset_exists_and_remove() {
        let fix = Fixture::new();
        attach_file_inner(&fix.root, "n.md", "a.bin", b"x", "_assets").unwrap();
        let path = "_assets/a.bin";
        assert!(fix.root.join(path).exists());

        // remove_asset works.
        remove_asset_inner(&fix.root, path).unwrap();
        assert!(!fix.root.join(path).exists());
    }

    #[test]
    fn attach_file_custom_folder() {
        let fix = Fixture::new();
        // Write _settings.md with a custom asset_folder.
        std::fs::write(
            fix.root.join("_settings.md"),
            "---\nasset_folder: _files\n---\n",
        )
        .unwrap();
        let path =
            attach_file_inner(&fix.root, "notes/entry.md", "doc.pdf", b"x", "_files").unwrap();
        assert_eq!(path, "notes/_files/doc.pdf");
        assert!(fix.root.join("notes/_files/doc.pdf").exists());
    }

    #[test]
    fn remove_asset_not_found() {
        let fix = Fixture::new();
        let err = remove_asset_inner(&fix.root, "missing.bin").unwrap_err();
        assert_eq!(err.code, "not_found");
    }

    // ── Group 2: Saved searches ───────────────────────────────────────────────

    #[test]
    fn saved_searches_empty_when_file_missing() {
        let fix = Fixture::new();
        let searches = saved_searches_get_inner(&fix.root).unwrap();
        assert!(searches.is_empty());
    }

    #[test]
    fn saved_searches_round_trip() {
        let fix = Fixture::new();
        let searches = vec![
            SavedSearchDto {
                name: "Atlas follow-ups".to_string(),
                text: String::new(),
                filters: vec![
                    SavedSearchFilterDto::Tag {
                        values: vec!["followup".to_string()],
                    },
                    SavedSearchFilterDto::Group {
                        path: "work/atlas".to_string(),
                    },
                ],
            },
            SavedSearchDto {
                name: "Inbox".to_string(),
                text: "review".to_string(),
                filters: Vec::new(),
            },
        ];
        saved_searches_set_inner(&fix.root, &searches).unwrap();
        let loaded = saved_searches_get_inner(&fix.root).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].name, "Atlas follow-ups");
        assert_eq!(loaded[0].filters.len(), 2);
        assert_eq!(loaded[1].name, "Inbox");
        assert_eq!(loaded[1].text, "review");
    }

    #[test]
    fn saved_searches_preserves_body() {
        let fix = Fixture::new();
        // Write _searches.md with a body.
        let initial = "---\nsearches: []\n---\n# My notes\n\nBody text here.\n";
        std::fs::write(fix.root.join("_searches.md"), initial).unwrap();
        // Set searches.
        let searches = vec![SavedSearchDto {
            name: "test".to_string(),
            text: String::new(),
            filters: Vec::new(),
        }];
        saved_searches_set_inner(&fix.root, &searches).unwrap();
        // Verify body is preserved.
        let content = std::fs::read_to_string(fix.root.join("_searches.md")).unwrap();
        assert!(content.contains("# My notes"), "body must be preserved");
        assert!(
            content.contains("Body text here."),
            "body must be preserved"
        );
    }

    // ── Group 3: People/tags ──────────────────────────────────────────────────

    #[test]
    fn set_person_creates_new_entry() {
        let fix = Fixture::new();
        let person = PersonInputDto {
            slug: "alice".to_string(),
            display_name: Some("Alice K.".to_string()),
            description: Some("Engineer".to_string()),
            color: Some("violet".to_string()),
            avatar_path: None,
        };
        set_person_inner(&fix.root, &person).unwrap();
        let people = read_people_list(&fix.root.join("_people.md")).unwrap();
        assert_eq!(people.len(), 1);
        assert_eq!(people[0].slug, "alice");
        assert_eq!(people[0].full_name.as_deref(), Some("Alice K."));
        assert_eq!(people[0].color.as_deref(), Some("violet"));
    }

    #[test]
    fn set_person_updates_existing() {
        let fix = Fixture::new();
        let p1 = PersonInputDto {
            slug: "alice".to_string(),
            display_name: Some("Alice".to_string()),
            description: None,
            color: None,
            avatar_path: None,
        };
        set_person_inner(&fix.root, &p1).unwrap();
        let p2 = PersonInputDto {
            slug: "alice".to_string(),
            display_name: Some("Alice K.".to_string()),
            description: Some("Updated".to_string()),
            color: Some("blue".to_string()),
            avatar_path: None,
        };
        set_person_inner(&fix.root, &p2).unwrap();
        let people = read_people_list(&fix.root.join("_people.md")).unwrap();
        assert_eq!(people.len(), 1, "must not duplicate on update");
        assert_eq!(people[0].full_name.as_deref(), Some("Alice K."));
        assert_eq!(people[0].description.as_deref(), Some("Updated"));
    }

    #[test]
    fn set_person_preserves_others() {
        let fix = Fixture::new();
        let p1 = PersonInputDto {
            slug: "alice".to_string(),
            display_name: Some("Alice".to_string()),
            description: None,
            color: None,
            avatar_path: None,
        };
        let p2 = PersonInputDto {
            slug: "bob".to_string(),
            display_name: Some("Bob".to_string()),
            description: None,
            color: None,
            avatar_path: None,
        };
        set_person_inner(&fix.root, &p1).unwrap();
        set_person_inner(&fix.root, &p2).unwrap();
        let people = read_people_list(&fix.root.join("_people.md")).unwrap();
        assert_eq!(people.len(), 2);
    }

    #[test]
    fn delete_person_removes_entry() {
        let fix = Fixture::new();
        let p = PersonInputDto {
            slug: "alice".to_string(),
            display_name: None,
            description: None,
            color: None,
            avatar_path: None,
        };
        set_person_inner(&fix.root, &p).unwrap();
        delete_person_inner(&fix.root, "alice").unwrap();
        let people = read_people_list(&fix.root.join("_people.md")).unwrap();
        assert!(people.is_empty());
    }

    #[test]
    fn delete_person_not_found() {
        let fix = Fixture::new();
        let err = delete_person_inner(&fix.root, "nobody").unwrap_err();
        assert_eq!(err.code, "not_found");
    }

    #[test]
    fn delete_person_preserves_body() {
        let fix = Fixture::new();
        let content =
            "---\npeople:\n  - name: alice\n    full_name: Alice\n---\n# Notes\n\nBody.\n";
        std::fs::write(fix.root.join("_people.md"), content).unwrap();
        delete_person_inner(&fix.root, "alice").unwrap();
        let out = std::fs::read_to_string(fix.root.join("_people.md")).unwrap();
        assert!(out.contains("# Notes"), "body must be preserved");
    }

    #[test]
    fn delete_tag_removes_from_tags_md() {
        let fix = Fixture::new();
        let tags_content = "---\ntags:\n  - name: followup\n    color: amber\n  - name: done\n    color: green\n---\n# Tag notes\n";
        std::fs::write(fix.root.join("_tags.md"), tags_content).unwrap();
        delete_tag_inner(&fix.root, "followup").unwrap();
        let out = std::fs::read_to_string(fix.root.join("_tags.md")).unwrap();
        assert!(!out.contains("followup"), "followup must be removed");
        assert!(out.contains("done"), "done must remain");
        assert!(out.contains("# Tag notes"), "body must be preserved");
    }

    #[test]
    fn delete_tag_noop_when_file_missing() {
        let fix = Fixture::new();
        // Must not error when _tags.md doesn't exist.
        delete_tag_inner(&fix.root, "nonexistent").unwrap();
    }

    #[test]
    fn rename_tag_through_command() {
        let fix = Fixture::new();
        fix.write_md(
            "notes/tagged.md",
            "---\ntags: [followup]\n---\n# Note\n\nSee #followup.\n",
        );
        let guard = fix.lib();
        let lib = guard.as_ref().unwrap();
        // Simulate the journal rename.
        journal::rename_tag(&lib.root, &lib.index, &lib.tokens, "followup", "follow-up").unwrap();
        let out = std::fs::read_to_string(fix.root.join("notes/tagged.md")).unwrap();
        assert!(out.contains("follow-up"));
        assert!(!out.contains("followup"));
    }

    // ── Group 4: Calendar ─────────────────────────────────────────────────────

    #[test]
    fn calendar_window_single_date_entry() {
        let fix = Fixture::new();
        fix.write_md(
            "work/task.md",
            "---\ntags: [work]\ndue: 2026-06-15\n---\n# Task\n\nBody.\n",
        );
        let guard = fix.lib();
        let lib = guard.as_ref().unwrap();
        let result = calendar_window_inner(lib, "2026-06-10", "2026-06-20", None).unwrap();
        assert!(!result.items.is_empty(), "task within window must appear");
        let item = result.items.iter().find(|i| i.entry_id == "work/task");
        assert!(item.is_some(), "work/task must be in calendar");
        let item = item.unwrap();
        assert!(!item.is_occurrence);
        assert_eq!(item.date_value, "2026-06-15");
    }

    #[test]
    fn calendar_window_out_of_range_excluded() {
        let fix = Fixture::new();
        fix.write_md("work/future.md", "---\ndue: 2026-07-01\n---\n# Future\n");
        let guard = fix.lib();
        let lib = guard.as_ref().unwrap();
        let result = calendar_window_inner(lib, "2026-06-01", "2026-06-30", None).unwrap();
        let item = result.items.iter().find(|i| i.entry_id == "work/future");
        assert!(item.is_none(), "future entry must not appear in window");
    }

    #[test]
    fn calendar_window_recurring_weekly() {
        let fix = Fixture::new();
        fix.write_md(
            "work/standup.md",
            "---\ndue: 2026-06-01\nrepeat: \"RRULE:FREQ=WEEKLY;BYDAY=MO\"\n---\n# Standup\n",
        );
        let guard = fix.lib();
        let lib = guard.as_ref().unwrap();
        // Query June 2026 (Mon: 1, 8, 15, 22, 29).
        let result = calendar_window_inner(lib, "2026-06-01", "2026-06-30", None).unwrap();
        let standup_items: Vec<_> = result
            .items
            .iter()
            .filter(|i| i.entry_id == "work/standup")
            .collect();
        assert!(
            !standup_items.is_empty(),
            "recurring standup must have occurrences"
        );
        for item in &standup_items {
            assert!(item.is_occurrence);
            assert!(item.occurrence_key.is_some());
        }
        // There are 5 Mondays in June 2026.
        assert_eq!(standup_items.len(), 5, "5 Mondays in June 2026");
    }

    #[test]
    fn calendar_window_recurring_with_override() {
        let fix = Fixture::new();
        fix.write_md(
            "work/standup2.md",
            "---\ndue: 2026-06-01\nrepeat: \"RRULE:FREQ=WEEKLY;BYDAY=MO\"\noverrides:\n  \"2026-06-08\": \"2026-06-09\"\n---\n# Standup2\n",
        );
        let guard = fix.lib();
        let lib = guard.as_ref().unwrap();
        let result = calendar_window_inner(lib, "2026-06-01", "2026-06-30", None).unwrap();
        let items: Vec<_> = result
            .items
            .iter()
            .filter(|i| i.entry_id == "work/standup2")
            .collect();
        // 2026-06-08 should be moved to 2026-06-09.
        let moved = items
            .iter()
            .any(|i| i.occurrence_key.as_deref() == Some("2026-06-09"));
        assert!(moved, "override must move 2026-06-08 to 2026-06-09");
        // 2026-06-08 must not appear as an occurrence key.
        let not_moved = items
            .iter()
            .any(|i| i.occurrence_key.as_deref() == Some("2026-06-08"));
        assert!(!not_moved, "2026-06-08 must not appear (overridden)");
    }

    #[test]
    fn calendar_window_range_date_spans_window() {
        let fix = Fixture::new();
        fix.write_md(
            "work/span.md",
            "---\ndue: 2026-06-14..2026-06-18\n---\n# Span\n",
        );
        let guard = fix.lib();
        let lib = guard.as_ref().unwrap();
        let result = calendar_window_inner(lib, "2026-06-16", "2026-06-20", None).unwrap();
        let item = result.items.iter().find(|i| i.entry_id == "work/span");
        assert!(item.is_some(), "overlapping range must appear");
    }

    #[test]
    fn calendar_window_invalid_date_returns_error() {
        let fix = Fixture::new();
        let guard = fix.lib();
        let lib = guard.as_ref().unwrap();
        let err = calendar_window_inner(lib, "not-a-date", "2026-06-30", None).unwrap_err();
        assert_eq!(err.code, "invalid_argument");
    }

    // ── Group 5: Settings ─────────────────────────────────────────────────────

    #[test]
    fn library_settings_empty_when_missing() {
        let fix = Fixture::new();
        let val = settings_get_library_inner(&fix.root).unwrap();
        assert!(val.as_object().map(|o| o.is_empty()).unwrap_or(false));
    }

    #[test]
    fn library_settings_round_trip() {
        let fix = Fixture::new();
        let patch = serde_json::json!({
            "primary_date_property": "scheduled",
            "asset_folder": "_files"
        });
        settings_set_library_inner(&fix.root, &patch).unwrap();
        let loaded = settings_get_library_inner(&fix.root).unwrap();
        assert_eq!(loaded["primary_date_property"].as_str(), Some("scheduled"));
        assert_eq!(loaded["asset_folder"].as_str(), Some("_files"));
    }

    #[test]
    fn library_settings_preserves_unknown_keys() {
        let fix = Fixture::new();
        // Write a settings file with an unknown key.
        let content = "---\nfoo_plugin_setting: bar\n---\n# Settings notes\n";
        std::fs::write(fix.root.join("_settings.md"), content).unwrap();
        // Apply a partial patch.
        let patch = serde_json::json!({"primary_date_property": "due"});
        settings_set_library_inner(&fix.root, &patch).unwrap();
        let out = std::fs::read_to_string(fix.root.join("_settings.md")).unwrap();
        assert!(
            out.contains("foo_plugin_setting"),
            "unknown key must be preserved"
        );
        assert!(out.contains("primary_date_property"));
    }

    #[test]
    fn library_settings_preserves_body() {
        let fix = Fixture::new();
        let content = "---\nprimary_date_property: due\n---\n# My settings notes\n\nBody.\n";
        std::fs::write(fix.root.join("_settings.md"), content).unwrap();
        let patch = serde_json::json!({"primary_date_property": "scheduled"});
        settings_set_library_inner(&fix.root, &patch).unwrap();
        let out = std::fs::read_to_string(fix.root.join("_settings.md")).unwrap();
        assert!(
            out.contains("# My settings notes"),
            "body must be preserved"
        );
    }

    #[test]
    fn calendar_uses_library_settings_prop() {
        let fix = Fixture::new();
        // Write _settings.md with primary_date_property = "scheduled".
        let settings = "---\nprimary_date_property: scheduled\n---\n";
        std::fs::write(fix.root.join("_settings.md"), settings).unwrap();
        // Write an entry that uses `scheduled` but not `due`.
        fix.write_md(
            "work/sched.md",
            "---\nscheduled: 2026-06-15\n---\n# Sched\n",
        );
        let guard = fix.lib();
        let lib = guard.as_ref().unwrap();
        let result = calendar_window_inner(lib, "2026-06-10", "2026-06-20", None).unwrap();
        let item = result.items.iter().find(|i| i.entry_id == "work/sched");
        assert!(item.is_some(), "entry with 'scheduled' prop must appear");
    }

    // ── Group 5b: Plugin settings ─────────────────────────────────────────────

    #[test]
    fn plugin_settings_empty_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings-com.test.plugin.json");
        let loaded = plugin_settings_get_inner(&path).unwrap();
        assert!(loaded.is_empty());
    }

    #[test]
    fn plugin_settings_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings-com.test.plugin.json");
        let mut values = std::collections::HashMap::new();
        values.insert("apiToken".to_string(), "secret-value".to_string());
        values.insert("theme".to_string(), "dark".to_string());
        plugin_settings_set_inner(&path, &values).unwrap();
        let loaded = plugin_settings_get_inner(&path).unwrap();
        assert_eq!(
            loaded.get("apiToken").map(|s| s.as_str()),
            Some("secret-value")
        );
        assert_eq!(loaded.get("theme").map(|s| s.as_str()), Some("dark"));
    }

    #[test]
    fn plugin_settings_overwrite_replaces_all() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings-com.test.plugin.json");
        let mut v1 = std::collections::HashMap::new();
        v1.insert("key1".to_string(), "a".to_string());
        v1.insert("key2".to_string(), "b".to_string());
        plugin_settings_set_inner(&path, &v1).unwrap();

        let mut v2 = std::collections::HashMap::new();
        v2.insert("key1".to_string(), "updated".to_string());
        plugin_settings_set_inner(&path, &v2).unwrap();

        let loaded = plugin_settings_get_inner(&path).unwrap();
        assert_eq!(loaded.get("key1").map(|s| s.as_str()), Some("updated"));
        // key2 was not in v2 — full replace, so it should be absent.
        assert!(!loaded.contains_key("key2"));
    }

    #[test]
    fn attach_file_uses_settings_asset_folder() {
        let fix = Fixture::new();
        // Write library settings with custom asset folder.
        let patch = serde_json::json!({"asset_folder": "_media"});
        settings_set_library_inner(&fix.root, &patch).unwrap();
        // The Rust command reads the folder from the settings.
        let folder = get_asset_folder_name(&fix.root);
        assert_eq!(folder, "_media");
        let path =
            attach_file_inner(&fix.root, "notes/entry.md", "photo.jpg", b"data", &folder).unwrap();
        assert_eq!(path, "notes/_media/photo.jpg");
    }
}
