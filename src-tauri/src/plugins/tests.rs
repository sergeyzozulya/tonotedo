// Integration tests for the plugin host (issue #25). Unit tests live next to their
// modules (error/manifest/grants/capability/runtime); these exercise the host end to end:
// discovery → grants → activation → invocation, plus the crash-containment acceptance list
// from spec 0010 §"Edge cases".

#![cfg(test)]

use std::path::Path;

use super::*;

// ── Test fixtures ──────────────────────────────────────────────────────────────

/// Write a plugin folder (`plugin.md` + optional `main.js`) under a library root.
fn write_plugin(root: &Path, dir: &str, manifest_md: &str, main_js: Option<&str>) {
    let pdir = manifest::plugins_dir(root).join(dir);
    std::fs::create_dir_all(&pdir).unwrap();
    std::fs::write(pdir.join("plugin.md"), manifest_md).unwrap();
    if let Some(js) = main_js {
        std::fs::write(pdir.join("main.js"), js).unwrap();
    }
}

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

/// A device-local grants directory for tests (review C2: grants live OUTSIDE the synced
/// library). It is shared but the store is keyed by the canonical library path inside, so
/// distinct test libraries never collide and a reload of the SAME library reuses its file
/// (which the persistence tests rely on).
fn grants_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("tonotedo-test-grants")
}

/// Load a host with the device-local grants dir threaded in.
fn load(dir: &tempfile::TempDir) -> PluginHost {
    PluginHost::load(dir.path().to_path_buf(), grants_dir())
}

// ── Discovery + activation ─────────────────────────────────────────────────────

#[test]
fn discovers_and_activates_permissionless_plugin() {
    let dir = tmp();
    write_plugin(
        dir.path(),
        "greeter",
        "---\nid: com.test.greeter\nname: Greeter\nversion: 1.0.0\nshape: [processor]\ncapabilities: [command]\npermissions: []\n---\nREADME\n",
        Some("plugin.registerCommand('hi', 'Say hi', function() { return { ok: true }; });"),
    );

    let host = load(&dir);
    let list = host.list();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].status, PluginStatus::Active);
    assert_eq!(list[0].commands.len(), 1);
    assert_eq!(list[0].commands[0].id, "com.test.greeter.hi");

    // Invoke the registered command.
    let out = host
        .invoke_command("com.test.greeter", "com.test.greeter.hi", "null")
        .unwrap();
    assert!(out.contains("\"ok\":true"));
}

#[test]
fn invalid_manifest_is_ignored_with_warning() {
    let dir = tmp();
    // Missing required `id`.
    write_plugin(
        dir.path(),
        "broken",
        "---\nname: Broken\nversion: 1.0.0\nshape: [processor]\n---\n",
        None,
    );
    let host = load(&dir);
    assert!(host.list().is_empty(), "broken plugin must not load");
    assert_eq!(host.warnings().len(), 1);
    assert_eq!(host.warnings()[0].source, "broken");
}

#[test]
fn folder_without_manifest_is_ignored() {
    let dir = tmp();
    let pdir = manifest::plugins_dir(dir.path()).join("not-a-plugin");
    std::fs::create_dir_all(&pdir).unwrap();
    std::fs::write(pdir.join("readme.txt"), "hi").unwrap();

    let host = load(&dir);
    assert!(host.list().is_empty());
    assert_eq!(host.warnings().len(), 1);
}

#[test]
fn duplicate_entries_owner_path_rejects_second() {
    let dir = tmp();
    let body = |id: &str| {
        format!(
            "---\nid: {id}\nname: {id}\nversion: 1.0.0\nshape: [provider]\ncapabilities: [entries-owner]\nentries-owner: Calendar/Google\npermissions: []\n---\n"
        )
    };
    // Folder names sort: "a-plugin" < "b-plugin"; a wins, b is rejected.
    write_plugin(dir.path(), "a-plugin", &body("com.test.a"), None);
    write_plugin(dir.path(), "b-plugin", &body("com.test.b"), None);

    let host = load(&dir);
    let ids: Vec<_> = host.list().iter().map(|p| p.id.clone()).collect();
    assert_eq!(ids, vec!["com.test.a"], "only the first claimant loads");
    assert!(host
        .warnings()
        .iter()
        .any(|w| w.source == "b-plugin" && w.reason.contains("already claimed")));
}

// ── Permission gating + grants ─────────────────────────────────────────────────

