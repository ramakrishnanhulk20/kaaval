import type { BitgetContext } from "../bitget/client.js";
import { divergence } from "../bitget/divergence.js";
import { nyseClock, tradableNow } from "../bitget/hours.js";
import { getFunding, getOrderBook, getTicker } from "../bitget/market.js";
import type { Instrument } from "../bitget/types.js";
import type { CalendarEvent, NewsItem, WorldState, WorldSymbol } from "../brain/types.js";
import { withCache } from "../news/cache.js";
import type { gatherCalendar, gatherNews } from "../news/feed.js";
import type { OrderBook } from "../sim/types.js";
import type { Universe } from "./universe.js";

export interface PerceptionDeps {
  bitget: BitgetContext;
  news: typeof gatherNews;
  calendar: typeof gatherCalendar;
  cacheDir: string;
  log: (line: string) => void;
}

export interface Perceived {
  world: WorldState;
  books: Map<string, OrderBook>;
  quotes: Map<string, { bid: number; ask: number }>;
  instruments: Map<string, Instrument>;
}

/** Bitget's public endpoints answer 429 at about nine requests a second, so three at a time. */
const MAX_IN_FLIGHT = 3;

const BOOK_DEPTH = 50;

/** One news gather per tick, reused by any tick that lands inside the same quarter hour. */
const NEWS_TTL_MS = 15 * 60_000;

/** GDELT answers 429 when it is asked the same question again and again, so this is hourly. */
const CALENDAR_TTL_MS = 60 * 60_000;

const CALENDAR_HORIZON_MS = 48 * 60 * 60_000;

/** The length of a regular New York session, used only to say when the next close is. */
const SESSION_MS = 6.5 * 60 * 60_000;

const BPS = 10_000;

interface Reading {
  key: string;
  symbol: WorldSymbol;
  book: OrderBook | null;
}

interface ReadTarget {
  instrument: Instrument;
  underlying: string;
  roundTheClock: boolean;
}

/**
 * The one world every brain is given.
 *
 * Built once per tick and handed unchanged to all three brains, so a difference in what
 * they decide can only come from the brain. Everything here is a live read from Bitget
 * or a live news call: no defaults, no filled-in prices. A symbol whose read fails is
 * left out of the world rather than carried at a stale price, because a brain that
 * cannot see a market must not trade it.
 */
export async function perceive(
  deps: PerceptionDeps,
  universe: Universe,
  now: Date,
  newsSinceTs: number,
): Promise<Perceived> {
  const clock = nyseClock(now);
  const targets = readTargets(universe);
  const instruments = new Map(
    targets.map((t) => [`${t.instrument.category}:${t.instrument.symbol}`, t.instrument]),
  );

  const readings = await inPool(targets, MAX_IN_FLIGHT, async (target) => {
    try {
      return await readSymbol(deps, target, clock.regularSessionOpen, now);
    } catch (error) {
      deps.log(`perception: ${target.instrument.symbol} skipped, ${(error as Error).message}`);
      return null;
    }
  });

  const books = new Map<string, OrderBook>();
  const quotes = new Map<string, { bid: number; ask: number }>();
  const symbols: WorldSymbol[] = [];
  for (const reading of readings) {
    if (!reading) continue;
    symbols.push(reading.symbol);
    quotes.set(reading.key, { bid: reading.symbol.bid, ask: reading.symbol.ask });
    if (reading.book) books.set(reading.key, reading.book);
  }

  const underlyings = [...new Set(symbols.map((s) => s.underlying))].sort();
  const [news, calendar] = await Promise.all([
    gatherNewsOnce(deps, symbols, newsSinceTs),
    gatherCalendarOnce(deps, underlyings, now),
  ]);

  const world: WorldState = {
    ts: now.getTime(),
    clock: {
      nowEt: clock.nowEt,
      regularSessionOpen: clock.regularSessionOpen,
      isWeekend: clock.isWeekend,
      msToNextOpen: clock.nextRegularOpen - now.getTime(),
      msToNextClose: msToNextClose(clock, now),
    },
    window: "normal",
    symbols,
    news,
    calendar,
  };

  return { world, books, quotes, instruments };
}

/**
 * Every instrument the tick reads, each one once. A hedge that is also some rToken's own
 * perpetual sits in both lists in the universe and must still be read a single time.
 */
