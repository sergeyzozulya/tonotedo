// Group tree builder (spec 0003).
//
// Takes a flat list of GroupMeta (vault-relative paths) and builds a tree for
// the sidebar.  Ordering rules (0003):
//   1. Nodes with an explicit `order` value sort first, ascending by order value.
//   2. Ties on `order` break alphabetically by name.
//   3. Nodes without `order` sort alphabetically by name after all ordered nodes.
//
// The `count` on a tree node is the sum of direct entries plus all descendant
// entries (aggregated bottom-up from the flat list's per-group counts).

import type { GroupMeta } from "../ipc/types.js";

export interface GroupNode {
  /** Full vault-relative path, e.g. "work/atlas". */
  path: string;
  /** Display name (last path segment or _group.md name). */
  name: string;
  /** Aggregated entry count: this group + all descendants. */
  count: number;
  /** Explicit ordering hint from _group.md (absent if not set). */
  order?: number;
  /** Optional color hint from _group.md. */
  color?: string;
  /** Optional icon hint from _group.md. */
  icon?: string;
  /** Sorted children per 0003 ordering rules. */
  children: GroupNode[];
}

/**
 * Compare two sibling GroupNodes per spec 0003 ordering rules:
 *   explicit order (ascending) < no order, then alphabetical by name.
 */
export function compareGroupNodes(a: GroupNode, b: GroupNode): number {
  const aHas = a.order !== undefined;
  const bHas = b.order !== undefined;
  if (aHas && bHas) {
    const diff = a.order! - b.order!;
    if (diff !== 0) return diff;
    return a.name.localeCompare(b.name);
  }
  if (aHas) return -1;
  if (bHas) return 1;
  return a.name.localeCompare(b.name);
}

/**
 * Build a sorted group tree from a flat GroupMeta list.
 *
 * The flat list may be incomplete (no intermediate nodes for "work" if no entry
 * sits directly in "work/") — missing nodes are synthesized automatically.
 *
 * Returns the root-level nodes sorted per 0003.
 */
export function buildGroupTree(groups: GroupMeta[]): GroupNode[] {
  // Index by path for fast lookup.
  const byPath = new Map<string, GroupNode>();

  // Ensure every path and its ancestors exist in the map.
  function ensure(path: string, meta?: GroupMeta): GroupNode {
    if (byPath.has(path)) return byPath.get(path)!;
    const name = path.split("/").at(-1) ?? path;
    const node: GroupNode = {
      path,
      name: meta?.name ?? name,
      count: meta?.count ?? 0,
      order: meta?.order,
      color: meta?.color,
      icon: meta?.icon,
      children: [],
    };
    byPath.set(path, node);
    return node;
  }

  // Seed all provided groups first (so their names/colors/orders are used).
  for (const g of groups) {
    ensure(g.path, g);
  }

  // Ensure all ancestor paths exist (synthesized with count 0).
  for (const g of groups) {
    const parts = g.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      ensure(parts.slice(0, i).join("/"));
    }
  }

  // Wire parent–child relationships.
  const roots: GroupNode[] = [];
  for (const [path, node] of byPath) {
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash === -1) {
      roots.push(node);
    } else {
      const parentPath = path.slice(0, lastSlash);
      const parent = ensure(parentPath);
      parent.children.push(node);
    }
  }

  // Aggregate counts bottom-up: each node accumulates its children's counts.
  function aggregateCounts(node: GroupNode): number {
    let total = node.count;
    for (const child of node.children) {
      total += aggregateCounts(child);
    }
    node.count = total;
    return total;
  }

  // Sort children recursively per 0003 ordering rules.
  function sortTree(nodes: GroupNode[]): GroupNode[] {
    nodes.sort(compareGroupNodes);
    for (const n of nodes) {
      n.children = sortTree(n.children);
    }
    return nodes;
  }

  const sortedRoots = sortTree(roots);
  for (const root of sortedRoots) {
    aggregateCounts(root);
  }

  return sortedRoots;
}
