// Reactive modal-editor flag (spec 0007 §Keymap presets / §Modal vs modeless).
//
// The vim-flavor preset sets `modalEditor: true` in user settings; the default
// preset sets it false. This store mirrors that flag reactively so the Editor
// can toggle its modal compartment live when the user switches presets in
// settings — no restart (a 0007 acceptance criterion).
//
// Persistence lives in settings.ts (`savePreset` writes `modalEditor`). This
// store is the in-memory reactive projection; the preset switcher calls
// `modalStore.set(...)` after persisting, and `modalStore.init()` reads the
// persisted value on mount.

import { settings_get_user } from "../../commands/settings.js";

let _enabled = $state(false);

export const modalStore = {
  get enabled() {
    return _enabled;
  },
  set(value: boolean) {
    _enabled = value;
  },
  /** Read the persisted flag from user settings (call on mount). */
  init() {
    _enabled = settings_get_user("modalEditor") === true;
  },
};
