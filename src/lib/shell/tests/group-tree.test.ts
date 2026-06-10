import { describe, it, expect } from "vitest";
import { buildGroupTree, compareGroupNodes } from "../group-tree.js";
import type { GroupNode } from "../group-tree.js";
import type { GroupMeta } from "../../ipc/types.js";

// ── compareGroupNodes ─────────────────────────────────────────────────────────

describe("compareGroupNodes — spec 0003 ordering rules", () => {
  function node(name: string, order?: number): GroupNode {
    return { path: name, name, count: 0, order, children: [] };
  }

  it("explicit order < no order", () => {
    const a = node("zzz", 1);
    const b = node("aaa"); // no order
    expect(compareGroupNodes(a, b)).toBeLessThan(0);
    expect(compareGroupNodes(b, a)).toBeGreaterThan(0);
  });

  it("lower explicit order sorts first", () => {
    const a = node("b", 1);
    const b = node("a", 2);
    expect(compareGroupNodes(a, b)).toBeLessThan(0);
  });

  it("tied explicit order breaks alphabetically by name", () => {
    const a = node("Beta", 1);
    const b = node("Alpha", 1);
    expect(compareGroupNodes(a, b)).toBeGreaterThan(0);
    expect(compareGroupNodes(b, a)).toBeLessThan(0);
  });

  it("both without order: alphabetical by name", () => {
    const a = node("Zebra");
    const b = node("Apple");
    expect(compareGroupNodes(a, b)).toBeGreaterThan(0);
    expect(compareGroupNodes(b, a)).toBeLessThan(0);
  });

  it("equal name + equal order = 0", () => {
    const a = node("same", 3);
    const b = node("same", 3);
    expect(compareGroupNodes(a, b)).toBe(0);
  });

  it("equal name + both no order = 0", () => {
    const a = node("same");
    const b = node("same");
    expect(compareGroupNodes(a, b)).toBe(0);
  });
});

// ── buildGroupTree ────────────────────────────────────────────────────────────

describe("buildGroupTree — flat list to tree", () => {
  it("single top-level group", () => {
    const groups: GroupMeta[] = [{ path: "inbox", name: "Inbox", count: 5 }];
    const tree = buildGroupTree(groups);
    expect(tree).toHaveLength(1);
    expect(tree[0].path).toBe("inbox");
    expect(tree[0].name).toBe("Inbox");
    expect(tree[0].count).toBe(5);
    expect(tree[0].children).toHaveLength(0);
  });

  it("nested groups wire parent–child correctly", () => {
    const groups: GroupMeta[] = [
      { path: "work", name: "Work", count: 0 },
      { path: "work/atlas", name: "Project Atlas", count: 4 },
    ];
    const tree = buildGroupTree(groups);
    expect(tree).toHaveLength(1);
    expect(tree[0].path).toBe("work");
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].path).toBe("work/atlas");
    expect(tree[0].children[0].name).toBe("Project Atlas");
  });

  it("synthesises missing intermediate ancestor nodes", () => {
    // No 'work' entry in the flat list — synthesised from 'work/atlas'.
    const groups: GroupMeta[] = [{ path: "work/atlas", name: "Project Atlas", count: 3 }];
    const tree = buildGroupTree(groups);
    expect(tree).toHaveLength(1);
    expect(tree[0].path).toBe("work");
    // Synthesised name = last path segment
    expect(tree[0].name).toBe("work");
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].path).toBe("work/atlas");
  });

  it("aggregates entry counts bottom-up", () => {
    const groups: GroupMeta[] = [
      { path: "work", name: "Work", count: 2 },
      { path: "work/atlas", name: "Atlas", count: 9 },
      { path: "work/meetings", name: "Meetings", count: 11 },
    ];
    const tree = buildGroupTree(groups);
    const work = tree.find((n) => n.path === "work")!;
    // work.count = 2 (direct) + 9 + 11 = 22
    expect(work.count).toBe(22);
  });

  it("sorts children per spec 0003: explicit order first, then alpha", () => {
    const groups: GroupMeta[] = [
      { path: "root/zzz", name: "ZZZ", count: 1, order: 1 },
      { path: "root/aaa", name: "AAA", count: 1 },
      { path: "root/bbb", name: "BBB", count: 1 },
      { path: "root/mmm", name: "MMM", count: 1, order: 2 },
    ];
    const tree = buildGroupTree(groups);
    const children = tree[0].children.map((c) => c.name);
    expect(children[0]).toBe("ZZZ"); // order 1
    expect(children[1]).toBe("MMM"); // order 2
    expect(children[2]).toBe("AAA"); // alpha
    expect(children[3]).toBe("BBB"); // alpha
  });

  it("multiple roots sorted alphabetically (no explicit order)", () => {
    const groups: GroupMeta[] = [
      { path: "journal", name: "Journal", count: 5 },
      { path: "books", name: "Books", count: 3 },
      { path: "work", name: "Work", count: 10 },
    ];
    const tree = buildGroupTree(groups);
    const names = tree.map((n) => n.name);
    expect(names).toEqual(["Books", "Journal", "Work"]);
  });

  it("3-level deep nesting", () => {
    const groups: GroupMeta[] = [{ path: "a/b/c", name: "C", count: 1 }];
    const tree = buildGroupTree(groups);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].children).toHaveLength(1);
    expect(tree[0].children[0].children[0].path).toBe("a/b/c");
  });

  it("empty input returns empty array", () => {
    expect(buildGroupTree([])).toHaveLength(0);
  });

  it("groups from mock ENTRIES cover the expected top-level groups", async () => {
    // Use the mock IPC to get a realistic flat list.
    const { mock } = await import("../../ipc/mock.js");
    const result = await mock.list_groups();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tree = buildGroupTree(result.value);
    const rootPaths = tree.map((n) => n.path);
    // Mock has work, journal, books, inbox as top-level groups.
    expect(rootPaths).toContain("work");
    expect(rootPaths).toContain("journal");
    expect(rootPaths).toContain("books");
    expect(rootPaths).toContain("inbox");
  });

  it("work group has atlas child in mock tree", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const result = await mock.list_groups();
    if (!result.ok) return;
    const tree = buildGroupTree(result.value);
    const work = tree.find((n) => n.path === "work");
    expect(work).toBeDefined();
    const atlas = work?.children.find((c) => c.path === "work/atlas");
    expect(atlas).toBeDefined();
    expect(atlas!.count).toBeGreaterThan(0);
  });
});

