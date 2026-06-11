// saved-searches-store.ts — Svelte 5 reactive store for saved searches.
//
// Wraps ipc.saved_searches_get / saved_searches_set.
// Components read `savedSearchesStore.searches` reactively; call
// `savedSearchesStore.save(name, text, filters)` to persist a new entry and
// `savedSearchesStore.remove(name)` to delete one.

import { ipc } from "../ipc/index.js";
import type { SavedSearch, SavedSearchFilter } from "../ipc/types.js";

function createSavedSearchesStore() {
  let searches = $state<SavedSearch[]>([]);
  let loaded = $state(false);
  let error = $state<string | null>(null);

  async function load(): Promise<void> {
    const result = await ipc.saved_searches_get();
    if (result.ok) {
      searches = result.value;
    } else {
      error = result.error.message;
    }
    loaded = true;
  }

  async function save(name: string, text: string, filters: SavedSearchFilter[]): Promise<void> {
    const existing = searches.findIndex((s) => s.name === name);
    const entry: SavedSearch = { name, text, filters };
    const next =
      existing >= 0 ? searches.map((s, i) => (i === existing ? entry : s)) : [...searches, entry];
    const result = await ipc.saved_searches_set(next);
    if (result.ok) {
      searches = next;
    } else {
      error = result.error.message;
    }
  }

  async function remove(name: string): Promise<void> {
    const next = searches.filter((s) => s.name !== name);
    const result = await ipc.saved_searches_set(next);
    if (result.ok) {
      searches = next;
    } else {
      error = result.error.message;
    }
  }

  return {
    get searches() {
      return searches;
    },
    get loaded() {
      return loaded;
    },
    get error() {
      return error;
    },
    load,
    save,
    remove,
  };
}

export const savedSearchesStore = createSavedSearchesStore();
export type { SavedSearch, SavedSearchFilter };