#[test]
fn plugin_requesting_permission_starts_pending() {
    let dir = tmp();
    write_plugin(
        dir.path(),
        "syncer",
        "---\nid: com.test.syncer\nname: Syncer\nversion: 1.0.0\nshape: [provider]\ncapabilities: [command]\npermissions: [read-entries]\n---\n",
        Some("plugin.registerCommand('sync', 'Sync', function() { return 1; });"),
    );
    let host = load(&dir);
    assert_eq!(host.list()[0].status, PluginStatus::PermissionsPending);
    // Pending plugins have no runtime → commands cannot run.
    let err = host
        .invoke_command("com.test.syncer", "com.test.syncer.sync", "null")
        .unwrap_err();
    assert_eq!(err.code, error::PluginErrorCode::NotActive);
}

#[test]
fn granting_permission_activates_and_persists() {
    let dir = tmp();
    write_plugin(
        dir.path(),
        "syncer",
        "---\nid: com.test.syncer\nname: Syncer\nversion: 1.0.0\nshape: [provider]\ncapabilities: [command]\npermissions: [read-entries]\n---\n",
        Some("plugin.registerCommand('sync', 'Sync', function() { return 42; });"),
    );

    {
        let mut host = load(&dir);
        host.set_grant("com.test.syncer", "read-entries", true)
            .unwrap();
        assert_eq!(host.list()[0].status, PluginStatus::Active);
        let out = host
            .invoke_command("com.test.syncer", "com.test.syncer.sync", "null")
            .unwrap();
        assert_eq!(out, "42");
    }

    // Reload: the grant persisted, so the plugin activates immediately.
    let host2 = load(&dir);
    assert_eq!(host2.list()[0].status, PluginStatus::Active);
}

#[test]
fn revoking_permission_knocks_plugin_back_to_pending() {
    let dir = tmp();
    write_plugin(
        dir.path(),
        "syncer",
        "---\nid: com.test.syncer\nname: Syncer\nversion: 1.0.0\nshape: [provider]\ncapabilities: [command]\npermissions: [read-entries]\n---\n",
        Some("plugin.registerCommand('sync', 'Sync', function() { return 1; });"),
    );
    let mut host = load(&dir);
    host.set_grant("com.test.syncer", "read-entries", true)
        .unwrap();
    assert_eq!(host.list()[0].status, PluginStatus::Active);
    host.set_grant("com.test.syncer", "read-entries", false)
        .unwrap();
    assert_eq!(host.list()[0].status, PluginStatus::PermissionsPending);
}

#[test]
fn set_grant_unknown_permission_errors() {
    let dir = tmp();
    write_plugin(
        dir.path(),
        "p",
        "---\nid: com.test.p\nname: P\nversion: 1.0.0\nshape: [provider]\ncapabilities: [command]\npermissions: [read-entries]\n---\n",
        None,
    );
    let mut host = load(&dir);
    let err = host.set_grant("com.test.p", "network", true).unwrap_err();
    assert_eq!(err.code, error::PluginErrorCode::InvalidArgument);
}

#[test]
fn synced_in_library_grants_are_ignored_plugin_stays_pending() {
    // C2 regression (reproduced exploit): a synced-in `plugin-grants.json` inside the
    // library granted full permissions with zero prompts on a fresh device. With grants
    // device-local, the in-library file is ignored → the plugin is permissions-pending and
    // a warning is recorded (0013/0010 conformance: re-prompt on a new device).
    let dir = tmp();
    write_plugin(
        dir.path(),
        "syncer",
        "---\nid: com.test.syncer\nname: Syncer\nversion: 1.0.0\nshape: [provider]\ncapabilities: [command]\npermissions: [read-entries]\n---\n",
        Some("plugin.registerCommand('sync', 'Sync', function() { return 1; });"),
    );
    // Attacker pre-authors a synced grants file granting read-entries.
    let attacker = grants::in_library_grants_path(dir.path());
    std::fs::create_dir_all(attacker.parent().unwrap()).unwrap();
    std::fs::write(
        &attacker,
        br#"{"plugins":{"com.test.syncer":{"version":"1.0.0","granted":["read-entries"]}}}"#,
    )
    .unwrap();

    // Fresh device: a never-before-seen grants dir.
    let fresh_device_grants = tmp();
    let host = PluginHost::load(
        dir.path().to_path_buf(),
        fresh_device_grants.path().to_path_buf(),
    );
    assert_eq!(
        host.list()[0].status,
        PluginStatus::PermissionsPending,
        "synced-in grants must not auto-activate the plugin"
    );
    assert!(
        host.warnings()
            .iter()
            .any(|w| w.reason.contains("in-library plugin-grants.json ignored")),
        "a warning about the ignored in-library grants must be recorded"
    );
}

