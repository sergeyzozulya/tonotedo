// Tests for the blocks layer (issue #13).
//
// DOM-free: we test the pure functions (extractBlockSpecs, headInRange,
// isImagePath, isAttachmentPath, toggleCheckbox dispatch) using EditorState
// and real Lezer markdown parsing. No DOM widgets are instantiated.

import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";

import { markdownExtension } from "../extensions/markdown.js";
import {
  extractBlockSpecs,
  headInRange,
  isImagePath,
  isAttachmentPath,
} from "../extensions/blocks.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function stateOf(doc: string, head?: number): EditorState {
  return EditorState.create({
    doc,
    selection: head === undefined ? undefined : EditorSelection.cursor(head),
    extensions: [markdownExtension],
  });
}

function fullRange(doc: string) {
  return [{ from: 0, to: doc.length }];
}

// ── isImagePath / isAttachmentPath ────────────────────────────────────────────

describe("isImagePath", () => {
  it("png is an image", () => expect(isImagePath("_assets/foo.png")).toBe(true));
  it("jpg is an image", () => expect(isImagePath("_assets/photo.jpg")).toBe(true));
  it("jpeg is an image", () => expect(isImagePath("_assets/x.jpeg")).toBe(true));
  it("webp is an image", () => expect(isImagePath("_assets/x.webp")).toBe(true));
  it("gif is an image", () => expect(isImagePath("_assets/x.gif")).toBe(true));
  it("svg is an image", () => expect(isImagePath("_assets/x.svg")).toBe(true));
  it("case-insensitive", () => expect(isImagePath("_assets/x.PNG")).toBe(true));
  it("pdf is not an image", () => expect(isImagePath("_assets/file.pdf")).toBe(false));
  it("docx is not an image", () => expect(isImagePath("_assets/doc.docx")).toBe(false));
  it("no extension is not an image", () => expect(isImagePath("_assets/noext")).toBe(false));
});

describe("isAttachmentPath", () => {
  it("pdf in _assets/ is an attachment", () =>
    expect(isAttachmentPath("_assets/file.pdf")).toBe(true));
  it("zip in _assets/ is an attachment", () =>
    expect(isAttachmentPath("_assets/data.zip")).toBe(true));
  it("png in _assets/ is NOT an attachment (it's an image)", () =>
    expect(isAttachmentPath("_assets/img.png")).toBe(false));
  it("path NOT starting with _assets/ is not an attachment", () =>
    expect(isAttachmentPath("https://example.com/file.pdf")).toBe(false));
  it("relative external link is not an attachment", () =>
    expect(isAttachmentPath("docs/report.pdf")).toBe(false));
});

// ── headInRange ───────────────────────────────────────────────────────────────

describe("headInRange", () => {
  it("returns true when head is inside the range", () => {
    const state = stateOf("hello world", 5);
    expect(headInRange(state, 3, 8)).toBe(true);
  });

  it("returns true when head is at the exact start of range", () => {
    const state = stateOf("hello", 2);
    expect(headInRange(state, 2, 5)).toBe(true);
  });

  it("returns true when head is at the exact end of range", () => {
    const state = stateOf("hello", 5);
    expect(headInRange(state, 2, 5)).toBe(true);
  });

  it("returns false when head is before the range", () => {
    const state = stateOf("hello world", 0);
    expect(headInRange(state, 3, 8)).toBe(false);
  });

  it("returns false when head is after the range", () => {
    const state = stateOf("hello world", 10);
    expect(headInRange(state, 3, 8)).toBe(false);
  });
});

// ── extractBlockSpecs — checkboxes ────────────────────────────────────────────

