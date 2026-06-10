import { describe, it, expect } from "vitest";
import {
  initialMobileScreenState,
  mobileScreenReduce,
  screenTitle,
  hasBack,
  type MobileScreen,
  type MobileScreenState,
} from "../mobile-screen.js";

// ── initial state ──────────────────────────────────────────────────────────────

describe("initialMobileScreenState", () => {
  it("starts on list screen", () => {
    const s = initialMobileScreenState();
    expect(s.screen).toBe("list");
    expect(s.propertiesOpen).toBe(false);
    expect(s.history).toHaveLength(0);
  });
});

// ── push ───────────────────────────────────────────────────────────────────────

describe("push event", () => {
  it("navigates to the new screen", () => {
    const s = initialMobileScreenState();
    const next = mobileScreenReduce(s, { type: "push", screen: "editor" });
    expect(next.screen).toBe("editor");
  });

  it("pushes previous screen onto history", () => {
    const s = initialMobileScreenState(); // list
    const next = mobileScreenReduce(s, { type: "push", screen: "calendar" });
    expect(next.history).toContain("list");
  });

  it("is a no-op when already on that screen", () => {
    const s = initialMobileScreenState();
    const next = mobileScreenReduce(s, { type: "push", screen: "list" });
    expect(next).toBe(s); // same reference
  });

  it("closes properties sheet when pushing", () => {
    const s: MobileScreenState = { screen: "list", propertiesOpen: true, history: [] };
    const next = mobileScreenReduce(s, { type: "push", screen: "editor" });
    expect(next.propertiesOpen).toBe(false);
  });

  it("all screens are reachable from list", () => {
    const screens: MobileScreen[] = ["editor", "sidebar", "calendar", "person", "tags", "settings"];
    const s = initialMobileScreenState();
    for (const screen of screens) {
      const next = mobileScreenReduce(s, { type: "push", screen });
      expect(next.screen).toBe(screen);
    }
  });

  it("builds history across multiple pushes", () => {
    let s = initialMobileScreenState(); // list
    s = mobileScreenReduce(s, { type: "push", screen: "sidebar" });
    s = mobileScreenReduce(s, { type: "push", screen: "calendar" });
    s = mobileScreenReduce(s, { type: "push", screen: "editor" });
    expect(s.screen).toBe("editor");
    expect(s.history).toEqual(["list", "sidebar", "calendar"]);
  });
});

// ── back ───────────────────────────────────────────────────────────────────────

describe("back event", () => {
  it("pops history to restore previous screen", () => {
    let s = initialMobileScreenState();
    s = mobileScreenReduce(s, { type: "push", screen: "editor" });
    s = mobileScreenReduce(s, { type: "back" });
    expect(s.screen).toBe("list");
    expect(s.history).toHaveLength(0);
  });

  it("stays put when history is empty", () => {
    const s = initialMobileScreenState();
    const next = mobileScreenReduce(s, { type: "back" });
    expect(next).toBe(s);
  });

  it("back with properties open → closes sheet, stays on screen", () => {
    const s: MobileScreenState = { screen: "editor", propertiesOpen: true, history: ["list"] };
    const next = mobileScreenReduce(s, { type: "back" });
    expect(next.propertiesOpen).toBe(false);
    expect(next.screen).toBe("editor");
    // History untouched — next back will pop
    expect(next.history).toHaveLength(1);
  });

  it("second back after sheet close pops history", () => {
    let s: MobileScreenState = { screen: "editor", propertiesOpen: true, history: ["list"] };
    s = mobileScreenReduce(s, { type: "back" }); // closes sheet
    s = mobileScreenReduce(s, { type: "back" }); // pops history
    expect(s.screen).toBe("list");
    expect(s.history).toHaveLength(0);
  });
});

// ── home ──────────────────────────────────────────────────────────────────────

describe("home event", () => {
  it("resets to list and clears everything", () => {
    let s = initialMobileScreenState();
    s = mobileScreenReduce(s, { type: "push", screen: "calendar" });
    s = mobileScreenReduce(s, { type: "push", screen: "editor" });
    const next = mobileScreenReduce(s, { type: "home" });
    expect(next.screen).toBe("list");
    expect(next.history).toHaveLength(0);
    expect(next.propertiesOpen).toBe(false);
  });
});

// ── properties sheet ──────────────────────────────────────────────────────────

describe("properties sheet events", () => {
  it("open-properties sets propertiesOpen", () => {
    const s = initialMobileScreenState();
    const next = mobileScreenReduce(s, { type: "open-properties" });
    expect(next.propertiesOpen).toBe(true);
  });

  it("close-properties clears propertiesOpen", () => {
    const s: MobileScreenState = { screen: "editor", propertiesOpen: true, history: [] };
    const next = mobileScreenReduce(s, { type: "close-properties" });
    expect(next.propertiesOpen).toBe(false);
  });

  it("toggle-properties toggles the flag", () => {
    const s = initialMobileScreenState();
    const open = mobileScreenReduce(s, { type: "toggle-properties" });
    expect(open.propertiesOpen).toBe(true);
    const closed = mobileScreenReduce(open, { type: "toggle-properties" });
    expect(closed.propertiesOpen).toBe(false);
  });
});

// ── widen ─────────────────────────────────────────────────────────────────────

describe("widen event", () => {
  it("collapses to editor screen and clears history", () => {
    let s = initialMobileScreenState();
    s = mobileScreenReduce(s, { type: "push", screen: "calendar" });
    const next = mobileScreenReduce(s, { type: "widen" });
    expect(next.screen).toBe("editor");
    expect(next.history).toHaveLength(0);
    expect(next.propertiesOpen).toBe(false);
  });
});

// ── hasBack / screenTitle ─────────────────────────────────────────────────────

describe("hasBack", () => {
  it("false with no history and no sheet", () => {
    expect(hasBack(initialMobileScreenState())).toBe(false);
  });

  it("true with history", () => {
    const s: MobileScreenState = { screen: "editor", propertiesOpen: false, history: ["list"] };
    expect(hasBack(s)).toBe(true);
  });

  it("true when properties open", () => {
    const s: MobileScreenState = { screen: "editor", propertiesOpen: true, history: [] };
    expect(hasBack(s)).toBe(true);
  });
});

describe("screenTitle", () => {
  const cases: Array<[MobileScreen, string]> = [
    ["list", "Entries"],
    ["editor", "Editor"],
    ["sidebar", "Groups"],
    ["calendar", "Calendar"],
    ["person", "Person"],
    ["tags", "Tags"],
    ["settings", "Settings"],
  ];

  for (const [screen, label] of cases) {
    it(`${screen} → "${label}"`, () => {
      expect(screenTitle(screen)).toBe(label);
    });
  }
});
