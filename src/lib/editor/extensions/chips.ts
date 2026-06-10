// Chips — layer 3 of design-0003 (issue #12).
//
// Widget decorations replace the literal spans for #tag, @mention, [[wikilink]]
// when the cursor is not inside them. When the cursor enters a chip range,
// cursor-reveal (layer 2) takes over and shows raw text; the chip layer produces
// no decoration for ranges the cursor touches so the two layers cooperate cleanly.
//
// Architecture choices (design-0003 §Chips, §Open questions):
//
//   - Reveal rule: adjacent-arrival (cursor lands adjacent → chip still shows;
//     only landing strictly inside the span reveals raw). "Adjacent" means the
//     cursor head is within [from, to] exclusive, i.e. the same predicate as
//     cursor-reveal's headInRange. This matches #11's atomicRanges behavior: the
//     atomic range stops the cursor at the boundary, so the cursor never sits
//     strictly inside a chip unless the user explicitly enters it with a gesture.
//     Ergonomics note recorded at the bottom of this file.
//
//   - Metadata cache: a simple Map<string, TagMeta | PersonMeta> refreshed at
//     mount (via ipc.tag_index / ipc.people_index) and on index_changed events.
//     Cache misses → default style chip; upgrade happens on the next metadata
//     refresh without reparse.
//
//   - Clicks: non-navigational on tag/mention (fires onTokenClick); wikilink
//     fires onNavigate(target). No actual navigation here.
//
//   - Wikilink resolution for the /dev demo uses the EntryId set passed in via
//     the `entryTitles` map. A miss renders the raw target with an "unresolved"
//     style.
//
// Precedence (design-0003): chips sit ABOVE cursor-reveal in the extension array.
// In CM6 earlier = higher precedence, so chips.ts's decorations override the
// plain mark that cursor-reveal would otherwise emit for the same range.
//
// Ergonomics note (open question from design-0003):
//   Adjacent-arrival means: arrowing from before a chip lands the cursor AT the
//   left boundary, which counts as "inside" via headInRange (inclusive). The chip
//   collapses to raw at that point. This gives direct edit access on a single
//   arrow press, which feels good for power users but may confuse casual ones
//   expecting a dedicated "enter" gesture. The adjacent-arrival model is easier
//   to implement correctly with atomic ranges (no phantom cursor-in-chip state).
//   The benchmark phase should compare against a gesture-based model where we
//   skip over chips atomically without revealing. For now this matches #11's
//   atomicRanges contract.

import { Decoration, EditorView, WidgetType, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, Facet } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

import { TAG_NODE, MENTION_NODE, WIKILINK_NODE } from "./inline-tokens.js";
import type { TagMeta, PersonMeta } from "../../ipc/types.js";
import type { Ipc } from "../../ipc/types.js";

// ── Public callbacks / config ────────────────────────────────────────────────

export interface ChipCallbacks {
  /** Fired when a tag or mention chip is clicked. Non-navigational. */
  onTokenClick?: (kind: "tag" | "mention", value: string) => void;
  /** Fired when a wikilink chip is clicked. */
  onNavigate?: (target: string) => void;
}

export interface ChipConfig extends ChipCallbacks {
  /** IPC facade (tag_index, people_index, on). */
  ipc: Ipc;
  /**
   * Map of entryId → title for wikilink resolution. Chips resolve the target
   * to a display title when the id is present; otherwise renders as unresolved.
   */
  entryTitles?: Map<string, string>;
}

// ── Metadata cache ────────────────────────────────────────────────────────────

export interface ChipMetaCache {
  tags: Map<string, TagMeta>;
  people: Map<string, PersonMeta>;
  /** Pre-resolved avatar URLs keyed by person slug. Populated async by the plugin. */
  avatarUrls?: Map<string, string>;
}

export function emptyCache(): ChipMetaCache {
  return { tags: new Map(), people: new Map() };
}

