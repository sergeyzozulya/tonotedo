// Block layer: checkboxes, attachment blocks, image rendering, paste/drop.
//
// Design-0003 §Decoration layers, layer 4.
// Spec refs:
//   - docs/spec/0006-markdown-editor.md (authoritative for all block behaviors)
//   - docs/tech/design-0003-editor-extensions.md §Blocks
//
// --- Checkboxes ---
// GFM task list items (- [ ] / - [x]) render as interactive checkboxes via a
// widget decoration replacing the `[ ]` / `[x]` marker. Click dispatches a
// TEXT EDIT toggling the marker. This is CONTENT-ONLY per spec 0006:
//   "I check a `- [ ]` checkbox; the change persists to the body like any other
//    edit. Checkboxes are content; the entry-level `done` property is separate."
// NO done-property coupling occurs here; that is a separate concern.
//
// --- Attachment blocks ---
// A markdown link whose href starts with `_assets/` and is NOT an image
// extension renders as a compact attachment block (file-type glyph + name).
// Cursor-adjacent reveals the raw markdown (via the shared `headInRange`
// predicate exported here).
// Click → onOpenAttachment(path) callback.
// Broken state (asset_exists → false) → broken styling + onAttachmentAction
// callback with 'relink' | 'remove'. The DELETE action (file + link removal,
// confirmed) is EMITTED upward, never performed inside the editor.
//
// --- Images ---
// `_assets/` image links render inline via facade asset_url (object URL in
// mock). Broken image (asset_exists → false) → placeholder widget showing path.
//
// --- Paste / Drop ---
// Image paste → attach_file → insert `![name](_assets/...)`.
// File drop → attach_file → insert `[name](_assets/...)`.
// Both work fully in-browser against the mock facade.
//
// --- Cursor-reveal interaction ---
// A shared predicate `isAdjacentToHead(state, from, to)` (the same "touch"
// semantics as cursor-reveal layer 2) gates all widget replacements: when the
// selection head is inside or adjacent to the raw link syntax, the widget is
// suppressed so cursor-reveal shows the raw text.

import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import type { Ipc } from "../../ipc/types.js";
import { settings_get_library } from "../../commands/settings.js";

// ── Asset folder name (library setting, default "_assets") ───────────────────

/** Return the configured asset folder name (without trailing slash). */
function assetFolderName(): string {
  return settings_get_library("assetFolder") ?? "_assets";
}

// ── Image extension set ───────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg"]);

/** True iff the path's extension is one of the inline-image types. */
export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return IMAGE_EXTS.has(path.slice(dot + 1).toLowerCase());
}

/** True iff path is an asset-folder link that should render as an attachment block. */
export function isAttachmentPath(path: string): boolean {
  const folder = assetFolderName();
  return path.startsWith(`${folder}/`) && !isImagePath(path);
}

// ── Cursor-adjacency predicate ────────────────────────────────────────────────

/**
 * True if any selection head lies within [from, to] (inclusive). Identical
 * semantics to headInRange in cursor-reveal (layer 2) — used to suppress block
 * widgets so the raw markdown shows when the cursor enters a link.
 *
 * Exported so tests can reference it directly.
 */
export function headInRange(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) {
    if (r.head >= from && r.head <= to) return true;
  }
  return false;
}

// ── Checkbox widget ───────────────────────────────────────────────────────────

/**
 * A checkbox WidgetType that replaces the `[ ]` or `[x]` GFM task marker.
 * Click dispatches a text edit in the view (content-only, no done-property
 * coupling per spec 0006).
 */
class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly markerFrom: number,
    readonly markerTo: number,
  ) {
    super();
  }

  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("input");
    el.type = "checkbox";
    el.checked = this.checked;
    el.className = "cm-tnd-checkbox";
    el.setAttribute("aria-label", this.checked ? "checked task" : "unchecked task");

    el.addEventListener("click", (e) => {
      e.preventDefault();
      toggleCheckbox(view, this.markerFrom, this.markerTo, this.checked);
    });

    return el;
  }

  ignoreEvent(e: Event): boolean {
    // Let the click through to our listener; ignore other events.
    return e.type !== "click";
  }
}

/**
 * Dispatch a text edit that toggles the checkbox marker between `[ ]` and `[x]`.
 * This is a CONTENT-ONLY edit per spec 0006 — no done-property coupling.
 *
 * Exported for use by keyboard commands (issue #7 / spec 0007).
 */