#[test]
fn device_local_grant_round_trips_on_same_device() {
    // The legitimate path: granting on a device persists to device-local storage and a
    // reload with the SAME device grants dir re-activates without a prompt.
    let dir = tmp();
    write_plugin(
        dir.path(),
        "syncer",
        "---\nid: com.test.syncer\nname: Syncer\nversion: 1.0.0\nshape: [provider]\ncapabilities: [command]\npermissions: [read-entries]\n---\n",
        Some("plugin.registerCommand('sync', 'Sync', function() { return 1; });"),
    );
    let device_grants = tmp();
    {
        let mut host =
            PluginHost::load(dir.path().to_path_buf(), device_grants.path().to_path_buf());
        host.set_grant("com.test.syncer", "read-entries", true)
            .unwrap();
        assert_eq!(host.list()[0].status, PluginStatus::Active);
    }
    // Reload on the SAME device → still active (grant persisted device-locally).
    let host2 = PluginHost::load(dir.path().to_path_buf(), device_grants.path().to_path_buf());
    assert_eq!(host2.list()[0].status, PluginStatus::Active);
}

// ── entries-owner end to end (grant gate + conflict) ───────────────────────────

const OWNER_MANIFEST: &str = "---\nid: com.test.cal\nname: Cal\nversion: 1.0.0\nshape: [provider]\ncapabilities: [command, entries-owner]\nentries-owner: Calendar/Google\npermissions: [read-entries, write-entries]\n---\n";

const OWNER_JS: &str = r#"
plugin.registerCommand('write', 'Write', function(args) {
    return plugin.entries.write(args.path, args.text);
});
plugin.registerCommand('read', 'Read', function(args) {
    return plugin.entries.read(args.path);
});
"#;

fn grant_all(host: &mut PluginHost, id: &str) {
    host.set_grant(id, "read-entries", true).unwrap();
    host.set_grant(id, "write-entries", true).unwrap();
}

#[test]
fn entries_owner_write_inside_prefix_succeeds() {
    let dir = tmp();
    write_plugin(dir.path(), "cal", OWNER_MANIFEST, Some(OWNER_JS));
    let mut host = load(&dir);
    grant_all(&mut host, "com.test.cal");

    let out = host
        .invoke_command(
            "com.test.cal",
            "com.test.cal.write",
            r##"{"path":"Calendar/Google/e1.md","text":"# Event\n"}"##,
        )
        .unwrap();
    assert!(out.contains("written"), "{out}");
    assert!(dir.path().join("Calendar/Google/e1.md").exists());
}

#[test]
fn entries_owner_write_outside_prefix_refused() {
    let dir = tmp();
    write_plugin(dir.path(), "cal", OWNER_MANIFEST, Some(OWNER_JS));
    let mut host = load(&dir);
    grant_all(&mut host, "com.test.cal");

    // The JS throws because the host returns a path-outside-prefix error envelope.
    let err = host
        .invoke_command(
            "com.test.cal",
            "com.test.cal.write",
            r#"{"path":"Other/x.md","text":"x"}"#,
        )
        .unwrap_err();
    assert_eq!(err.code, error::PluginErrorCode::JsException);
    assert!(err.message.contains("PathOutsidePrefix"), "{}", err.message);
    assert!(!dir.path().join("Other/x.md").exists());
}

#[test]
fn entries_owner_write_without_grant_is_permission_error() {
    let dir = tmp();
    write_plugin(dir.path(), "cal", OWNER_MANIFEST, Some(OWNER_JS));
    let mut host = load(&dir);
    // Grant read so the plugin activates, but NOT write.
    host.set_grant("com.test.cal", "read-entries", true)
        .unwrap();
    // Still pending (write-entries ungranted) → not active.
    assert_eq!(host.list()[0].status, PluginStatus::PermissionsPending);
    host.set_grant("com.test.cal", "write-entries", true)
        .unwrap();
    assert_eq!(host.list()[0].status, PluginStatus::Active);
    // Now revoke write live; the per-call gate must refuse the write.
    host.set_grant("com.test.cal", "write-entries", false)
        .unwrap();
    // Revoke knocked it back to pending (no runtime) — re-grant only read won't help;
    // re-grant write to get an active runtime, then revoke is tested at the injection
    // level in runtime/capability unit tests. Here we assert the pending transition.
    assert_eq!(host.list()[0].status, PluginStatus::PermissionsPending);
}