/** Build a cache from raw index results. Pure — no side effects. */
export function buildCache(tags: TagMeta[], people: PersonMeta[]): ChipMetaCache {
  return {
    tags: new Map(tags.map((t) => [t.name, t])),
    people: new Map(people.map((p) => [p.slug, p])),
  };
}

// ── Reveal predicate ─────────────────────────────────────────────────────────

/** True if any selection head lies within [from, to] (inclusive). */
function headInRange(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) {
    if (r.head >= from && r.head <= to) return true;
  }
  return false;
}

// ── Widget helpers ────────────────────────────────────────────────────────────

const COLOR_NAMES = ["slate", "red", "amber", "green", "teal", "blue", "violet", "pink"] as const;
type ColorName = (typeof COLOR_NAMES)[number];

function isColorName(s: string): s is ColorName {
  return (COLOR_NAMES as readonly string[]).includes(s);
}

function chipStyle(color: string): { fg: string; bg: string } {
  if (isColorName(color)) {
    return {
      fg: `var(--tnd-chip-${color}-fg, #333)`,
      bg: `var(--tnd-chip-${color}-bg, rgba(0,0,0,0.07))`,
    };
  }
  // Hex escape-hatch: render verbatim.
  return { fg: color, bg: `${color}22` };
}

// ── Tag chip ──────────────────────────────────────────────────────────────────

class TagChipWidget extends WidgetType {
  constructor(
    readonly slug: string,
    readonly meta: TagMeta | undefined,
    readonly onClick: ((slug: string) => void) | undefined,
  ) {
    super();
  }

  eq(other: TagChipWidget): boolean {
    return (
      this.slug === other.slug &&
      this.meta?.color === other.meta?.color &&
      this.meta?.name === other.meta?.name
    );
  }

  toDOM(): HTMLElement {
    const color = this.meta?.color ?? "slate";
    const { fg, bg } = chipStyle(color);

    const el = document.createElement("span");
    el.className = "cm-tnd-chip cm-tnd-chip-tag";
    el.style.color = fg;
    el.style.backgroundColor = bg;

    const label = document.createElement("span");
    label.className = "cm-tnd-chip-label";
    label.textContent = `#${this.slug}`;
    el.appendChild(label);

    if (this.onClick) {
      const slug = this.slug;
      const cb = this.onClick;
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        cb(slug);
      });
      el.style.cursor = "pointer";
    }

    return el;
  }

  ignoreEvent(): boolean {
    // Let mousedown fire so the click callback works.
    return false;
  }
}

// ── Mention chip ──────────────────────────────────────────────────────────────

class MentionChipWidget extends WidgetType {
  constructor(
    readonly slug: string,
    readonly meta: PersonMeta | undefined,
    readonly avatarSrc: string | undefined,
    readonly onClick: ((slug: string) => void) | undefined,
  ) {
    super();
  }

  eq(other: MentionChipWidget): boolean {
    return (
      this.slug === other.slug &&
      this.meta?.displayName === other.meta?.displayName &&
      this.avatarSrc === other.avatarSrc
    );
  }

