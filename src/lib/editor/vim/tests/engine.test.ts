// @vitest-environment happy-dom
//
// Vim modal engine — mode transitions, operators, live deactivation, and
// editor-zone scoping (spec 0007 §Modal vs modeless + acceptance criteria).
//
// These drive a real CodeMirror EditorView in a DOM, dispatching keydown
// events the way the browser would, and assert on document text, selection,
// and the mode field.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { vimCompartment, modalEnabled, currentMode, isModalActive } from "../index.js";
import { setRegister } from "../operators.js";

// ── Harness ──────────────────────────────────────────────────────────────────

let view: EditorView;

function mount(doc: string, enabled = true, selectionAnchor = 0): EditorView {
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: { anchor: selectionAnchor },
      extensions: [vimCompartment.of(modalEnabled(enabled))],
    }),
  });
  view.focus();
  return view;
}

/** Dispatch a single bare-key keydown into the editor's content DOM. */
function press(key: string): void {
  const target = view.contentDOM;
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
}

function type(keys: string): void {
  for (const k of keys) press(k);
}

function head(): number {
  return view.state.selection.main.head;
}

function doc(): string {
  return view.state.doc.toString();
}

beforeEach(() => {
  setRegister("", false);
});

afterEach(() => {
  view?.destroy();
  document.body.innerHTML = "";
});

// ── Mode transitions ─────────────────────────────────────────────────────────

describe("mode transitions", () => {
  it("opens in normal mode when the engine is enabled", () => {
    mount("hello");
    expect(currentMode(view)).toBe("normal");
  });

  it("i enters insert mode", () => {
    mount("hello");
    press("i");
    expect(currentMode(view)).toBe("insert");
  });

  it("Escape returns to normal mode", () => {
    mount("hello");
    press("i");
    expect(currentMode(view)).toBe("insert");
    press("Escape");
    expect(currentMode(view)).toBe("normal");
  });

  it("a enters insert mode one column to the right", () => {
    mount("hello", true, 1);
    press("a");
    expect(currentMode(view)).toBe("insert");
    expect(head()).toBe(2);
  });

  it("A enters insert at the end of the line", () => {
    mount("hello", true, 0);
    press("A");
    expect(currentMode(view)).toBe("insert");
    expect(head()).toBe(5);
  });

  it("I enters insert at the line start", () => {
    mount("hello", true, 3);
    press("I");
    expect(head()).toBe(0);
  });

  it("o opens a line below and enters insert", () => {
    mount("a\nb", true, 0);
    press("o");
    expect(currentMode(view)).toBe("insert");
    expect(doc()).toBe("a\n\nb");
    expect(head()).toBe(2);
  });

  it("O opens a line above and enters insert", () => {
    mount("a\nb", true, 2);
    press("O");
    expect(currentMode(view)).toBe("insert");
    expect(doc()).toBe("a\n\nb");
  });

  it("v toggles visual mode", () => {
    mount("hello");
    press("v");
    expect(currentMode(view)).toBe("visual");
    press("v");
    expect(currentMode(view)).toBe("normal");
  });
});

// ── Motions move the cursor ──────────────────────────────────────────────────

describe("normal-mode motions move the cursor", () => {
  it("l moves right, h moves left", () => {
    mount("hello", true, 0);
    press("l");
    expect(head()).toBe(1);
    press("h");
    expect(head()).toBe(0);
  });

  it("j moves down a line", () => {
    mount("abc\ndef", true, 1);
    press("j");
    expect(head()).toBe(5); // line 2, col 1
  });

  it("gg jumps to document start, G to the last line", () => {
    mount("one\ntwo\nthree", true, 5);
    press("G");
    expect(head()).toBe(8); // start of "three"
    type("gg");
    expect(head()).toBe(0);
  });

  it("ignores stray printable keys in normal mode (does not type)", () => {
    mount("hi", true, 0);
    press("z");
    expect(doc()).toBe("hi");
  });
});

// ── Operators ────────────────────────────────────────────────────────────────

describe("operators", () => {
  it("x deletes the character under the cursor", () => {
    mount("hello", true, 0);
    press("x");
    expect(doc()).toBe("ello");
  });

  it("dd deletes the current line", () => {
    mount("one\ntwo\nthree", true, 4); // on "two"
    type("dd");
    expect(doc()).toBe("one\nthree");
  });

  it("yy then p pastes the line below", () => {
    mount("one\ntwo", true, 0); // on "one"
    type("yy");
    type("p");
    expect(doc()).toBe("one\none\ntwo");
  });

  it("dd then p moves a line", () => {
    mount("a\nb\nc", true, 0); // on "a"
    type("dd"); // doc: "b\nc", register holds "a\n"
    expect(doc()).toBe("b\nc");
    type("p"); // paste below current line ("b")
    expect(doc()).toBe("b\na\nc");
  });
});

// ── Insert mode passes keys through ──────────────────────────────────────────

describe("insert mode does not intercept", () => {
  it("printable keys in insert mode are not swallowed by the engine", () => {
    mount("", true, 0);
    press("i");
    // In insert mode the DOM handler returns false → default not prevented.
    const event = new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("normal-mode keys are swallowed (defaultPrevented)", () => {
    mount("hello", true, 0);
    const event = new KeyboardEvent("keydown", { key: "l", bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

// ── Live deactivation (preset switch back to default) ────────────────────────

describe("deactivation on preset switch", () => {
  it("reconfiguring the compartment to disabled removes the engine entirely", () => {
    mount("hello", true, 0);
    expect(isModalActive(view)).toBe(true);

    view.dispatch({ effects: vimCompartment.reconfigure(modalEnabled(false)) });
    expect(isModalActive(view)).toBe(false);

    // With the engine gone, a bare 'l' is no longer intercepted.
    const event = new KeyboardEvent("keydown", { key: "l", bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("re-enabling the compartment restores normal mode", () => {
    mount("hello", false, 0);
    expect(isModalActive(view)).toBe(false);
    view.dispatch({ effects: vimCompartment.reconfigure(modalEnabled(true)) });
    expect(isModalActive(view)).toBe(true);
    expect(currentMode(view)).toBe("normal");
  });
});

// ── Editor-zone scoping ──────────────────────────────────────────────────────

describe("editor-zone scoping", () => {
  it("a plain text input (e.g. the search box) is unaffected by the engine", () => {
    // The modal engine is a CM extension installed only on the editor view; an
    // ordinary <input> shares no state with it. Typing 'i' there must insert a
    // literal character, not switch to insert mode.
    mount("hello", true, 0);
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);
    input.focus();

    // Simulate typing into the input — the engine has no handler bound here.
    const event = new KeyboardEvent("keydown", { key: "i", bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    // The editor's own mode is untouched by events on the input.
    expect(currentMode(view)).toBe("normal");
  });
});

// ── Disabled engine is fully inert ───────────────────────────────────────────

describe("engine off", () => {
  it("does not install the mode field when disabled", () => {
    mount("hello", false, 0);
    expect(isModalActive(view)).toBe(false);
  });

  it("does not intercept keys when disabled", () => {
    mount("hello", false, 0);
    const event = new KeyboardEvent("keydown", { key: "l", bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
