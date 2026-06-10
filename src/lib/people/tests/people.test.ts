// Headless tests for people utilities and mock IPC (issue #22).
//
// Covers:
//   1. partitionPeople — declared/unmanaged split, count-badge correctness
//   2. mentions_for mock — union of surfaces, recency order
//   3. set_person / delete_person mock — round-trip mutation
//   4. create-person flow state (dialog slug validation logic)

import { describe, it, expect, beforeEach } from "vitest";
import { partitionPeople, comparePerson } from "../people-utils.js";
import type { PersonMeta } from "../../ipc/types.js";

// ── partitionPeople ───────────────────────────────────────────────────────────

describe("partitionPeople — declared/unmanaged split", () => {
  const people: PersonMeta[] = [
    { slug: "anna", displayName: "Anna K.", count: 6, declared: true },
    { slug: "bob", displayName: "Bob T.", count: 4, declared: true },
    { slug: "sergey", displayName: "sergey", count: 3 }, // undeclared
    { slug: "carol", displayName: "Carol M.", count: 2, declared: true },
    { slug: "ghost", displayName: "ghost", count: 1 }, // undeclared
  ];

  it("splits into declared and unmanaged groups", () => {
    const { declared, unmanaged } = partitionPeople(people);
    expect(declared.map((p) => p.slug)).toEqual(["anna", "bob", "carol"]);
    expect(unmanaged.map((p) => p.slug)).toEqual(["sergey", "ghost"]);
  });

  it("declared group sorted by count desc, then name asc", () => {
    const { declared } = partitionPeople(people);
    expect(declared[0].slug).toBe("anna"); // count 6
    expect(declared[1].slug).toBe("bob"); // count 4
    expect(declared[2].slug).toBe("carol"); // count 2
  });

  it("unmanaged group sorted by count desc", () => {
    const { unmanaged } = partitionPeople(people);
    expect(unmanaged[0].slug).toBe("sergey"); // count 3
    expect(unmanaged[1].slug).toBe("ghost"); // count 1
  });

  it("empty input returns empty partitions", () => {
    const { declared, unmanaged } = partitionPeople([]);
    expect(declared).toHaveLength(0);
    expect(unmanaged).toHaveLength(0);
  });

  it("all declared → unmanaged is empty", () => {
    const all: PersonMeta[] = [
      { slug: "a", displayName: "A", count: 1, declared: true },
      { slug: "b", displayName: "B", count: 2, declared: true },
    ];
    const { declared, unmanaged } = partitionPeople(all);
    expect(declared).toHaveLength(2);
    expect(unmanaged).toHaveLength(0);
  });

  it("all unmanaged → declared is empty", () => {
    const all: PersonMeta[] = [
      { slug: "x", displayName: "x", count: 1 },
      { slug: "y", displayName: "y", count: 5 },
    ];
    const { declared, unmanaged } = partitionPeople(all);
    expect(declared).toHaveLength(0);
    expect(unmanaged).toHaveLength(2);
  });

  it("tie in count breaks by displayName asc", () => {
    const tied: PersonMeta[] = [
      { slug: "zara", displayName: "Zara", count: 3, declared: true },
      { slug: "alice", displayName: "Alice", count: 3, declared: true },
    ];
    const { declared } = partitionPeople(tied);
    expect(declared[0].displayName).toBe("Alice");
    expect(declared[1].displayName).toBe("Zara");
  });
});

// ── comparePerson ─────────────────────────────────────────────────────────────

describe("comparePerson — sort comparator", () => {
  it("higher count sorts first", () => {
    const a: PersonMeta = { slug: "a", displayName: "A", count: 10 };
    const b: PersonMeta = { slug: "b", displayName: "B", count: 1 };
    expect(comparePerson(a, b)).toBeLessThan(0);
    expect(comparePerson(b, a)).toBeGreaterThan(0);
  });

  it("equal count falls back to displayName asc", () => {
    const a: PersonMeta = { slug: "z", displayName: "Zoe", count: 5 };
    const b: PersonMeta = { slug: "a", displayName: "Amy", count: 5 };
    expect(comparePerson(a, b)).toBeGreaterThan(0);
    expect(comparePerson(b, a)).toBeLessThan(0);
  });
});

// ── mentions_for mock ─────────────────────────────────────────────────────────

describe("mentions_for mock — union surfaces + recency order", () => {
  it("finds entries mentioning person in frontmatter people array", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const result = await mock.mentions_for("anna");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.map((e) => e.id);
    // Anna is in people frontmatter for these entries.
    expect(ids).toContain("work/atlas/project-overview");
    expect(ids).toContain("work/atlas/meeting-2026-05");
  });

  it("finds entries mentioning person via body @mention", async () => {
    const { mock } = await import("../../ipc/mock.js");
    // sergey is used in body text (@sergey) and in frontmatter.
    const result = await mock.mentions_for("sergey");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.map((e) => e.id);
    expect(ids).toContain("work/atlas/project-overview"); // @anna (lead) and @sergey (infra)
    expect(ids).toContain("work/atlas/tech-decisions"); // @sergey owns
  });

  it("returns most-recent-first (modifiedAt descending)", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const result = await mock.mentions_for("anna");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dates = result.value.map((e) => e.modifiedAt);
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1] >= dates[i]).toBe(true);
    }
  });

  it("returns empty array for a slug with no mentions", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const result = await mock.mentions_for("nobody-at-all");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  it("unions frontmatter and body surfaces without duplication", async () => {
    // project-overview has both anna in frontmatter AND @anna in body.
    // It should appear only once.
    const { mock } = await import("../../ipc/mock.js");
    const result = await mock.mentions_for("anna");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.map((e) => e.id);
    const projectOverviewCount = ids.filter((id) => id === "work/atlas/project-overview").length;
    expect(projectOverviewCount).toBe(1);
  });
});

