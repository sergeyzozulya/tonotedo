// Per-library permission grant store (spec 0010 §"Permissions", design-0002 §"Model").
//
// Grants persist in `<library>/.tonotedo/state/plugin-grants.json`. They are per-library
// because plugins travel with the library (0013) and a synced-in plugin re-prompts on a
// new device by design (design-0002). The store records, per plugin id, the version the
// grants were captured against and the set of granted permission entries.
//
// VERSION-DIFF RULE (0010 edge case "Plugin version downgrade/upgrade across launches"):
//   When a plugin's manifest version differs from the stored version, reconcile against
//   the manifest's *requested* permission set:
//     - permissions the new version DROPPED → removed from the grant set (no zombie
//       permissions);
//     - permissions the new version ADDED (not previously seen) → the plugin goes to
//       `permissions-pending`: the user must re-prompt before they are granted.
//   A permission that exists in both versions keeps its prior grant decision.
//
// INVARIANTS:
//   - The grant set is the ONLY source of truth for whether a permission is live.
//     Capability injection re-checks it on every call (design-0002), so a revoke takes
//     effect mid-session.
//   - Persistence is atomic (core::fswrite::atomic_write) so a crash mid-write never
//     leaves a half-written grants file.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::core::fswrite::atomic_write;

use super::manifest::Manifest;

/// On-disk grant record for one plugin.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct PluginGrant {
    /// The version these grants were captured against.
    pub version: String,
    /// Permission entries the user has explicitly granted (subset of the manifest's
    /// requested permissions).
    pub granted: Vec<String>,
}

/// The full grant store (plugin id → record). Serialized as the top-level JSON object.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GrantStore {
    #[serde(default)]
    plugins: BTreeMap<String, PluginGrant>,
}

/// Path to the grants file for a library root.
pub fn grants_path(library_root: &Path) -> PathBuf {
    library_root
        .join(".tonotedo")
        .join("state")
        .join("plugin-grants.json")
}

impl GrantStore {
    /// Load the grant store from disk. A missing or unparseable file yields an empty
    /// store (grants are advisory state, never a hard failure on read).
    pub fn load(library_root: &Path) -> Self {
        let path = grants_path(library_root);
        match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            Err(_) => GrantStore::default(),
        }
    }

    /// Persist the grant store atomically.
    pub fn save(&self, library_root: &Path) -> std::io::Result<()> {
        let path = grants_path(library_root);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let bytes = serde_json::to_vec_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        atomic_write(&path, &bytes).map_err(|e| match e {
            crate::core::fswrite::WriteError::Io(io) => io,
        })
    }

    /// Whether a specific permission entry is currently granted to a plugin.
    ///
    /// This is the per-call gate used by capability injection (design-0002).
    pub fn is_granted(&self, plugin_id: &str, permission: &str) -> bool {
        self.plugins
            .get(plugin_id)
            .map(|g| g.granted.iter().any(|p| p == permission))
            .unwrap_or(false)
    }

    /// Set (grant or revoke) a single permission for a plugin at its current version.
    ///
    /// Granting a permission not in the plugin's manifest is a caller error; the host
    /// passes the manifest so we can validate. Returns `false` (no-op) if the permission
    /// is not in the manifest's requested set.
    pub fn set_grant(&mut self, manifest: &Manifest, permission: &str, granted: bool) -> bool {
        if !manifest.permissions.iter().any(|p| p == permission) {
            return false;
        }
        let entry = self
            .plugins
            .entry(manifest.id.clone())
            .or_insert_with(|| PluginGrant {
                version: manifest.version.clone(),
                granted: Vec::new(),
            });
        // Keep the record's version current (a set_grant implies the user acted on the
        // current manifest).
        entry.version = manifest.version.clone();
        let pos = entry.granted.iter().position(|p| p == permission);
        match (granted, pos) {
            (true, None) => entry.granted.push(permission.to_string()),
            (false, Some(i)) => {
                entry.granted.remove(i);
            }
            _ => {}
        }
        true
    }

    /// Reconcile the stored grant for a plugin against its (possibly new-version)
    /// manifest, applying the version-diff rule. Returns the resulting permission status.
    ///
    /// Mutates the store in place (dropping zombie permissions, bumping the recorded
    /// version) but does NOT persist — the caller decides when to `save`.
    pub fn reconcile_version(&mut self, manifest: &Manifest) -> PermissionStatus {
        let requested = &manifest.permissions;

        // A plugin with no requested permissions is trivially satisfied.
        if requested.is_empty() {
            // Clear any stale record so the store stays tidy.
            self.plugins.remove(&manifest.id);
            return PermissionStatus::Satisfied;
        }

        let prev = self.plugins.get(&manifest.id).cloned();

        match prev {
            None => {
                // Never granted → all requested permissions are pending.
                PermissionStatus::Pending
            }
            Some(prev) => {
                // Drop any granted permission the new version no longer requests.
                let retained: Vec<String> = prev
                    .granted
                    .iter()
                    .filter(|p| requested.contains(p))
                    .cloned()
                    .collect();

                // Are there requested permissions that are not yet granted?
                let has_ungranted = requested.iter().any(|r| !retained.contains(r));

                let record = self.plugins.entry(manifest.id.clone()).or_default();
                record.version = manifest.version.clone();
                record.granted = retained;

                if has_ungranted {
                    PermissionStatus::Pending
                } else {
                    PermissionStatus::Satisfied
                }
            }
        }
    }

    /// All currently-granted permissions for a plugin (for the manager UI).
    pub fn granted_for(&self, plugin_id: &str) -> Vec<String> {
        self.plugins
            .get(plugin_id)
            .map(|g| g.granted.clone())
            .unwrap_or_default()
    }
}

