// Real IPC implementation — wraps @tauri-apps/api/core invoke calls.
//
// Only `core_version` is implemented today. Every other command returns
// NotImplemented referencing issue #30 (first-wave IPC scaffold).
//
// When Tauri generates bindings (tauri-specta or equivalent, design-0004
// §Interfaces), replace the invoke() calls here with the typed wrappers.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Ipc,
  Result,
  EntryContent,
  EntrySummary,
  TagMeta,
  PersonMeta,
  Backlink,
  Page,
  AssetPath,
  IpcEventName,
  IpcEventPayload,
  IpcUnsubscribe,
  IpcError,
} from "./types.js";

function notImplemented(command: string): IpcError {
  return {
    code: "not_implemented",
    message: `${command} is not yet implemented in the Rust core (issue #30)`,
    detail:
      "First-wave IPC surface (design-0004, issue #30). Will be implemented when the Rust core ships the corresponding handler.",
  };
}

function notImpl<T>(command: string): Promise<Result<T>> {
  return Promise.resolve({ ok: false, error: notImplemented(command) });
}

export const real: Ipc = {
  async core_version(): Promise<Result<string>> {
    try {
      const v = await invoke<string>("core_version");
      return { ok: true, value: v };
    } catch (e) {
      return {
        ok: false,
        error: {
          code: "io_error",
          message: String(e),
        },
      };
    }
  },

  read_entry(): Promise<Result<EntryContent>> {
    return notImpl("read_entry");
  },

  write_entry(): Promise<Result<{ selfToken: string }>> {
    return notImpl("write_entry");
  },

  search(): Promise<Result<Page<EntrySummary>>> {
    return notImpl("search");
  },

  tag_index(): Promise<Result<TagMeta[]>> {
    return notImpl("tag_index");
  },

  people_index(): Promise<Result<PersonMeta[]>> {
    return notImpl("people_index");
  },

  entries_in_group(): Promise<Result<Page<EntrySummary>>> {
    return notImpl("entries_in_group");
  },

  backlinks(): Promise<Result<Backlink[]>> {
    return notImpl("backlinks");
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