export function toggleCheckbox(
  view: EditorView,
  markerFrom: number,
  markerTo: number,
  currentlyChecked: boolean,
): boolean {
  const newMarker = currentlyChecked ? "[ ]" : "[x]";
  view.dispatch({
    changes: { from: markerFrom, to: markerTo, insert: newMarker },
    // Keep the cursor where it is; this is a content-only mutation.
    userEvent: "checkbox.toggle",
  });
  return true;
}

// ── Attachment block widget ───────────────────────────────────────────────────

/** Compact attachment block: file-type glyph + filename. */
class AttachmentWidget extends WidgetType {
  constructor(
    readonly path: string,
    readonly broken: boolean,
    readonly callbacks: BlockCallbacks,
  ) {
    super();
  }

  eq(other: AttachmentWidget): boolean {
    return other.path === this.path && other.broken === this.broken;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = this.broken
      ? "cm-tnd-attachment cm-tnd-attachment--broken"
      : "cm-tnd-attachment";
    el.setAttribute("aria-label", `attachment: ${fileName(this.path)}`);

    const glyph = document.createElement("span");
    glyph.className = "cm-tnd-attachment-glyph";
    glyph.textContent = this.broken ? "⚠" : fileGlyph(this.path);

    const name = document.createElement("span");
    name.className = "cm-tnd-attachment-name";
    name.textContent = fileName(this.path);

    el.appendChild(glyph);
    el.appendChild(name);

    if (this.broken) {
      const relink = document.createElement("button");
      relink.className = "cm-tnd-attachment-action";
      relink.textContent = "Relink…";
      relink.addEventListener("click", (e) => {
        e.stopPropagation();
        this.callbacks.onAttachmentAction?.(this.path, "relink");
      });

      const remove = document.createElement("button");
      remove.className = "cm-tnd-attachment-action cm-tnd-attachment-action--remove";
      remove.textContent = "Remove link";
      remove.addEventListener("click", (e) => {
        e.stopPropagation();
        this.callbacks.onAttachmentAction?.(this.path, "remove");
      });

      el.appendChild(relink);
      el.appendChild(remove);
    } else {
      el.addEventListener("click", () => {
        this.callbacks.onOpenAttachment?.(this.path);
      });
      el.style.cursor = "pointer";
    }

    return el;
  }

  ignoreEvent(): boolean {
    // We handle click ourselves.
    return false;
  }
}

function fileName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

function fileGlyph(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
  const map: Record<string, string> = {
    pdf: "📄",
    doc: "📝",
    docx: "📝",
    xls: "📊",
    xlsx: "📊",
    ppt: "📊",
    pptx: "📊",
    zip: "🗜",
    tar: "🗜",
    gz: "🗜",
    txt: "📃",
    csv: "📊",
    mp3: "🎵",
    mp4: "🎬",
    mov: "🎬",
  };
  return map[ext] ?? "📎";
}

// ── Image widget ──────────────────────────────────────────────────────────────

/** Inline image widget: renders the asset as an <img>. */
class ImageWidget extends WidgetType {
  constructor(
    readonly path: string,
    readonly url: string,
    readonly alt: string,
    readonly broken: boolean,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return other.path === this.path && other.url === this.url && other.broken === this.broken;
  }

