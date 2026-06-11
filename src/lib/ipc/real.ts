// Real IPC implementation — wraps @tauri-apps/api/core invoke calls.
//
// Command signatures match the Rust handlers in src-tauri/src/ipc/mod.rs.
// Field names that are camelCase in types.ts are mapped by serde renames on
// the Rust side, so the JSON payloads already arrive in the right shape.
//
// tauri-specta codegen is DEFERRED (see ipc/mod.rs §"tauri-specta decision").
// When it lands, replace the invoke() calls with the generated typed wrappers.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Ipc,
  Result,
  EntryContent,
  EntryId,
  EntrySummary,
  TagMeta,
  PersonMeta,
  GroupMeta,
  Backlink,
  Page,
  AssetPath,
  Cursor,
  GroupPath,
  SearchQuery,
  SavedSearch,
  PersonInput,
  IpcEventName,
  IpcEventPayload,
  IpcUnsubscribe,
  IpcError,
  CalendarWindowResult,
  TrashManifest,
  TrashOpResult,
  RestoreResult,
  PluginInfo,
} from "./types.js";

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Wrap an invoke call in a typed Result.
 *
 * Tauri commands that return `Result<T, IpcError>` in Rust serialize as:
 *   - success:  the `T` value directly (Tauri unwraps Ok)
 *   - failure:  a thrown error whose `.message` is JSON-serialized IpcError
 *
 * We catch the thrown error and parse it back into our Result<T> shape.
 */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<Result<T>> {
  try {
    const value = await invoke<T>(command, args);
    return { ok: true, value };
  } catch (raw) {
    // Tauri serializes command errors as JSON strings in the thrown error message.
    const message = raw instanceof Error ? raw.message : String(raw);
    try {
      const parsed = JSON.parse(message) as IpcError;
      return { ok: false, error: parsed };
    } catch {
      return {
        ok: false,
        error: { code: "io_error", message },
      };
    }
  }
}

// ── IPC implementation ────────────────────────────────────────────────────────

