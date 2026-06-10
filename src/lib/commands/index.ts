// Public surface of the commands module (spec 0007).

export { registry } from "./registry.js";
export type { Command, CommandCategory, WhenContext, ChordString } from "./registry.js";

export {
  parseStroke,
  parseChord,
  normalizeChord,
  isOsReserved,
  detectConflicts,
  resolveBindings,
  buildBindingList,
  ChordStateMachine,
  CHORD_TIMEOUT_MS,
} from "./keymap.js";
export type {
  ParsedStroke,
  ParsedChord,
  Binding,
  ConflictKind,
  ConflictResult,
  UserBindings,
} from "./keymap.js";

export {
  getActiveZone,
  setZone,
  currentContext,
  evaluateContext,
  zoneLabel,
  ZONE_CONTEXTS,
  TEXT_INPUT_ZONES,
} from "./zones.js";
export type { ZoneId } from "./zones.js";

export {
  settingsStore,
  setSettingsStore,
  loadUserBindings,
  saveBinding,
  removeBindingOverride,
  savePreset,
  LocalStorageSettingsStore,
  MemorySettingsStore,
  librarySettingsStore,
  setLibrarySettingsStore,
  MemoryLibrarySettingsStore,
  settings_get_user,
  settings_set_user,
  settings_get_library,
  settings_set_library,
  getPrimaryDateProp,
} from "./settings.js";
export type {
  UserSettings,
  LibrarySettings,
  ISettingsStore,
  ILibrarySettingsStore,
  PresetId,
} from "./settings.js";

export { parsePresetMarkdown, loadPresets, getPreset, _resetPresetCache } from "./presets.js";
export type { PresetDefinition, PresetBinding } from "./presets.js";

export { fuzzyMatch, rankByFuzzy, highlightSegments } from "./fuzzy.js";
export type { FuzzyMatch, RankedCommand, TextSegment } from "./fuzzy.js";

export { getRecents, recordRecent, clearRecents } from "./recents.js";

export {
  keymapAction,
  attachKeymapListener,
  attachToDocument,
  setPaletteOpener,
  setCheatsheetOpener,
  setHintCallback,
} from "./keymap-action.js";

export { seedCommands, seedThemeCommands } from "./seed.js";

export { default as Palette } from "./Palette.svelte";
export { default as Cheatsheet } from "./Cheatsheet.svelte";