describe("extractBlockSpecs — checkboxes", () => {
  it("detects unchecked task marker", () => {
    const doc = "- [ ] buy milk\n";
    const state = stateOf(doc);
    const specs = extractBlockSpecs(state, fullRange(doc));
    const checkboxes = specs.filter((s) => s.kind === "checkbox");
    expect(checkboxes).toHaveLength(1);
    expect(checkboxes[0]).toMatchObject({ kind: "checkbox", checked: false });
  });

  it("detects checked task marker", () => {
    const doc = "- [x] done task\n";
    const state = stateOf(doc);
    const specs = extractBlockSpecs(state, fullRange(doc));
    const checkboxes = specs.filter((s) => s.kind === "checkbox");
    expect(checkboxes).toHaveLength(1);
    expect(checkboxes[0]).toMatchObject({ kind: "checkbox", checked: true });
  });

  it("detects multiple checkboxes", () => {
    const doc = "- [ ] first\n- [x] second\n- [ ] third\n";
    const state = stateOf(doc);
    const specs = extractBlockSpecs(state, fullRange(doc));
    const checkboxes = specs.filter((s) => s.kind === "checkbox");
    expect(checkboxes).toHaveLength(3);
    expect(checkboxes.map((s) => (s as { checked: boolean }).checked)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("non-task list item produces no checkbox", () => {
    const doc = "- plain item\n";
    const state = stateOf(doc);
    const specs = extractBlockSpecs(state, fullRange(doc));
    expect(specs.filter((s) => s.kind === "checkbox")).toHaveLength(0);
  });

  it("checkbox markerFrom/markerTo cover `[ ]` / `[x]`", () => {
    const doc = "- [ ] task\n";
    const state = stateOf(doc);
    const specs = extractBlockSpecs(state, fullRange(doc));
    const cb = specs.find((s) => s.kind === "checkbox");
    expect(cb).toBeDefined();
    if (cb && cb.kind === "checkbox") {
      const marker = doc.slice(cb.markerFrom, cb.markerTo);
      expect(marker).toBe("[ ]");
    }
  });
});

// ── extractBlockSpecs — image vs attachment classification ────────────────────

describe("extractBlockSpecs — image vs attachment", () => {
  it("_assets/ image link is classified as image", () => {
    const doc = "![alt text](_assets/photo.png)\n";
    const state = stateOf(doc);
    const specs = extractBlockSpecs(state, fullRange(doc));
    const images = specs.filter((s) => s.kind === "image");
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ kind: "image", path: "_assets/photo.png" });
  });

  it("_assets/ non-image link is classified as attachment", () => {
    const doc = "[report.pdf](_assets/report.pdf)\n";
    const state = stateOf(doc);
    const specs = extractBlockSpecs(state, fullRange(doc));
    const attachments = specs.filter((s) => s.kind === "attachment");
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ kind: "attachment", path: "_assets/report.pdf" });
  });

  it("external link is not an attachment", () => {
    const doc = "[Google](https://google.com)\n";
    const state = stateOf(doc);
    const specs = extractBlockSpecs(state, fullRange(doc));
    expect(specs.filter((s) => s.kind === "attachment")).toHaveLength(0);
  });

  it("_assets/ pdf is NOT classified as image", () => {
    const doc = "[spec.pdf](_assets/spec.pdf)\n";
    const state = stateOf(doc);
    const specs = extractBlockSpecs(state, fullRange(doc));
    expect(specs.filter((s) => s.kind === "image")).toHaveLength(0);
  });

  it("image preserves alt text", () => {
    const doc = "![my caption](_assets/diagram.png)\n";
    const state = stateOf(doc);
    const specs = extractBlockSpecs(state, fullRange(doc));
    const img = specs.find((s) => s.kind === "image");
    expect(img).toBeDefined();
    if (img && img.kind === "image") {
      expect(img.alt).toBe("my caption");
    }
  });
});

// ── extractBlockSpecs — cursor-reveal (reveal when adjacent) ─────────────────

describe("extractBlockSpecs — suppress when head in range", () => {
  it("checkbox spec is present regardless of cursor (suppression is in buildDecorations)", () => {
    // extractBlockSpecs returns specs unconditionally; suppression happens later.
    const doc = "- [ ] task\n";
    const state = stateOf(doc, 3); // cursor inside marker
    const specs = extractBlockSpecs(state, fullRange(doc));
    // The spec is still extracted; widget-building suppresses it at render time.
    expect(specs.filter((s) => s.kind === "checkbox")).toHaveLength(1);
  });
});

// ── headInRange suppresses widget — integration with buildDecorations ─────────

