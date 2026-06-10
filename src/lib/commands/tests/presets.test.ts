import { describe, it, expect, beforeEach } from "vitest";
import { parsePresetMarkdown, _resetPresetCache } from "../presets.js";
import type { PresetDefinition } from "../presets.js";

beforeEach(() => {
  _resetPresetCache();
});

// ── parsePresetMarkdown ────────────────────────────────────────────────────────

describe("parsePresetMarkdown — front-matter parsing", () => {
  const sample = `---
id: default
name: Default
description: The default modeless keymap.
modal: false
---

# Default

\`\`\`bindings
palette.open  cmd+k  (global)
entry.create  cmd+n  (global)
\`\`\`
`;

  it("parses id and name from front-matter", () => {
    const p = parsePresetMarkdown(sample);
    expect(p).not.toBeNull();
    expect(p!.id).toBe("default");
    expect(p!.name).toBe("Default");
  });

  it("parses description", () => {
    const p = parsePresetMarkdown(sample);
    expect(p!.description).toBe("The default modeless keymap.");
  });

  it("parses modal: false", () => {
    expect(parsePresetMarkdown(sample)!.modal).toBe(false);
  });

  it("parses modal: true", () => {
    const text = sample.replace("modal: false", "modal: true");
    expect(parsePresetMarkdown(text)!.modal).toBe(true);
  });

  it("returns null when front-matter is missing", () => {
    expect(parsePresetMarkdown("# No front-matter\n\n```bindings\n```")).toBeNull();
  });

  it("returns null when id is missing", () => {
    const noId = sample.replace("id: default\n", "");
    expect(parsePresetMarkdown(noId)).toBeNull();
  });
});

describe("parsePresetMarkdown — bindings table parsing", () => {
  const withBindings = `---
id: test
name: Test
description: test preset
modal: false
---

\`\`\`bindings
palette.open          cmd+k       (global)
editor.toggle-checkbox cmd+shift+c zone:editor
entry.create          (none)      (global)
\`\`\`
`;

  let preset: PresetDefinition;

  beforeEach(() => {
    preset = parsePresetMarkdown(withBindings)!;
  });

  it("parses correct number of bindings", () => {
    expect(preset.bindings).toHaveLength(3);
  });

  it("parses commandId correctly", () => {
    expect(preset.bindings[0].commandId).toBe("palette.open");
    expect(preset.bindings[1].commandId).toBe("editor.toggle-checkbox");
    expect(preset.bindings[2].commandId).toBe("entry.create");
  });

  it("parses chord correctly", () => {
    expect(preset.bindings[0].chord).toBe("cmd+k");
    expect(preset.bindings[1].chord).toBe("cmd+shift+c");
  });

  it("parses (none) chord as null", () => {
    expect(preset.bindings[2].chord).toBeNull();
  });

  it("parses (global) when-context as empty string", () => {
    expect(preset.bindings[0].when).toBe("");
    expect(preset.bindings[2].when).toBe("");
  });

  it("parses zone context correctly", () => {
    expect(preset.bindings[1].when).toBe("zone:editor");
  });

  it("skips blank lines in bindings block", () => {
    const withBlanks = withBindings.replace("palette.open", "\n\npalette.open");
    const p = parsePresetMarkdown(withBlanks);
    expect(p!.bindings).toHaveLength(3); // same count
  });

  it("skips comment lines in bindings block", () => {
    const withComment = withBindings.replace("palette.open", "# This is a comment\npalette.open");
    const p = parsePresetMarkdown(withComment);
    expect(p!.bindings).toHaveLength(3);
  });

  it("handles preset with no bindings block", () => {
    const noBindings = `---
id: empty
name: Empty
description: no bindings
modal: false
---

# Empty preset
`;
    const p = parsePresetMarkdown(noBindings)!;
    expect(p).not.toBeNull();
    expect(p.bindings).toHaveLength(0);
  });
});

describe("parsePresetMarkdown — vim-flavor preset shape", () => {
  const vimSample = `---
id: vim-flavor
name: Vim Flavor
description: Vim-ish modal editing.
modal: true
---

\`\`\`bindings
palette.open  cmd+k  (global)
editor.find   /      zone:editor
\`\`\`
`;

  it("sets modal: true for vim-flavor", () => {
    expect(parsePresetMarkdown(vimSample)!.modal).toBe(true);
  });

  it("parses single-char binding (/)", () => {
    const p = parsePresetMarkdown(vimSample)!;
    const editorFind = p.bindings.find((b) => b.commandId === "editor.find");
    expect(editorFind).toBeDefined();
    expect(editorFind!.chord).toBe("/");
  });
});
