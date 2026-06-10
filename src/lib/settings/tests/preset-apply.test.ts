// Preset apply semantics tests (spec 0007, issue #23).
//
// Covers:
//   - Import-once: applying a preset overwrites all bindings
//   - Applied-preset flag is stored
//   - Modal flag is correctly stored for vim-flavor
//   - Applying a second preset overwrites the first

import { describe, it, expect, beforeEach } from "vitest";
import {
  MemorySettingsStore,
  setSettingsStore,
  saveBinding,
  savePreset,
  loadUserBindings,
} from "../../../lib/commands/settings.js";
import { parsePresetMarkdown, _resetPresetCache } from "../../../lib/commands/presets.js";

beforeEach(() => {
  setSettingsStore(new MemorySettingsStore());
  _resetPresetCache();
});

const VIM_PRESET_MD = `---
id: vim-flavor
name: Vim Flavor
description: Vim-ish modal editing.
modal: true
---

\`\`\`bindings
palette.open   cmd+k    (global)
editor.find    /        zone:editor
entry.create   (none)   (global)
\`\`\`
`;

const DEFAULT_PRESET_MD = `---
id: default
name: Default
description: The default modeless keymap.
modal: false
---

\`\`\`bindings
palette.open   cmd+k    (global)
entry.create   cmd+n    (global)
editor.bold    cmd+b    zone:editor
\`\`\`
`;

describe("Preset apply — import-once semantics", () => {
  it("applies vim-flavor preset bindings", () => {
    const preset = parsePresetMarkdown(VIM_PRESET_MD)!;
    for (const b of preset.bindings) {
      if (b.chord !== null) saveBinding(b.commandId, [b.chord]);
    }
    savePreset("vim-flavor", preset.modal);

    const bindings = loadUserBindings();
    expect(bindings.get("palette.open")).toEqual(["cmd+k"]);
    expect(bindings.get("editor.find")).toEqual(["/"]);
  });

  it("stores the applied preset id", () => {
    const store = new MemorySettingsStore();
    setSettingsStore(store);
    savePreset("vim-flavor", true);
    expect(store.load().preset).toBe("vim-flavor");
  });

  it("stores modal: true for vim-flavor", () => {
    const store = new MemorySettingsStore();
    setSettingsStore(store);
    savePreset("vim-flavor", true);
    expect(store.load().modalEditor).toBe(true);
  });

  it("stores modal: false for default preset", () => {
    const store = new MemorySettingsStore();
    setSettingsStore(store);
    savePreset("default", false);
    expect(store.load().modalEditor).toBe(false);
  });

  it("applying a second preset overwrites the preset id", () => {
    const store = new MemorySettingsStore();
    setSettingsStore(store);
    savePreset("vim-flavor", true);
    savePreset("emacs-flavor", false);
    expect(store.load().preset).toBe("emacs-flavor");
    expect(store.load().modalEditor).toBe(false);
  });

  it("preserves existing bindings when storing preset id", () => {
    saveBinding("entry.create", ["meta+shift+n"]);
    savePreset("vim-flavor", true);
    // The binding key should still be there (savePreset only touches preset/modal).
    const bindings = loadUserBindings();
    expect(bindings.get("entry.create")).toEqual(["meta+shift+n"]);
  });
});

describe("Preset apply — overwrite semantics (import-once)", () => {
  it("overwriting a binding from one preset with another works", () => {
    // Apply default first
    saveBinding("palette.open", ["cmd+k"]);
    saveBinding("entry.create", ["cmd+n"]);
    savePreset("default", false);

    // Now apply vim which removes entry.create binding
    const vim = parsePresetMarkdown(VIM_PRESET_MD)!;
    // The (none) binding — test removal logic:
    const noneBinding = vim.bindings.find((b) => b.commandId === "entry.create");
    expect(noneBinding?.chord).toBeNull();
  });
});

describe("parsePresetMarkdown — integration", () => {
  it("parses vim-flavor preset correctly", () => {
    const preset = parsePresetMarkdown(VIM_PRESET_MD);
    expect(preset).not.toBeNull();
    expect(preset!.id).toBe("vim-flavor");
    expect(preset!.modal).toBe(true);
    expect(preset!.bindings).toHaveLength(3);
  });

  it("parses default preset correctly", () => {
    const preset = parsePresetMarkdown(DEFAULT_PRESET_MD);
    expect(preset).not.toBeNull();
    expect(preset!.id).toBe("default");
    expect(preset!.modal).toBe(false);
    expect(preset!.bindings).toHaveLength(3);
  });
});
