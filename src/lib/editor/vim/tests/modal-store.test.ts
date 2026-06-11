// Reactive modal-editor flag — preset-driven activation (spec 0007).
//
// Confirms the store initialises from persisted user settings and that the
// shipped vim-flavor preset declares modal editing (so applying it flips the
// flag the Editor reads).

import { describe, it, expect, beforeEach } from "vitest";
import { MemorySettingsStore, setSettingsStore, savePreset } from "../../../commands/settings.js";
import { getPreset, _resetPresetCache } from "../../../commands/presets.js";
import { modalStore } from "../modal-store.svelte.js";

beforeEach(() => {
  setSettingsStore(new MemorySettingsStore());
  _resetPresetCache();
  modalStore.set(false);
});

describe("modalStore", () => {
  it("initialises false when no preset has been applied", () => {
    modalStore.init();
    expect(modalStore.enabled).toBe(false);
  });

  it("initialises true after the vim-flavor preset persisted modalEditor", () => {
    savePreset("vim-flavor", true);
    modalStore.init();
    expect(modalStore.enabled).toBe(true);
  });

  it("set() toggles the flag for live preset switches", () => {
    modalStore.set(true);
    expect(modalStore.enabled).toBe(true);
    modalStore.set(false);
    expect(modalStore.enabled).toBe(false);
  });
});

describe("shipped presets", () => {
  it("vim-flavor declares modal: true", () => {
    expect(getPreset("vim-flavor")?.modal).toBe(true);
  });

  it("default declares modal: false", () => {
    expect(getPreset("default")?.modal).toBe(false);
  });
});
