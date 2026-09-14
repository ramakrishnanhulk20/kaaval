import type { BitgetContext } from "./client.js";
import { getCandles } from "./market.js";
import type { Category, Instrument } from "./types.js";

export interface MarketClock {
  nowEt: string;
  regularSessionOpen: boolean;
  isWeekend: boolean;
  isHoliday: boolean;
  lastRegularClose: number;
  nextRegularOpen: number;
}

export interface Tradability {
  tradable: boolean;
  venue: "rtoken-spot" | "stock-perp" | "crypto-perp";
  reason: string;
  nextOpen?: number;
  nextClose?: number;
}

const ET_ZONE = "America/New_York";
const OPEN_HOUR = 9;
const OPEN_MINUTE = 30;
const CLOSE_HOUR = 16;
const CLOSE_MINUTE = 0;

/**
 * NYSE full-day closures for 2026 and 2027, from the exchange's own holiday page:
 * https://www.nyse.com/markets/hours-calendars
 *
 * Early closes (1:00 pm ET on the day after Thanksgiving, Christmas Eve and July 3
 * when it falls on a weekday) are NOT handled here. On those days this clock reports
 * the session open until 16:00 ET while the real tape stopped at 13:00, so anything
 * that must be exact on an early close needs its own check. Dates outside 2026 and
 * 2027 are treated as ordinary trading days: extend the list before then.
 */
const HOLIDAYS = new Set<string>([
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03",
  "2026-09-07",
  "2026-11-26",
  "2026-12-25",
  "2027-01-01",
  "2027-01-18",
  "2027-02-15",
  "2027-03-26",
  "2027-05-31",
  "2027-06-18",
  "2027-07-05",
  "2027-09-06",
  "2027-11-25",
  "2027-12-24",
]);

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: ET_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface EtParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function etParts(date: Date): EtParts {
  const found: Record<string, number> = {};
  for (const part of ET_PARTS.formatToParts(date)) {
    if (part.type !== "literal") {
      found[part.type] = Number(part.value);
    }
  }
  return {
    year: found["year"] ?? 0,
    month: found["month"] ?? 0,
    day: found["day"] ?? 0,
    hour: found["hour"] ?? 0,
    minute: found["minute"] ?? 0,
    second: found["second"] ?? 0,
  };
}

/** How far New York was from UTC at this instant, taken from Intl rather than a rule. */
function etOffsetMs(date: Date): number {
  const p = etParts(date);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime();
}

/**
 * The UTC instant of an ET wall-clock time. The offset is resolved twice because the
 * first guess uses the offset of the wrong side of a daylight-saving change on the two
 * days a year the clocks move.
 */
function etInstant(year: number, month: number, day: number, hour: number, minute: number): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - etOffsetMs(new Date(wall));
  return wall - etOffsetMs(new Date(first));
}

