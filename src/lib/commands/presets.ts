/// <reference types="vite/client" />
// Preset loader — spec 0007 §Keymap presets.
//
// Parses preset markdown files from src/presets/*.md.
// Each file has a YAML front-matter block and a ```bindings code fence.
//
// Bindings table format (one binding per line, whitespace-delimited):
//   <commandId>  <chord-or-(none)>  <when-or-(global)>
//
// The "(none)" sentinel means no binding for this command in this preset.
// The "(global)" sentinel means empty when-context (always active).

import type { ChordString, WhenContext } from "./registry.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PresetBinding {
  commandId: string;
  /** Canonical chord string, or null if the preset deliberately has no binding. */
  chord: ChordString | null;
  /** When-context. "" means global (always active). */
  when: WhenContext;
}

export interface PresetDefinition {
  id: string;
  name: string;
  description: string;
  /** Whether the vim modal editor engine should be enabled. */
  modal: boolean;
  bindings: PresetBinding[];
}

// ── Parser ────────────────────────────────────────────────────────────────────

/** Parse a single line of the bindings table. Returns null on blank/comment. */
function parseBindingLine(line: string): PresetBinding | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  // Split on 2+ whitespace characters to allow spaces in chord display.
  // But the format is fixed: commandId  chord  when
  // Using simple split on whitespace (multiple tokens) and take columns 0,1,2.
  const parts = trimmed.split(/\s+/);
  if (parts.length < 3) return null;

  const commandId = parts[0];
  const chordRaw = parts[1];
  const whenRaw = parts.slice(2).join(" "); // allow "(global)" to be multi-word in future

  const chord = chordRaw === "(none)" ? null : chordRaw;
  const when = whenRaw === "(global)" ? "" : whenRaw;

  return { commandId, chord, when };
}

/** Parse front-matter YAML lines (key: value only, no nesting needed here). */
function parseFrontmatter(block: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (m) result[m[1]] = m[2].trim();
  }
  return result;
}

/**
 * Parse a preset markdown file's text content.
 * Returns null if the file is malformed.
 */
export function parsePresetMarkdown(text: string): PresetDefinition | null {
  // Extract front-matter block between --- delimiters.
  const fmMatch = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const fm = parseFrontmatter(fmMatch[1]);

  if (!fm.id || !fm.name) return null;

  // Extract the ```bindings code block.
  const bindingsMatch = text.match(/```bindings\s*\n([\s\S]*?)```/);
  const bindings: PresetBinding[] = [];
  if (bindingsMatch) {
    for (const line of bindingsMatch[1].split("\n")) {
      const binding = parseBindingLine(line);
      if (binding) bindings.push(binding);
    }
  }

  return {
    id: fm.id,
    name: fm.name,
    description: fm.description ?? "",
    modal: fm.modal === "true",
    bindings,
  };
}

// ── Vite import.meta.glob loader ───────────────────────────────────────────────

// Eagerly import all preset markdown files at build time via Vite.
// The ?raw query tells Vite to load them as plain string content.
const presetFiles = import.meta.glob<string>("/src/presets/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
});

let _loaded: PresetDefinition[] | null = null;

/**
 * Return all loaded preset definitions. Parsed once; cached.
 */
export function loadPresets(): PresetDefinition[] {
  if (_loaded !== null) return _loaded;
  const results: PresetDefinition[] = [];
  for (const [path, content] of Object.entries(presetFiles)) {
    if (typeof content !== "string") continue;
    const def = parsePresetMarkdown(content);
    if (def) {
      results.push(def);
    } else {
      console.warn("[commands/presets] Failed to parse preset:", path);
    }
  }
  // Stable order: default first, then alphabetical by id.
  results.sort((a, b) => {
    if (a.id === "default") return -1;
    if (b.id === "default") return 1;
    return a.id.localeCompare(b.id);
  });
  _loaded = results;
  return results;
}

/** Get a single preset by id. */
export function getPreset(id: string): PresetDefinition | undefined {
  return loadPresets().find((p) => p.id === id);
}

/** Reset cached presets (for tests). */
export function _resetPresetCache(): void {
  _loaded = null;
}
