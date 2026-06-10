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
  Backlink,
  Page,
  AssetPath,
  Cursor,
  GroupPath,
  SearchQuery,
  IpcEventName,
  IpcEventPayload,
  IpcUnsubscribe,
  IpcError,
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

/** Typed not-implemented error for commands awaiting their Rust side (refs #30). */
function notImpl<T>(command: string): Promise<Result<T>> {
  return Promise.resolve({
    ok: false,
    error: {
      code: "not_implemented",
      message: `${command} is not implemented in the desktop backend yet (refs #30)`,
    },
  });
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

  // ── Asset commands (issue #13) — stubs, refs #30 ────────────────────────────

  attach_file(): Promise<Result<AssetPath>> {
    return notImpl("attach_file");
  },

  asset_url(): Promise<Result<string>> {
    return notImpl("asset_url");
  },

  asset_exists(): Promise<Result<boolean>> {
    return notImpl("asset_exists");
  },

  remove_asset(): Promise<Result<void>> {
    return notImpl("remove_asset");
  },

  async entry_titles(): Promise<Result<Record<string, string>>> {
    return call<Record<string, string>>("entry_titles");
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
