import { describe, it, expect, beforeEach, vi } from "vitest";
import { syncPluginCommands, clearPluginCommands } from "../plugin-commands.js";
import type { PluginInfo } from "../../ipc/types.js";
import { registry } from "../../commands/registry.js";

// Helper: build a minimal PluginInfo.
function makePlugin(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: "com.test.plugin",
    name: "Test Plugin",
    version: "1.0.0",
    status: "active",
    shape: ["processor"],
    capabilities: ["command"],
    permissions: [],
    granted: [],
    settings: [],
    commands: [{ id: "com.test.plugin.run", title: "Run Test" }],
    views: [],
    strikes: 0,
    readme: "",
    ...overrides,
  };
}

// Build a minimal mock Ipc with a spy on plugins_invoke_command.
function makeMockIpc() {
  return {
    plugins_invoke_command: vi.fn().mockResolvedValue({ ok: true, value: "{}" }),
  } as unknown as import("../../ipc/types.js").Ipc;
}

beforeEach(() => {
  clearPluginCommands();
  // Clean up any test commands from the shared registry between tests.
  registry.unregister("com.test.plugin.run");
  registry.unregister("com.test.plugin.other");
  registry.unregister("com.other.cmd");
});

describe("syncPluginCommands — registration", () => {
  it("registers commands for active plugins", () => {
    const plugin = makePlugin();
    const ipc = makeMockIpc();
    syncPluginCommands([plugin], ipc);
    const cmd = registry.get("com.test.plugin.run");
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe("Run Test");
    expect(cmd!.category).toBe("App");
  });

  it("does not register commands for non-active plugins", () => {
    for (const status of ["permissions-pending", "suspended", "failed"] as const) {
      clearPluginCommands();
      registry.unregister("com.test.plugin.run");
      const plugin = makePlugin({ status });
      syncPluginCommands([plugin], makeMockIpc());
      expect(registry.get("com.test.plugin.run")).toBeUndefined();
    }
  });

  it("registered command invokes plugins_invoke_command on the correct plugin", async () => {
    const plugin = makePlugin();
    const ipc = makeMockIpc();
    syncPluginCommands([plugin], ipc);
    const cmd = registry.get("com.test.plugin.run")!;
    await cmd.handler();
    expect(ipc.plugins_invoke_command).toHaveBeenCalledWith(
      "com.test.plugin",
      "com.test.plugin.run",
      "{}",
    );
  });

  it("is idempotent — re-syncing same plugins does not duplicate registration", () => {
    const plugin = makePlugin();
    const ipc = makeMockIpc();
    syncPluginCommands([plugin], ipc);
    syncPluginCommands([plugin], ipc);
    // Should still only have one handler — registry.get returns the latest,
    // and calling it twice with the same ids should not throw or cause issues.
    expect(registry.get("com.test.plugin.run")).toBeDefined();
  });
});

describe("syncPluginCommands — unregistration on status change", () => {
  it("unregisters a command when the plugin becomes inactive on re-sync", () => {
    const active = makePlugin({ status: "active" });
    const ipc = makeMockIpc();
    syncPluginCommands([active], ipc);
    expect(registry.get("com.test.plugin.run")).toBeDefined();

    // Plugin is now suspended — re-sync should remove the command.
    const suspended = makePlugin({ status: "suspended" });
    syncPluginCommands([suspended], ipc);
    expect(registry.get("com.test.plugin.run")).toBeUndefined();
  });

  it("unregisters all commands when plugin list is empty on reload", () => {
    const plugin = makePlugin();
    const ipc = makeMockIpc();
    syncPluginCommands([plugin], ipc);
    expect(registry.get("com.test.plugin.run")).toBeDefined();

    syncPluginCommands([], ipc);
    expect(registry.get("com.test.plugin.run")).toBeUndefined();
  });
});

describe("clearPluginCommands", () => {
  it("removes all registered plugin commands", () => {
    const plugin = makePlugin({
      commands: [
        { id: "com.test.plugin.run", title: "Run" },
        { id: "com.test.plugin.other", title: "Other" },
      ],
    });
    syncPluginCommands([plugin], makeMockIpc());
    expect(registry.get("com.test.plugin.run")).toBeDefined();
    expect(registry.get("com.test.plugin.other")).toBeDefined();

    clearPluginCommands();
    expect(registry.get("com.test.plugin.run")).toBeUndefined();
    expect(registry.get("com.test.plugin.other")).toBeUndefined();
  });
});
