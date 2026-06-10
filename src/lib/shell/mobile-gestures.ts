// Mobile gesture recognizers — pure logic, no DOM side effects.
// Extracted as testable functions per spec 0013.
//
// Covers:
//   • pull-down-to-open-palette (touchstart/touchmove on app-bar region)
//   • long-press timer (entry rows, chips)

// ── Pull-down gesture ─────────────────────────────────────────────────────────

export interface PullDownOptions {
  /** Vertical pixels downward required to trigger. Default: 60. */
  threshold?: number;
  /** Max horizontal drift allowed before cancelling. Default: 30. */
  maxDrift?: number;
}

export type PullDownState =
  | { phase: "idle" }
  | { phase: "tracking"; startY: number; startX: number; currentY: number }
  | { phase: "triggered" }
  | { phase: "cancelled" };

/**
 * Pure state-machine step for the pull-down gesture.
 *
 * Callers feed touch events (as minimal {x,y} coords) and receive the next
 * state. "triggered" fires once when the threshold is crossed; subsequent
 * moves stay in "tracking" but the caller should treat "triggered" as a
 * one-shot signal.
 */
export function pullDownStep(
  state: PullDownState,
  event: { type: "start" | "move" | "end" | "cancel"; x: number; y: number },
  opts: PullDownOptions = {},
): PullDownState {
  const threshold = opts.threshold ?? 60;
  const maxDrift = opts.maxDrift ?? 30;

  switch (event.type) {
    case "start":
      return { phase: "tracking", startY: event.y, startX: event.x, currentY: event.y };

    case "move": {
      if (state.phase !== "tracking") return state;
      const deltaY = event.y - state.startY;
      const deltaX = Math.abs(event.x - state.startX);
      // Cancel if too much horizontal drift
      if (deltaX > maxDrift) return { phase: "cancelled" };
      // Trigger once threshold crossed
      if (deltaY >= threshold) return { phase: "triggered" };
      return { ...state, currentY: event.y };
    }

    case "end":
    case "cancel":
      return { phase: "idle" };

    default:
      return state;
  }
}

/**
 * Progress [0, 1] of the pull-down (for visual affordance).
 * Returns 0 when not tracking.
 */
export function pullDownProgress(state: PullDownState, opts: PullDownOptions = {}): number {
  if (state.phase !== "tracking") return 0;
  const threshold = opts.threshold ?? 60;
  const delta = state.currentY - state.startY;
  return Math.min(1, Math.max(0, delta / threshold));
}

// ── Long-press timer ──────────────────────────────────────────────────────────

export interface LongPressOptions {
  /** Duration in ms before the long-press fires. Default: 500. */
  duration?: number;
}

export interface LongPressHandle {
  /** Cancel the pending long-press (e.g. on pointerup/pointercancel). */
  cancel: () => void;
  /** true if the handle has already fired or been cancelled. */
  readonly done: boolean;
}

/**
 * Start a long-press timer. Calls `onFire` after `duration` ms unless
 * `handle.cancel()` is called first.
 *
 * Returns a handle to cancel the press.
 */
export function startLongPress(onFire: () => void, opts: LongPressOptions = {}): LongPressHandle {
  const duration = opts.duration ?? 500;
  let _done = false;
  const id = setTimeout(() => {
    if (!_done) {
      _done = true;
      onFire();
    }
  }, duration);

  return {
    cancel() {
      if (!_done) {
        _done = true;
        clearTimeout(id);
      }
    },
    get done() {
      return _done;
    },
  };
}
