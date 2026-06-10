import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

import { markdownExtension } from "../extensions/markdown.js";
import {
  scanLine,
  TAG_NODE,
  MENTION_NODE,
  WIKILINK_NODE,
  type ScannedToken,
} from "../extensions/inline-tokens.js";

// ── Pure scanner parity vs the Rust body scanner ─────────────────────────────
//
// These tables mirror the test cases in src-tauri/src/core/index/scanner.rs so
// the TS scanner and the Rust scanner agree on tokenization. `scanLine` takes a
// single already-code-stripped line (the Rust `scan_stripped` contract).

function values(text: string, kind: ScannedToken["kind"]): string[] {
  return scanLine(text)
    .filter((t) => t.kind === kind)
    .map((t) => t.value);
}

describe("scanLine — tags (charset, hierarchy, boundary)", () => {
  it("simple tag", () => {
    expect(values("this is #followup text", "tag")).toEqual(["followup"]);
  });
  it("hierarchical tag keeps slashes", () => {
    expect(values("filed under #project/atlas", "tag")).toEqual(["project/atlas"]);
  });
  it("tag at line start", () => {
    expect(values("#standup notes", "tag")).toEqual(["standup"]);
  });
  it("tag charset includes - and _", () => {
    expect(values("#foo-bar_baz done", "tag")).toEqual(["foo-bar_baz"]);
  });
  it("# preceded by word char is not a tag", () => {
    expect(values("foo#bar", "tag")).toEqual([]);
  });
  it("bare # with no following chars is not a tag", () => {
    expect(values("text # alone", "tag")).toEqual([]);
  });
  it("multiple tags on one line, in order", () => {
    expect(values("tagged as #foo #bar and #baz", "tag")).toEqual(["foo", "bar", "baz"]);
  });
});

describe("scanLine — mentions (charset, word boundary)", () => {
  it("simple mention", () => {
    expect(values("had lunch with @sergey today", "mention")).toEqual(["sergey"]);
  });
  it("mention at line start", () => {
    expect(values("@anna should review this", "mention")).toEqual(["anna"]);
  });
  it("email@host is NOT a mention (preceded by word char)", () => {
    expect(values("contact email@example.com for details", "mention")).toEqual([]);
  });
  it("mention after punctuation is allowed", () => {
    expect(values("cc: @bob", "mention")).toEqual(["bob"]);
  });
  it("disallowed chars stop the slug at the dot", () => {
    expect(values("asked @john.doe to review", "mention")).toEqual(["john"]);
  });
  it("no slash in mentions — slug stops before /", () => {
    expect(values("@a/b", "mention")).toEqual(["a"]);
  });
});

describe("scanLine — wikilinks (display, qualified target)", () => {
  it("bare wikilink", () => {
    expect(values("see [[meeting-notes]] for context", "wikilink")).toEqual(["meeting-notes"]);
  });
  it("display text is stripped, target before pipe", () => {
    expect(values("see [[work/atlas/meeting-notes|meeting notes]] today", "wikilink")).toEqual([
      "work/atlas/meeting-notes",
    ]);
  });
  it("path-qualified target preserved", () => {
    expect(values("[[work/atlas/notes]]", "wikilink")).toEqual(["work/atlas/notes"]);
  });
  it("target is trimmed", () => {
    expect(values("[[  spaced  | x ]]", "wikilink")).toEqual(["spaced"]);
  });
  it("empty target is not a wikilink", () => {
    expect(values("[[|only display]]", "wikilink")).toEqual([]);
  });
  it("unterminated wikilink is not a token", () => {
    expect(values("[[unclosed", "wikilink")).toEqual([]);
  });
});

describe("scanLine — mixed and offsets", () => {
  it("mixed tokens on one line", () => {
    const toks = scanLine("meeting with @anna about [[project-x]] #followup");
    expect(toks.map((t) => `${t.kind}:${t.value}`)).toEqual([
      "mention:anna",
      "wikilink:project-x",
      "tag:followup",
    ]);
  });
  it("offsets cover the full literal incl. markers", () => {
    const toks = scanLine("x #tag y");
    expect(toks[0]).toMatchObject({ kind: "tag", from: 2, to: 6, value: "tag" });
  });
});

// ── Lezer tree parity + code suppression (structural) ────────────────────────

function treeTokens(doc: string): Array<{ name: string; from: number; to: number; text: string }> {
  const state = EditorState.create({ doc, extensions: [markdownExtension] });
  const tree = syntaxTree(state);
  const out: Array<{ name: string; from: number; to: number; text: string }> = [];
  tree.iterate({
    enter: (n) => {
      if (n.name === TAG_NODE || n.name === MENTION_NODE || n.name === WIKILINK_NODE) {
        out.push({ name: n.name, from: n.from, to: n.to, text: doc.slice(n.from, n.to) });
      }
    },
  });
  return out;
}

describe("Lezer tree — custom nodes", () => {
  it("emits all three node types with full-literal ranges", () => {
    const toks = treeTokens("a #tag @sergey [[wl|disp]] z");
    expect(toks.map((t) => [t.name, t.text])).toEqual([
      [TAG_NODE, "#tag"],
      [MENTION_NODE, "@sergey"],
      [WIKILINK_NODE, "[[wl|disp]]"],
    ]);
  });

  it("fenced code suppresses all three tokens", () => {
    expect(treeTokens("before\n```\n#nope @nope [[nope]]\n```\nafter")).toEqual([]);
  });

  it("tilde fenced code suppresses tokens", () => {
    expect(treeTokens("~~~\n#nope\n~~~\n")).toEqual([]);
  });

  it("inline code suppresses tokens", () => {
    expect(treeTokens("use `#config` option")).toEqual([]);
  });

  it("inline code does not suppress tokens outside the span", () => {
    const toks = treeTokens("use `code` and then #real-tag");
    expect(toks.map((t) => t.text)).toEqual(["#real-tag"]);
  });

  it("email@host is not a mention in the tree", () => {
    expect(
      treeTokens("contact email@example.com now").filter((t) => t.name === MENTION_NODE),
    ).toEqual([]);
  });

  it("foo#bar is not a tag in the tree", () => {
    expect(treeTokens("foo#bar").filter((t) => t.name === TAG_NODE)).toEqual([]);
  });
});
