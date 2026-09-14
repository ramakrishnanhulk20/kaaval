import type { MarketClock } from "../bitget/hours.js";
import type { CalendarEvent } from "../brain/types.js";
import type { Rulebook } from "../risk/rulebook.js";

const MS_PER_MINUTE = 60_000;

/** 09:30 New York, as minutes from midnight, the only hard-coded time the engine needs. */
const OPEN_MINUTE_OF_DAY = 9 * 60 + 30;

export type TickWindow = "normal" | "event" | "open";

/**
 * Which cadence the engine is on right now, and how long until the next tick.
 *
 * Two windows earn the faster cadence: the hour after a scheduled release, when the
 * only market open to trade the reaction is this one, and the half hour either side of
 * the New York open, when Bitget's own guidance says rToken prices re-anchor. An event
 * wins a tie with the open, because an earnings release inside the open window is the
 * more urgent of the two.
 *
 * The minutes since the open are read from the clock's own ET string rather than
 * recomputed, so this function stays pure and has one source for the wall clock.
 */
export function tickWindow(
  now: Date,
  clock: MarketClock,
  calendar: CalendarEvent[],
  rb: Rulebook,
): { window: TickWindow; nextTickMs: number } {
  const nowMs = now.getTime();
  const eventWindowMs = rb.cadence.eventWindowMinutes * MS_PER_MINUTE;
  const openWindowMs = rb.cadence.openWindowMinutes * MS_PER_MINUTE;

  const inEvent = calendar.some((event) => {
    const since = nowMs - event.ts;
    return since >= 0 && since <= eventWindowMs;
  });
  if (inEvent) return { window: "event", nextTickMs: rb.cadence.eventMinutes * MS_PER_MINUTE };

  const toOpen = clock.nextRegularOpen - nowMs;
  const beforeOpen = toOpen >= 0 && toOpen <= openWindowMs;
  const minuteNow = minuteOfDay(clock.nowEt);
  const afterOpen =
    clock.regularSessionOpen &&
    minuteNow !== null &&
    minuteNow - OPEN_MINUTE_OF_DAY >= 0 &&
    (minuteNow - OPEN_MINUTE_OF_DAY) * MS_PER_MINUTE <= openWindowMs;
  if (beforeOpen || afterOpen) {
    return { window: "open", nextTickMs: rb.cadence.eventMinutes * MS_PER_MINUTE };
  }

  return { window: "normal", nextTickMs: rb.cadence.normalMinutes * MS_PER_MINUTE };
}

/**
 * The day a tick belongs to, in UTC. Every daily limit is measured against this key
 * rather than against a New York date, so the reset happens at one instant worldwide
 * and never twice on a clock-change weekend.
 */
export function utcDayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function minuteOfDay(nowEt: string): number | null {
  const match = /(\d{1,2}):(\d{2})/.exec(nowEt);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}