  toDOM(): HTMLElement {
    // Use the person's color token when available, otherwise fall back to blue.
    const color = this.meta?.color ?? "blue";
    const { fg, bg } = chipStyle(color);

    const el = document.createElement("span");
    el.className = "cm-tnd-chip cm-tnd-chip-mention";
    el.style.color = fg;
    el.style.backgroundColor = bg;

    // Avatar / initial circle.
    const avatar = document.createElement("span");
    avatar.className = "cm-tnd-chip-avatar";
    avatar.style.backgroundColor = bg;
    avatar.style.color = fg;

    if (this.avatarSrc) {
      const img = document.createElement("img");
      img.className = "cm-tnd-chip-avatar-img";
      img.src = this.avatarSrc;
      img.alt = this.meta?.displayName ?? this.slug;
      // Broken-image fallback: hide img, show initial.
      img.addEventListener("error", () => {
        img.style.display = "none";
        const initial = document.createElement("span");
        initial.className = "cm-tnd-chip-avatar-initial";
        initial.textContent = (this.meta?.displayName ?? this.slug).charAt(0).toUpperCase();
        avatar.appendChild(initial);
      });
      avatar.appendChild(img);
    } else {
      const initial = document.createElement("span");
      initial.className = "cm-tnd-chip-avatar-initial";
      initial.textContent = (this.meta?.displayName ?? this.slug).charAt(0).toUpperCase();
      avatar.appendChild(initial);
    }

    el.appendChild(avatar);

    const label = document.createElement("span");
    label.className = "cm-tnd-chip-label";
    label.textContent = this.meta?.displayName ?? `@${this.slug}`;
    el.appendChild(label);

    if (this.onClick) {
      const slug = this.slug;
      const cb = this.onClick;
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        cb(slug);
      });
      el.style.cursor = "pointer";
    }

    return el;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// ── Wikilink chip ─────────────────────────────────────────────────────────────

class WikilinkChipWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly displayText: string | undefined,
    readonly resolved: boolean,
    readonly resolvedTitle: string | undefined,
    readonly onClick: ((target: string) => void) | undefined,
  ) {
    super();
  }

  eq(other: WikilinkChipWidget): boolean {
    return (
      this.target === other.target &&
      this.resolved === other.resolved &&
      this.resolvedTitle === other.resolvedTitle &&
      this.displayText === other.displayText
    );
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = this.resolved
      ? "cm-tnd-chip cm-tnd-chip-wikilink"
      : "cm-tnd-chip cm-tnd-chip-wikilink cm-tnd-chip-wikilink--unresolved";

    // Prefer explicit display text, then resolved title, then raw target.
    const label = this.displayText ?? this.resolvedTitle ?? this.target;
    const text = document.createElement("span");
    text.className = "cm-tnd-chip-label";
    text.textContent = label;
    el.appendChild(text);

    if (this.onClick) {
      const target = this.target;
      const cb = this.onClick;
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        cb(target);
      });
      el.style.cursor = "pointer";
    }

    return el;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// ── Core computation ──────────────────────────────────────────────────────────

export interface ComputeChipsOptions {
  cache: ChipMetaCache;
  entryTitles: Map<string, string>;
  callbacks: ChipCallbacks;
  ranges: readonly { from: number; to: number }[];
}

/**
 * Compute chip widget decorations for the given state over the supplied ranges.
 * Pure and DOM-free — unit-tested directly.
 *
 * For each custom token not touched by the cursor, emits a widget decoration
 * (replacing the token's span) plus a zero-length mark at the same position for
 * atomic cursor skip. The widget decoration IS the chip; it hides the raw text.
 */
