// Tests for calendar_window mock implementation and drag write-back.

import { describe, it, expect } from "vitest";
import { mock } from "../../ipc/mock.js";
import { parseFrontmatter, applyPanelEdit } from "../../panel/frontmatter-view.js";

// ── calendar_window mock ──────────────────────────────────────────────────────

describe("calendar_window mock", () => {
  it("returns ok result for a valid date range", async () => {
    const result = await mock.calendar_window("2026-06-01", "2026-06-30");
    expect(result.ok).toBe(true);
  });

  it("returns at least one item for a wide window", async () => {
    const result = await mock.calendar_window("2026-06-01", "2026-06-30");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items.length).toBeGreaterThan(0);
    }
  });

  it("returns only items for the given group filter", async () => {
    const result = await mock.calendar_window("2026-06-01", "2026-06-30", "inbox");
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const item of result.value.items) {
        expect(item.group === "inbox" || item.group.startsWith("inbox/")).toBe(true);
      }
    }
  });

  it("returns no items for a date range with no matching entries", async () => {
    const result = await mock.calendar_window("2020-01-01", "2020-01-31");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).toHaveLength(0);
    }
  });

  it("returns error for invalid date format", async () => {
    const result = await mock.calendar_window("not-a-date", "2026-06-30");
    expect(result.ok).toBe(false);
  });

  it("expands recurring entries (standup — weekly BYDAY=MO)", async () => {
    const result = await mock.calendar_window("2026-06-01", "2026-06-30");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const standupItems = result.value.items.filter((i) => i.entryId === "work/atlas/standup");
      // June 2026 Mondays: 1, 8, 15, 22, 29 = 5, but June 8 is moved to June 9 by override.
      // All 5 Mondays appear (including the moved June 8 → June 9).
      expect(standupItems.length).toBe(5);
      expect(standupItems.every((i) => i.isOccurrence)).toBe(true);
    }
  });

  it("applies override: June 8 moved to June 9 for standup", async () => {
    const result = await mock.calendar_window("2026-06-01", "2026-06-30");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const standupItems = result.value.items.filter((i) => i.entryId === "work/atlas/standup");
      // June 8 should NOT appear (it's overridden to June 9).
      const june8 = standupItems.filter((i) => i.dateValue === "2026-06-08");
      expect(june8).toHaveLength(0);
      // June 9 SHOULD appear (the moved occurrence).
      const june9 = standupItems.filter((i) => i.dateValue === "2026-06-09");
      expect(june9).toHaveLength(1);
    }
  });

  it("expands daily-weekday recurring entry (journal/daily-prompt)", async () => {
    const result = await mock.calendar_window("2026-06-01", "2026-06-30");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const promptItems = result.value.items.filter((i) => i.entryId === "journal/daily-prompt");
      // COUNT=20, BYDAY=MO,TU,WE,TH,FR, starting June 9 (Tuesday)
      // Week of June 9: Tue 9, Wed 10, Thu 11, Fri 12 = 4
      // Week of June 15: Mon–Fri = 5
      // Week of June 22: Mon–Fri = 5 (total so far = 14)
      // Week of June 29: Mon 29, Tue 30 = 2 more (total = 16... but COUNT=20 so all 16 in June)
      // At most COUNT=20 occurrences, all within window.
      expect(promptItems.length).toBeGreaterThan(0);
      expect(promptItems.length).toBeLessThanOrEqual(20);
      expect(promptItems.every((i) => i.isOccurrence)).toBe(true);
    }
  });

  it("includes a range item (roadmap)", async () => {
    const result = await mock.calendar_window("2026-06-01", "2026-06-30");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const roadmapItems = result.value.items.filter((i) => i.entryId === "work/atlas/roadmap");
      expect(roadmapItems).toHaveLength(1);
      expect(roadmapItems[0].dateValue).toContain("..");
    }
  });

  it("includes the meeting (datetime item) on June 12", async () => {
    const result = await mock.calendar_window("2026-06-10", "2026-06-14");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const meetingItems = result.value.items.filter(
        (i) => i.entryId === "work/atlas/meeting-2026-05",
      );
      expect(meetingItems).toHaveLength(1);
    }
  });
});

// ── drag write-back via applyPanelEdit ────────────────────────────────────────

describe("drag write-back via applyPanelEdit", () => {
  /** Simulate applying a ChangeSpec to doc text. */
  function applyChange(doc: string, from: number, to: number, insert: string): string {
    return doc.slice(0, from) + insert + doc.slice(to);
  }

  it("updates due property via set-scalar", () => {
    const doc = `---
title: Follow-up with Anna
tags: [followup, action]
due: 2026-06-13
---

# Body
`;
    const model = parseFrontmatter(doc);
    const change = applyPanelEdit(doc, model, {
      kind: "set-scalar",
      key: "due",
      value: "2026-06-20",
    });
    expect(change).not.toBeNull();
    const result = applyChange(doc, change!.from, change!.to, change!.insert);
    expect(result).toContain("due: 2026-06-20");
    expect(result).not.toContain("due: 2026-06-13");
  });

  it("adds due property when missing", () => {
    const doc = `---
title: No Due
tags: [test]
---

# Body
`;
    const model = parseFrontmatter(doc);
    const change = applyPanelEdit(doc, model, {
      kind: "add",
      key: "due",
      value: "2026-06-25",
    });
    expect(change).not.toBeNull();
    const result = applyChange(doc, change!.from, change!.to, change!.insert);
    expect(result).toContain("due: 2026-06-25");
  });

  it("preserves other properties after updating due", () => {
    const doc = `---
title: Test Entry
tags: [work, planning]
people: [anna]
due: 2026-06-15
priority: 2
---

# Body text
`;
    const model = parseFrontmatter(doc);
    const change = applyPanelEdit(doc, model, {
      kind: "set-scalar",
      key: "due",
      value: "2026-06-22",
    });
    const result = applyChange(doc, change!.from, change!.to, change!.insert);
    expect(result).toContain("tags: [work, planning]");
    expect(result).toContain("people: [anna]");
    expect(result).toContain("priority: 2");
    expect(result).toContain("due: 2026-06-22");
  });

  it("removes due property", () => {
    const doc = `---
title: Test
due: 2026-06-15
---

Body
`;
    const model = parseFrontmatter(doc);
    const change = applyPanelEdit(doc, model, { kind: "remove", key: "due" });
    expect(change).not.toBeNull();
    const result = applyChange(doc, change!.from, change!.to, change!.insert);
    expect(result).not.toContain("due:");
  });

  it("is a no-op for a read-only key (created)", () => {
    const doc = `---
title: Test
created: 2026-01-01T00:00+00:00
due: 2026-06-15
---
`;
    const model = parseFrontmatter(doc);
    const change = applyPanelEdit(doc, model, {
      kind: "set-scalar",
      key: "created",
      value: "2026-12-31",
    });
    expect(change).toBeNull();
  });
});
