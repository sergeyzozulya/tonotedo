// Plugin host (issue #25) — THE security boundary of the app.
//
// Specs: docs/spec/0010-plugins.md (contract), docs/spec/0002-entries.md (atomic write
// path), design: docs/tech/design-0002-plugin-host.md (architecture), adr-0005 (engine).
//
// This module owns the plugin lifecycle and is the single point through which the UI
// talks to plugins. The UI never holds a runtime; it calls the Tauri commands in lib.rs,
// which delegate here.
//
// LIFECYCLE (design-0002 §"Model"):
//   discovered → manifest-validated → permissions-pending → active → (suspended | failed)
//
//   - discovered/manifest-validated: `discover()` scans `.tonotedo/plugins/`. A folder
//     with a valid manifest reaches `manifest-validated`; an invalid one is dropped with
//     a warning (it never enters the host's plugin map; it lives only in `warnings`).
//   - permissions-pending: a validated plugin whose requested permissions are not all
//     granted (grant store version-diff). It is NOT activated; its commands cannot run.
//   - active: all permissions satisfied → the runtime is spawned, entry JS evaluated,
//     registrations collected.
//   - suspended: 3 strikes during the session (runtime-level). The PluginRuntime reports
//     this; the host surfaces it.
//   - failed: activation itself failed (entry JS threw at load, or a dup entries-owner
//     loser). Stays out of `active`.
//
// THREADING: each active plugin owns its own worker thread (see runtime.rs). The host
// holds the `PluginRuntime` handles behind a `Mutex` inside the Tauri-managed
// `PluginHostState`. The host map is small (a handful of plugins) so a coarse lock is
// fine; runtime calls block the caller's command thread, never the UI thread.

pub mod capability;
pub mod error;
pub mod grants;
pub mod manifest;
pub mod runtime;
pub mod secrets;

#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;

use error::PluginError;
use grants::{GrantStore, PermissionStatus};
use manifest::{DiscoveryWarning, Manifest, SettingField};
use runtime::PluginRuntime;

/// The lifecycle status of a plugin, as surfaced to the manager UI (#26).
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PluginStatus {
    /// Manifest validated; all permissions granted; runtime active.
    Active,
    /// Manifest validated but one or more requested permissions await the user.
    PermissionsPending,
    /// Activation failed (entry JS threw at load, etc.).
    Failed,
    /// Suspended after 3 strikes this session.
    Suspended,
}

/// One plugin tracked by the host.
struct LoadedPlugin {
    manifest: Manifest,
    status: PluginStatus,
    /// Present only when `status == Active`/`Suspended`.
    runtime: Option<PluginRuntime>,
    /// A failure reason when `status == Failed`.
    failure: Option<String>,
}

/// The host's mutable state, managed by Tauri alongside `AppState` (lib.rs).
pub struct PluginHostState(pub Mutex<Option<PluginHost>>);

impl PluginHostState {
    pub fn empty() -> Self {
        PluginHostState(Mutex::new(None))
    }
}

/// The live plugin host for an open library.
pub struct PluginHost {
    library_root: PathBuf,
    /// Shared, so injected entries-owner closures see live revocations (design-0002).
    grants: Arc<Mutex<GrantStore>>,
    /// Validated plugins keyed by id. Invalid folders never appear here.
    plugins: Vec<LoadedPlugin>,
    /// Discovery + activation warnings, surfaced verbatim by the manager.
    warnings: Vec<DiscoveryWarning>,
}

/// A plugin descriptor for the manager UI (`plugins_list`).
#[derive(Debug, Clone, Serialize)]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub status: PluginStatus,
    pub shape: Vec<String>,
    pub capabilities: Vec<String>,
    /// All permission entries the manifest requests.
    pub permissions: Vec<String>,
    /// The subset of `permissions` currently granted.
    pub granted: Vec<String>,
    pub settings: Vec<SettingField>,
    /// Namespaced command ids the plugin registered (empty unless active).
    pub commands: Vec<capability::RegisteredCommand>,
    /// Namespaced view names the plugin registered (empty unless active).
    pub views: Vec<capability::RegisteredView>,
    /// Strike count this session (0 unless something failed).
    pub strikes: u64,
    /// Per-plugin warnings (e.g. activation failure detail).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
}

impl PluginHost {
    /// Build the host for a library: discover plugins, reconcile grants (version-diff),
    /// and activate those whose permissions are satisfied.
    pub fn load(library_root: PathBuf) -> Self {
        let discovery = manifest::discover(&library_root);
        let grant_store = GrantStore::load(&library_root);
        let grants = Arc::new(Mutex::new(grant_store));

        let mut plugins = Vec::new();
        for m in discovery.manifests {
            let status = {
                let mut g = grants.lock().expect("grants lock");
                match g.reconcile_version(&m) {
                    PermissionStatus::Satisfied => PluginStatus::Active,
                    PermissionStatus::Pending => PluginStatus::PermissionsPending,
                }
            };
            plugins.push(LoadedPlugin {
                manifest: m,
                status,
                runtime: None,
                failure: None,
            });
        }

        // Persist any version-diff reconciliation (dropped zombie permissions).
        if let Ok(g) = grants.lock() {
            let _ = g.save(&library_root);
        }

        let mut host = PluginHost {
            library_root,
            grants,
            plugins,
            warnings: discovery.warnings,
        };

        // Activate every plugin whose permissions are satisfied.
        let ids: Vec<String> = host
            .plugins
            .iter()
            .filter(|p| p.status == PluginStatus::Active)
            .map(|p| p.manifest.id.clone())
            .collect();
        for id in ids {
            host.activate(&id);
        }

        host
    }