  toDOM(): HTMLElement {
    if (this.broken) {
      const el = document.createElement("span");
      el.className = "cm-tnd-image-broken";
      el.textContent = `[broken image: ${fileName(this.path)}]`;
      return el;
    }

    const img = document.createElement("img");
    img.src = this.url;
    img.alt = this.alt || fileName(this.path);
    img.className = "cm-tnd-image";
    img.style.maxWidth = "100%";
    img.style.display = "block";
    img.style.margin = "0.25em 0";
    return img;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

// ── Callbacks surface ─────────────────────────────────────────────────────────

export interface AttachmentAction {
  path: string;
  action: "relink" | "remove";
}

/** Callbacks the editor surface exposes for block interactions. */
export interface BlockCallbacks {
  /** Called when the user clicks a non-broken attachment block. Desktop: OS-open. */
  onOpenAttachment?: (path: string) => void;
  /**
   * Called when the user clicks "Relink…" or "Remove link" on a broken
   * attachment. The action itself (file removal + link removal) is NOT
   * performed inside the editor — it is delegated upward.
   */
  onAttachmentAction?: (path: string, action: "relink" | "remove") => void;
}

// ── Asset state: existence + URL cache ───────────────────────────────────────

/**
 * Result of a resolved asset check. The blocks ViewPlugin populates this
 * asynchronously and triggers a re-render via forceUpdate when done.
 */
interface AssetState {
  exists: boolean;
  /** Set for image assets that exist: the object / asset-protocol URL. */
  url?: string;
}

// ── Block decoration computation ──────────────────────────────────────────────

/**
 * Walk the Lezer tree looking for GFM task-list items and _assets/ image/link
 * nodes. Returns the raw link specs to be resolved.
 */
interface CheckboxSpec {
  kind: "checkbox";
  checked: boolean;
  markerFrom: number;
  markerTo: number;
  /** The range that should be replaced by the widget (same as marker range). */
  from: number;
  to: number;
}

interface LinkSpec {
  kind: "image" | "attachment";
  /** The path extracted from the link href, relative to the entry. */
  path: string;
  alt: string;
  /** Full link range in the document — replaced by the widget. */
  from: number;
  to: number;
}

type BlockSpec = CheckboxSpec | LinkSpec;

/**
 * Extract block specs from the Lezer tree over the given ranges.
 * Pure state scan — no async, no DOM.
 */
export function extractBlockSpecs(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): BlockSpec[] {
  const specs: BlockSpec[] = [];
  const tree = syntaxTree(state);

  for (const { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        // ── GFM task list checkboxes ─────────────────────────────────────────
        // Lezer GFM emits a `TaskMarker` node for `[ ]` / `[x]`.
        if (node.name === "TaskMarker") {
          const text = state.doc.sliceString(node.from, node.to);
          const checked = text === "[x]" || text === "[X]";
          specs.push({
            kind: "checkbox",
            checked,
            markerFrom: node.from,
            markerTo: node.to,
            from: node.from,
            to: node.to,
          });
          return false;
        }

        // ── Images and attachment links ─────────────────────────────────────
        // Image syntax: `![alt](url)` → Lezer emits `Image` with a `URL` child.
        // Link syntax:  `[text](url)` → Lezer emits `Link` with a `URL` child.
        if (node.name === "Image" || node.name === "Link") {
          const nodeFrom = node.from;
          const nodeTo = node.to;
          let urlFrom = -1;
          let urlTo = -1;
          let altText = "";

          // Walk children to find URL node and alt/label text.
          node.node.cursor().iterate((child) => {
            if (child.name === "URL") {
              urlFrom = child.from;
              urlTo = child.to;
            }
            // For images the alt is inside `[...]`; for links it's the label.
          });

          if (urlFrom === -1) return false;

          const href = state.doc.sliceString(urlFrom, urlTo);

          // Only handle asset-folder links.
          if (!href.startsWith(`${assetFolderName()}/`)) return false;

          if (node.name === "Image") {
            // Extract alt text: between `![` and `](`.
            const raw = state.doc.sliceString(nodeFrom, nodeTo);
            const altMatch = /^!\[([^\]]*)]/.exec(raw);
            altText = altMatch ? altMatch[1] : "";

            specs.push({
              kind: "image",
              path: href,
              alt: altText,
              from: nodeFrom,
              to: nodeTo,
            });
          } else {
            // Attachment link — only non-image extensions.
            if (!isAttachmentPath(href)) return false;
            specs.push({
              kind: "attachment",
              path: href,
              alt: "",
              from: nodeFrom,
              to: nodeTo,
            });
          }
          return false;
        }
      },
    });
  }

  return specs;
}

// ── ViewPlugin ────────────────────────────────────────────────────────────────

/**
 * Build block decorations from the extracted specs + resolved asset states.
 * Pure — no async, no DOM side effects.
 */
