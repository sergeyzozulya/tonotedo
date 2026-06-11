<script lang="ts">
  // PluginManager — main-zone view for the plugin inventory (spec 0010, issue #26).
  //
  // Design: per screens-dir.jsx PluginRow — icon box (border, provider/spark icon),
  // title + kind badge (PROVIDER/PROCESSOR/etc) + version, description line,
  // toggle switch on right; grants row with permission chips (network/write=amber,
  // rest=muted). Token-mapped per theme.

  import { SvelteMap } from "svelte/reactivity";
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
      await loadAllPluginSettings(plugins);
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
      await loadAllPluginSettings(plugins);
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

  // ── Pending first-run prompt ──────────────────────────────────────────────────

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

  // ── Settings values ───────────────────────────────────────────────────────────

  const settingsValues = $state<Record<string, Record<string, string>>>({});

  /** Load persisted settings for all plugins after the plugin list is fetched. */
  async function loadAllPluginSettings(pluginList: PluginInfo[]): Promise<void> {
    for (const p of pluginList) {
      if (p.settings.length === 0) continue;
      const res = await ipc.plugin_settings_get(p.id);
      if (res.ok && Object.keys(res.value).length > 0) {
        settingsValues[p.id] = { ...res.value };
      }
    }
  }

  function settingValue(pluginId: string, field: PluginSettingField): string {
    return settingsValues[pluginId]?.[field.key] ?? field.default ?? "";
  }

  /** Debounce timers per plugin to avoid saving on every keystroke. */
  const _saveTimers = new SvelteMap<string, ReturnType<typeof setTimeout>>();

  function onSettingInput(pluginId: string, field: PluginSettingField, value: string): void {
    if (!settingsValues[pluginId]) settingsValues[pluginId] = {};
    settingsValues[pluginId][field.key] = value;

    // Persist with a 500ms debounce so rapid typing doesn't hammer IPC.
    const existing = _saveTimers.get(pluginId);
    if (existing !== undefined) clearTimeout(existing);
    _saveTimers.set(
      pluginId,
      setTimeout(() => {
        _saveTimers.delete(pluginId);
        const snapshot = { ...(settingsValues[pluginId] ?? {}) };
        ipc.plugin_settings_set(pluginId, snapshot).catch((err: unknown) => {
          console.warn(`[plugins] failed to save settings for ${pluginId}:`, err);
        });
      }, 500),
    );
  }

  // ── Reveal password fields ────────────────────────────────────────────────────

  const revealed = $state(new Set<string>());

  function toggleReveal(key: string): void {
    if (revealed.has(key)) {
      revealed.delete(key);
    } else {
      revealed.add(key);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  /** True if permission is "dangerous" (amber highlight per design) */
  function isDangerPerm(perm: string): boolean {
    return perm === "network" || perm.startsWith("write");
  }

  /** Is plugin effectively on (active) */
  function isOn(plugin: PluginInfo): boolean {
    return plugin.status === "active";
  }
</script>

<div class="pm-root">
  <!-- Header -->
  <div class="pm-header">
    <div class="pm-header-main">
      <h1 class="pm-title">Plugins</h1>
      <span class="pm-subtitle">.tonotedo/plugins/</span>
    </div>
    <span class="pm-active-count">{plugins.filter(isOn).length} active</span>
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
      No plugins installed. Drop a plugin folder into
      <code class="pm-path">.tonotedo/plugins/</code> and reload.
    </div>
  {:else}
    <div class="pm-body">
      <div class="pm-content">
        <ul class="pm-list" role="list">
          {#each plugins as plugin (plugin.id)}
            {@const isExpanded = expanded.has(plugin.id)}
            {@const flow = pendingFlow.get(plugin.id)}
            {@const on = isOn(plugin)}

            <li class="pm-item">
              <!-- Plugin row (per PluginRow in design) -->
              <div class="pm-row">
                <!-- Icon box -->
                <span class="pm-icon-box" class:pm-icon-box--on={on}>
                  {#if plugin.shape.includes("provider")}
                    <!-- link icon -->
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 20 20"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.6"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M8 11.5a3 3 0 004.3 0l2.2-2.2a3 3 0 00-4.3-4.3L11 6" />
                      <path d="M12 8.5a3 3 0 00-4.3 0L5.5 10.7a3 3 0 004.3 4.3L11 14" />
                    </svg>
                  {:else}
                    <!-- spark icon -->
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 20 20"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.6"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M10 2.5l1.7 5 5 1.7-5 1.7L10 16l-1.7-5-5-1.7 5-1.7z" />
                    </svg>
                  {/if}
                </span>

                <!-- Plugin info -->
                <div class="pm-info">
                  <div class="pm-name-row">
                    <span class="pm-plugin-name">{plugin.name}</span>
                    <!-- Kind badge -->
                    {#each plugin.shape.slice(0, 1) as s (s)}
                      <span class="pm-kind-badge" class:pm-kind-badge--provider={s === "provider"}
                        >{s}</span
                      >
                    {/each}
                    <span class="pm-version">v{plugin.version}</span>
                    <!-- Status badge -->
                    <span class="pm-status-badge pm-status-badge--{plugin.status}">
                      {plugin.status === "active"
                        ? "Active"
                        : plugin.status === "permissions-pending"
                          ? "Pending"
                          : plugin.status === "suspended"
                            ? "Suspended"
                            : "Failed"}
                    </span>
                    {#if plugin.strikes > 0}
                      <span class="pm-strikes" title="{plugin.strikes} crash(es) this session">
                        ⚠ {plugin.strikes}
                      </span>
                    {/if}
                  </div>
                  {#if plugin.capabilities.length > 0}
                    <div class="pm-desc">{plugin.capabilities.join(" · ")}</div>
                  {/if}
                  <!-- Grants row -->
                  {#if plugin.permissions.length > 0}
                    <div class="pm-grants-row">
                      <span class="pm-grants-label">grants:</span>
                      {#each plugin.permissions as perm (perm)}
                        <span class="pm-perm-chip" class:pm-perm-chip--danger={isDangerPerm(perm)}
                          >{perm}</span
                        >
                      {/each}
                    </div>
                  {/if}
                </div>

                <!-- Toggle + expand -->
                <div class="pm-row-right">
                  <!-- ON/OFF toggle (design-style) -->
                  <button
                    class="pm-toggle"
                    class:pm-toggle--on={on}
                    onclick={() => toggleExpand(plugin.id)}
                    aria-label="{on ? 'Disable' : 'Enable'} {plugin.name}"
                    title={on ? "Active" : "Inactive"}
                  >
                    <span class="pm-toggle-thumb"></span>
                  </button>
                  <!-- Expand -->
                  <button
                    class="pm-expand-btn"
                    onclick={() => toggleExpand(plugin.id)}
                    aria-expanded={isExpanded}
                    aria-label="Details for {plugin.name}">{isExpanded ? "▾" : "▸"}</button
                  >
                </div>
              </div>

              <!-- Expanded panel -->
              {#if isExpanded}
                <div class="pm-panel">
                  <!-- Pending: first-run -->
                  {#if plugin.status === "permissions-pending"}
                    {#if !flow}
                      <div
                        class="pm-alert pm-alert--accent"
                        role="region"
                        aria-label="Permission required"
                      >
                        <div class="pm-alert-title">Waiting for your permission</div>
                        <p class="pm-alert-body">
                          <strong>{plugin.name}</strong> requests {plugin.permissions.length} permission{plugin
                            .permissions.length === 1
                            ? ""
                            : "s"}.
                        </p>
                        <div class="pm-alert-actions">
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
                      <div
                        class="pm-alert pm-alert--panel"
                        role="region"
                        aria-label="Confirm grant all"
                      >
                        <div class="pm-alert-title">
                          Grant all permissions to <strong>{plugin.name}</strong>?
                        </div>
                        <ul class="pm-confirm-list">
                          {#each plugin.permissions as perm (perm)}
                            <li>{permissionLabel(perm)}</li>
                          {/each}
                        </ul>
                        <div class="pm-alert-actions">
                          <button class="pm-btn pm-btn--primary" onclick={() => grantAll(plugin)}>
                            Confirm &amp; activate
                          </button>
                          <button class="pm-btn" onclick={() => dismissFlow(plugin.id)}
                            >Cancel</button
                          >
                        </div>
                      </div>
                    {/if}
                  {/if}

                  <!-- Suspended -->
                  {#if plugin.status === "suspended"}
                    <div
                      class="pm-alert pm-alert--danger"
                      role="region"
                      aria-label="Plugin suspended"
                    >
                      <div class="pm-alert-title">
                        Suspended after {plugin.strikes} crash{plugin.strikes === 1 ? "" : "es"}
                      </div>
                      {#if plugin.failure}
                        <pre class="pm-failure-detail">{plugin.failure}</pre>
                      {/if}
                      <div class="pm-alert-actions">
                        <button class="pm-btn pm-btn--primary" onclick={reload}>
                          Reload to re-enable
                        </button>
                      </div>
                    </div>
                  {/if}

                  <!-- Failed -->
                  {#if plugin.status === "failed" && plugin.failure}
                    <div class="pm-alert pm-alert--danger" role="region" aria-label="Plugin failed">
                      <div class="pm-alert-title">Activation failed</div>
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
                              <div
                                class="pm-perm-label"
                                class:pm-perm-label--danger={isDangerPerm(perm)}
                              >
                                {permissionLabel(perm)}
                              </div>
                              <div class="pm-perm-detail">{permissionDetail(perm)}</div>
                            </div>
                            <button
                              class="pm-grant-toggle"
                              class:pm-grant-toggle--granted={isGranted}
                              disabled={busy}
                              aria-pressed={isGranted}
                              aria-label="{isGranted
                                ? 'Revoke'
                                : 'Grant'} permission: {permissionLabel(perm)}"
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
                                  aria-label={revealed.has(fieldKey)
                                    ? "Hide value"
                                    : "Reveal value"}
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

                  <!-- Commands -->
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

        <div class="pm-footer-note">
          drop a folder into <span class="pm-footer-path">.tonotedo/plugins/</span> — it travels with
          the library to mobile.
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  /* ── Root ────────────────────────────────────────────────────────────────────── */

  .pm-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    background: var(--tnd-bg);
    color: var(--tnd-text);
    font-family: var(--tnd-font-ui);
    font-size: 13.5px;
  }

  /* ── Header ──────────────────────────────────────────────────────────────────── */

  .pm-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 20px 24px 14px;
    border-bottom: 1px solid var(--tnd-line);
    background: var(--tnd-panel);
    flex-shrink: 0;
  }

  .pm-header-main {
    flex: 1;
    min-width: 0;
  }

  .pm-title {
    font-size: 17px;
    font-weight: var(--tnd-title-weight, 600);
    margin: 0;
    color: var(--tnd-text);
    font-family: var(--tnd-font-ui);
    line-height: 1.2;
  }

  .pm-subtitle {
    font-size: 11px;
    color: var(--tnd-text-faint);
    font-family: var(--tnd-font-mono);
    display: block;
    margin-top: 1px;
  }

  .pm-active-count {
    font-size: 11px;
    color: var(--tnd-text-faint);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  .pm-reload-btn {
    background: var(--tnd-panel2);
    border: 1px solid var(--tnd-line-strong);
    color: var(--tnd-text-muted);
    font-size: 12px;
    padding: 4px 12px;
    border-radius: var(--tnd-radius, 4px);
    cursor: pointer;
    font-family: var(--tnd-font-ui);
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

  /* ── Loading / error / empty ─────────────────────────────────────────────────── */

  .pm-loading,
  .pm-empty {
    padding: 40px 24px;
    color: var(--tnd-text-faint);
    font-size: 13px;
    font-family: var(--tnd-font-ui);
  }

  .pm-path {
    font-family: var(--tnd-font-mono);
    color: var(--tnd-accent-text);
    font-size: 12px;
  }

  .pm-error {
    margin: 12px 24px;
    padding: 10px 14px;
    background: var(--tnd-chip-red-bg);
    border: 1px solid var(--tnd-chip-red-fg);
    border-radius: var(--tnd-radius, 5px);
    color: var(--tnd-chip-red-fg);
    font-size: 13px;
  }

  /* ── Body scroll ─────────────────────────────────────────────────────────────── */

  .pm-body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
  }

  .pm-content {
    max-width: 720px;
    margin: 0 auto;
    padding: 0 24px;
  }

  /* ── Plugin list ─────────────────────────────────────────────────────────────── */

  .pm-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .pm-item {
    border-bottom: 1px solid var(--tnd-line);
  }

  .pm-item:last-child {
    border-bottom: none;
  }

  /* ── Plugin row (per PluginRow in design) ────────────────────────────────────── */

  .pm-row {
    display: flex;
    align-items: flex-start;
    gap: 11px;
    padding: 15px 4px;
  }

  /* Icon box: 30×30, border, icon colored by status */
  .pm-icon-box {
    width: 30px;
    height: 30px;
    border: 1px solid var(--tnd-line-strong);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--tnd-text-faint);
    border-radius: var(--tnd-radius, 0px);
  }

  .pm-icon-box--on {
    color: var(--tnd-accent);
  }

  /* Info block */
  .pm-info {
    flex: 1;
    min-width: 0;
  }

  .pm-name-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }

  .pm-plugin-name {
    font-size: 13.5px;
    font-weight: 700;
    color: var(--tnd-text);
    font-family: var(--tnd-font-ui);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Kind badge (PROVIDER / PROCESSOR / etc.) */
  .pm-kind-badge {
    font-size: 10px;
    color: var(--tnd-chip-amber-fg);
    padding: 1px 6px;
    border: 1px solid var(--tnd-line);
    text-transform: var(--tnd-label-transform, uppercase);
    letter-spacing: 0.04em;
    font-family: var(--tnd-font-ui);
    white-space: nowrap;
    border-radius: var(--tnd-tag-radius, 0px);
  }

  .pm-kind-badge--provider {
    color: var(--tnd-accent-text);
  }

  .pm-version {
    font-size: 10.5px;
    color: var(--tnd-text-faint);
    font-family: var(--tnd-font-mono);
    flex-shrink: 0;
  }

  /* Status badge */
  .pm-status-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 1px 6px;
    border: 1px solid var(--tnd-line);
    text-transform: var(--tnd-label-transform, uppercase);
    letter-spacing: 0.04em;
    flex-shrink: 0;
    border-radius: var(--tnd-tag-radius, 0px);
  }

  .pm-status-badge--active {
    background: var(--tnd-accent-soft);
    color: var(--tnd-accent-text);
    border-color: var(--tnd-accent);
  }

  .pm-status-badge--permissions-pending {
    background: var(--tnd-chip-amber-bg);
    color: var(--tnd-chip-amber-fg);
    border-color: var(--tnd-chip-amber-fg);
  }

  .pm-status-badge--suspended {
    background: var(--tnd-chip-red-bg);
    color: var(--tnd-chip-red-fg);
    border-color: var(--tnd-chip-red-fg);
  }

  .pm-status-badge--failed {
    background: var(--tnd-chip-red-bg);
    color: var(--tnd-chip-red-fg);
    border-color: var(--tnd-chip-red-fg);
  }

  .pm-strikes {
    font-size: 11px;
    color: var(--tnd-chip-red-fg);
    font-weight: 600;
    flex-shrink: 0;
  }

  /* Description / capabilities line */
  .pm-desc {
    font-size: 11.5px;
    color: var(--tnd-text-muted);
    margin-top: 3px;
    font-family: var(--tnd-font-ui);
  }

  /* Grants row */
  .pm-grants-row {
    display: flex;
    gap: 5px;
    margin-top: 8px;
    flex-wrap: wrap;
    align-items: center;
  }

  .pm-grants-label {
    font-size: 10px;
    color: var(--tnd-text-faint);
    font-family: var(--tnd-font-ui);
  }

  .pm-perm-chip {
    font-size: 10.5px;
    color: var(--tnd-text-muted);
    padding: 1px 6px;
    border: 1px solid var(--tnd-line);
    font-family: var(--tnd-font-ui);
    border-radius: var(--tnd-tag-radius, 0px);
  }

  .pm-perm-chip--danger {
    color: var(--tnd-chip-amber-fg);
  }

  /* Right side: toggle + expand */
  .pm-row-right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    padding-top: 3px;
  }

  /* Toggle switch (per MToggle in design) */
  .pm-toggle {
    width: 34px;
    height: 18px;
    background: var(--tnd-line-strong);
    position: relative;
    flex-shrink: 0;
    display: inline-block;
    border: none;
    cursor: pointer;
    padding: 0;
    border-radius: 9px;
    transition: background 0.15s;
  }

  .pm-toggle--on {
    background: var(--tnd-accent);
  }

  .pm-toggle-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    background: #fff;
    border-radius: 50%;
    transition: left 0.15s;
  }

  .pm-toggle--on .pm-toggle-thumb {
    left: 18px;
  }

  /* Mono: square toggle + thumb */
  :global([data-tnd-theme="mono"]) .pm-toggle {
    border-radius: 0;
  }

  :global([data-tnd-theme="mono"]) .pm-toggle-thumb {
    border-radius: 0;
  }

  .pm-expand-btn {
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--tnd-text-faint);
    font-size: 11px;
    padding: 2px 4px;
    font-family: var(--tnd-font-ui);
  }

  .pm-expand-btn:hover {
    color: var(--tnd-text-muted);
  }

  /* ── Expand panel ─────────────────────────────────────────────────────────────── */

  .pm-panel {
    padding: 0 4px 16px 41px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  /* ── Alert cards ──────────────────────────────────────────────────────────────── */

  .pm-alert {
    padding: 12px 14px;
    border-radius: var(--tnd-radius, 5px);
    font-size: 13px;
  }

  .pm-alert--accent {
    background: var(--tnd-accent-soft);
    border: 1px solid var(--tnd-accent);
  }

  .pm-alert--panel {
    background: var(--tnd-panel2);
    border: 1px solid var(--tnd-line-strong);
  }

  .pm-alert--danger {
    background: var(--tnd-chip-red-bg);
    border: 1px solid var(--tnd-chip-red-fg);
  }

  .pm-alert-title {
    font-weight: 600;
    color: var(--tnd-text);
    margin-bottom: 5px;
    font-family: var(--tnd-font-ui);
  }

  .pm-alert--accent .pm-alert-title {
    color: var(--tnd-accent-text);
  }

  .pm-alert--danger .pm-alert-title {
    color: var(--tnd-chip-red-fg);
  }

  .pm-alert-body {
    margin: 0 0 10px;
    color: var(--tnd-text-muted);
    line-height: 1.5;
    font-family: var(--tnd-font-ui);
  }

  .pm-alert-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .pm-confirm-list {
    margin: 0 0 10px 16px;
    padding: 0;
    color: var(--tnd-text-muted);
    font-size: 12.5px;
    line-height: 1.7;
    font-family: var(--tnd-font-ui);
  }

  .pm-failure-detail {
    font-size: 11.5px;
    font-family: var(--tnd-font-mono);
    color: var(--tnd-text-muted);
    white-space: pre-wrap;
    word-break: break-all;
    margin: 6px 0;
    background: var(--tnd-panel2);
    padding: 8px 10px;
    border-radius: var(--tnd-radius, 4px);
    max-height: 120px;
    overflow-y: auto;
  }

  /* ── Section headings ─────────────────────────────────────────────────────────── */

  .pm-section {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }

  .pm-section-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: var(--tnd-label-spacing, 0.07em);
    text-transform: var(--tnd-label-transform, uppercase);
    color: var(--tnd-text-faint);
    font-family: var(--tnd-font-ui);
  }

  /* ── Capability chips ─────────────────────────────────────────────────────────── */

  .pm-chips-row {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }

  .pm-chip {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: var(--tnd-tag-radius, 10px);
    font-weight: 500;
    font-family: var(--tnd-font-ui);
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

  /* ── Permissions list ─────────────────────────────────────────────────────────── */

  .pm-perm-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .pm-perm-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 7px 10px;
    background: var(--tnd-panel2);
    border-radius: var(--tnd-radius, 4px);
    border: 1px solid var(--tnd-line);
  }

  .pm-perm-info {
    flex: 1;
    min-width: 0;
  }

  .pm-perm-label {
    font-size: 12.5px;
    font-weight: 500;
    color: var(--tnd-text);
    font-family: var(--tnd-font-ui);
  }

  .pm-perm-label--danger {
    color: var(--tnd-chip-amber-fg);
  }

  .pm-perm-detail {
    font-size: 11.5px;
    color: var(--tnd-text-faint);
    margin-top: 1px;
    line-height: 1.4;
    font-family: var(--tnd-font-ui);
  }

  .pm-grant-toggle {
    flex-shrink: 0;
    padding: 3px 10px;
    border-radius: var(--tnd-radius, 4px);
    font-size: 11.5px;
    font-family: var(--tnd-font-ui);
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

  /* ── Settings form ────────────────────────────────────────────────────────────── */

  .pm-settings-form {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .pm-setting-row {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .pm-setting-label {
    font-size: 12px;
    font-weight: 500;
    color: var(--tnd-text-muted);
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--tnd-font-ui);
  }

  .pm-secret-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 1px 5px;
    border-radius: var(--tnd-tag-radius, 3px);
    background: var(--tnd-chip-violet-bg, rgba(100, 50, 200, 0.1));
    color: var(--tnd-chip-violet-fg, #6432c8);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .pm-setting-desc {
    font-size: 11.5px;
    color: var(--tnd-text-faint);
    margin-bottom: 2px;
    line-height: 1.4;
    font-family: var(--tnd-font-ui);
  }

  .pm-setting-input {
    max-width: 320px;
    padding: 5px 8px;
    background: var(--tnd-panel2);
    border: 1px solid var(--tnd-line-strong);
    border-radius: var(--tnd-radius, 4px);
    color: var(--tnd-text);
    font-size: 13px;
    font-family: var(--tnd-font-ui);
    outline: none;
  }

  .pm-setting-input:focus {
    border-color: var(--tnd-accent);
  }

  .pm-setting-input--number {
    width: 100px;
  }

  .pm-setting-input--secret {
    font-family: var(--tnd-font-mono);
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
    border-radius: var(--tnd-radius, 4px);
    color: var(--tnd-text);
    font-size: 13px;
    font-family: var(--tnd-font-ui);
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
    border-radius: var(--tnd-radius, 4px);
    cursor: pointer;
    font-family: var(--tnd-font-ui);
    flex-shrink: 0;
  }

  .pm-reveal-btn:hover {
    color: var(--tnd-text);
    background: var(--tnd-panel2);
  }

  /* ── Commands list ────────────────────────────────────────────────────────────── */

  .pm-cmd-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .pm-cmd-row {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 5px 10px;
    background: var(--tnd-panel2);
    border-radius: var(--tnd-radius, 4px);
  }

  .pm-cmd-title {
    font-size: 13px;
    color: var(--tnd-text);
    flex: 1;
    font-family: var(--tnd-font-ui);
  }

  .pm-cmd-id {
    font-size: 11px;
    color: var(--tnd-text-faint);
    font-family: var(--tnd-font-mono);
    flex-shrink: 0;
  }

  /* ── README ───────────────────────────────────────────────────────────────────── */

  .pm-readme {
    font-size: 12.5px;
    font-family: var(--tnd-font-mono);
    white-space: pre-wrap;
    word-break: break-word;
    background: var(--tnd-panel2);
    border: 1px solid var(--tnd-line);
    border-radius: var(--tnd-radius, 5px);
    padding: 12px 14px;
    color: var(--tnd-text-muted);
    line-height: 1.55;
    max-height: 280px;
    overflow-y: auto;
  }

  /* ── Footer note ──────────────────────────────────────────────────────────────── */

  .pm-footer-note {
    font-size: 12px;
    color: var(--tnd-text-faint);
    padding: 14px 4px;
    font-family: var(--tnd-font-ui);
    display: flex;
    gap: 4px;
    align-items: center;
  }

  .pm-footer-path {
    color: var(--tnd-accent-text);
    font-family: var(--tnd-font-mono);
  }

  /* ── Shared buttons ───────────────────────────────────────────────────────────── */

  .pm-btn {
    background: var(--tnd-panel2);
    border: 1px solid var(--tnd-line-strong);
    color: var(--tnd-text-muted);
    font-size: 12px;
    padding: 5px 12px;
    border-radius: var(--tnd-radius, 4px);
    cursor: pointer;
    font-family: var(--tnd-font-ui);
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