export const real: Ipc = {
  async core_version(): Promise<Result<string>> {
    return call<string>("core_version");
  },

  async read_entry(id: EntryId): Promise<Result<EntryContent>> {
    return call<EntryContent>("read_entry", { id });
  },

  async write_entry(
    id: EntryId,
    text: string,
    selfToken: string,
  ): Promise<Result<{ selfToken: string }>> {
    return call<{ selfToken: string }>("write_entry", { id, text, selfToken });
  },

  async search(query: SearchQuery): Promise<Result<Page<EntrySummary>>> {
    return call<Page<EntrySummary>>("search", { query });
  },

  async tag_index(): Promise<Result<TagMeta[]>> {
    return call<TagMeta[]>("tag_index");
  },

  async people_index(): Promise<Result<PersonMeta[]>> {
    return call<PersonMeta[]>("people_index");
  },

  async entries_in_group(group: GroupPath, cursor?: Cursor): Promise<Result<Page<EntrySummary>>> {
    return call<Page<EntrySummary>>("entries_in_group", { group, cursor });
  },

  async backlinks(id: EntryId): Promise<Result<Backlink[]>> {
    return call<Backlink[]>("backlinks", { id });
  },

  // ── Asset commands (issue #13) ───────────────────────────────────────────────

  async attach_file(
    entryPath: string,
    name: string,
    bytes: Uint8Array,
  ): Promise<Result<AssetPath>> {
    return call<AssetPath>("attach_file", { entryPath, name, bytes: Array.from(bytes) });
  },

  async asset_url(assetPath: AssetPath): Promise<Result<string>> {
    return call<string>("asset_url", { assetPath });
  },

  async asset_exists(assetPath: AssetPath): Promise<Result<boolean>> {
    return call<boolean>("asset_exists", { assetPath });
  },

  async remove_asset(assetPath: AssetPath): Promise<Result<void>> {
    return call<void>("remove_asset", { assetPath });
  },

  async entry_titles(): Promise<Result<Record<string, string>>> {
    return call<Record<string, string>>("entry_titles");
  },

  async list_groups(): Promise<Result<GroupMeta[]>> {
    return call<GroupMeta[]>("list_groups");
  },

  // ── Group schema (phase 6 / issue #28) ───────────────────────────────────────

  async effective_schema(groupPath: string): Promise<Result<string | null>> {
    return call<string | null>("effective_schema", { groupPath });
  },

  // ── Saved searches (spec 0009) ───────────────────────────────────────────────

  async saved_searches_get(): Promise<Result<SavedSearch[]>> {
    return call<SavedSearch[]>("saved_searches_get");
  },

  async saved_searches_set(searches: SavedSearch[]): Promise<Result<void>> {
    return call<void>("saved_searches_set", { searches });
  },

  // ── People mutation commands (issue #22) ─────────────────────────────────────

  async set_person(person: PersonInput): Promise<Result<void>> {
    return call<void>("set_person", { person });
  },

  async delete_person(slug: string): Promise<Result<void>> {
    return call<void>("delete_person", { slug });
  },

  async mentions_for(slug: string): Promise<Result<EntrySummary[]>> {
    return call<EntrySummary[]>("mentions_for", { slug });
  },

  // ── Tag mutation commands (issue #22) ────────────────────────────────────────

  async rename_tag(oldName: string, newName: string): Promise<Result<void>> {
    return call<void>("rename_tag", { oldName, newName });
  },

  async merge_tag(sourceTag: string, targetTag: string): Promise<Result<void>> {
    return call<void>("merge_tag", { sourceTag, targetTag });
  },

  async delete_tag(name: string): Promise<Result<void>> {
    return call<void>("delete_tag", { name });
  },

  // ── Group mutation commands (phase 6) ────────────────────────────────────────

  async create_group(path: GroupPath): Promise<Result<void>> {
    return call<void>("create_group", { path });
  },

  async rename_group(oldPath: GroupPath, newName: string): Promise<Result<void>> {
    return call<void>("rename_group", { oldPath, newName });
  },

  async move_group(srcPath: GroupPath, dstParent: GroupPath): Promise<Result<void>> {
    return call<void>("move_group", { srcPath, dstParent });
  },

  async move_entry(path: string, dstGroup: GroupPath): Promise<Result<void>> {
    return call<void>("move_entry", { path, dstGroup });
  },

  async rename_entry(path: string, newSlug: string): Promise<Result<string>> {
    return call<string>("rename_entry", { path, newSlug });
  },

  // ── Trash commands (phase 6) ──────────────────────────────────────────────────

  async trash_entry(path: string): Promise<Result<TrashOpResult>> {
    return call<TrashOpResult>("ipc_trash_entry", { path });
  },

  async trash_group(path: GroupPath): Promise<Result<TrashOpResult>> {
    return call<TrashOpResult>("ipc_trash_group", { path });
  },

  async trash_list(): Promise<Result<TrashManifest[]>> {
    return call<TrashManifest[]>("trash_list");
  },

  async trash_restore(id: string): Promise<Result<RestoreResult>> {
    return call<RestoreResult>("trash_restore", { id });
  },

  async trash_purge(id: string): Promise<Result<void>> {
    return call<void>("trash_purge", { id });
  },

  // ── Calendar facade (issue #21) ───────────────────────────────────────────────

  async calendar_window(
    from: string,
    to: string,
    group?: string,
  ): Promise<Result<CalendarWindowResult>> {
    return call<CalendarWindowResult>("calendar_window", { from, to, group });
  },

  // ── Plugins (issue #25) ────────────────────────────────────────────────────

  async plugins_list(): Promise<Result<PluginInfo[]>> {
    return call<PluginInfo[]>("plugins_list");
  },

  async plugins_reload(): Promise<Result<PluginInfo[]>> {
    return call<PluginInfo[]>("plugins_reload");
  },

  async plugins_set_grant(plugin: string, perm: string, granted: boolean): Promise<Result<void>> {
    return call<void>("plugins_set_grant", { plugin, perm, granted });
  },

  async plugins_invoke_command(
    plugin: string,
    commandId: string,
    argsJson: string,
  ): Promise<Result<string>> {
    // Rust arg names are snake_case: command_id, args_json.
    return call<string>("plugins_invoke_command", {
      plugin,
      commandId,
      argsJson,
    });
  },

  on<E extends IpcEventName>(
    event: E,
    handler: (payload: IpcEventPayload<E>) => void,
  ): IpcUnsubscribe {
    // listen() is async; we store the unlisten promise and call it on cleanup.
    const unlistenP = listen<IpcEventPayload<E>>(event, (e) => handler(e.payload));
    return () => {
      unlistenP
        .then((unlisten) => unlisten())
        .catch(() => {
          // best-effort cleanup
        });
    };
  },
};
