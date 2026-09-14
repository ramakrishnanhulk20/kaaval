// The cadence: which window a given instant falls in and how long the engine sleeps
// after it. Does NOT cover the NYSE calendar itself (bitget/hours.test.ts), early
// closes, or what the engine does inside a tick.
import { describe, expect, it } from "vitest";
import { nyseClock } from "../../src/bitget/hours.js";
import type { CalendarEvent } from "../../src/brain/types.js";
import { tickWindow, utcDayKey } from "../../src/engine/clock.js";
import { DEFAULT_RULEBOOK } from "../../src/risk/rulebook.js";

const rb = DEFAULT_RULEBOOK;

function at(iso: string): { now: Date; clock: ReturnType<typeof nyseClock> } {
  const now = new Date(iso);
  return { now, clock: nyseClock(now) };
}

function earningsAt(iso: string): CalendarEvent {
  return { ts: new Date(iso).getTime(), kind: "earnings", title: "NVDA reports", symbol: "NVDA", timing: "after-close" };
}

describe("tickWindow", () => {
  it("runs on the slow cadence in the middle of the night", () => {
    const { now, clock } = at("2026-09-11T02:00:00Z");
    expect(tickWindow(now, clock, [], rb)).toEqual({ window: "normal", nextTickMs: 15 * 60_000 });
  });

  it("speeds up for the hour after a scheduled release", () => {
    const { now, clock } = at("2026-09-11T02:00:00Z");
    const ten = tickWindow(now, clock, [earningsAt("2026-09-11T01:50:00Z")], rb);
    expect(ten).toEqual({ window: "event", nextTickMs: 2 * 60_000 });

    const late = tickWindow(now, clock, [earningsAt("2026-09-11T00:30:00Z")], rb);
    expect(late.window).toBe("normal");

    const notYet = tickWindow(now, clock, [earningsAt("2026-09-11T03:00:00Z")], rb);
    expect(notYet.window).toBe("normal");
  });

  it("speeds up on both sides of the New York open", () => {
    const before = at("2026-09-11T13:25:00Z");
    expect(tickWindow(before.now, before.clock, [], rb)).toEqual({ window: "open", nextTickMs: 2 * 60_000 });

    const after = at("2026-09-11T13:35:00Z");
    expect(after.clock.regularSessionOpen).toBe(true);
    expect(tickWindow(after.now, after.clock, [], rb)).toEqual({ window: "open", nextTickMs: 2 * 60_000 });

    const later = at("2026-09-11T15:00:00Z");
    expect(tickWindow(later.now, later.clock, [], rb).window).toBe("normal");
  });

  it("gives an event the faster cadence even inside the open window", () => {
    const { now, clock } = at("2026-09-11T13:35:00Z");
    const window = tickWindow(now, clock, [earningsAt("2026-09-11T13:30:00Z")], rb);
    expect(window.window).toBe("event");
  });
});

describe("utcDayKey", () => {
  it("names the UTC day, not the local one", () => {
    expect(utcDayKey(Date.parse("2026-09-11T23:59:59Z"))).toBe("2026-09-11");
    expect(utcDayKey(Date.parse("2026-09-12T00:00:00Z"))).toBe("2026-09-12");
  });
});
