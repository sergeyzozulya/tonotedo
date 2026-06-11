// Settings store — spec 0011 §User settings and Library settings.
//
// Architecture:
//   - User settings: backed by the IPC settings_get_user / settings_set_user commands
//     which persist to the platform config dir (macOS: ~/Library/Application Support/…).
//     An in-memory cache is loaded async at startup via initSettingsFromIpc(). Writes
//     go through both the cache and the IPC command (write-through).
//   - Library settings: backed by IPC settings_get_library / settings_set_library which
//     persist to _settings.md at the library root. Loaded when a library opens via
//     initLibrarySettingsFromIpc().
//   - Fallback / mock: when no IPC is wired (the /dev demo or tests), the existing
//     localStorage-backed and in-memory stores are used transparently.
//
// Migration: on first IPC-backed run, if localStorage has user settings and the IPC
// file is empty, the localStorage data is seeded into the file (one-shot migration).
//
// Public contract:
//   settings_get_user / settings_set_user — synchronous, read/write the in-memory cache
//   settings_get_library / settings_set_library — synchronous, read/write in-memory cache
//   loadUserBindings, saveBinding, removeBindingOverride, savePreset — helpers unchanged
//   initSettingsFromIpc(ipc) — call once at app startup; loads remote, migrates if needed
//   initLibrarySettingsFromIpc(ipc) — call when a library is opened
//   getPrimaryDateProp() — reads library settings cache, default "due"

import type { Ipc } from "../ipc/types.js";
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

/** Library-scope settings (round-trips through _settings.md). */
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

// ── In-memory user settings cache (authoritative source after init) ────────────

/** In-memory cache of user settings — kept in sync with the IPC file. */
let userSettingsCache: UserSettings = {};

/** True after initSettingsFromIpc has completed at least one successful load. */
let userSettingsLoaded = false;

/** The IPC facade to use for settings persistence. null = not wired (mock/test). */
let _ipc: Ipc | null = null;

// ── Singleton store (legacy — reads from / writes to cache) ───────────────────

/** Use this in production code. Swap in MemorySettingsStore for tests. */
export let settingsStore: ISettingsStore = new LocalStorageSettingsStore();

/** Replace the store (used in tests and future Tauri file impl). */
export function setSettingsStore(store: ISettingsStore): void {
  settingsStore = store;
  // Reset the in-memory cache so the new store is authoritative.
  userSettingsCache = {};
  userSettingsLoaded = false;
}

// ── IPC bootstrap ─────────────────────────────────────────────────────────────

/**
 * Initialize user settings from IPC, migrating localStorage data on first run.
 *
 * Call once at app startup (AppShell onmount or equivalent). After this call
 * the in-memory cache is authoritative; writes go through to the IPC file.
 *
 * Migration rule (spec 0011 §Non-goals — "no migration framework"):
 * If the IPC file is empty AND localStorage has settings, seed the file once
 * so existing desktop users keep their settings after the upgrade.
 */
export async function initSettingsFromIpc(ipc: Ipc): Promise<void> {
  _ipc = ipc;
  try {
    const res = await ipc.settings_get_user();
    if (!res.ok) {
      // Fall through — keep existing cache (may be empty).
      return;
    }
    const remote = res.value as UserSettings;
    const remoteIsEmpty = Object.keys(remote).length === 0;

    if (remoteIsEmpty) {
      // Attempt migration from localStorage.
      const local = new LocalStorageSettingsStore().load();
      if (Object.keys(local).length > 0) {
        // Seed the IPC file from localStorage (one-shot migration).
        const seedRes = await ipc.settings_set_user(local as Record<string, unknown>);
        if (seedRes.ok) {
          userSettingsCache = { ...local };
          userSettingsLoaded = true;
          return;
        }
      }
    }

    // Normal load: apply whatever is in the file.
    userSettingsCache = { ...remote };
    userSettingsLoaded = true;
  } catch {
    // Best-effort: keep existing cache.
  }
}

// ── In-memory library settings cache ─────────────────────────────────────────

/** In-memory cache of library settings — populated when a library opens. */
let librarySettingsCache: LibrarySettings = {};

/**
 * Initialize library settings from IPC.
 * Call when a library is opened (open_library event or equivalent).
 */
export async function initLibrarySettingsFromIpc(ipc: Ipc): Promise<void> {
  _ipc = ipc;
  try {
    const res = await ipc.settings_get_library();
    if (res.ok) {
      // Map the snake_case keys from the Rust side to camelCase on the TS side.
      librarySettingsCache = mapLibrarySettingsFromWire(res.value);
    }
  } catch {
    // Best-effort.
  }
}