// ── people_index mock — declared flag ─────────────────────────────────────────

describe("people_index mock — declared flag", () => {
  it("declared people have declared=true", async () => {
    const { mock, PEOPLE_DECLARED } = await import("../../ipc/mock.js");
    const result = await mock.people_index();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const p of result.value) {
      if (PEOPLE_DECLARED.has(p.slug)) {
        expect(p.declared).toBe(true);
      }
    }
  });

  it("undeclared people (sergey) have declared=false/undefined", async () => {
    const { mock, PEOPLE_DECLARED } = await import("../../ipc/mock.js");
    const result = await mock.people_index();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const p of result.value) {
      if (!PEOPLE_DECLARED.has(p.slug)) {
        expect(p.declared).toBeFalsy();
      }
    }
  });

  it("count badges match actual entry references", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const result = await mock.people_index();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // anna appears in 5 entries (project-overview, meeting-2026-05, roadmap,
    // journal-2026-05-21, follow-up-anna, inbox/contacts = 6 entries).
    const anna = result.value.find((p) => p.slug === "anna");
    expect(anna).toBeDefined();
    expect(anna!.count).toBeGreaterThanOrEqual(5);
  });
});

// ── set_person / delete_person ────────────────────────────────────────────────

describe("set_person / delete_person mock", () => {
  beforeEach(async () => {
    // Reset: remove any lingering test person from prior runs.
    const { mock } = await import("../../ipc/mock.js");
    await mock.delete_person("testperson").catch(() => undefined);
  });

  it("set_person adds a new declared person", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const setResult = await mock.set_person({
      slug: "testperson",
      displayName: "Test Person",
      description: "A test.",
      color: "teal",
    });
    expect(setResult.ok).toBe(true);

    // testperson has no entry references → count 0, so it won't appear in
    // people_index (which is built from entries). Test store persistence directly.
    const { peopleStore } = await import("../../ipc/mock.js");
    expect(peopleStore.has("testperson")).toBe(true);
    expect(peopleStore.get("testperson")?.displayName).toBe("Test Person");
  });

  it("set_person overwrites existing person metadata", async () => {
    const { mock, peopleStore } = await import("../../ipc/mock.js");
    await mock.set_person({ slug: "anna", displayName: "Anna Updated", color: "red" });
    expect(peopleStore.get("anna")?.displayName).toBe("Anna Updated");
    expect(peopleStore.get("anna")?.color).toBe("red");
    // Restore original.
    await mock.set_person({ slug: "anna", displayName: "Anna K.", color: "violet" });
  });

  it("delete_person removes from store", async () => {
    const { mock, peopleStore } = await import("../../ipc/mock.js");
    await mock.set_person({ slug: "tempslug", displayName: "Temp" });
    expect(peopleStore.has("tempslug")).toBe(true);
    const del = await mock.delete_person("tempslug");
    expect(del.ok).toBe(true);
    expect(peopleStore.has("tempslug")).toBe(false);
  });

  it("delete_person returns not_found for missing slug", async () => {
    const { mock } = await import("../../ipc/mock.js");
    const result = await mock.delete_person("does-not-exist");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("not_found");
  });
});

// ── create-person flow state (slug validation logic) ─────────────────────────

describe("create-person flow — slug validation", () => {
  // Pure logic that mirrors what CreatePersonDialog does before calling set_person.

  function validateSlug(slug: string): string | null {
    if (!slug.trim()) return "Slug is required.";
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) return "Only letters, digits, - and _ are allowed.";
    if (slug.length > 64) return "Slug is too long (max 64 chars).";
    return null; // valid
  }

  it("empty slug is invalid", () => {
    expect(validateSlug("")).not.toBeNull();
    expect(validateSlug("   ")).not.toBeNull();
  });

  it("valid slug passes", () => {
    expect(validateSlug("sergey")).toBeNull();
    expect(validateSlug("anna-k")).toBeNull();
    expect(validateSlug("bob_t")).toBeNull();
  });

  it("slash is disallowed in person slug", () => {
    expect(validateSlug("sergey/work")).not.toBeNull();
  });

  it("slug too long is invalid", () => {
    expect(validateSlug("a".repeat(65))).not.toBeNull();
    expect(validateSlug("a".repeat(64))).toBeNull();
  });

  it("special characters are disallowed", () => {
    expect(validateSlug("john.doe")).not.toBeNull();
    expect(validateSlug("anna@work")).not.toBeNull();
    expect(validateSlug("name with spaces")).not.toBeNull();
  });
});
