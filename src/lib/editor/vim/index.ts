// Vim-flavor modal engine — public surface (spec 0007 §Modal vs modeless).
//
// The Editor component installs `vimCompartment` and reconfigures it with
// `modalEnabled(true|false)` to toggle the engine live when the active preset
// changes. Switching back to a non-modal preset reconfigures to the empty set,
// which removes the mode field, keymap, and DOM handler entirely — no lingering
// key interception (a brief acceptance criterion).

import { Compartment, type Extension } from "@codemirror/state";

import { modalExtension } from "./keymap.js";
import { modeNotifier } from "./mode-state.js";

export {
  type VimMode,
  vimModeField,
  setVimMode,
  currentMode,
  isModalActive,
  registerModeListener,
} from "./mode-state.js";

/** Compartment wrapping the modal engine so it can be toggled at runtime. */
export const vimCompartment = new Compartment();

/**
 * The extension to load into the compartment. `enabled === false` loads nothing
 * (engine off); `true` loads the full modal engine + mode notifier.
 */
export function modalEnabled(enabled: boolean): Extension {
  return enabled ? modalExtension(modeNotifier) : [];
}