function buildDecorations(
  state: EditorState,
  specs: BlockSpec[],
  assetStates: Map<string, AssetState>,
  callbacks: BlockCallbacks,
): DecorationSet {
  // Must add decorations in ascending order.
  const sorted = specs.slice().sort((a, b) => a.from - b.from);
  const builder = new RangeSetBuilder<Decoration>();

  for (const spec of sorted) {
    // Suppress the widget when the cursor touches the raw syntax (cursor-reveal
    // will show the raw text instead).
    if (headInRange(state, spec.from, spec.to)) continue;

    if (spec.kind === "checkbox") {
      const widget = new CheckboxWidget(spec.checked, spec.markerFrom, spec.markerTo);
      builder.add(spec.from, spec.to, Decoration.replace({ widget, side: -1 }));
    } else if (spec.kind === "image") {
      const assetState = assetStates.get(spec.path);
      if (!assetState) continue; // still loading — skip until resolved
      const widget = new ImageWidget(spec.path, assetState.url ?? "", spec.alt, !assetState.exists);
      // Images are block-level: replace the entire link syntax with a block widget.
      builder.add(spec.from, spec.to, Decoration.replace({ widget, block: false }));
    } else {
      // attachment
      const assetState = assetStates.get(spec.path);
      if (!assetState) continue; // still loading
      const widget = new AttachmentWidget(spec.path, !assetState.exists, callbacks);
      builder.add(spec.from, spec.to, Decoration.replace({ widget, side: -1 }));
    }
  }

  return builder.finish();
}

/**
 * Create the blocks ViewPlugin given an IPC facade and callback surface.
 *
 * The plugin:
 *   1. Scans the visible ranges for block specs on every update.
 *   2. Resolves asset existence / URL asynchronously (per unique path).
 *   3. Rebuilds decorations when resolutions arrive.
 */
export function blocksPlugin(ipc: Ipc, callbacks: BlockCallbacks = {}): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      /** Latest specs extracted from the tree. */
      private specs: BlockSpec[] = [];
      /** Resolved asset states keyed by path. */
      private assetStates = new Map<string, AssetState>();
      /** Paths currently being resolved (avoid duplicate in-flight requests). */
      private resolving = new Set<string>();

      constructor(view: EditorView) {
        this.decorations = Decoration.none;
        this.refresh(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.refresh(update.view);
        }
      }

      private refresh(view: EditorView) {
        this.specs = extractBlockSpecs(view.state, view.visibleRanges);
        this.resolveAssets(view);
        this.decorations = buildDecorations(view.state, this.specs, this.assetStates, callbacks);
      }

      private resolveAssets(view: EditorView) {
        const linkSpecs = this.specs.filter((s): s is LinkSpec => s.kind !== "checkbox");
        for (const spec of linkSpecs) {
          if (this.assetStates.has(spec.path)) continue;
          if (this.resolving.has(spec.path)) continue;

          this.resolving.add(spec.path);
          const path = spec.path;
          const kind = spec.kind;

          ipc.asset_exists(path).then((res) => {
            if (!res.ok || !res.value) {
              this.assetStates.set(path, { exists: false });
              this.resolving.delete(path);
              this.forceUpdate(view);
              return;
            }

            if (kind === "image") {
              ipc.asset_url(path).then((urlRes) => {
                const url = urlRes.ok ? urlRes.value : "";
                this.assetStates.set(path, { exists: true, url });
                this.resolving.delete(path);
                this.forceUpdate(view);
              });
            } else {
              this.assetStates.set(path, { exists: true });
              this.resolving.delete(path);
              this.forceUpdate(view);
            }
          });
        }
      }

      private forceUpdate(view: EditorView) {
        // Rebuild decorations using current specs + newly resolved states.
        // Dispatch a null transaction to cause a re-render.
        if (view.state) {
          this.decorations = buildDecorations(view.state, this.specs, this.assetStates, callbacks);
          // Request a view measure to apply the updated decorations.
          view.requestMeasure();
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      provide: (plugin) =>
        EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
    },
  );
}

// ── Paste / Drop handlers ─────────────────────────────────────────────────────

/**
 * Build a CM6 `domEventHandlers` extension that handles:
 *   - `paste` events containing images → attach_file → insert `![name](path)`
 *   - `drop` events containing files  → attach_file → insert `[name](path)` or
 *     `![name](path)` depending on whether it's an image.
 *
 * The `entryPath` prop is reactive: pass a getter so the handler always uses
 * the currently-open entry's path (needed because the Editor mounts once but
 * can display different entries).
 */