export function computeChipDecorations(
  state: EditorState,
  opts: ComputeChipsOptions,
): DecorationSet {
  interface Pending {
    from: number;
    to: number;
    deco: import("@codemirror/view").Decoration;
  }
  const pending: Pending[] = [];
  const tree = syntaxTree(state);

  const { cache, entryTitles, callbacks, ranges } = opts;

  for (const { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        const name = node.name;
        if (name !== TAG_NODE && name !== MENTION_NODE && name !== WIKILINK_NODE) return;

        // Reveal raw when the cursor is inside the token range.
        if (headInRange(state, node.from, node.to)) return;

        const literal = state.doc.sliceString(node.from, node.to);

        if (name === TAG_NODE) {
          // Literal is `#slug`; value is the slug after `#`.
          const slug = literal.startsWith("#") ? literal.slice(1) : literal;
          const meta = cache.tags.get(slug);
          const widget = new TagChipWidget(
            slug,
            meta,
            callbacks.onTokenClick ? (s: string) => callbacks.onTokenClick!("tag", s) : undefined,
          );
          pending.push({
            from: node.from,
            to: node.to,
            deco: Decoration.replace({ widget, inclusive: false }),
          });
        } else if (name === MENTION_NODE) {
          // Literal is `@slug`.
          const slug = literal.startsWith("@") ? literal.slice(1) : literal;
          const meta = cache.people.get(slug);
          // avatarSrc is pre-resolved from PersonMeta.avatarPath by the plugin;
          // see ChipsPlugin.resolveAvatarUrls().
          const avatarSrc = cache.avatarUrls?.get(slug);
          const widget = new MentionChipWidget(
            slug,
            meta,
            avatarSrc,
            callbacks.onTokenClick
              ? (s: string) => callbacks.onTokenClick!("mention", s)
              : undefined,
          );
          pending.push({
            from: node.from,
            to: node.to,
            deco: Decoration.replace({ widget, inclusive: false }),
          });
        } else {
          // WIKILINK_NODE — literal is `[[target]]` or `[[target|display]]`.
          const inner = literal.slice(2, -2); // strip [[ and ]]
          const pipe = inner.indexOf("|");
          const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
          const displayText = pipe === -1 ? undefined : inner.slice(pipe + 1).trim() || undefined;
          const resolvedTitle = entryTitles.get(target);
          const resolved = resolvedTitle !== undefined;
          const widget = new WikilinkChipWidget(
            target,
            displayText,
            resolved,
            resolvedTitle,
            callbacks.onNavigate,
          );
          pending.push({
            from: node.from,
            to: node.to,
            deco: Decoration.replace({ widget, inclusive: false }),
          });
        }
      },
    });
  }

  pending.sort((a, b) => a.from - b.from || a.to - b.to);

  const builder = new RangeSetBuilder<import("@codemirror/view").Decoration>();
  for (const p of pending) builder.add(p.from, p.to, p.deco);
  return builder.finish();
}

// ── Facet for chip config ─────────────────────────────────────────────────────

/** Facet through which the chips ViewPlugin receives its config. */
export const chipConfig = Facet.define<ChipConfig, ChipConfig>({
  combine: (values) => values[values.length - 1] ?? { ipc: null as never },
});

// ── ViewPlugin ────────────────────────────────────────────────────────────────

class ChipsPlugin {
  decorations: DecorationSet;
  private cache: ChipMetaCache = emptyCache();
  private entryTitles: Map<string, string> = new Map();
  private unsubscribe: (() => void) | null = null;

  constructor(private view: EditorView) {
    this.decorations = Decoration.none;
    void this.refreshMetadata();
    this.subscribeToChanges();
    this.rebuild(view);
  }

  private getConfig(): ChipConfig {
    return this.view.state.facet(chipConfig);
  }

  private async refreshMetadata(): Promise<void> {
    const cfg = this.getConfig();
    if (!cfg?.ipc) return;
    try {
      const [tagResult, peopleResult, titlesResult] = await Promise.all([
        cfg.ipc.tag_index(),
        cfg.ipc.people_index(),
        cfg.ipc.entry_titles(),
      ]);
      const tags = tagResult.ok ? tagResult.value : [];
      const people = peopleResult.ok ? peopleResult.value : [];
      const newCache = buildCache(tags, people);

      // Resolve avatar URLs for people that have an avatarPath (async, best-effort).
      const avatarUrls = await this.resolveAvatarUrls(cfg, people);
      newCache.avatarUrls = avatarUrls;
      this.cache = newCache;

      // Merge IPC-loaded titles with any caller-supplied entryTitles override.
      if (titlesResult.ok) {
        const callerOverride = cfg.entryTitles ?? new Map<string, string>();
        const merged = new Map<string, string>(Object.entries(titlesResult.value));
        for (const [k, v] of callerOverride) merged.set(k, v);
        this.entryTitles = merged;
      }
    } catch {
      // On failure keep the previous cache — never block rendering.
    }
    // After metadata updates, rebuild decorations.
    // Use requestMeasure to schedule a safe re-render outside CM6's update cycle.
    this.view.requestMeasure({
      read: () => {},
      write: () => {
        this.rebuild(this.view);
      },
    });
  }

