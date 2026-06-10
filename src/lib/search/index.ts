export { default as SearchOverlay } from "./SearchOverlay.svelte";
export { savedSearchesStore } from "./saved-searches-store.js";
export { parseQuery, matchesQuery, queryMatches } from "./query-parse.js";
export type { ParsedQuery } from "./query-parse.js";
export type { SavedSearch, SavedSearchFilter } from "../ipc/types.js";
