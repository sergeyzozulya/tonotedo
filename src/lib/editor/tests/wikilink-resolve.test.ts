// Tests for bare-wikilink ambiguity resolution (spec 0006 §Wikilinks, 0003).

import { describe, it, expect } from "vitest";
import { resolveWikilink } from "../wikilink-resolve.js";

const titles = new Map<string, string>([
  ["work/atlas/meeting-notes", "Atlas meeting notes"],
  ["home/meeting-notes", "Home meeting notes"],
  ["work/atlas/roadmap", "Roadmap"],
]);
const groups = ["work", "work/atlas", "home"];

describe("resolveWikilink", () => {
  it("resolves an already-qualified entry target uniquely", () => {
    const r = resolveWikilink({
      target: "work/atlas/roadmap",
      entryTitles: titles,
      groupPaths: groups,
    });
    expect(r).toEqual({ status: "unique", target: "work/atlas/roadmap", kind: "entry" });
  });

  it("resolves a unique bare slug to its qualified entry id", () => {
    const r = resolveWikilink({ target: "roadmap", entryTitles: titles, groupPaths: groups });
    expect(r).toEqual({ status: "unique", target: "work/atlas/roadmap", kind: "entry" });
  });

  it("flags a bare slug shared by two entries as ambiguous", () => {
    const r = resolveWikilink({ target: "meeting-notes", entryTitles: titles, groupPaths: groups });
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") {
      expect(r.candidates.map((c) => c.target).sort()).toEqual([
        "home/meeting-notes",
        "work/atlas/meeting-notes",
      ]);
      expect(r.candidates.every((c) => c.kind === "entry")).toBe(true);
    }
  });

  it("flags an entry-vs-group name clash as ambiguous", () => {
    // An entry slug "atlas" clashing with the group named "atlas".
    const t = new Map(titles);
    t.set("work/atlas", "Atlas the entry"); // an entry whose id last segment is "atlas"
    const r = resolveWikilink({ target: "atlas", entryTitles: t, groupPaths: groups });
    // "work/atlas" is BOTH an entry id and a group path → ambiguous.
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") {
      expect(r.candidates.map((c) => c.kind).sort()).toEqual(["entry", "group"]);
    }
  });

  it("resolves a bare group name uniquely when no entry clashes", () => {
    const r = resolveWikilink({ target: "home", entryTitles: titles, groupPaths: groups });
    expect(r).toEqual({ status: "unique", target: "home", kind: "group" });
  });

  it("returns none for an unknown target", () => {
    const r = resolveWikilink({ target: "nope", entryTitles: titles, groupPaths: groups });
    expect(r).toEqual({ status: "none" });
  });
});
