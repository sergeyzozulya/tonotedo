<script lang="ts">
  // PluginManager — main-zone view for the plugin inventory (spec 0010, issue #26).
  //
  // Features:
  //   • Plugin list with status badges (active / permissions-pending / suspended / failed).
  //   • Per-plugin expand panel: README, capabilities, permissions with plain-language
  //     labels and grant toggles (plugins_set_grant).
  //   • Pending plugins show a prominent first-run prompt (grant-all / review flow).
  //   • Suspended plugins show strike context and a re-enable affordance.
  //   • Reload button → plugins_reload.
  //   • Settings schema rendering: typed inputs, secret fields as password inputs.
  //   • Settings secret fields surface the "stored / rejected" v1 state.

  import { ipc } from "../ipc/index.js";
  import type { PluginInfo, PluginSettingField } from "../ipc/types.js";
  import { permissionLabel, permissionDetail } from "./permission-labels.js";
  import { syncPluginCommands } from "./plugin-commands.js";

  // ── Data ──────────────────────────────────────────────────────────────────────

  let plugins = $state<PluginInfo[]>([]);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let reloading = $state(false);

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    const res = await ipc.plugins_list();
    loading = false;
    if (res.ok) {
      plugins = res.value;
      syncPluginCommands(plugins, ipc);
    } else {
      loadError = res.error.message;
    }
  }

  async function reload(): Promise<void> {
    reloading = true;
    const res = await ipc.plugins_reload();
    reloading = false;
    if (res.ok) {
      plugins = res.value;
      syncPluginCommands(plugins, ipc);
    } else {
      loadError = res.error.message;
    }
  }

  $effect(() => {
    load();
  });

  // ── Expand/collapse per plugin ────────────────────────────────────────────────

  const expanded = $state(new Set<string>());

  function toggleExpand(id: string): void {
    if (expanded.has(id)) {
      expanded.delete(id);
    } else {
      expanded.add(id);
    }
  }

  // ── Grant toggles ─────────────────────────────────────────────────────────────

  let grantBusy = $state<Record<string, boolean>>({});

  async function toggleGrant(
    pluginId: string,
    perm: string,
    currentlyGranted: boolean,
  ): Promise<void> {
    const key = `${pluginId}:${perm}`;
    if (grantBusy[key]) return;
    grantBusy[key] = true;
    const res = await ipc.plugins_set_grant(pluginId, perm, !currentlyGranted);
    delete grantBusy[key];
    grantBusy = { ...grantBusy };
    if (res.ok) {
      await load();
    }
  }

  // ── Pending first-run prompt: grant-all flow ──────────────────────────────────

  type PendingFlow = "prompt" | "review";
  const pendingFlow = $state(new Map<string, PendingFlow>());

  function startGrantAll(id: string): void {
    pendingFlow.set(id, "prompt");
  }

  function startReview(id: string): void {
    pendingFlow.set(id, "review");
  }

  function dismissFlow(id: string): void {
    pendingFlow.delete(id);
  }

  async function grantAll(plugin: PluginInfo): Promise<void> {
    for (const perm of plugin.permissions) {
      if (!plugin.granted.includes(perm)) {
        await ipc.plugins_set_grant(plugin.id, perm, true);
      }
    }
    pendingFlow.delete(plugin.id);
    await load();
  }

  // ── Settings values (session-only; no persist in v1 mock) ────────────────────

  const settingsValues = $state<Record<string, Record<string, string>>>({});

  function settingValue(pluginId: string, field: PluginSettingField): string {
    return settingsValues[pluginId]?.[field.key] ?? field.default ?? "";
  }

  function onSettingInput(pluginId: string, field: PluginSettingField, value: string): void {
    if (!settingsValues[pluginId]) settingsValues[pluginId] = {};
    settingsValues[pluginId][field.key] = value;
  }

  // ── Reveal password fields ─────────────────────────────────────────────────────

  const revealed = $state(new Set<string>());

  function toggleReveal(key: string): void {
    if (revealed.has(key)) {
      revealed.delete(key);
    } else {
      revealed.add(key);
    }
  }
</script>

