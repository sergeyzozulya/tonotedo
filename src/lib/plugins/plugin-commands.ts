// Plugin command bridge — registers/unregisters palette commands for active plugins.
//
// Spec 0010 §"Integration points": plugin commands are namespaced, appear in the
// palette, and are invocable via plugins_invoke_command. They must be unregistered
// when the plugin is reloaded or suspended.
//
// Usage:
//   syncPluginCommands(plugins, ipc)  — call after plugins_list / plugins_reload.
//   clearPluginCommands()             — call before a reload so stale entries are purged.

import type { PluginInfo } from "../ipc/types.js";
import type { Ipc } from "../ipc/types.js";
import { registry } from "../commands/registry.js";

/** Ids of currently-registered plugin commands (for teardown). */
const registeredIds = new Set<string>();

/** Remove all currently-registered plugin commands from the registry. */
export function clearPluginCommands(): void {
  for (const id of registeredIds) {
    registry.unregister(id);
  }
  registeredIds.clear();
}

/**
 * Sync the registry with the given plugin list.
 * - Active plugins: register all their commands (namespaced).
 * - Inactive / suspended / pending plugins: ensure their commands are removed.
 * - Idempotent: safe to call after every plugins_list / plugins_reload.
 */
export function syncPluginCommands(plugins: PluginInfo[], ipc: Ipc): void {
  // First, remove any stale commands not present in the current active set.
  const activeCommandIds = new Set<string>();
  for (const plugin of plugins) {
    if (plugin.status === "active") {
      for (const cmd of plugin.commands) {
        activeCommandIds.add(cmd.id);
      }
    }
  }
  for (const id of registeredIds) {
    if (!activeCommandIds.has(id)) {
      registry.unregister(id);
      registeredIds.delete(id);
    }
  }

  // Register commands for active plugins.
  for (const plugin of plugins) {
    if (plugin.status !== "active") continue;
    for (const cmd of plugin.commands) {
      if (registeredIds.has(cmd.id)) continue; // already registered
      const pluginId = plugin.id;
      const commandId = cmd.id;
      registry.register({
        id: commandId,
        name: cmd.title,
        description: `Plugin command from ${plugin.name}`,
        category: "App",
        defaultBindings: [],
        when: "",
        handler: () => {
          void ipc.plugins_invoke_command(pluginId, commandId, "{}");
        },
      });
      registeredIds.add(commandId);
    }
  }
}
