// Plugin manifest discovery + validation (spec 0010 §"Manifest", design-0002 §"Model").
//
// A plugin is a folder under `<library>/.tonotedo/plugins/<dir>/` containing a
// `plugin.md`. The frontmatter declares id/name/version/shape/capabilities/permissions
// and an optional settings schema. The body is the README (surfaced verbatim by the
// manager; the host does not parse it).
//
// INVARIANTS:
//   - A folder without a readable `plugin.md`, or one whose frontmatter fails the
//     schema below, is IGNORED with a `DiscoveryWarning` — never a hard failure
//     (0010 edge case "Plugin without plugin.md"). Discovery of one bad plugin must
//     not stop discovery of the others.
//   - Two plugins declaring the same `entries-owner` path: the SECOND (by stable
//     directory-name order) is rejected (0010 edge case "Two plugins claim the same
//     path"). Determinism matters so the same plugin "wins" across launches; we sort
//     directory entries before resolving conflicts.
//   - `id`, `name`, `version` are mandatory non-empty strings. `version` must be
//     semver-shaped (`MAJOR.MINOR.PATCH`) so the grant store's version-diff rule
//     (grants.rs) can compare versions meaningfully.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use saphyr::{LoadableYamlNode, YamlOwned};
use serde::Serialize;

use crate::core::frontmatter::split_frontmatter;

/// The v1 closed capability set (0010 §"Capabilities"). Anything else is rejected.
pub const KNOWN_CAPABILITIES: &[&str] = &["command", "view", "render-code-block", "entries-owner"];

/// The v1 plugin shapes (0010 §"Two shapes").
pub const KNOWN_SHAPES: &[&str] = &["provider", "processor"];

/// A fully-validated plugin manifest.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub shape: Vec<String>,
    pub capabilities: Vec<String>,
    /// Declared permission entries, verbatim (e.g. `read-entries`, `network:api.example.com`).
    pub permissions: Vec<String>,
    /// The `entries-owner` group path this plugin owns, if it declared the capability.
    /// Library-relative, normalized (no leading/trailing slash, no `..`).
    pub entries_owner_path: Option<String>,
    /// Declared settings schema (0010 §"Settings"). Empty when none declared.
    pub settings: Vec<SettingField>,
    /// The plugin folder name under `.tonotedo/plugins/` (used for stable ordering).
    pub dir_name: String,
    /// The plugin's README (manifest body), surfaced verbatim by the manager.
    pub readme: String,
}

/// A single settings field (0010 §"Settings").
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SettingField {
    pub key: String,
    #[serde(rename = "type")]
    pub field_type: SettingType,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Default value as a YAML/JSON-ish string (rendered by the settings surface).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    /// For `enum` fields: the allowed values.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub options: Vec<String>,
}

/// The typed setting kinds (0010 §"Settings").
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SettingType {
    String,
    Boolean,
    Number,
    Enum,
    /// Secret fields go to the OS keychain, not app-private state (0010, design-0002).
    Secret,
}

/// A record that a discovered folder was ignored, with the reason.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DiscoveryWarning {
    /// The folder name (or path) that was ignored.
    pub source: String,
    /// Human-readable reason.
    pub reason: String,
}

/// The outcome of scanning `.tonotedo/plugins/`.
#[derive(Debug, Default)]
pub struct Discovery {
    /// Manifests that validated. Conflicting `entries-owner` losers are NOT here
    /// (they appear in `warnings`).
    pub manifests: Vec<Manifest>,
    /// Folders that were ignored, with reasons.
    pub warnings: Vec<DiscoveryWarning>,
}

/// Absolute path to the plugins directory for a library root.
pub fn plugins_dir(library_root: &Path) -> PathBuf {
    library_root.join(".tonotedo").join("plugins")
}

