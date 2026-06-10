// Structured plugin errors (design-0002 §"Failure modes").
//
// Every failure a plugin job can produce maps to one of these variants. The host
// never lets a raw `rquickjs::Error`, panic, or string escape to the UI: the
// boundary always yields a `PluginError` with a stable machine-readable `code`,
// which the plugin manager (#26) surfaces verbatim.
//
// INVARIANT (error opacity): a `PluginError::message` derived from JS-thrown text
// is host-controlled — we truncate it and never interpret it. The `code` is the
// contract; the `message` is advisory.

use serde::Serialize;

/// Maximum length of a JS-derived error message we are willing to carry across the
/// boundary. JS can throw arbitrarily large strings; we cap to bound memory and to
/// keep notifications readable (design-0002 §"Failure modes").
pub const MAX_MESSAGE_LEN: usize = 2000;

/// A structured, non-panicking plugin failure.
///
/// `code` is stable and machine-readable; the UI keys off it. `message` is advisory
/// human text and may originate (truncated) from plugin code — never trusted for
/// control flow.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PluginError {
    /// Stable machine-readable discriminator.
    pub code: PluginErrorCode,
    /// Advisory human-readable detail. Truncated; never load-bearing.
    pub message: String,
}

/// Stable error codes for plugin job failures.
///
/// Serialized in `snake_case` to match the TS facade (`types.ts`).
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginErrorCode {
    /// The plugin's JS threw an exception (caught at the runtime boundary).
    JsException,
    /// A deadline (command 5s / render 500ms) elapsed; the job was interrupted.
    Deadline,
    /// The runtime hit its memory limit; the offending allocation failed and the job died.
    Memory,
    /// A required capability was not declared in the manifest.
    CapabilityNotDeclared,
    /// A declared capability's permission grant is missing or was revoked.
    PermissionRevoked,
    /// A network host was requested that no `network:<host>` grant covers.
    NetworkHostNotGranted,
    /// The plugin tried to touch an `entries-owner` path outside its declared subtree.
    PathOutsidePrefix,
    /// An `entries-owner` write found the target user-modified since the plugin last
    /// read it; the fixed conflict policy refused the overwrite (0010, 0002).
    Conflict,
    /// The capability has been suspended after 3 strikes this session.
    Suspended,
    /// The plugin is not active (not found, failed validation, or permissions pending).
    NotActive,
    /// The named command/renderer/view was never registered by the plugin.
    NotRegistered,
    /// Host-internal failure (worker thread died, channel closed, lock poisoned).
    HostInternal,
    /// A feature is present but deliberately deferred in the v1 host (e.g. network).
    Unsupported,
    /// Arguments to a host call were malformed (bad JSON, wrong shape).
    InvalidArgument,
}

impl PluginError {
    /// Construct an error, truncating `message` to `MAX_MESSAGE_LEN` on a char boundary.
    pub fn new(code: PluginErrorCode, message: impl Into<String>) -> Self {
        let mut message = message.into();
        if message.len() > MAX_MESSAGE_LEN {
            // Truncate on a char boundary to keep the string valid UTF-8.
            let mut end = MAX_MESSAGE_LEN;
            while end > 0 && !message.is_char_boundary(end) {
                end -= 1;
            }
            message.truncate(end);
            message.push('…');
        }
        PluginError { code, message }
    }

    pub fn js_exception(message: impl Into<String>) -> Self {
        Self::new(PluginErrorCode::JsException, message)
    }

    pub fn deadline() -> Self {
        Self::new(
            PluginErrorCode::Deadline,
            "plugin job exceeded its deadline and was interrupted",
        )
    }

    pub fn memory() -> Self {
        Self::new(
            PluginErrorCode::Memory,
            "plugin runtime hit its memory limit",
        )
    }

    pub fn capability_not_declared(cap: &str) -> Self {
        Self::new(
            PluginErrorCode::CapabilityNotDeclared,
            format!("capability `{cap}` is not declared in the manifest"),
        )
    }

    pub fn permission_revoked(perm: &str) -> Self {
        Self::new(
            PluginErrorCode::PermissionRevoked,
            format!("permission `{perm}` is not granted (or was revoked)"),
        )
    }

    pub fn network_host_not_granted(host: &str) -> Self {
        Self::new(
            PluginErrorCode::NetworkHostNotGranted,
            format!("no `network:{host}` grant covers this request"),
        )
    }

    pub fn path_outside_prefix(path: &str) -> Self {
        Self::new(
            PluginErrorCode::PathOutsidePrefix,
            format!("path `{path}` is outside the plugin's owned subtree"),
        )
    }

    pub fn conflict(path: &str) -> Self {
        Self::new(
            PluginErrorCode::Conflict,
            format!("entry `{path}` was modified outside the plugin since its last read"),
        )
    }

    pub fn suspended() -> Self {
        Self::new(
            PluginErrorCode::Suspended,
            "plugin capability suspended after repeated failures (3 strikes)",
        )
    }

    pub fn not_active() -> Self {
        Self::new(
            PluginErrorCode::NotActive,
            "plugin is not active (failed validation or awaiting permissions)",
        )
    }

    pub fn not_registered(id: &str) -> Self {
        Self::new(
            PluginErrorCode::NotRegistered,
            format!("`{id}` was not registered by the plugin"),
        )
    }

    pub fn host_internal(message: impl Into<String>) -> Self {
        Self::new(PluginErrorCode::HostInternal, message)
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(PluginErrorCode::Unsupported, message)
    }

    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self::new(PluginErrorCode::InvalidArgument, message)
    }
}

impl std::fmt::Display for PluginError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{:?}] {}", self.code, self.message)
    }
}

impl std::error::Error for PluginError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_truncated_on_char_boundary() {
        let long = "é".repeat(MAX_MESSAGE_LEN); // 2-byte chars → > MAX bytes
        let e = PluginError::js_exception(long);
        // Must be valid UTF-8 and bounded.
        assert!(e.message.len() <= MAX_MESSAGE_LEN + 4);
        assert!(e.message.ends_with('…'));
    }

    #[test]
    fn short_message_untouched() {
        let e = PluginError::js_exception("boom");
        assert_eq!(e.message, "boom");
    }

    #[test]
    fn codes_serialize_snake_case() {
        let e = PluginError::deadline();
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"deadline\""));
    }
}
