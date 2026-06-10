import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  pullDownStep,
  pullDownProgress,
  startLongPress,
  type PullDownState,
} from "../mobile-gestures.js";

// ── pullDownStep ───────────────────────────────────────────────────────────────

describe("pullDownStep — idle → tracking", () => {
  it("transitions to tracking on start", () => {
    const state: PullDownState = { phase: "idle" };
    const next = pullDownStep(state, { type: "start", x: 100, y: 50 });
    expect(next.phase).toBe("tracking");
    if (next.phase === "tracking") {
      expect(next.startY).toBe(50);
      expect(next.startX).toBe(100);
    }
  });
});

describe("pullDownStep — tracking moves", () => {
  const tracking: PullDownState = { phase: "tracking", startY: 10, startX: 50, currentY: 10 };

  it("stays tracking below threshold", () => {
    const next = pullDownStep(tracking, { type: "move", x: 50, y: 60 }); // delta=50, default=60
    expect(next.phase).toBe("tracking");
  });

  it("triggers when threshold crossed (default 60)", () => {
    const next = pullDownStep(tracking, { type: "move", x: 50, y: 71 }); // delta=61
    expect(next.phase).toBe("triggered");
  });

  it("cancels on excessive horizontal drift", () => {
    const next = pullDownStep(tracking, { type: "move", x: 90, y: 30 }); // drift=40 > maxDrift=30
    expect(next.phase).toBe("cancelled");
  });

  it("does not trigger on upward move", () => {
    const next = pullDownStep(tracking, { type: "move", x: 50, y: 5 }); // negative delta
    expect(next.phase).toBe("tracking");
  });

  it("respects custom threshold", () => {
    const next = pullDownStep(tracking, { type: "move", x: 50, y: 41 }, { threshold: 30 });
    expect(next.phase).toBe("triggered");
  });

  it("respects custom maxDrift", () => {
    // drift = 20, maxDrift = 10 → cancel
    const next = pullDownStep(tracking, { type: "move", x: 70, y: 20 }, { maxDrift: 10 });
    expect(next.phase).toBe("cancelled");
  });
});

describe("pullDownStep — end/cancel", () => {
  it("resets to idle on end", () => {
    const tracking: PullDownState = { phase: "tracking", startY: 10, startX: 50, currentY: 30 };
    const next = pullDownStep(tracking, { type: "end", x: 0, y: 0 });
    expect(next.phase).toBe("idle");
  });

  it("resets to idle on cancel", () => {
    const tracking: PullDownState = { phase: "tracking", startY: 10, startX: 50, currentY: 30 };
    const next = pullDownStep(tracking, { type: "cancel", x: 0, y: 0 });
    expect(next.phase).toBe("idle");
  });

  it("ignores move when not tracking", () => {
    const idle: PullDownState = { phase: "idle" };
    const next = pullDownStep(idle, { type: "move", x: 50, y: 100 });
    expect(next.phase).toBe("idle");
  });
});

describe("pullDownStep — no double-trigger", () => {
  it("stays triggered once threshold is crossed", () => {
    const tracking: PullDownState = { phase: "tracking", startY: 10, startX: 50, currentY: 10 };
    const triggered = pullDownStep(tracking, { type: "move", x: 50, y: 75 });
    expect(triggered.phase).toBe("triggered");
    // Further moves don't change phase (caller resets on trigger)
    const next = pullDownStep(triggered, { type: "move", x: 50, y: 100 });
    expect(next.phase).toBe("triggered");
  });
});

// ── pullDownProgress ───────────────────────────────────────────────────────────

describe("pullDownProgress", () => {
  it("returns 0 for idle state", () => {
    expect(pullDownProgress({ phase: "idle" })).toBe(0);
  });

  it("returns 0 for triggered state", () => {
    expect(pullDownProgress({ phase: "triggered" })).toBe(0);
  });

  it("returns fractional progress", () => {
    const tracking: PullDownState = { phase: "tracking", startY: 0, startX: 0, currentY: 30 };
    const progress = pullDownProgress(tracking, { threshold: 60 });
    expect(progress).toBeCloseTo(0.5);
  });

  it("clamps to [0, 1]", () => {
    const tracking: PullDownState = { phase: "tracking", startY: 0, startX: 0, currentY: 200 };
    expect(pullDownProgress(tracking)).toBe(1);
    const negTracking: PullDownState = { phase: "tracking", startY: 100, startX: 0, currentY: 50 };
    expect(pullDownProgress(negTracking)).toBe(0);
  });
});

// ── startLongPress ─────────────────────────────────────────────────────────────

describe("startLongPress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires onFire after duration", () => {
    const onFire = vi.fn();
    startLongPress(onFire, { duration: 500 });
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("uses default 500ms duration", () => {
    const onFire = vi.fn();
    startLongPress(onFire);
    vi.advanceTimersByTime(499);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("cancel prevents firing", () => {
    const onFire = vi.fn();
    const handle = startLongPress(onFire, { duration: 500 });
    vi.advanceTimersByTime(200);
    handle.cancel();
    vi.advanceTimersByTime(400);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("handle.done is false before firing", () => {
    const handle = startLongPress(() => {}, { duration: 500 });
    expect(handle.done).toBe(false);
  });

  it("handle.done is true after firing", () => {
    const handle = startLongPress(() => {}, { duration: 500 });
    vi.advanceTimersByTime(500);
    expect(handle.done).toBe(true);
  });

  it("handle.done is true after cancel", () => {
    const handle = startLongPress(() => {}, { duration: 500 });
    handle.cancel();
    expect(handle.done).toBe(true);
  });

  it("fires exactly once even if cancel called after fire", () => {
    const onFire = vi.fn();
    const handle = startLongPress(onFire, { duration: 100 });
    vi.advanceTimersByTime(100);
    handle.cancel(); // no-op after fire
    expect(onFire).toHaveBeenCalledTimes(1);
  });
});
