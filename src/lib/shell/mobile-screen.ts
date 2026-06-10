// Mobile screen state machine — spec 0013 §Touch translation / zones → screens.
//
// On narrow viewports (<700px), focus zones become full-screen views.
// The machine tracks which screen is visible and manages back-navigation.
//
// Screens:
//   list        — EntryList (default landing)
//   editor      — Editor (+ CalendarView / PersonView / TagBrowser as sub-views)
//   sidebar     — Group tree navigation
//   calendar    — CalendarView full-screen
//   person      — PersonView full-screen
//   tags        — TagBrowser full-screen
//   settings    — Settings full-screen (stub #24)
//   properties  — PropertiesPanel bottom sheet (layered on editor)
//
// "properties" is a sheet, not a full-screen push, so it has separate open/close
// rather than replacing the current screen in the stack.

export type MobileScreen =
  | "list"
  | "editor"
  | "sidebar"
  | "calendar"
  | "person"
  | "tags"
  | "settings";

export interface MobileScreenState {
  /** Currently visible full-screen. */
  screen: MobileScreen;
  /** Properties sheet is open (layered on top of any screen). */
  propertiesOpen: boolean;
  /** Back-navigation history (stack, top = most recent). */
  history: MobileScreen[];
}

export function initialMobileScreenState(): MobileScreenState {
  return { screen: "list", propertiesOpen: false, history: [] };
}

export type MobileScreenEvent =
  | { type: "push"; screen: MobileScreen }
  | { type: "back" }
  | { type: "home" }
  | { type: "open-properties" }
  | { type: "close-properties" }
  | { type: "toggle-properties" }
  | { type: "widen" }; // viewport widens → collapse to desktop fallback

/**
 * Pure state-machine reducer for mobile screen transitions.
 * Returns the next state (immutable).
 */
export function mobileScreenReduce(
  state: MobileScreenState,
  event: MobileScreenEvent,
): MobileScreenState {
  switch (event.type) {
    case "push": {
      const screen = event.screen;
      if (screen === state.screen) return state; // no-op
      return {
        screen,
        propertiesOpen: false, // sheets close on navigation
        history: [...state.history, state.screen],
      };
    }

    case "back": {
      if (state.propertiesOpen) {
        // First back closes the sheet without navigating.
        return { ...state, propertiesOpen: false };
      }
      if (state.history.length === 0) {
        // Nothing to go back to; stay on current screen.
        return state;
      }
      const history = [...state.history];
      const screen = history.pop()!;
      return { screen, propertiesOpen: false, history };
    }

    case "home":
      return { screen: "list", propertiesOpen: false, history: [] };

    case "open-properties":
      return { ...state, propertiesOpen: true };

    case "close-properties":
      return { ...state, propertiesOpen: false };

    case "toggle-properties":
      return { ...state, propertiesOpen: !state.propertiesOpen };

    case "widen":
      // Viewport widened; keep editor as the active zone for the shell to reset.
      return { screen: "editor", propertiesOpen: false, history: [] };

    default:
      return state;
  }
}

/** Which screen to show — convenience accessor. */
export function screenTitle(screen: MobileScreen): string {
  const labels: Record<MobileScreen, string> = {
    list: "Entries",
    editor: "Editor",
    sidebar: "Groups",
    calendar: "Calendar",
    person: "Person",
    tags: "Tags",
    settings: "Settings",
  };
  return labels[screen] ?? screen;
}

/** True for screens that should show a back button. */
export function hasBack(state: MobileScreenState): boolean {
  if (state.propertiesOpen) return true;
  return state.history.length > 0;
}
