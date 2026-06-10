// Tag utilities — pure logic for building the tag hierarchy tree and
// classifying tags (spec 0004, issue #22).
//
// RESPONSIBILITIES:
//   buildTagTree     — flat TagMeta[] → nested TagNode tree (parent/child via "/")
//   isNonCanonical   — flags tags with disallowed characters
//
// Hierarchy rules (spec 0004 §Hierarchy):
//   "parent/child" is a display convention. The tag string is the identity.
//   Metadata is per exact tag string — parent metadata is NOT inherited.
//   If "project" has no TagMeta entry but "project/atlas" does, "project" is
//   synthesised as a virtual parent node with count=0 and no metadata.
//
// No DOM, no IPC — pure functions; testable without Svelte.

import type { TagMeta } from "../ipc/types.js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface TagNode {
  /** Full tag name (e.g. "project/atlas"). */
  name: string;
  /** The last segment for display (e.g. "atlas"). */
  label: string;
  /** Depth in the hierarchy (0 = root). */
  depth: number;
  /** Metadata if this exact tag was in the TagMeta[] list. */
  meta?: TagMeta;
  /** Synthesised = true when a parent node has no TagMeta entry of its own. */
  synthesised: boolean;
  /** Child tag nodes (sorted alphabetically by label). */
  children: TagNode[];
}

/**
 * Build a nested tag tree from a flat TagMeta[] list.
 *
 * Parent nodes that are not in the flat list are synthesised automatically
 * with no metadata and count=0.  Children are sorted alphabetically.
 */
export function buildTagTree(tags: TagMeta[]): TagNode[] {
  // Index by exact name.
  const byName = new Map<string, TagMeta>(tags.map((t) => [t.name, t]));

  // Collect all names, including synthesised intermediates.
  const allNames = new Set<string>();
  for (const t of tags) {
    allNames.add(t.name);
    const parts = t.name.split("/");
    for (let i = 1; i < parts.length; i++) {
      allNames.add(parts.slice(0, i).join("/"));
    }
  }

  // Build node map.
  const nodeMap = new Map<string, TagNode>();

  function ensureNode(name: string): TagNode {
    if (nodeMap.has(name)) return nodeMap.get(name)!;
    const label = name.split("/").at(-1) ?? name;
    const meta = byName.get(name);
    const node: TagNode = {
      name,
      label,
      depth: name.split("/").length - 1,
      meta,
      synthesised: !meta,
      children: [],
    };
    nodeMap.set(name, node);
    return node;
  }

  for (const name of allNames) {
    ensureNode(name);
  }

  // Wire parent → child relationships.
  const roots: TagNode[] = [];
  for (const [name, node] of nodeMap) {
    const lastSlash = name.lastIndexOf("/");
    if (lastSlash === -1) {
      roots.push(node);
    } else {
      const parentName = name.slice(0, lastSlash);
      const parent = ensureNode(parentName);
      parent.children.push(node);
    }
  }

  // Sort children alphabetically by label at all levels.
  function sortTree(nodes: TagNode[]): TagNode[] {
    nodes.sort((a, b) => a.label.localeCompare(b.label));
    for (const n of nodes) sortTree(n.children);
    return nodes;
  }

  return sortTree(roots);
}

/**
 * Flatten a tag tree to a preorder sequence (parent before children).
 * Useful for rendering as an indented list.
 */
export function flattenTagTree(roots: TagNode[]): TagNode[] {
  const result: TagNode[] = [];
  function visit(node: TagNode): void {
    result.push(node);
    for (const child of node.children) visit(child);
  }
  for (const root of roots) visit(root);
  return result;
}

/**
 * Returns true if the tag name contains characters outside the canonical set
 * (letters, digits, `-`, `_`, `/`) — spec 0004 §Edge cases "non-canonical".
 */
export function isNonCanonical(name: string): boolean {
  return /[^a-zA-Z0-9\-_/]/.test(name);
}