function dateKey(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function weekdayIndex(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function isWeekendDay(year: number, month: number, day: number): boolean {
  const weekday = weekdayIndex(year, month, day);
  return weekday === 0 || weekday === 6;
}

function isTradingDay(year: number, month: number, day: number): boolean {
  return !isWeekendDay(year, month, day) && !HOLIDAYS.has(dateKey(year, month, day));
}

function shiftDay(p: EtParts, days: number): { year: number; month: number; day: number } {
  const moved = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return {
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(),
  };
}

/** Two weeks covers the longest run of weekend and holiday closures on the calendar. */
const SEARCH_DAYS = 14;

function lastRegularCloseBefore(p: EtParts, nowMs: number): number {
  for (let back = 0; back <= SEARCH_DAYS; back += 1) {
    const d = shiftDay(p, -back);
    if (!isTradingDay(d.year, d.month, d.day)) continue;
    const close = etInstant(d.year, d.month, d.day, CLOSE_HOUR, CLOSE_MINUTE);
    if (close <= nowMs) return close;
  }
  throw new Error("no NYSE regular close found in the last two weeks, check the holiday list");
}

function nextRegularOpenAfter(p: EtParts, nowMs: number): number {
  for (let ahead = 0; ahead <= SEARCH_DAYS; ahead += 1) {
    const d = shiftDay(p, ahead);
    if (!isTradingDay(d.year, d.month, d.day)) continue;
    const open = etInstant(d.year, d.month, d.day, OPEN_HOUR, OPEN_MINUTE);
    if (open > nowMs) return open;
  }
  throw new Error("no NYSE regular open found in the next two weeks, check the holiday list");
}

function nextRegularCloseAfter(p: EtParts, nowMs: number): number {
  for (let ahead = 0; ahead <= SEARCH_DAYS; ahead += 1) {
    const d = shiftDay(p, ahead);
    if (!isTradingDay(d.year, d.month, d.day)) continue;
    const close = etInstant(d.year, d.month, d.day, CLOSE_HOUR, CLOSE_MINUTE);
    if (close > nowMs) return close;
  }
  throw new Error("no NYSE regular close found in the next two weeks, check the holiday list");
}

/**
 * Where the New York trading day stands right now.
 *
 * Regular session is 09:30 to 16:00 ET, open at 09:30 and closed at 16:00 exactly.
 * Daylight saving comes from Intl, never from a hand-written rule, so the two clock
 * changes a year need no code of their own.
 */
export function nyseClock(now: Date = new Date()): MarketClock {
  const nowMs = now.getTime();
  const p = etParts(now);
  const minuteOfDay = p.hour * 60 + p.minute;
  const openMinute = OPEN_HOUR * 60 + OPEN_MINUTE;
  const closeMinute = CLOSE_HOUR * 60 + CLOSE_MINUTE;
  const weekend = isWeekendDay(p.year, p.month, p.day);
  const holiday = HOLIDAYS.has(dateKey(p.year, p.month, p.day));

  return {
    nowEt: `${dateKey(p.year, p.month, p.day)} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:${String(p.second).padStart(2, "0")} ET`,
    regularSessionOpen:
      !weekend && !holiday && minuteOfDay >= openMinute && minuteOfDay < closeMinute,
    isWeekend: weekend,
    isHoliday: holiday,
    lastRegularClose: lastRegularCloseBefore(p, nowMs),
    nextRegularOpen: nextRegularOpenAfter(p, nowMs),
  };
}

/**
 * Whether this instrument can be traded at this instant, and on which venue.
 *
 * Perpetuals run around the clock on Bitget, weekends included, so they are always
 * tradable. An rToken is tradable when it is one of the round-the-clock listings or
 * when the New York regular session is open. Bitget's API does not publish which
 * rTokens are round-the-clock, so roundTheClock is an input here and is measured by
 * classifyWeekendTrading, not guessed from the symbol.
 */
export function tradableNow(
  instrument: Instrument,
  roundTheClock: boolean,
  now: Date = new Date(),
): Tradability {
  const venue: Tradability["venue"] =
    instrument.category === "USDT-FUTURES"
      ? instrument.isStock
        ? "stock-perp"
        : "crypto-perp"
      : "rtoken-spot";

  if (instrument.status !== "online") {
    return { tradable: false, venue, reason: `Bitget lists the status as ${instrument.status}` };
  }

  if (instrument.category === "USDT-FUTURES") {
    return {
      tradable: true,
      venue,
      reason:
        venue === "stock-perp"
          ? "stock perpetual, trades on Bitget through nights, weekends and holidays"
          : "crypto perpetual, trades around the clock",
    };
  }

  const clock = nyseClock(now);
  if (roundTheClock) {
    return {
      tradable: true,
      venue,
      reason: "rToken trades round the clock, proven by volume outside US market hours",
    };
  }
  if (clock.regularSessionOpen) {
    return {
      tradable: true,
      venue,
      reason: "rToken follows US market hours and the regular session is open",
      nextClose: nextRegularCloseAfter(etParts(now), now.getTime()),
    };
  }
  const why = clock.isHoliday
    ? "a US market holiday"
    : clock.isWeekend
      ? "the weekend"
      : "outside 09:30 to 16:00 ET";
  return {
    tradable: false,
    venue,
    reason: `rToken follows US market hours and it is ${why}`,
    nextOpen: clock.nextRegularOpen,
  };
}

/**
 * Bitget's public history-candles endpoint starts answering 429 at roughly nine
 * requests a second, measured on 2026-09-08 by bursting it at rising concurrency.
 * Three workers ran at about 7.8 requests a second with no refusals, so all 699
 * rTokens take about a minute and a half.
 */
const SCAN_CONCURRENCY = 3;

/** Pauses before each retry. A refused request needs time, not another instant try. */
const RETRY_DELAYS_MS = [250, 1_000, 3_000];

/**
 * Which of these symbols actually traded during a weekend window.
 *
 * Bitget publishes no flag for round-the-clock rTokens, so the tape answers instead:
 * one hourly candle with volume above zero inside the window means the market was
 * open. A symbol that still fails after its retries throws rather than reporting a
 * quiet weekend, so a network problem can never be mistaken for a closed market.
 */
export async function classifyWeekendTrading(
  ctx: BitgetContext,
  category: Category,
  symbols: string[],
  weekend: { start: number; end: number },
): Promise<Map<string, boolean>> {
  if (weekend.start >= weekend.end) {
    throw new RangeError("weekend window must start before it ends");
  }
  const result = new Map<string, boolean>();
  const queue = [...symbols];

  const worker = async (): Promise<void> => {
    for (let symbol = queue.pop(); symbol !== undefined; symbol = queue.pop()) {
      const candles = await withRetries(() =>
        getCandles(ctx, category, symbol, "1H", { since: weekend.start, until: weekend.end }),
      );
      result.set(
        symbol,
        candles.some((c) => c.ts >= weekend.start && c.ts <= weekend.end && c.volume > 0),
      );
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(SCAN_CONCURRENCY, Math.max(symbols.length, 1)) }, worker),
  );
  return result;
}

async function withRetries<T>(run: () => Promise<T>): Promise<T> {
  for (const delay of RETRY_DELAYS_MS) {
    try {
      return await run();
    } catch {
      await sleep(delay);
    }
  }
  return await run();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