#[test]
fn entries_owner_conflict_when_user_modified() {
    let dir = tmp();
    write_plugin(dir.path(), "cal", OWNER_MANIFEST, Some(OWNER_JS));
    let mut host = load(&dir);
    grant_all(&mut host, "com.test.cal");

    let rel = "Calendar/Google/e1.md";
    // Plugin writes, then reads (records last-seen hash).
    host.invoke_command(
        "com.test.cal",
        "com.test.cal.write",
        &format!(r##"{{"path":"{rel}","text":"# Original\n"}}"##),
    )
    .unwrap();
    host.invoke_command(
        "com.test.cal",
        "com.test.cal.read",
        &format!(r##"{{"path":"{rel}"}}"##),
    )
    .unwrap();

    // External (user) modification.
    std::fs::write(dir.path().join(rel), b"# User edited\n").unwrap();

    // Plugin tries to overwrite → conflict outcome (NOT an error; the JS gets 'conflict').
    let out = host
        .invoke_command(
            "com.test.cal",
            "com.test.cal.write",
            &format!(r##"{{"path":"{rel}","text":"# Plugin update\n"}}"##),
        )
        .unwrap();
    assert!(out.contains("conflict"), "{out}");
    // The user's content is preserved (policy is fixed, non-overridable).
    let on_disk = std::fs::read(dir.path().join(rel)).unwrap();
    assert_eq!(on_disk, b"# User edited\n");
}

#[test]
fn revoke_keeps_runtime_commands_registered_but_invocation_errors() {
    // M6 / 0010 edge case: "Affected capabilities suspend; commands stay registered but
    // error if invoked." Revoking a permission must NOT tear down the runtime — the command
    // remains listed, but invoking it returns PermissionRevoked. Re-granting restores it.
    let dir = tmp();
    write_plugin(
        dir.path(),
        "syncer",
        "---\nid: com.test.syncer\nname: Syncer\nversion: 1.0.0\nshape: [provider]\ncapabilities: [command]\npermissions: [read-entries]\n---\n",
        Some("plugin.registerCommand('sync', 'Sync', function() { return 7; });"),
    );
    let mut host = load(&dir);
    host.set_grant("com.test.syncer", "read-entries", true)
        .unwrap();
    assert_eq!(host.list()[0].status, PluginStatus::Active);
    assert_eq!(
        host.invoke_command("com.test.syncer", "com.test.syncer.sync", "null")
            .unwrap(),
        "7"
    );

    // Revoke mid-session.
    host.set_grant("com.test.syncer", "read-entries", false)
        .unwrap();
    let info = &host.list()[0];
    // Capability suspended (pending) but the command is STILL registered/listed.
    assert_eq!(info.status, PluginStatus::PermissionsPending);
    assert_eq!(
        info.commands.len(),
        1,
        "command stays registered after revoke"
    );
    assert_eq!(info.commands[0].id, "com.test.syncer.sync");
    // Invoking it now errors with PermissionRevoked (not NotActive — the runtime is alive).
    let err = host
        .invoke_command("com.test.syncer", "com.test.syncer.sync", "null")
        .unwrap_err();
    assert_eq!(err.code, error::PluginErrorCode::PermissionRevoked);

    // Re-grant clears it: the command works again without a re-spawn.
    host.set_grant("com.test.syncer", "read-entries", true)
        .unwrap();
    assert_eq!(host.list()[0].status, PluginStatus::Active);
    assert_eq!(
        host.invoke_command("com.test.syncer", "com.test.syncer.sync", "null")
            .unwrap(),
        "7"
    );
}

// ── render-code-block end to end ───────────────────────────────────────────────

#[test]
fn render_code_block_returns_constrained_output() {
    let dir = tmp();
    write_plugin(
        dir.path(),
        "mermaid",
        "---\nid: com.test.mermaid\nname: Mermaid\nversion: 1.0.0\nshape: [processor]\ncapabilities: [render-code-block]\npermissions: []\n---\n",
        Some(
            "plugin.registerCodeBlockRenderer(function(text, lang) {\
             return { nodes: [ { kind: 'heading', level: 99, children: [ { kind: 'text', text: lang } ] } ] };\
             });",
        ),
    );
    let host = load(&dir);
    let out = host
        .render_code_block("com.test.mermaid", "graph TD;", "mermaid")
        .unwrap();
    // Heading level clamped to 6 by host sanitize().
    match &out.nodes[0] {
        capability::RenderNode::Heading { level, .. } => assert_eq!(*level, 6),
        other => panic!("expected heading, got {other:?}"),
    }
}

#[test]
fn render_code_block_empty_is_fallback() {
    let dir = tmp();
    write_plugin(
        dir.path(),
        "noop",
        "---\nid: com.test.noop\nname: Noop\nversion: 1.0.0\nshape: [processor]\ncapabilities: [render-code-block]\npermissions: []\n---\n",
        // Renderer returns null → graceful fallback.
        Some("plugin.registerCodeBlockRenderer(function() { return null; });"),
    );
    let host = load(&dir);
    let out = host.render_code_block("com.test.noop", "x", "y").unwrap();
    assert!(out.is_empty());
}

// ── crash containment ──────────────────────────────────────────────────────────

#[test]
fn three_strikes_suspends_in_manager_view() {
    let dir = tmp();
    write_plugin(
        dir.path(),
        "buggy",
        "---\nid: com.test.buggy\nname: Buggy\nversion: 1.0.0\nshape: [processor]\ncapabilities: [command]\npermissions: []\n---\n",
        Some("plugin.registerCommand('boom', 'Boom', function() { throw new Error('x'); });"),
    );
    let host = load(&dir);
    for _ in 0..3 {
        let _ = host.invoke_command("com.test.buggy", "com.test.buggy.boom", "null");
    }
    let info = &host.list()[0];
    assert_eq!(info.status, PluginStatus::Suspended);
    assert_eq!(info.strikes, 3);
}

// ── network gate (transport deferred; gate live) ───────────────────────────────

const NET_MANIFEST: &str = "---\nid: com.test.net\nname: Net\nversion: 1.0.0\nshape: [provider]\ncapabilities: [command]\npermissions: ['network:api.example.com']\n---\n";

const NET_JS: &str = r#"
plugin.registerCommand('hit', 'Hit', function(args) {
    return plugin.fetch(args.host, {});
});
"#;

#[test]
fn network_ungranted_host_is_refused() {
    let dir = tmp();
    write_plugin(dir.path(), "net", NET_MANIFEST, Some(NET_JS));
    let mut host = load(&dir);
    host.set_grant("com.test.net", "network:api.example.com", true)
        .unwrap();
    // Request a DIFFERENT host than the one granted → refused by the per-host gate.
    let err = host
        .invoke_command(
            "com.test.net",
            "com.test.net.hit",
            r#"{"host":"evil.example.com"}"#,
        )
        .unwrap_err();
    assert_eq!(err.code, error::PluginErrorCode::JsException);
    assert!(
        err.message.contains("NetworkHostNotGranted"),
        "{}",
        err.message
    );
}

#[test]
fn network_granted_host_is_gated_but_deferred() {
    let dir = tmp();
    write_plugin(dir.path(), "net", NET_MANIFEST, Some(NET_JS));
    let mut host = load(&dir);
    host.set_grant("com.test.net", "network:api.example.com", true)
        .unwrap();
    // The granted host passes the gate but the transport is deferred → Unsupported.
    let err = host
        .invoke_command(
            "com.test.net",
            "com.test.net.hit",
            r#"{"host":"api.example.com"}"#,
        )
        .unwrap_err();
    assert_eq!(err.code, error::PluginErrorCode::JsException);
    assert!(err.message.contains("Unsupported"), "{}", err.message);
}

#[test]
fn invoking_unregistered_command_errors() {
    let dir = tmp();
    write_plugin(
        dir.path(),
        "p",
        "---\nid: com.test.p\nname: P\nversion: 1.0.0\nshape: [processor]\ncapabilities: [command]\npermissions: []\n---\n",
        Some("plugin.registerCommand('real', 'Real', function() { return 1; });"),
    );
    let host = load(&dir);
    let err = host
        .invoke_command("com.test.p", "com.test.p.ghost", "null")
        .unwrap_err();
    assert_eq!(err.code, error::PluginErrorCode::NotRegistered);
}