/**
 * Map wire-format library settings (snake_case, arbitrary unknown keys) to
 * the typed LibrarySettings shape.  Unknown keys are preserved verbatim.
 */
function mapLibrarySettingsFromWire(wire: Record<string, unknown>): LibrarySettings {
  const out: LibrarySettings = { ...wire };
  // The Rust side uses snake_case for the two spec-defined keys.
  if ("primary_date_property" in wire && !("primaryDateProp" in wire)) {
    out.primaryDateProp = wire["primary_date_property"] as string;
  }
  if ("asset_folder" in wire && !("assetFolder" in wire)) {
    out.assetFolder = wire["asset_folder"] as string;
  }
  return out;
}

/**
 * Map a LibrarySettings patch to the wire format (snake_case) expected by Rust.
 */
function mapLibrarySettingsToWire(patch: Partial<LibrarySettings>): Record<string, unknown> {
  const wire: Record<string, unknown> = { ...patch };
  if ("primaryDateProp" in patch) {
    wire["primary_date_property"] = patch.primaryDateProp;
    delete wire["primaryDateProp"];
  }
  if ("assetFolder" in patch) {
    wire["asset_folder"] = patch.assetFolder;
    delete wire["assetFolder"];
  }
  return wire;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Load user bindings as a Map for use with keymap.ts resolveBindings. */
export function loadUserBindings(): Map<string, ChordString[]> {
  const settings = settingsStore.load();
  // Merge IPC cache over localStorage so IPC wins after init.
  const cached = userSettingsLoaded ? userSettingsCache : {};
  const merged = { ...settings, ...cached };
  if (!merged.bindings) return new Map();
  return new Map(Object.entries(merged.bindings));
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

// ── Scoped facade helpers (refs #32) ──────────────────────────────────────────

/** Get a user-scope setting value (or undefined if not set). */
export function settings_get_user<K extends keyof UserSettings>(key: K): UserSettings[K] {
  // After IPC init the cache is authoritative; fall back to localStorage before that.
  if (userSettingsLoaded) {
    return userSettingsCache[key] as UserSettings[K];
  }
  return settingsStore.load()[key];
}

/** Set a user-scope setting value. Merges with existing settings, writes through to IPC. */
export function settings_set_user<K extends keyof UserSettings>(
  key: K,
  value: UserSettings[K],
): void {
  // Update in-memory cache.
  userSettingsCache = { ...userSettingsCache, [key]: value };
  userSettingsLoaded = true;

  // Write through to IPC file (fire-and-forget; errors are non-fatal).
  if (_ipc) {
    const patch: Record<string, unknown> = { [key as string]: value };
    _ipc.settings_set_user(patch).catch(() => {
      // Best-effort persistence.
    });
  } else {
    // Fallback to localStorage when IPC not wired (mock / test context).
    const settings = settingsStore.load();
    settingsStore.save({ ...settings, [key]: value });
  }
}

/** Get a library-scope setting value (or undefined if not set). */
export function settings_get_library<K extends keyof LibrarySettings>(key: K): LibrarySettings[K] {
  return librarySettingsCache[key] as LibrarySettings[K];
}

/** Set a library-scope setting value. Merges with existing settings, writes through to IPC. */
export function settings_set_library<K extends keyof LibrarySettings>(
  key: K,
  value: LibrarySettings[K],
): void {
  // Update in-memory cache.
  librarySettingsCache = { ...librarySettingsCache, [key]: value };

  // Write through to IPC (fire-and-forget).
  if (_ipc) {
    const wirePatch = mapLibrarySettingsToWire({ [key]: value } as Partial<LibrarySettings>);
    _ipc.settings_set_library(wirePatch).catch(() => {
      // Best-effort.
    });
  } else {
    librarySettingsStore.save({ ...librarySettingsStore.load(), [key]: value });
  }
}

/** The primary date property for the current library (default: "due"). */
export function getPrimaryDateProp(): string {
  return (
    librarySettingsCache.primaryDateProp ?? librarySettingsStore.load().primaryDateProp ?? "due"
  );
}

// ── Library settings store (legacy, used when IPC not wired) ──────────────────

export interface ILibrarySettingsStore {
  load(): LibrarySettings;
  save(settings: LibrarySettings): void;
}

/** In-memory library settings (mock + tests; real impl uses _settings.md). */
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
  // Reset the in-memory cache so the new store is authoritative.
  librarySettingsCache = {};
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Reset the IPC wiring and caches (for tests only).
 * Restores the module to the state it has before any initSettingsFromIpc call.
 */
export function _resetSettingsForTest(): void {
  _ipc = null;
  userSettingsCache = {};
  userSettingsLoaded = false;
  librarySettingsCache = {};
}