/// Discover and validate all plugins under `<library>/.tonotedo/plugins/`.
///
/// Never errors: a missing directory yields an empty `Discovery`; unreadable or
/// invalid folders become `warnings`.
pub fn discover(library_root: &Path) -> Discovery {
    let dir = plugins_dir(library_root);
    let mut out = Discovery::default();

    let read_dir = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        // No plugins dir → nothing to discover. Not a warning.
        Err(_) => return out,
    };

    // Collect + sort directory names for deterministic conflict resolution.
    let mut entries: Vec<PathBuf> = read_dir
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    entries.sort();

    // First pass: validate every manifest independently.
    let mut validated: Vec<Manifest> = Vec::new();
    for path in entries {
        let dir_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let manifest_path = path.join("plugin.md");
        match std::fs::read(&manifest_path) {
            Ok(bytes) => match parse_manifest(&bytes, &dir_name) {
                Ok(m) => validated.push(m),
                Err(reason) => out.warnings.push(DiscoveryWarning {
                    source: dir_name,
                    reason,
                }),
            },
            Err(_) => out.warnings.push(DiscoveryWarning {
                source: dir_name,
                reason: "no readable plugin.md in folder".to_string(),
            }),
        }
    }

    // Second pass: resolve entries-owner path conflicts. First declarer (sorted order)
    // wins; later declarers of the same path are rejected (0010).
    let mut claimed: BTreeSet<String> = BTreeSet::new();
    for m in validated {
        if let Some(owned) = &m.entries_owner_path {
            if !claimed.insert(owned.clone()) {
                out.warnings.push(DiscoveryWarning {
                    source: m.dir_name.clone(),
                    reason: format!(
                        "entries-owner path `{owned}` is already claimed by another plugin"
                    ),
                });
                continue;
            }
        }
        out.manifests.push(m);
    }

    out
}

/// Parse + validate a single `plugin.md`'s bytes into a `Manifest`.
///
/// Returns `Err(reason)` for any schema violation; the caller turns that into a
/// `DiscoveryWarning`. This function is the whole manifest schema gate.
pub fn parse_manifest(bytes: &[u8], dir_name: &str) -> Result<Manifest, String> {
    let split = split_frontmatter(bytes);
    if !split.had_fence {
        return Err("plugin.md has no frontmatter block".to_string());
    }

    let docs = YamlOwned::load_from_str(&split.yaml_text)
        .map_err(|e| format!("malformed manifest frontmatter: {e}"))?;
    let doc = docs
        .into_iter()
        .next()
        .ok_or_else(|| "empty manifest frontmatter".to_string())?;
    let mapping = doc
        .as_mapping()
        .ok_or_else(|| "manifest frontmatter is not a mapping".to_string())?;

    let get = |key: &str| -> Option<&YamlOwned> {
        mapping
            .iter()
            .find(|(k, _)| k.as_str() == Some(key))
            .map(|(_, v)| v)
    };

    let id = require_nonempty_string(get("id"), "id")?;
    validate_plugin_id(&id)?;
    let name = require_nonempty_string(get("name"), "name")?;
    let version = require_nonempty_string(get("version"), "version")?;
    if !is_semver(&version) {
        return Err(format!(
            "version `{version}` is not semver (expected MAJOR.MINOR.PATCH)"
        ));
    }

    let shape = string_list(get("shape"), "shape")?;
    for s in &shape {
        if !KNOWN_SHAPES.contains(&s.as_str()) {
            return Err(format!("unknown shape `{s}`"));
        }
    }
    if shape.is_empty() {
        return Err("shape must declare at least one of provider/processor".to_string());
    }

    let capabilities = string_list(get("capabilities"), "capabilities")?;
    for c in &capabilities {
        if !KNOWN_CAPABILITIES.contains(&c.as_str()) {
            return Err(format!(
                "unknown capability `{c}` (v1 set is closed; see 0010)"
            ));
        }
    }

    let permissions = string_list(get("permissions"), "permissions")?;
    for p in &permissions {
        validate_permission(p)?;
    }

    // `entries-owner` capability requires an `entries-owner` path declaration.
    let entries_owner_path = if capabilities.iter().any(|c| c == "entries-owner") {
        let raw = require_nonempty_string(get("entries-owner"), "entries-owner")?;
        Some(normalize_owner_path(&raw)?)
    } else {
        None
    };

    let settings = parse_settings(get("settings"))?;

    Ok(Manifest {
        id,
        name,
        version,
        shape,
        capabilities,
        permissions,
        entries_owner_path,
        settings,
        dir_name: dir_name.to_string(),
        readme: split.body,
    })
}

// ── Field helpers ──────────────────────────────────────────────────────────────

fn require_nonempty_string(node: Option<&YamlOwned>, field: &str) -> Result<String, String> {
    let s = node
        .and_then(|y| y.as_str())
        .ok_or_else(|| format!("`{field}` is required and must be a string"))?;
    if s.trim().is_empty() {
        return Err(format!("`{field}` must not be empty"));
    }
    Ok(s.to_string())
}