/// The permission state of a plugin after version reconciliation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionStatus {
    /// All requested permissions are granted (or none are requested).
    Satisfied,
    /// One or more requested permissions await the user's grant.
    Pending,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::manifest::parse_manifest;
    use tempfile::TempDir;

    fn manifest(version: &str, perms: &str) -> Manifest {
        let src = format!(
            "---\nid: com.test.p\nname: P\nversion: {version}\nshape: [provider]\ncapabilities: []\npermissions: {perms}\n---\n"
        );
        parse_manifest(src.as_bytes(), "p").unwrap()
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = TempDir::new().unwrap();
        let m = manifest("1.0.0", "[read-entries, write-entries]");
        let mut store = GrantStore::default();
        store.set_grant(&m, "read-entries", true);
        store.save(dir.path()).unwrap();

        let loaded = GrantStore::load(dir.path());
        assert!(loaded.is_granted("com.test.p", "read-entries"));
        assert!(!loaded.is_granted("com.test.p", "write-entries"));
    }

    #[test]
    fn set_grant_rejects_undeclared_permission() {
        let m = manifest("1.0.0", "[read-entries]");
        let mut store = GrantStore::default();
        assert!(!store.set_grant(&m, "network", false));
        assert!(store.set_grant(&m, "read-entries", true));
    }

    #[test]
    fn revoke_takes_effect() {
        let m = manifest("1.0.0", "[read-entries]");
        let mut store = GrantStore::default();
        store.set_grant(&m, "read-entries", true);
        assert!(store.is_granted("com.test.p", "read-entries"));
        store.set_grant(&m, "read-entries", false);
        assert!(!store.is_granted("com.test.p", "read-entries"));
    }

    #[test]
    fn version_diff_drops_removed_permission() {
        // v1 grants read + write; v2 drops write → write grant is gone, read stays.
        let v1 = manifest("1.0.0", "[read-entries, write-entries]");
        let mut store = GrantStore::default();
        store.set_grant(&v1, "read-entries", true);
        store.set_grant(&v1, "write-entries", true);

        let v2 = manifest("2.0.0", "[read-entries]");
        let status = store.reconcile_version(&v2);
        assert_eq!(status, PermissionStatus::Satisfied);
        assert!(store.is_granted("com.test.p", "read-entries"));
        assert!(!store.is_granted("com.test.p", "write-entries"));
    }

    #[test]
    fn version_diff_added_permission_is_pending() {
        // v1 grants read; v2 adds network → pending until re-prompt.
        let v1 = manifest("1.0.0", "[read-entries]");
        let mut store = GrantStore::default();
        store.set_grant(&v1, "read-entries", true);

        let v2 = manifest("2.0.0", "[read-entries, 'network:api.example.com']");
        let status = store.reconcile_version(&v2);
        assert_eq!(status, PermissionStatus::Pending);
        // The pre-existing grant is retained...
        assert!(store.is_granted("com.test.p", "read-entries"));
        // ...but the new one is NOT auto-granted.
        assert!(!store.is_granted("com.test.p", "network:api.example.com"));
    }

    #[test]
    fn never_granted_is_pending() {
        let m = manifest("1.0.0", "[read-entries]");
        let mut store = GrantStore::default();
        assert_eq!(store.reconcile_version(&m), PermissionStatus::Pending);
    }

    #[test]
    fn no_permissions_is_satisfied() {
        let m = manifest("1.0.0", "[]");
        let mut store = GrantStore::default();
        assert_eq!(store.reconcile_version(&m), PermissionStatus::Satisfied);
    }

    #[test]
    fn fully_granted_is_satisfied() {
        let m = manifest("1.0.0", "[read-entries]");
        let mut store = GrantStore::default();
        store.set_grant(&m, "read-entries", true);
        assert_eq!(store.reconcile_version(&m), PermissionStatus::Satisfied);
    }
}
