// Settings store — spec 0011 §User settings.
//
// This module provides the interface for user-level settings with a localStorage
// implementation. Real file persistence (platform config dir) comes with #23.
//
// User scope: keybindings, theme, mode, editor prefs.
// Library scope: primaryDateProp, assetFolder — in-memory for the mock; will
// live in _settings.md via the real IPC when that lands.

import { type ChordString } from "./registry.js";

// ── Types ──────────────────────────────────────────────────────────────────────

/** Preset identifier. */
export type PresetId = "default" | "vim-flavor" | "emacs-flavor";

/**
 * The user-settings shape stored to disk / localStorage.
 * Unknown keys round-trip (spec 0011 §Edge cases).
 */
export interface UserSettings {
  /** User keybinding overrides: commandId → array of chord strings. */
  bindings?: Record<string, ChordString[]>;
  /** Active keymap preset. null if no preset has been applied. */
  preset?: PresetId | null;
  /** Whether the vim modal engine is enabled (set by vim-flavor preset). */
  modalEditor?: boolean;
  /** Active theme key (e.g. "paper", "fog"). */
  theme?: string;
  /** Active theme mode. */
  mode?: "light" | "dark" | "system";
  /** Editor font size in px (default 14). */
  fontSize?: number;
  /** Editor line width in chars (default 72). */
  lineWidth?: number;
  /** Anything else the file contained — preserved verbatim. */
  [key: string]: unknown;
}

/** Library-scope settings (will round-trip through _settings.md in real IPC). */
export interface LibrarySettings {
  /** The frontmatter property used as the calendar primary date. Default: "due". */
  primaryDateProp?: string;
  /** Asset folder name. Default: "_assets". */
  assetFolder?: string;
  /** Anything else — preserved verbatim. */
  [key: string]: unknown;
}

// ── Settings store interface ───────────────────────────────────────────────────

export interface ISettingsStore {
  load(): UserSettings;
  save(settings: UserSettings): void;
}

// ── localStorage implementation ────────────────────────────────────────────────

const STORAGE_KEY = "tonotedo:user-settings";

export class LocalStorageSettingsStore implements ISettingsStore {
  load(): UserSettings {
    if (typeof localStorage === "undefined") return {};
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      return JSON.parse(raw) as UserSettings;
    } catch {
      // Malformed JSON — return defaults (spec 0011 §Edge cases).
      return {};
    }
  }

  save(settings: UserSettings): void {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }
}

// ── In-memory implementation (for tests) ──────────────────────────────────────

export class MemorySettingsStore implements ISettingsStore {
  private _data: UserSettings = {};

  load(): UserSettings {
    return { ...this._data };
  }

  save(settings: UserSettings): void {
    this._data = { ...settings };
  }
}

// ── Singleton store ────────────────────────────────────────────────────────────

/** Use this in production code. Swap in MemorySettingsStore for tests. */
export let settingsStore: ISettingsStore = new LocalStorageSettingsStore();

/** Replace the store (used in tests and future Tauri file impl). */
export function setSettingsStore(store: ISettingsStore): void {
  settingsStore = store;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Load user bindings as a Map for use with keymap.ts resolveBindings. */
export function loadUserBindings(): Map<string, ChordString[]> {
  const settings = settingsStore.load();
  if (!settings.bindings) return new Map();
  return new Map(Object.entries(settings.bindings));
}

/** Persist a single binding override. Merges with existing settings. */
export function saveBinding(commandId: string, chords: ChordString[]): void {
  const settings = settingsStore.load();
  const bindings = settings.bindings ?? {};
  bindings[commandId] = chords;
  settingsStore.save({ ...settings, bindings });
}

/** Remove a binding override (falling back to command default). */
export function removeBindingOverride(commandId: string): void {
  const settings = settingsStore.load();
  if (!settings.bindings) return;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { [commandId]: _removed, ...rest } = settings.bindings;
  settingsStore.save({ ...settings, bindings: rest });
}

/** Save which preset was last applied (import-once semantics). */
export function savePreset(id: PresetId, modalEditor: boolean): void {
  const settings = settingsStore.load();
  settingsStore.save({ ...settings, preset: id, modalEditor });
}

// ── Library settings store ─────────────────────────────────────────────────────

export interface ILibrarySettingsStore {
  load(): LibrarySettings;
  save(settings: LibrarySettings): void;
}

/** In-memory library settings (mock + tests; real impl will use _settings.md). */
export class MemoryLibrarySettingsStore implements ILibrarySettingsStore {
  private _data: LibrarySettings = {};

  load(): LibrarySettings {
    return { ...this._data };
  }

  save(settings: LibrarySettings): void {
    this._data = { ...settings };
  }
}

/** Singleton library settings store — swappable like settingsStore. */
export let librarySettingsStore: ILibrarySettingsStore = new MemoryLibrarySettingsStore();

export function setLibrarySettingsStore(store: ILibrarySettingsStore): void {
  librarySettingsStore = store;
}

// ── Scoped facade helpers (refs #32) ──────────────────────────────────────────

/** Get a user-scope setting value (or undefined if not set). */
export function settings_get_user<K extends keyof UserSettings>(key: K): UserSettings[K] {
  return settingsStore.load()[key];
}

/** Set a user-scope setting value. Merges with existing settings. */
export function settings_set_user<K extends keyof UserSettings>(
  key: K,
  value: UserSettings[K],
): void {
  const settings = settingsStore.load();
  settingsStore.save({ ...settings, [key]: value });
}

/** Get a library-scope setting value (or undefined if not set). */
export function settings_get_library<K extends keyof LibrarySettings>(key: K): LibrarySettings[K] {
  return librarySettingsStore.load()[key];
}

/** Set a library-scope setting value. Merges with existing settings. */
export function settings_set_library<K extends keyof LibrarySettings>(
  key: K,
  value: LibrarySettings[K],
): void {
  const settings = librarySettingsStore.load();
  librarySettingsStore.save({ ...settings, [key]: value });
}

/** The primary date property for the current library (default: "due"). */
export function getPrimaryDateProp(): string {
  return librarySettingsStore.load().primaryDateProp ?? "due";
}