/// Accept either a single string (`shape: processor`) or a YAML sequence
/// (`shape: [processor]`). Returns the de-duplicated list.
fn string_list(node: Option<&YamlOwned>, field: &str) -> Result<Vec<String>, String> {
    let node = match node {
        None => return Ok(Vec::new()),
        Some(n) if n.is_null() => return Ok(Vec::new()),
        Some(n) => n,
    };
    if let Some(s) = node.as_str() {
        return Ok(vec![s.to_string()]);
    }
    let seq = node
        .as_sequence()
        .ok_or_else(|| format!("`{field}` must be a string or a list of strings"))?;
    let mut out = Vec::new();
    for item in seq.iter() {
        let s = item
            .as_str()
            .ok_or_else(|| format!("`{field}` entries must be strings"))?;
        if !out.contains(&s.to_string()) {
            out.push(s.to_string());
        }
    }
    Ok(out)
}

/// A permission entry is valid if it is a bare keyword (`read-entries`,
/// `write-entries`) or a scoped form (`network:<host>`, `filesystem:<path>`).
/// Validate a plugin id (security: final-review F12).
///
/// A plugin's command ids must be namespaced under its plugin id (enforced in
/// the runtime). If the id could alias a core command namespace, a plugin could
/// register — and on suspend, *unregister* — a core command (e.g. `entry.create`).
/// Require a reverse-DNS-ish form (at least one `.`, charset `[a-z0-9.-]`) and
/// forbid ids equal to or prefixing any reserved core namespace.
fn validate_plugin_id(id: &str) -> Result<(), String> {
    const RESERVED_CORE: &[&str] = &[
        "entry", "editor", "view", "focus", "app", "palette", "bench", "nav", "group", "tag",
    ];
    if !id.contains('.') {
        return Err(format!(
            "plugin id `{id}` must be namespaced (reverse-DNS form, e.g. com.example.myplugin)"
        ));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
    {
        return Err(format!(
            "plugin id `{id}` may only contain lowercase letters, digits, '.', and '-'"
        ));
    }
    let first = id.split('.').next().unwrap_or("");
    if RESERVED_CORE.contains(&first) {
        return Err(format!(
            "plugin id `{id}` may not start with the reserved core namespace `{first}`"
        ));
    }
    Ok(())
}

fn validate_permission(p: &str) -> Result<(), String> {
    if p.trim().is_empty() {
        return Err("empty permission entry".to_string());
    }
    if let Some((scope, rest)) = p.split_once(':') {
        match scope {
            "network" | "filesystem" => {
                if rest.trim().is_empty() {
                    return Err(format!("`{scope}:` permission requires a value"));
                }
                Ok(())
            }
            other => Err(format!("unknown scoped permission `{other}:…`")),
        }
    } else {
        match p {
            "read-entries" | "write-entries" | "filesystem" => Ok(()),
            // SECURITY (review M5): a bare `network` is an any-host wildcard — far too
            // broad. Network access must be scoped to a specific host (`network:<host>`),
            // which the per-request gate enforces exactly. Reject the bare form loudly.
            "network" => Err(
                "bare `network` permission is not allowed; scope it as `network:<host>`"
                    .to_string(),
            ),
            other => Err(format!("unknown permission `{other}`")),
        }
    }
}

/// Normalize an `entries-owner` group path: trim slashes, reject traversal and
/// absolute paths. The result is library-relative with no leading/trailing slash.
fn normalize_owner_path(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_matches('/');
    if trimmed.is_empty() {
        return Err("entries-owner path must not be empty".to_string());
    }
    if trimmed.starts_with('/') || trimmed.contains("..") {
        return Err(format!(
            "entries-owner path `{raw}` must be library-relative"
        ));
    }
    // Forbid the reserved metadata roots and the plugins area itself.
    if trimmed == ".tonotedo" || trimmed.starts_with(".tonotedo/") {
        return Err("entries-owner path may not target app metadata".to_string());
    }
    Ok(trimmed.to_string())
}

fn parse_settings(node: Option<&YamlOwned>) -> Result<Vec<SettingField>, String> {
    let node = match node {
        None => return Ok(Vec::new()),
        Some(n) if n.is_null() => return Ok(Vec::new()),
        Some(n) => n,
    };
    let seq = node
        .as_sequence()
        .ok_or_else(|| "`settings` must be a list of field definitions".to_string())?;
    let mut out = Vec::new();
    for item in seq.iter() {
        let m = item
            .as_mapping()
            .ok_or_else(|| "each settings entry must be a mapping".to_string())?;
        let field_get = |key: &str| -> Option<&YamlOwned> {
            m.iter()
                .find(|(k, _)| k.as_str() == Some(key))
                .map(|(_, v)| v)
        };
        let key = require_nonempty_string(field_get("key"), "settings.key")?;
        let type_str = require_nonempty_string(field_get("type"), "settings.type")?;
        let field_type = match type_str.as_str() {
            "string" => SettingType::String,
            "boolean" => SettingType::Boolean,
            "number" => SettingType::Number,
            "enum" => SettingType::Enum,
            "secret" => SettingType::Secret,
            other => return Err(format!("unknown settings type `{other}`")),
        };
        let label = field_get("label")
            .and_then(|y| y.as_str())
            .unwrap_or(&key)
            .to_string();
        let description = field_get("description")
            .and_then(|y| y.as_str())
            .map(|s| s.to_string());
        let default = field_get("default").map(yaml_scalar_to_string);
        let options = match field_get("options") {
            Some(n) => string_list(Some(n), "settings.options")?,
            None => Vec::new(),
        };
        if matches!(field_type, SettingType::Enum) && options.is_empty() {
            return Err(format!("enum setting `{key}` must declare `options`"));
        }
        out.push(SettingField {
            key,
            field_type,
            label,
            description,
            default,
            options,
        });
    }
    Ok(out)
}

/// Render a scalar YAML node to a display string (for setting defaults).
fn yaml_scalar_to_string(node: &YamlOwned) -> String {
    if let Some(s) = node.as_str() {
        return s.to_string();
    }
    if let Some(b) = node.as_bool() {
        return b.to_string();
    }
    if let Some(i) = node.as_integer() {
        return i.to_string();
    }
    if node.is_null() {
        return String::new();
    }
    // Fallback for floats / unusual scalars.
    format!("{node:?}")
}

/// A loose semver check: `MAJOR.MINOR.PATCH` where each is a non-negative integer.
/// Pre-release / build metadata suffixes are tolerated after the patch.
pub fn is_semver(v: &str) -> bool {
    let core = v.split(['-', '+']).next().unwrap_or(v);
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &[u8] = b"---\nid: com.example.mermaid\nname: Mermaid\nversion: 0.1.0\nshape: [processor]\ncapabilities: [render-code-block]\npermissions: [read-entries]\n---\nREADME body.\n";

    #[test]
    fn parses_a_good_manifest() {
        let m = parse_manifest(GOOD, "mermaid").unwrap();
        assert_eq!(m.id, "com.example.mermaid");
        assert_eq!(m.version, "0.1.0");
        assert_eq!(m.shape, vec!["processor"]);
        assert_eq!(m.capabilities, vec!["render-code-block"]);
        assert_eq!(m.permissions, vec!["read-entries"]);
        assert!(m.entries_owner_path.is_none());
        assert_eq!(m.readme, "README body.\n");
    }

    // F12 — plugin id must be namespaced and may not alias core command namespaces.
    #[test]
    fn rejects_core_namespace_and_unnamespaced_ids() {
        let mk = |id: &str| {
            format!(
                "---\nid: {id}\nname: X\nversion: 0.1.0\nshape: [processor]\ncapabilities: [command]\npermissions: []\n---\nx"
            )
            .into_bytes()
        };
        // bare core namespace — would let a command id `entry.create` replace core.
        assert!(parse_manifest(&mk("entry"), "x").is_err());
        // reverse-DNS form whose first label is reserved.
        assert!(parse_manifest(&mk("editor.evil"), "x").is_err());
        // no dot at all.
        assert!(parse_manifest(&mk("mermaid"), "x").is_err());
        // bad charset.
        assert!(parse_manifest(&mk("com.Example.Plugin"), "x").is_err());
        // valid namespaced id passes.
        assert!(parse_manifest(&mk("com.example.tool"), "x").is_ok());
    }

    #[test]
    fn rejects_missing_frontmatter() {
        assert!(parse_manifest(b"no frontmatter here", "x").is_err());
    }

    #[test]
    fn rejects_missing_id() {
        let src = b"---\nname: X\nversion: 1.0.0\nshape: [processor]\n---\n";
        assert!(parse_manifest(src, "x").is_err());
    }

    #[test]
    fn rejects_bad_version() {
        let src = b"---\nid: com.test.x\nname: X\nversion: v1\nshape: [processor]\ncapabilities: []\n---\n";
        let e = parse_manifest(src, "x").unwrap_err();
        assert!(e.contains("semver"), "{e}");
    }

    #[test]
    fn rejects_unknown_capability() {
        let src = b"---\nid: com.test.x\nname: X\nversion: 1.0.0\nshape: [processor]\ncapabilities: [telepathy]\n---\n";
        assert!(parse_manifest(src, "x").unwrap_err().contains("capability"));
    }

    #[test]
    fn rejects_unknown_permission() {
        let src = b"---\nid: com.test.x\nname: X\nversion: 1.0.0\nshape: [processor]\ncapabilities: []\npermissions: [steal-data]\n---\n";
        assert!(parse_manifest(src, "x").unwrap_err().contains("permission"));
    }

    #[test]
    fn accepts_network_host_permission() {
        let src = b"---\nid: com.test.x\nname: X\nversion: 1.0.0\nshape: [provider]\ncapabilities: []\npermissions: ['network:api.example.com']\n---\n";
        let m = parse_manifest(src, "x").unwrap();
        assert_eq!(m.permissions, vec!["network:api.example.com"]);
    }

    #[test]
    fn rejects_bare_network_permission() {
        // M5: a bare `network` is an any-host wildcard and must be rejected loudly.
        let src = b"---\nid: com.test.x\nname: X\nversion: 1.0.0\nshape: [provider]\ncapabilities: []\npermissions: [network]\n---\n";
        let e = parse_manifest(src, "x").unwrap_err();
        assert!(e.contains("network:<host>"), "{e}");
    }

    #[test]
    fn entries_owner_requires_path() {
        let src = b"---\nid: com.test.x\nname: X\nversion: 1.0.0\nshape: [provider]\ncapabilities: [entries-owner]\n---\n";
        assert!(parse_manifest(src, "x").is_err());
    }

    #[test]
    fn entries_owner_path_normalized() {
        let src = b"---\nid: com.test.x\nname: X\nversion: 1.0.0\nshape: [provider]\ncapabilities: [entries-owner]\nentries-owner: /Calendar/Google/\n---\n";
        let m = parse_manifest(src, "x").unwrap();
        assert_eq!(m.entries_owner_path.as_deref(), Some("Calendar/Google"));
    }

    #[test]
    fn entries_owner_rejects_traversal() {
        let src = b"---\nid: com.test.x\nname: X\nversion: 1.0.0\nshape: [provider]\ncapabilities: [entries-owner]\nentries-owner: ../escape\n---\n";
        assert!(parse_manifest(src, "x").is_err());
    }

    #[test]
    fn parses_settings_with_secret_and_enum() {
        let src = b"---\nid: com.test.x\nname: X\nversion: 1.0.0\nshape: [provider]\ncapabilities: []\nsettings:\n  - key: token\n    type: secret\n    label: API token\n  - key: mode\n    type: enum\n    label: Mode\n    options: [fast, slow]\n    default: fast\n---\n";
        let m = parse_manifest(src, "x").unwrap();
        assert_eq!(m.settings.len(), 2);
        assert_eq!(m.settings[0].field_type, SettingType::Secret);
        assert_eq!(m.settings[1].field_type, SettingType::Enum);
        assert_eq!(m.settings[1].options, vec!["fast", "slow"]);
        assert_eq!(m.settings[1].default.as_deref(), Some("fast"));
    }

    #[test]
    fn enum_setting_requires_options() {
        let src = b"---\nid: com.test.x\nname: X\nversion: 1.0.0\nshape: [provider]\ncapabilities: []\nsettings:\n  - key: mode\n    type: enum\n    label: Mode\n---\n";
        assert!(parse_manifest(src, "x").is_err());
    }

    #[test]
    fn shape_accepts_single_string() {
        let src = b"---\nid: com.test.x\nname: X\nversion: 1.0.0\nshape: processor\ncapabilities: []\n---\n";
        let m = parse_manifest(src, "x").unwrap();
        assert_eq!(m.shape, vec!["processor"]);
    }

    #[test]
    fn semver_check() {
        assert!(is_semver("1.2.3"));
        assert!(is_semver("0.0.1-beta.1"));
        assert!(!is_semver("1.2"));
        assert!(!is_semver("1.2.x"));
        assert!(!is_semver("v1.2.3"));
    }
}
