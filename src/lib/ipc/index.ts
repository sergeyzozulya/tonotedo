// IPC facade entry point.
//
// Runtime detection: Tauri v2 injects `__TAURI_INTERNALS__` onto `window`
// (confirmed in @tauri-apps/api v2 source — window.__TAURI_INTERNALS__ is the
// canonical presence check; the old v1 `__TAURI__` global is NOT present in v2).
//
// If the global is absent (plain browser / vitest / dev server) → mock.
// If present → real Tauri IPC.

import { real } from "./real.js";
import { mock } from "./mock.js";
import type { Ipc } from "./types.js";

export type { Ipc };
export type * from "./types.js";

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export const ipc: Ipc = isTauri() ? real : mock;
