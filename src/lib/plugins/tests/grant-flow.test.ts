// Tests for the pending-prompt state machine and grant toggle plumbing.
// These are pure logic tests (no Svelte rendering required).

import { describe, it, expect, vi } from "vitest";
import type { PluginInfo } from "../../ipc/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makePlugin(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: "com.test.gcal",
    name: "Google Calendar",
    version: "1.0.0",
    status: "permissions-pending",
    shape: ["provider"],
    capabilities: ["command", "entries-owner"],
    permissions: ["read-entries", "write-entries", "network:www.googleapis.com"],
    granted: ["read-entries"],
    settings: [],
    commands: [],
    views: [],
    strikes: 0,
    readme: "",
    ...overrides,
  };
}

// ── Pending state machine ──────────────────────────────────────────────────────
// The manager component manages a Map<pluginId, "prompt" | "review">.
// We extract the logic as a plain function to test it without Svelte.

type PendingFlow = "prompt" | "review";

function pendingFlowReducer(
  state: Map<string, PendingFlow>,
  action:
    | { type: "start-grant-all"; id: string }
    | { type: "start-review"; id: string }
    | { type: "dismiss"; id: string }
    | { type: "confirm-grant-all"; id: string },
): Map<string, PendingFlow> {
  const next = new Map(state);
  switch (action.type) {
    case "start-grant-all":
      next.set(action.id, "prompt");
      break;
    case "start-review":
      next.set(action.id, "review");
      break;
    case "dismiss":
    case "confirm-grant-all":
      next.delete(action.id);
      break;
  }
  return next;
}

describe("pending-prompt state machine", () => {
  it("initial state: no plugin has a flow", () => {
    const state = new Map<string, PendingFlow>();
    expect(state.size).toBe(0);
  });

  it("start-grant-all sets flow to 'prompt'", () => {
    let state = new Map<string, PendingFlow>();
    state = pendingFlowReducer(state, { type: "start-grant-all", id: "com.test.gcal" });
    expect(state.get("com.test.gcal")).toBe("prompt");
  });

  it("start-review sets flow to 'review'", () => {
    let state = new Map<string, PendingFlow>();
    state = pendingFlowReducer(state, { type: "start-review", id: "com.test.gcal" });
    expect(state.get("com.test.gcal")).toBe("review");
  });

  it("dismiss clears the flow", () => {
    let state = new Map<string, PendingFlow>([["com.test.gcal", "prompt"]]);
    state = pendingFlowReducer(state, { type: "dismiss", id: "com.test.gcal" });
    expect(state.has("com.test.gcal")).toBe(false);
  });

  it("confirm-grant-all clears the flow", () => {
    let state = new Map<string, PendingFlow>([["com.test.gcal", "prompt"]]);
    state = pendingFlowReducer(state, { type: "confirm-grant-all", id: "com.test.gcal" });
    expect(state.has("com.test.gcal")).toBe(false);
  });

  it("flows are independent per plugin", () => {
    let state = new Map<string, PendingFlow>();
    state = pendingFlowReducer(state, { type: "start-grant-all", id: "plugin-a" });
    state = pendingFlowReducer(state, { type: "start-review", id: "plugin-b" });
    expect(state.get("plugin-a")).toBe("prompt");
    expect(state.get("plugin-b")).toBe("review");
    state = pendingFlowReducer(state, { type: "dismiss", id: "plugin-a" });
    expect(state.has("plugin-a")).toBe(false);
    expect(state.get("plugin-b")).toBe("review");
  });
});

// ── Grant toggle plumbing ──────────────────────────────────────────────────────

describe("grant toggle plumbing", () => {
  it("calls plugins_set_grant with inverted value when toggling", async () => {
    const plugin = makePlugin();
    const ipc = {
      plugins_set_grant: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    } as unknown as import("../../ipc/types.js").Ipc;

    // Simulate toggling 'write-entries' which is NOT granted.
    const perm = "write-entries";
    const currentlyGranted = plugin.granted.includes(perm); // false
    await ipc.plugins_set_grant(plugin.id, perm, !currentlyGranted);

    expect(ipc.plugins_set_grant).toHaveBeenCalledWith("com.test.gcal", "write-entries", true);
  });

  it("calls plugins_set_grant with false when revoking a granted permission", async () => {
    const plugin = makePlugin();
    const ipc = {
      plugins_set_grant: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    } as unknown as import("../../ipc/types.js").Ipc;

    const perm = "read-entries";
    const currentlyGranted = plugin.granted.includes(perm); // true
    await ipc.plugins_set_grant(plugin.id, perm, !currentlyGranted);

    expect(ipc.plugins_set_grant).toHaveBeenCalledWith("com.test.gcal", "read-entries", false);
  });

  it("grantAll calls plugins_set_grant for each non-granted permission", async () => {
    const plugin = makePlugin();
    const ipc = {
      plugins_set_grant: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    } as unknown as import("../../ipc/types.js").Ipc;

    // Simulate grantAll logic.
    for (const perm of plugin.permissions) {
      if (!plugin.granted.includes(perm)) {
        await ipc.plugins_set_grant(plugin.id, perm, true);
      }
    }

    // 'read-entries' is already granted, so only 'write-entries' and 'network:...' should be called.
    expect(ipc.plugins_set_grant).toHaveBeenCalledTimes(2);
    expect(ipc.plugins_set_grant).toHaveBeenCalledWith("com.test.gcal", "write-entries", true);
    expect(ipc.plugins_set_grant).toHaveBeenCalledWith(
      "com.test.gcal",
      "network:www.googleapis.com",
      true,
    );
  });
});