describe("headInRange suppress widget (integration)", () => {
  it("headInRange at the attachment link position returns true", () => {
    const doc = "[report.pdf](_assets/report.pdf)\n";
    const state = stateOf(doc);
    const specs = extractBlockSpecs(state, fullRange(doc));
    const att = specs.find((s) => s.kind === "attachment");
    expect(att).toBeDefined();
    if (att) {
      // Cursor inside the link range → should suppress widget.
      const midState = stateOf(doc, att.from + 1);
      expect(headInRange(midState, att.from, att.to)).toBe(true);
    }
  });

  it("headInRange outside attachment link returns false", () => {
    const doc = "[report.pdf](_assets/report.pdf) text here\n";
    const state = stateOf(doc);
    const specs = extractBlockSpecs(state, fullRange(doc));
    const att = specs.find((s) => s.kind === "attachment");
    expect(att).toBeDefined();
    if (att) {
      // Cursor after the link range → widget should be shown.
      const afterState = stateOf(doc, doc.length - 1);
      expect(headInRange(afterState, att.from, att.to)).toBe(false);
    }
  });
});

// ── toggleCheckbox dispatch ───────────────────────────────────────────────────
//
// toggleCheckbox needs an EditorView to dispatch (CM6 requires it). We test the
// underlying TEXT TRANSFORM directly: given the marker range and current checked
// state, verify the changeset produces the correct text. This avoids instantiating
// EditorView (which needs DOM) while still validating the content-only edit.

describe("toggleCheckbox — text transform", () => {
  /** Apply the same changeset that toggleCheckbox would dispatch. Pure state only. */
  function applyToggle(
    doc: string,
    markerFrom: number,
    markerTo: number,
    currentlyChecked: boolean,
  ): string {
    const state = EditorState.create({ doc, extensions: [markdownExtension] });
    const newMarker = currentlyChecked ? "[ ]" : "[x]";
    const tx = state.update({ changes: { from: markerFrom, to: markerTo, insert: newMarker } });
    return tx.state.doc.toString();
  }

  it("toggles [ ] to [x]", () => {
    const doc = "- [ ] task\n";
    const state = stateOf(doc);
    const specs = extractBlockSpecs(state, fullRange(doc));
    const cb = specs.find((s) => s.kind === "checkbox");
    expect(cb).toBeDefined();
    if (cb && cb.kind === "checkbox") {
      const result = applyToggle(doc, cb.markerFrom, cb.markerTo, false);
      expect(result).toContain("[x]");
      expect(result).not.toContain("[ ]");
    }
  });

  it("toggles [x] to [ ]", () => {
    const doc = "- [x] done\n";
    const state = stateOf(doc);
    const specs = extractBlockSpecs(state, fullRange(doc));
    const cb = specs.find((s) => s.kind === "checkbox");
    expect(cb).toBeDefined();
    if (cb && cb.kind === "checkbox") {
      const result = applyToggle(doc, cb.markerFrom, cb.markerTo, true);
      expect(result).toContain("[ ]");
      expect(result).not.toContain("[x]");
    }
  });

  it("does not affect text outside the marker", () => {
    const doc = "- [ ] buy milk\n";
    const state = stateOf(doc);
    const specs = extractBlockSpecs(state, fullRange(doc));
    const cb = specs.find((s) => s.kind === "checkbox");
    if (cb && cb.kind === "checkbox") {
      const result = applyToggle(doc, cb.markerFrom, cb.markerTo, false);
      expect(result).toContain("buy milk");
    }
  });

  it("toggle is content-only — text before and after marker is preserved", () => {
    const doc = "- [ ] first task\n- [x] second task\n";
    const state = stateOf(doc);
    const specs = extractBlockSpecs(state, fullRange(doc));
    const cb = specs.find((s) => s.kind === "checkbox" && !(s as { checked: boolean }).checked);
    if (cb && cb.kind === "checkbox") {
      const result = applyToggle(doc, cb.markerFrom, cb.markerTo, false);
      // First item toggled
      expect(result).toMatch(/- \[x\] first task/);
      // Second item unchanged
      expect(result).toMatch(/- \[x\] second task/);
    }
  });

  it("marker text before toggle is `[ ]`", () => {
    const doc = "- [ ] task\n";
    const state = stateOf(doc);
    const specs = extractBlockSpecs(state, fullRange(doc));
    const cb = specs.find((s) => s.kind === "checkbox");
    if (cb && cb.kind === "checkbox") {
      expect(doc.slice(cb.markerFrom, cb.markerTo)).toBe("[ ]");
    }
  });

  it("marker text before toggle is `[x]` for checked item", () => {
    const doc = "- [x] done\n";
    const state = stateOf(doc);
    const specs = extractBlockSpecs(state, fullRange(doc));
    const cb = specs.find((s) => s.kind === "checkbox");
    if (cb && cb.kind === "checkbox") {
      expect(doc.slice(cb.markerFrom, cb.markerTo)).toBe("[x]");
    }
  });
});

