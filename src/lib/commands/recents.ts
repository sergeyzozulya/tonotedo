// Recents store — tracks recently executed commands for palette promotion.
// Persisted in localStorage (ephemeral-ish; not as critical as settings).

const STORAGE_KEY = "tonotedo:recent-commands";
const MAX_RECENTS = 10;

let _cache: string[] | null = null;

function loadFromStorage(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveToStorage(ids: string[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
}

/** Get recent command ids, most-recent first. */
export function getRecents(): string[] {
  if (_cache === null) _cache = loadFromStorage();
  return [..._cache];
}

/** Record a command as recently used. */
export function recordRecent(commandId: string): void {
  if (_cache === null) _cache = loadFromStorage();
  // Remove existing entry, prepend, trim to max.
  _cache = [commandId, ..._cache.filter((id) => id !== commandId)].slice(0, MAX_RECENTS);
  saveToStorage(_cache);
}

/** Clear all recents (for tests). */
export function clearRecents(): void {
  _cache = [];
  saveToStorage([]);
}