<div class="pm-root">
  <!-- Header -->
  <div class="pm-header">
    <h1 class="pm-title">Plugins</h1>
    <button
      class="pm-reload-btn"
      onclick={reload}
      disabled={reloading || loading}
      aria-label="Reload plugins"
      title="Reload plugins from disk"
    >
      {reloading ? "Reloading…" : "Reload"}
    </button>
  </div>

  <!-- Error banner -->
  {#if loadError}
    <div class="pm-error" role="alert">{loadError}</div>
  {/if}

  <!-- Loading -->
  {#if loading}
    <div class="pm-loading" aria-live="polite">Loading plugins…</div>
  {:else if plugins.length === 0}
    <div class="pm-empty">
      No plugins installed. Drop a plugin folder into <code>.tonotedo/plugins/</code> and reload.
    </div>
  {:else}
    <ul class="pm-list" role="list">
      {#each plugins as plugin (plugin.id)}
        {@const isExpanded = expanded.has(plugin.id)}
        {@const flow = pendingFlow.get(plugin.id)}

        <li class="pm-item" class:pm-item--expanded={isExpanded}>
          <!-- Row header -->
          <div
            class="pm-row"
            role="button"
            tabindex="0"
            aria-expanded={isExpanded}
            onclick={() => toggleExpand(plugin.id)}
            onkeydown={(e) => (e.key === "Enter" || e.key === " ") && toggleExpand(plugin.id)}
          >
            <span class="pm-row-chevron">{isExpanded ? "▾" : "▸"}</span>
            <span class="pm-plugin-name">{plugin.name}</span>
            <span class="pm-plugin-version">v{plugin.version}</span>
            <span class="pm-badge pm-badge--{plugin.status}" aria-label="Status: {plugin.status}">
              {plugin.status === "active"
                ? "Active"
                : plugin.status === "permissions-pending"
                  ? "Pending"
                  : plugin.status === "suspended"
                    ? "Suspended"
                    : "Failed"}
            </span>
            {#if plugin.strikes > 0}
              <span class="pm-strikes" title="{plugin.strikes} crash(es) this session"
                >⚠ {plugin.strikes}</span
              >
            {/if}
          </div>

          <!-- Expanded panel -->
          {#if isExpanded}
            <div class="pm-panel">
              <!-- Pending first-run prompt (prominent card) -->
              {#if plugin.status === "permissions-pending"}
                {#if !flow}
                  <div class="pm-pending-card" role="region" aria-label="Permission required">
                    <div class="pm-pending-card-title">
                      This plugin is waiting for your permission
                    </div>
                    <p class="pm-pending-card-body">
                      <strong>{plugin.name}</strong> requests {plugin.permissions.length} permission{plugin
                        .permissions.length === 1
                        ? ""
                        : "s"}. Review them below, then grant or deny.
                    </p>
                    <div class="pm-pending-card-actions">
                      <button
                        class="pm-btn pm-btn--primary"
                        onclick={() => startGrantAll(plugin.id)}
                      >
                        Grant all &amp; activate
                      </button>
                      <button class="pm-btn" onclick={() => startReview(plugin.id)}>
                        Review individually
                      </button>
                    </div>
                  </div>
                {:else if flow === "prompt"}
                  <div class="pm-grant-confirm" role="region" aria-label="Confirm grant all">
                    <div class="pm-grant-confirm-msg">
                      Grant all permissions to <strong>{plugin.name}</strong>?
                    </div>
                    <ul class="pm-grant-confirm-list">
                      {#each plugin.permissions as perm (perm)}
                        <li>{permissionLabel(perm)}</li>
                      {/each}
                    </ul>
                    <div class="pm-grant-confirm-actions">
                      <button class="pm-btn pm-btn--primary" onclick={() => grantAll(plugin)}>
                        Confirm &amp; activate
                      </button>
                      <button class="pm-btn" onclick={() => dismissFlow(plugin.id)}>Cancel</button>
                    </div>
                  </div>
                {/if}
              {/if}

              <!-- Suspended: strike context + re-enable -->
              {#if plugin.status === "suspended"}
                <div class="pm-suspended-card" role="region" aria-label="Plugin suspended">
                  <div class="pm-suspended-title">
                    Plugin suspended after {plugin.strikes} crash{plugin.strikes === 1 ? "" : "es"}
                  </div>
                  {#if plugin.failure}
                    <pre class="pm-failure-detail">{plugin.failure}</pre>
                  {/if}
                  <div class="pm-suspended-actions">
                    <button class="pm-btn pm-btn--primary" onclick={reload}>
                      Reload to re-enable
                    </button>
                  </div>
                </div>
              {/if}

              <!-- Failed: activation error -->
              {#if plugin.status === "failed" && plugin.failure}
                <div class="pm-failed-card" role="region" aria-label="Plugin failed">
                  <div class="pm-failed-title">Activation failed</div>
                  <pre class="pm-failure-detail">{plugin.failure}</pre>
                </div>
              {/if}

              <!-- Shape + capabilities -->
              <div class="pm-section">
                <div class="pm-section-label">Type</div>
                <div class="pm-chips-row">
                  {#each plugin.shape as s (s)}
                    <span class="pm-chip pm-chip--shape">{s}</span>
                  {/each}
                  {#each plugin.capabilities as cap (cap)}
                    <span class="pm-chip pm-chip--cap">{cap}</span>
                  {/each}
                </div>
              </div>

              <!-- Permissions -->
              {#if plugin.permissions.length > 0}
                <div class="pm-section">
                  <div class="pm-section-label">Permissions</div>
                  <ul class="pm-perm-list" role="list">
                    {#each plugin.permissions as perm (perm)}
                      {@const isGranted = plugin.granted.includes(perm)}
                      {@const busy = !!grantBusy[`${plugin.id}:${perm}`]}
                      <li class="pm-perm-row">
                        <div class="pm-perm-info">
                          <div class="pm-perm-label">{permissionLabel(perm)}</div>
                          <div class="pm-perm-detail">{permissionDetail(perm)}</div>
                        </div>
                        <button
                          class="pm-grant-toggle"
                          class:pm-grant-toggle--granted={isGranted}
                          disabled={busy}
                          aria-pressed={isGranted}
                          aria-label="{isGranted ? 'Revoke' : 'Grant'} permission: {permissionLabel(
                            perm,
                          )}"
                          onclick={() => toggleGrant(plugin.id, perm, isGranted)}
                        >
                          {busy ? "…" : isGranted ? "Granted" : "Denied"}
                        </button>
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}

              <!-- Settings schema -->
              {#if plugin.settings.length > 0}
                <div class="pm-section">
                  <div class="pm-section-label">Settings</div>
                  <div class="pm-settings-form">
                    {#each plugin.settings as field (field.key)}
                      {@const fieldKey = `${plugin.id}:${field.key}`}
                      <div class="pm-setting-row">
                        <label class="pm-setting-label" for={fieldKey}>
                          {field.label}
                          {#if field.type === "secret"}
                            <span class="pm-secret-badge">secret</span>
                          {/if}
                        </label>
                        {#if field.description}
                          <div class="pm-setting-desc">{field.description}</div>
                        {/if}

                        {#if field.type === "boolean"}
                          <input
                            id={fieldKey}
                            type="checkbox"
                            class="pm-setting-checkbox"
                            checked={settingValue(plugin.id, field) === "true"}
                            onchange={(e) =>
                              onSettingInput(
                                plugin.id,
                                field,
                                (e.target as HTMLInputElement).checked ? "true" : "false",
                              )}
                          />
                        {:else if field.type === "number"}
                          <input
                            id={fieldKey}
                            type="number"
                            class="pm-setting-input pm-setting-input--number"
                            value={settingValue(plugin.id, field)}
                            oninput={(e) =>
                              onSettingInput(
                                plugin.id,
                                field,
                                (e.target as HTMLInputElement).value,
                              )}
                          />
                        {:else if field.type === "enum" && field.options && field.options.length > 0}
                          <select
                            id={fieldKey}
                            class="pm-setting-select"
                            value={settingValue(plugin.id, field)}
                            onchange={(e) =>
                              onSettingInput(
                                plugin.id,
                                field,
                                (e.target as HTMLSelectElement).value,
                              )}
                          >
                            {#each field.options as opt (opt)}
                              <option value={opt}>{opt}</option>
                            {/each}
                          </select>
                        {:else if field.type === "secret"}
                          <div class="pm-secret-row">
                            <input
                              id={fieldKey}
                              type={revealed.has(fieldKey) ? "text" : "password"}
                              class="pm-setting-input pm-setting-input--secret"
                              value={settingValue(plugin.id, field)}
                              autocomplete="off"
                              placeholder="Enter value…"
                              oninput={(e) =>
                                onSettingInput(
                                  plugin.id,
                                  field,
                                  (e.target as HTMLInputElement).value,
                                )}
                            />
                            <button
                              class="pm-reveal-btn"
                              type="button"
                              aria-label={revealed.has(fieldKey) ? "Hide value" : "Reveal value"}
                              onclick={() => toggleReveal(fieldKey)}
                            >
                              {revealed.has(fieldKey) ? "Hide" : "Show"}
                            </button>
                          </div>
                        {:else}
                          <input
                            id={fieldKey}
                            type="text"
                            class="pm-setting-input"
                            value={settingValue(plugin.id, field)}
                            oninput={(e) =>
                              onSettingInput(
                                plugin.id,
                                field,
                                (e.target as HTMLInputElement).value,
                              )}
                          />
                        {/if}
                      </div>
                    {/each}
                  </div>
                </div>
              {/if}

              <!-- Commands registered -->
              {#if plugin.commands.length > 0}
                <div class="pm-section">
                  <div class="pm-section-label">Commands</div>
                  <ul class="pm-cmd-list" role="list">
                    {#each plugin.commands as cmd (cmd.id)}
                      <li class="pm-cmd-row">
                        <span class="pm-cmd-title">{cmd.title}</span>
                        <code class="pm-cmd-id">{cmd.id}</code>
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}

              <!-- README -->
              {#if plugin.readme}
                <div class="pm-section">
                  <div class="pm-section-label">About</div>
                  <pre class="pm-readme">{plugin.readme}</pre>
                </div>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  /* ── Root ───────────────────────────────────────────────────────────────────── */

  .pm-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow-y: auto;
    background: var(--tnd-bg);
    color: var(--tnd-text);
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 13.5px;
  }

  /* ── Header ─────────────────────────────────────────────────────────────────── */

  .pm-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 20px 28px 12px;
    border-bottom: 1px solid var(--tnd-line-strong);
    flex-shrink: 0;
  }

  .pm-title {
    font-size: 17px;
    font-weight: 600;
    margin: 0;
    flex: 1;
    color: var(--tnd-text);
  }

  .pm-reload-btn {
    background: var(--tnd-panel2);
    border: 1px solid var(--tnd-line-strong);
    color: var(--tnd-text-muted);
    font-size: 12.5px;
    padding: 4px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    flex-shrink: 0;
  }

  .pm-reload-btn:hover:not(:disabled) {
    background: var(--tnd-panel);
    color: var(--tnd-text);
  }

  .pm-reload-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* ── Loading / error / empty ────────────────────────────────────────────────── */

  .pm-loading,
  .pm-empty {
    padding: 40px 28px;
    color: var(--tnd-text-faint);
    font-size: 13.5px;
    text-align: center;
  }

  .pm-error {
    margin: 12px 28px;
    padding: 10px 14px;
    background: rgba(192, 57, 43, 0.07);
    border: 1px solid rgba(192, 57, 43, 0.22);
    border-radius: 5px;
    color: #c0392b;
    font-size: 13px;
  }

  /* ── Plugin list ────────────────────────────────────────────────────────────── */

  .pm-list {
    list-style: none;
    margin: 0;
    padding: 8px 0;
  }

  .pm-item {
    border-bottom: 1px solid var(--tnd-line);
  }

  .pm-item:last-child {
    border-bottom: none;
  }

  /* ── Plugin row ─────────────────────────────────────────────────────────────── */

  .pm-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 28px;
    cursor: pointer;
    outline: none;
    transition: background 0.08s;
    user-select: none;
  }

  .pm-row:hover {
    background: var(--tnd-panel2);
  }

  .pm-row:focus-visible {
    outline: 2px solid var(--tnd-accent);
    outline-offset: -2px;
  }

  .pm-row-chevron {
    width: 12px;
    flex-shrink: 0;
    font-size: 11px;
    color: var(--tnd-text-faint);
  }

  .pm-plugin-name {
    flex: 1;
    font-weight: 600;
    color: var(--tnd-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pm-plugin-version {
    font-size: 11.5px;
    color: var(--tnd-text-faint);
    font-family: ui-monospace, monospace;
    flex-shrink: 0;
  }

  /* ── Status badges ──────────────────────────────────────────────────────────── */

  .pm-badge {
    font-size: 10.5px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 10px;
    flex-shrink: 0;
    letter-spacing: 0.02em;
  }

  .pm-badge--active {
    background: rgba(34, 139, 34, 0.12);
    color: #228b22;
  }

  .pm-badge--permissions-pending {
    background: rgba(184, 115, 0, 0.12);
    color: #b87300;
  }

  .pm-badge--suspended {
    background: rgba(192, 57, 43, 0.12);
    color: #c0392b;
  }

  .pm-badge--failed {
    background: rgba(100, 10, 10, 0.12);
    color: #900;
  }

  .pm-strikes {
    font-size: 11px;
    color: #c0392b;
    font-weight: 600;
    flex-shrink: 0;
  }

  /* ── Expand panel ───────────────────────────────────────────────────────────── */

  .pm-panel {
    padding: 0 28px 18px 52px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  /* ── Pending first-run card ─────────────────────────────────────────────────── */

  .pm-pending-card {
    padding: 14px 16px;
    background: var(--tnd-accent-soft);
    border: 1px solid var(--tnd-accent);
    border-radius: 6px;
    font-size: 13px;
  }

  .pm-pending-card-title {
    font-weight: 600;
    color: var(--tnd-accent-text);
    margin-bottom: 6px;
  }

  .pm-pending-card-body {
    margin: 0 0 12px;
    color: var(--tnd-text-muted);
    line-height: 1.5;
  }

  .pm-pending-card-actions {
    display: flex;
    gap: 8px;
  }

  /* ── Grant-all confirm card ─────────────────────────────────────────────────── */

  .pm-grant-confirm {
    padding: 14px 16px;
    background: var(--tnd-panel2);
    border: 1px solid var(--tnd-line-strong);
    border-radius: 6px;
    font-size: 13px;
  }

  .pm-grant-confirm-msg {
    font-weight: 500;
    margin-bottom: 8px;
    color: var(--tnd-text);
  }

  .pm-grant-confirm-list {
    margin: 0 0 12px 16px;
    padding: 0;
    color: var(--tnd-text-muted);
    font-size: 12.5px;
    line-height: 1.7;
  }

  .pm-grant-confirm-actions {
    display: flex;
    gap: 8px;
  }

  /* ── Suspended / failed cards ───────────────────────────────────────────────── */

  .pm-suspended-card,
  .pm-failed-card {
    padding: 12px 14px;
    background: rgba(192, 57, 43, 0.06);
    border: 1px solid rgba(192, 57, 43, 0.18);
    border-radius: 6px;
    font-size: 13px;
  }

  .pm-suspended-title,
  .pm-failed-title {
    font-weight: 600;
    color: #c0392b;
    margin-bottom: 6px;
  }

  .pm-suspended-actions {
    margin-top: 10px;
  }

  .pm-failure-detail {
    font-size: 11.5px;
    font-family: ui-monospace, monospace;
    color: var(--tnd-text-muted);
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0 0 6px;
    background: var(--tnd-panel2);
    padding: 8px 10px;
    border-radius: 4px;
    max-height: 120px;
    overflow-y: auto;
  }

  /* ── Section headings ───────────────────────────────────────────────────────── */

  .pm-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .pm-section-label {
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--tnd-text-faint);
  }

  /* ── Capability chips ───────────────────────────────────────────────────────── */

  .pm-chips-row {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }

  .pm-chip {
    font-size: 11.5px;
    padding: 2px 8px;
    border-radius: 10px;
    font-weight: 500;
  }

  .pm-chip--shape {
    background: var(--tnd-panel2);
    color: var(--tnd-text-muted);
    border: 1px solid var(--tnd-line-strong);
  }

  .pm-chip--cap {
    background: var(--tnd-accent-soft);
    color: var(--tnd-accent-text);
  }

  /* ── Permissions list ───────────────────────────────────────────────────────── */

  .pm-perm-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .pm-perm-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 8px 12px;
    background: var(--tnd-panel2);
    border-radius: 5px;
  }

  .pm-perm-info {
    flex: 1;
    min-width: 0;
  }

  .pm-perm-label {
    font-size: 13px;
    font-weight: 500;
    color: var(--tnd-text);
  }

  .pm-perm-detail {
    font-size: 12px;
    color: var(--tnd-text-faint);
    margin-top: 2px;
    line-height: 1.4;
  }

  .pm-grant-toggle {
    flex-shrink: 0;
    padding: 3px 10px;
    border-radius: 4px;
    font-size: 12px;
    font-family: inherit;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid var(--tnd-line-strong);
    background: var(--tnd-panel);
    color: var(--tnd-text-muted);
    transition: background 0.1s;
  }

  .pm-grant-toggle--granted {
    background: var(--tnd-accent-soft);
    border-color: var(--tnd-accent);
    color: var(--tnd-accent-text);
  }

  .pm-grant-toggle:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ── Settings form ──────────────────────────────────────────────────────────── */

  .pm-settings-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .pm-setting-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .pm-setting-label {
    font-size: 12.5px;
    font-weight: 500;
    color: var(--tnd-text-muted);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .pm-secret-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 1px 5px;
    border-radius: 3px;
    background: rgba(100, 50, 200, 0.1);
    color: #6432c8;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .pm-setting-desc {
    font-size: 11.5px;
    color: var(--tnd-text-faint);
    margin-bottom: 2px;
    line-height: 1.4;
  }

  .pm-setting-input {
    max-width: 320px;
    padding: 5px 8px;
    background: var(--tnd-panel2);
    border: 1px solid var(--tnd-line-strong);
    border-radius: 4px;
    color: var(--tnd-text);
    font-size: 13px;
    font-family: inherit;
    outline: none;
  }

  .pm-setting-input:focus {
    border-color: var(--tnd-accent);
  }

  .pm-setting-input--number {
    width: 100px;
  }

  .pm-setting-input--secret {
    font-family: ui-monospace, monospace;
    max-width: 260px;
  }

  .pm-setting-checkbox {
    width: 16px;
    height: 16px;
    cursor: pointer;
    accent-color: var(--tnd-accent);
  }

  .pm-setting-select {
    max-width: 240px;
    padding: 5px 8px;
    background: var(--tnd-panel2);
    border: 1px solid var(--tnd-line-strong);
    border-radius: 4px;
    color: var(--tnd-text);
    font-size: 13px;
    font-family: inherit;
    outline: none;
    cursor: pointer;
  }

  .pm-setting-select:focus {
    border-color: var(--tnd-accent);
  }

  .pm-secret-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .pm-reveal-btn {
    background: none;
    border: 1px solid var(--tnd-line-strong);
    color: var(--tnd-text-faint);
    font-size: 11.5px;
    padding: 3px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    flex-shrink: 0;
  }

  .pm-reveal-btn:hover {
    color: var(--tnd-text);
    background: var(--tnd-panel2);
  }

  /* ── Commands list ──────────────────────────────────────────────────────────── */

  .pm-cmd-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .pm-cmd-row {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 5px 10px;
    background: var(--tnd-panel2);
    border-radius: 4px;
  }

  .pm-cmd-title {
    font-size: 13px;
    color: var(--tnd-text);
    flex: 1;
  }

  .pm-cmd-id {
    font-size: 11px;
    color: var(--tnd-text-faint);
    font-family: ui-monospace, monospace;
    flex-shrink: 0;
  }

  /* ── README ─────────────────────────────────────────────────────────────────── */

  .pm-readme {
    font-size: 12.5px;
    font-family: ui-monospace, monospace;
    white-space: pre-wrap;
    word-break: break-word;
    background: var(--tnd-panel2);
    border: 1px solid var(--tnd-line);
    border-radius: 5px;
    padding: 12px 14px;
    color: var(--tnd-text-muted);
    line-height: 1.55;
    max-height: 280px;
    overflow-y: auto;
  }

  /* ── Shared buttons ─────────────────────────────────────────────────────────── */

  .pm-btn {
    background: var(--tnd-panel2);
    border: 1px solid var(--tnd-line-strong);
    color: var(--tnd-text-muted);
    font-size: 12.5px;
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    white-space: nowrap;
  }

  .pm-btn:hover {
    background: var(--tnd-panel);
    color: var(--tnd-text);
  }

  .pm-btn--primary {
    background: var(--tnd-accent);
    border-color: var(--tnd-accent);
    color: #fff;
  }

  .pm-btn--primary:hover {
    opacity: 0.88;
  }
</style>