export function pasteDropHandlers(ipc: Ipc, getEntryPath: () => string): Extension {
  async function handleFile(
    view: EditorView,
    name: string,
    bytes: Uint8Array,
    insertPos: number,
  ): Promise<void> {
    const entryPath = getEntryPath();
    const res = await ipc.attach_file(entryPath, name, bytes);
    if (!res.ok) {
      console.warn("[blocks] attach_file failed:", res.error.message);
      return;
    }
    const assetPath = res.value;
    const isImage = isImagePath(name);
    const markdown = isImage ? `![${name}](${assetPath})` : `[${name}](${assetPath})`;

    view.dispatch({
      changes: { from: insertPos, to: insertPos, insert: markdown + "\n" },
      userEvent: isImage ? "paste.image" : "drop.file",
    });
  }

  const handlers: Parameters<typeof EditorView.domEventHandlers>[0] = {
    paste(event: ClipboardEvent, view: EditorView): boolean | void {
      const items = event.clipboardData?.items;
      if (!items) return;

      let hasImage = false;
      for (const item of Array.from(items)) {
        if (!item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (!file) continue;
        hasImage = true;
        event.preventDefault();

        const name = file.name || `pasted-image-${Date.now()}.png`;
        const pos = view.state.selection.main.head;

        file
          .arrayBuffer()
          .then((buf) => handleFile(view, name, new Uint8Array(buf), pos))
          .catch((err) => console.warn("[blocks] paste failed:", err));
      }

      return hasImage || undefined;
    },

    drop(event: DragEvent, view: EditorView): boolean | void {
      const files = event.dataTransfer?.files;
      if (!files?.length) return;

      event.preventDefault();

      // Insert at the drop position.
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.doc.length;

      for (const file of Array.from(files)) {
        file
          .arrayBuffer()
          .then((buf) => handleFile(view, file.name, new Uint8Array(buf), pos))
          .catch((err) => console.warn("[blocks] drop failed:", err));
      }

      return true;
    },
  };

  return EditorView.domEventHandlers(handlers);
}

// ── Theme styles ──────────────────────────────────────────────────────────────

const v = (name: string, fallback: string) => `var(--tnd-${name}, ${fallback})`;

/**
 * Base theme for block decorations. Compose into the editor's theme bundle.
 */
export const blocksTheme = EditorView.baseTheme({
  // Checkbox
  ".cm-tnd-checkbox": {
    verticalAlign: "middle",
    marginRight: "0.35em",
    cursor: "pointer",
    accentColor: v("accent", "#2563eb"),
  },

  // Attachment block
  ".cm-tnd-attachment": {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.3em",
    padding: "0.1em 0.5em",
    borderRadius: "4px",
    border: `1px solid ${v("line-strong", "#ccc")}`,
    backgroundColor: v("panel2", "#f5f5f5"),
    fontSize: "0.85em",
    userSelect: "none",
  },
  ".cm-tnd-attachment--broken": {
    borderColor: v("chip-red-fg", "#c0392b"),
    color: v("chip-red-fg", "#c0392b"),
    backgroundColor: v("chip-red-bg", "rgba(192,57,43,0.08)"),
  },
  ".cm-tnd-attachment-glyph": {
    fontSize: "1em",
  },
  ".cm-tnd-attachment-name": {
    fontFamily: v("editor-code-font", "ui-monospace, SFMono-Regular, Menlo, monospace"),
    fontSize: "0.9em",
  },
  ".cm-tnd-attachment-action": {
    marginLeft: "0.4em",
    fontSize: "0.78em",
    padding: "0.1em 0.4em",
    border: `1px solid ${v("line-strong", "#ccc")}`,
    borderRadius: "3px",
    background: "transparent",
    cursor: "pointer",
    color: "inherit",
  },
  ".cm-tnd-attachment-action--remove": {
    color: v("chip-red-fg", "#c0392b"),
    borderColor: v("chip-red-fg", "#c0392b"),
  },

  // Inline image
  ".cm-tnd-image": {
    maxWidth: "100%",
    display: "block",
    margin: "0.25em 0",
    borderRadius: "4px",
  },
  ".cm-tnd-image-broken": {
    display: "inline-block",
    padding: "0.2em 0.5em",
    borderRadius: "3px",
    border: `1px dashed ${v("chip-red-fg", "#c0392b")}`,
    color: v("text-muted", "#666"),
    fontSize: "0.85em",
    fontStyle: "italic",
  },
});