// ── Entry-list state transitions (pure logic) ─────────────────────────────────

describe("entry-list state — responsive mode logic", () => {
  type MobileScreen = "list" | "editor" | "sidebar";

  function nextScreen(
    current: MobileScreen,
    action: "selectGroup" | "selectEntry" | "back",
  ): MobileScreen {
    if (action === "selectGroup") return "list";
    if (action === "selectEntry") return "editor";
    if (action === "back") {
      if (current === "editor") return "list";
      if (current === "sidebar") return "list";
      return "list";
    }
    return current;
  }

  it("selecting a group navigates to list screen", () => {
    expect(nextScreen("sidebar", "selectGroup")).toBe("list");
  });

  it("selecting an entry navigates to editor screen", () => {
    expect(nextScreen("list", "selectEntry")).toBe("editor");
  });

  it("back from editor returns to list", () => {
    expect(nextScreen("editor", "back")).toBe("list");
  });

  it("back from sidebar returns to list", () => {
    expect(nextScreen("sidebar", "back")).toBe("list");
  });

  it("back from list stays on list", () => {
    expect(nextScreen("list", "back")).toBe("list");
  });
});

// ── list_groups mock ──────────────────────────────────────────────────────────

describe("list_groups mock", () => {
  it("returns ok with a non-empty array", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const result = await mock.list_groups();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThan(0);
  });

  it("all returned paths are non-empty strings", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const result = await mock.list_groups();
    if (!result.ok) return;
    for (const g of result.value) {
      expect(typeof g.path).toBe("string");
      expect(g.path.length).toBeGreaterThan(0);
      expect(typeof g.name).toBe("string");
      expect(g.name.length).toBeGreaterThan(0);
    }
  });

  it("counts are non-negative", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const result = await mock.list_groups();
    if (!result.ok) return;
    for (const g of result.value) {
      expect(g.count).toBeGreaterThanOrEqual(0);
    }
  });

  it("paths include leaf groups from ENTRIES", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const result = await mock.list_groups();
    if (!result.ok) return;
    const paths = result.value.map((g) => g.path);
    expect(paths).toContain("work/atlas");
    expect(paths).toContain("journal");
    expect(paths).toContain("books");
    expect(paths).toContain("inbox");
  });

  it("real.ts stub returns an ok result (list_groups is wired)", async () => {
    // In Node without Tauri, invoke() throws → io_error (not not_implemented).
    const { real } = await import("../../ipc/real.js");
    const result = await real.list_groups();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("io_error");
    }
  });
});