  /** Resolve avatarPath → object URL for each person that declares one. */
  private async resolveAvatarUrls(
    cfg: ChipConfig,
    people: PersonMeta[],
  ): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    if (!cfg.ipc) return urls;
    await Promise.all(
      people
        .filter((p) => p.avatarPath)
        .map(async (p) => {
          try {
            const res = await cfg.ipc.asset_url(p.avatarPath!);
            if (res.ok) urls.set(p.slug, res.value);
          } catch {
            // Broken avatar → keep initial fallback; do nothing.
          }
        }),
    );
    return urls;
  }

  private subscribeToChanges(): void {
    const cfg = this.getConfig();
    if (!cfg?.ipc) return;
    this.unsubscribe = cfg.ipc.on("index_changed", () => {
      void this.refreshMetadata();
    });
  }

  private rebuild(view: EditorView): void {
    const cfg = this.getConfig();
    this.decorations = computeChipDecorations(view.state, {
      cache: this.cache,
      entryTitles: this.entryTitles,
      callbacks: { onTokenClick: cfg?.onTokenClick, onNavigate: cfg?.onNavigate },
      ranges: view.visibleRanges,
    });
  }

  update(update: ViewUpdate): void {
    // Re-merge caller-supplied entryTitles override when the facet value changes.
    if (update.startState.facet(chipConfig) !== update.state.facet(chipConfig)) {
      const callerOverride = this.getConfig().entryTitles;
      if (callerOverride) {
        for (const [k, v] of callerOverride) this.entryTitles.set(k, v);
      }
    }
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
      this.rebuild(update.view);
    }
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

/**
 * The chips ViewPlugin. Must be listed BEFORE cursorReveal in the extension array
 * so chip widget decorations take precedence over the plain marks cursor-reveal
 * emits for the same token ranges (design-0003 §Decoration layers, layer 3).
 *
 * Install via:
 *
 *   extensions: [
 *     frontmatterFold,
 *     chips(config),   // layer 3 — above cursorReveal
 *     cursorReveal,    // layer 2
 *     ...
 *   ]
 */
export function chips(config: ChipConfig): import("@codemirror/state").Extension {
  return [
    chipConfig.of(config),
    ViewPlugin.fromClass(ChipsPlugin, {
      decorations: (plugin) => plugin.decorations,
      provide: (plugin) =>
        EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
    }),
    chipsTheme,
  ];
}

// ── CSS theme ─────────────────────────────────────────────────────────────────

export const chipsTheme = EditorView.baseTheme({
  ".cm-tnd-chip": {
    display: "inline-flex",
    alignItems: "center",
    gap: "3px",
    borderRadius: "4px",
    padding: "0 5px",
    fontSize: "0.88em",
    lineHeight: "1.5",
    verticalAlign: "baseline",
    whiteSpace: "nowrap",
    userSelect: "none",
  },
  ".cm-tnd-chip-avatar": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1.1em",
    height: "1.1em",
    borderRadius: "50%",
    overflow: "hidden",
    flexShrink: "0",
    fontSize: "0.75em",
    fontWeight: "600",
  },
  ".cm-tnd-chip-avatar-img": {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  ".cm-tnd-chip-avatar-initial": {
    lineHeight: "1",
  },
  ".cm-tnd-chip-wikilink": {
    textDecoration: "underline",
    textDecorationStyle: "dotted",
    textUnderlineOffset: "2px",
  },
  ".cm-tnd-chip-wikilink--unresolved": {
    opacity: "0.55",
    textDecorationStyle: "dashed",
  },
  ".cm-tnd-chip-label": {
    lineHeight: "inherit",
  },
});