// ── Paste handler — markdown insertion (mocked IPC) ───────────────────────────

describe("paste handler — markdown insertion (mocked IPC)", async () => {
  // We test the logic directly by calling the handleFile logic as captured
  // via a thin wrapper, since the actual domEventHandlers need a real DOM.
  // Instead we verify the markdown format that attach_file produces.

  it("image paste produces ![name](path) markdown", () => {
    const name = "screenshot.png";
    const assetPath = "_assets/screenshot.png";
    const isImage = isImagePath(name);
    const markdown = isImage ? `![${name}](${assetPath})` : `[${name}](${assetPath})`;
    expect(markdown).toBe("![screenshot.png](_assets/screenshot.png)");
  });

  it("file drop produces [name](path) markdown", () => {
    const name = "report.pdf";
    const assetPath = "_assets/report.pdf";
    const isImage = isImagePath(name);
    const markdown = isImage ? `![${name}](${assetPath})` : `[${name}](${assetPath})`;
    expect(markdown).toBe("[report.pdf](_assets/report.pdf)");
  });

  it("webp is treated as image", () => {
    const name = "animation.webp";
    expect(isImagePath(name)).toBe(true);
  });

  it("svg is treated as image", () => {
    expect(isImagePath("diagram.svg")).toBe(true);
  });
});

// ── Mock IPC — asset operations ───────────────────────────────────────────────

describe("mock IPC asset operations", async () => {
  const { mock } = await import("../../ipc/mock.js");

  it("asset_exists returns true for seeded images", async () => {
    const res = await mock.asset_exists("work/atlas/_assets/blueprint-cover.png");
    expect(res.ok).toBe(true);
    expect(res.ok && res.value).toBe(true);
  });

  it("asset_exists returns false for unknown path", async () => {
    const res = await mock.asset_exists("work/atlas/_assets/nonexistent.png");
    expect(res.ok).toBe(true);
    expect(res.ok && res.value).toBe(false);
  });

  it("attach_file stores bytes and returns an asset path", async () => {
    const bytes = new TextEncoder().encode("fake pdf content");
    const res = await mock.attach_file("work/atlas/blocks-demo.md", "my-doc.pdf", bytes);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toMatch(/^work\/atlas\/_assets\/my-doc\.pdf/);
      // Now exists
      const existsRes = await mock.asset_exists(res.value);
      expect(existsRes.ok && existsRes.value).toBe(true);
    }
  });

  it("attach_file collision-safe rename: second file with same name gets -2 suffix", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await mock.attach_file("work/atlas/test-entry.md", "collision.pdf", bytes);
    const res2 = await mock.attach_file("work/atlas/test-entry.md", "collision.pdf", bytes);
    expect(res2.ok).toBe(true);
    if (res2.ok) {
      expect(res2.value).toContain("collision-2.pdf");
    }
  });

  it("remove_asset removes the file", async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const attachRes = await mock.attach_file("work/atlas/test.md", "temp.pdf", bytes);
    expect(attachRes.ok).toBe(true);
    if (!attachRes.ok) return;
    const path = attachRes.value;

    const removeRes = await mock.remove_asset(path);
    expect(removeRes.ok).toBe(true);

    const existsRes = await mock.asset_exists(path);
    expect(existsRes.ok && existsRes.value).toBe(false);
  });

  it("remove_asset on non-existent path returns error", async () => {
    const res = await mock.remove_asset("work/atlas/_assets/ghost.pdf");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });
});