    /// Read a plugin's entry JS. Convention: `<dir>/main.js` next to `plugin.md`. A
    /// missing entry file is allowed (a plugin may be manifest-only, e.g. a pure view
    /// declaration) — the source is then empty.
    fn entry_source(&self, manifest: &Manifest) -> String {
        let path = manifest::plugins_dir(&self.library_root)
            .join(&manifest.dir_name)
            .join("main.js");
        std::fs::read_to_string(path).unwrap_or_default()
    }

    /// Spawn the runtime for a plugin and move it to `active` (or `failed`).
    fn activate(&mut self, plugin_id: &str) {
        let Some(idx) = self.plugins.iter().position(|p| p.manifest.id == plugin_id) else {
            return;
        };
        // Take what we need before borrowing mutably.
        let manifest = self.plugins[idx].manifest.clone();
        let source = self.entry_source(&manifest);
        let grants = Arc::clone(&self.grants);
        let root = self.library_root.clone();

        match PluginRuntime::spawn(manifest, source, grants, root) {
            Ok(rt) => {
                let p = &mut self.plugins[idx];
                p.status = PluginStatus::Active;
                p.runtime = Some(rt);
                p.failure = None;
            }
            Err(e) => {
                let p = &mut self.plugins[idx];
                p.status = PluginStatus::Failed;
                p.runtime = None;
                p.failure = Some(e.to_string());
            }
        }
    }

    /// The manager's plugin list.
    pub fn list(&self) -> Vec<PluginInfo> {
        let mut out = Vec::with_capacity(self.plugins.len());
        for p in &self.plugins {
            let granted = self
                .grants
                .lock()
                .map(|g| g.granted_for(&p.manifest.id))
                .unwrap_or_default();
            // Reflect a live suspension from the runtime.
            let (status, strikes, commands, views) = match &p.runtime {
                Some(rt) => {
                    let status = if rt.is_suspended() {
                        PluginStatus::Suspended
                    } else {
                        p.status
                    };
                    (
                        status,
                        rt.strike_count(),
                        rt.commands.clone(),
                        rt.views.clone(),
                    )
                }
                None => (p.status, 0, Vec::new(), Vec::new()),
            };
            out.push(PluginInfo {
                id: p.manifest.id.clone(),
                name: p.manifest.name.clone(),
                version: p.manifest.version.clone(),
                status,
                shape: p.manifest.shape.clone(),
                capabilities: p.manifest.capabilities.clone(),
                permissions: p.manifest.permissions.clone(),
                granted,
                settings: p.manifest.settings.clone(),
                commands,
                views,
                strikes,
                failure: p.failure.clone(),
            });
        }
        out
    }

    /// Discovery / activation warnings.
    pub fn warnings(&self) -> &[DiscoveryWarning] {
        &self.warnings
    }

    /// The library root this host was built for (used to detect a library switch).
    pub fn root(&self) -> &std::path::Path {
        &self.library_root
    }

    /// Grant or revoke a single permission for a plugin, persist, and (when a grant just
    /// completed the requested set) activate the plugin.
    ///
    /// Revoking a live permission takes effect immediately for in-flight `entries-owner`
    /// calls because injection re-checks the shared grant store per call (design-0002).
    pub fn set_grant(
        &mut self,
        plugin_id: &str,
        permission: &str,
        granted: bool,
    ) -> Result<(), PluginError> {
        let Some(idx) = self.plugins.iter().position(|p| p.manifest.id == plugin_id) else {
            return Err(PluginError::not_active());
        };
        let manifest = self.plugins[idx].manifest.clone();

        let new_status = {
            let mut g = self
                .grants
                .lock()
                .map_err(|_| PluginError::host_internal("grants lock poisoned"))?;
            if !g.set_grant(&manifest, permission, granted) {
                return Err(PluginError::invalid_argument(format!(
                    "permission `{permission}` is not requested by `{plugin_id}`"
                )));
            }
            let _ = g.save(&self.library_root);
            g.reconcile_version(&manifest)
        };

        match new_status {
            PermissionStatus::Satisfied => {
                // Activate if not already active.
                if self.plugins[idx].runtime.is_none() {
                    self.activate(plugin_id);
                } else {
                    self.plugins[idx].status = PluginStatus::Active;
                }
            }
            PermissionStatus::Pending => {
                // A revoke can knock an active plugin back to pending: tear down its runtime
                // so its capabilities stop (design-0002: "affected capabilities suspend").
                self.plugins[idx].status = PluginStatus::PermissionsPending;
                self.plugins[idx].runtime = None;
            }
        }
        Ok(())
    }

    /// Invoke a registered command on an active plugin.
    pub fn invoke_command(
        &self,
        plugin_id: &str,
        command_id: &str,
        args_json: &str,
    ) -> Result<String, PluginError> {
        let p = self
            .plugins
            .iter()
            .find(|p| p.manifest.id == plugin_id)
            .ok_or_else(PluginError::not_active)?;
        let rt = p.runtime.as_ref().ok_or_else(PluginError::not_active)?;
        // Guard: the command must actually be one this plugin registered.
        if !rt.commands.iter().any(|c| c.id == command_id) {
            return Err(PluginError::not_registered(command_id));
        }
        rt.invoke_command(command_id, args_json)
    }

    /// Render a code block via a plugin's registered renderer.
    pub fn render_code_block(
        &self,
        plugin_id: &str,
        text: &str,
        lang: &str,
    ) -> Result<capability::RenderOutput, PluginError> {
        let p = self
            .plugins
            .iter()
            .find(|p| p.manifest.id == plugin_id)
            .ok_or_else(PluginError::not_active)?;
        let rt = p.runtime.as_ref().ok_or_else(PluginError::not_active)?;
        rt.render(text, lang)
    }
}