function readTargets(universe: Universe): ReadTarget[] {
  const seen = new Set<string>();
  const targets: ReadTarget[] = [];
  const add = (instrument: Instrument, underlying: string, roundTheClock: boolean): void => {
    const key = `${instrument.category}:${instrument.symbol}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ instrument, underlying, roundTheClock });
  };

  for (const entry of universe.entries) {
    add(entry.rToken, entry.underlying, entry.roundTheClock);
    if (entry.perp) add(entry.perp, entry.underlying, true);
  }
  for (const hedge of universe.hedges) {
    add(hedge, hedge.baseCoin.toUpperCase(), true);
  }
  return targets;
}

async function readSymbol(
  deps: PerceptionDeps,
  target: ReadTarget,
  sessionOpen: boolean,
  now: Date,
): Promise<Reading> {
  const { instrument } = target;
  const category = instrument.category;
  // The quote and the book are what every other number here is built from, so they go out
  // together. The two reads that depend on them follow together as well: a tick that takes
  // four round trips one after another is a tick whose prices are four round trips old.
  const [ticker, book] = await Promise.all([
    getTicker(deps.bitget, category, instrument.symbol),
    getOrderBook(deps.bitget, category, instrument.symbol, BOOK_DEPTH).catch((error: unknown) => {
      deps.log(`perception: no book for ${instrument.symbol}, ${(error as Error).message}`);
      return null;
    }),
  ]);

  // Divergence measures drift away from the last regular close, so it says nothing while
  // that session is running and nothing at all for a crypto hedge that never had one. It
  // is read on the rToken only: a stock perpetual's own drift is not a gate or a hedge
  // trigger anywhere in the rulebook, and every extra symbol is another request a tick.
  const wantsDivergence = !sessionOpen && category === "SPOT" && instrument.isStock;
  const [divergencePct, fundingRate] = await Promise.all([
    wantsDivergence
      ? divergence(deps.bitget, category, instrument.symbol, now, ticker).then(
          (drift) => drift.pct,
          (error: unknown) => {
            deps.log(`perception: no divergence for ${instrument.symbol}, ${(error as Error).message}`);
            return null;
          },
        )
      : Promise.resolve(null),
    category === "USDT-FUTURES"
      ? getFunding(deps.bitget, instrument.symbol).then(
          (funding) => funding.rate,
          (error: unknown) => {
            deps.log(`perception: no funding for ${instrument.symbol}, ${(error as Error).message}`);
            return null;
          },
        )
      : Promise.resolve(null),
  ]);

  // The touch of the book is what an order fills against, so the world, the stop triggers
  // and the fills all read the same two numbers. A symbol whose book did not come back
  // falls back to the ticker's own quote.
  const bid = book?.bids[0]?.price ?? ticker.bid;
  const ask = book?.asks[0]?.price ?? ticker.ask;
  const mid = (bid + ask) / 2;

  return {
    key: `${category}:${instrument.symbol}`,
    book,
    symbol: {
      category,
      symbol: instrument.symbol,
      underlying: target.underlying,
      last: ticker.last,
      bid,
      ask,
      spreadBps: mid > 0 ? ((ask - bid) / mid) * BPS : Number.POSITIVE_INFINITY,
      // Bitget reports 24 hour volume in the base coin, so the last price converts it.
      volume24hUsdt: ticker.volume24h * ticker.last,
      divergencePct,
      fundingRate,
      // Open interest is deliberately not read: nothing in the rulebook uses it and it
      // would cost another request for every perpetual on every tick.
      openInterest: null,
      roundTheClock: target.roundTheClock,
      tradable: tradableNow(instrument, target.roundTheClock, now).tradable,
    },
  };
}

const MAX_PROMPT_HEADLINES = 20;

async function gatherNewsOnce(
  deps: PerceptionDeps,
  symbols: WorldSymbol[],
  sinceTs: number,
): Promise<NewsItem[]> {
  const wanted = symbols
    .filter((s) => s.category === "SPOT")
    .map((s) => ({ symbol: s.symbol, underlying: s.underlying }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  if (wanted.length === 0) return [];

  // The cache key leaves out sinceTs, which moves every tick, on purpose: the point is
  // that two ticks inside the same quarter hour share one gather instead of asking GDELT
  // and EDGAR the same question twice.
  const { value, cached } = await withCache(
    { dir: deps.cacheDir, ttlMs: NEWS_TTL_MS },
    { kind: "kaaval-tick-news", symbols: wanted.map((s) => s.symbol) },
    () => deps.news({ symbols: wanted, sinceTs, cacheDir: deps.cacheDir }, deps.log),
  );
  deps.log(`news: ${value.length} items${cached ? ", reused from this quarter hour" : ""}`);
  // Newest first already. Every headline is paid for in each model call of the tick, so
  // the prompt carries the freshest twenty and not the whole window.
  return value.slice(0, MAX_PROMPT_HEADLINES);
}

async function gatherCalendarOnce(
  deps: PerceptionDeps,
  underlyings: string[],
  now: Date,
): Promise<CalendarEvent[]> {
  if (underlyings.length === 0) return [];
  const { value, cached } = await withCache(
    { dir: deps.cacheDir, ttlMs: CALENDAR_TTL_MS },
    { kind: "kaaval-tick-calendar", underlyings },
    () =>
      deps.calendar(
        {
          underlyings,
          fromTs: now.getTime(),
          toTs: now.getTime() + CALENDAR_HORIZON_MS,
          cacheDir: deps.cacheDir,
        },
        deps.log,
      ),
  );
  deps.log(`calendar: ${value.length} events${cached ? ", reused from this hour" : ""}`);
  return value;
}

/**
 * Time to the next regular close. While the session runs it comes from the ET clock
 * string; while it is shut it is the next open plus the length of a session, which is
 * right except on the handful of early closes bitget/hours.ts already documents.
 */
function msToNextClose(
  clock: { nowEt: string; regularSessionOpen: boolean; nextRegularOpen: number },
  now: Date,
): number {
  if (!clock.regularSessionOpen) return clock.nextRegularOpen - now.getTime() + SESSION_MS;
  const match = /(\d{2}):(\d{2}):(\d{2})/.exec(clock.nowEt);
  if (!match) return SESSION_MS;
  const secondOfDay = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return (16 * 3600 - secondOfDay) * 1000;
}

/** Runs the tasks with at most `limit` of them in flight, answers in the order given. */
async function inPool<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next; index < items.length; index = next) {
      next += 1;
      results[index] = await run(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, worker));
  return results;
}
