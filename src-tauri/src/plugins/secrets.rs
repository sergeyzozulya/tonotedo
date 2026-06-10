// Secret settings storage (spec 0010 §"Settings", design-0002 §"Settings").
//
// A plugin's settings schema may declare `secret` fields. Non-secret values store in
// app-private per-library state (handled by the settings surface, #11). Secret values
// must NOT land in plaintext app state: they belong in the OS keychain/keystore and are
// handed to the plugin only at call time.
//
// V1 HOST DECISION: the OS keychain integration is NOT implemented in this host. Rather
// than add the `keyring` dependency (which brings a platform-specific native surface and
// per-target entitlement/keystore setup that is out of scope for the plugin-host phase and
// untestable headlessly), the host REJECTS attempts to store a secret value with a
// structured `Unsupported` error. This is the spec-sanctioned fallback ("unsupported in
// v1 host, store rejected"). The rejection is the boundary: a secret never silently leaks
// into plaintext state. Wiring `keyring` later is a localized change behind this function.

use super::error::PluginError;

/// Attempt to store a secret settings value. Always rejects in the v1 host (see module
/// docs); the caller surfaces the error in the settings UI.
///
/// This exists so the settings surface has a single, typed place to route secret writes
/// through — keeping the "secrets never hit plaintext state" invariant enforceable in one
/// spot rather than scattered across call sites.
pub fn store_secret(_plugin_id: &str, _key: &str, _value: &str) -> Result<(), PluginError> {
    Err(PluginError::unsupported(
        "secret settings are not supported by the v1 plugin host; \
         storing the value was rejected (no plaintext fallback)",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::error::PluginErrorCode;

    #[test]
    fn store_secret_is_rejected_not_silently_dropped() {
        let err = store_secret("com.test.p", "token", "hunter2").unwrap_err();
        assert_eq!(err.code, PluginErrorCode::Unsupported);
        // The boundary must be explicit, never a silent success.
        assert!(err.message.contains("rejected"));
    }
}
