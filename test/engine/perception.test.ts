// One tick's worth of looking at the world: what gets read, what is left out, and what
// is reused from the cache. Does NOT cover the live Bitget API or the live news sources
// (news/live.test.ts), the brains, or the risk layer.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CalendarEvent, NewsItem } from "../../src/brain/types.js";
import { perceive, type PerceptionDeps } from "../../src/engine/perception.js";
import { buildUniverse, type Universe } from "../../src/engine/universe.js";
import { DEFAULT_RULEBOOK } from "../../src/risk/rulebook.js";
import { bookAround, fakeMarket } from "../support/fake-bitget.js";

const NIGHT = new Date("2026-09-11T02:00:00Z");
const SESSION = new Date("2026-09-11T14:00:00Z");

const quotes = {
  RTSLAUSDT: { last: 404, bid: 403.9, ask: 404.1, usdtVolume: 50_000_000 },
  RNVDAUSDT: { last: 180, bid: 179.9, ask: 180.1, usdtVolume: 9_000_000 },
  TSLAUSDT: { last: 402, bid: 401.9, ask: 402.1, usdtVolume: 20_000_000 },
  NVDAUSDT: { last: 179, bid: 178.9, ask: 179.1, usdtVolume: 8_000_000 },
  SPYUSDT: { last: 660, bid: 659.9, ask: 660.1, usdtVolume: 5_000_000 },
  BTCUSDT: { last: 60_000, bid: 59_990, ask: 60_010, usdtVolume: 900_000_000 },
  ETHUSDT: { last: 3_000, bid: 2_999, ask: 3_001, usdtVolume: 400_000_000 },
};

const books = {
  RTSLAUSDT: bookAround(404),
  RNVDAUSDT: bookAround(180),
  TSLAUSDT: bookAround(402),
  NVDAUSDT: bookAround(179),
  SPYUSDT: bookAround(660),
  BTCUSDT: bookAround(60_000, 5),
  ETHUSDT: bookAround(3_000, 20),
};

function market() {
  return fakeMarket({
    quotes,
    books,
    tradedOverWeekend: ["RTSLAUSDT", "RNVDAUSDT"],
    funding: { TSLAUSDT: 0.0001, BTCUSDT: 0.00021 },
    // The anchor candle closes at 400, so rTSLA at 404 is exactly one percent adrift.
    candleClose: 400,
  });
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function universeOf(ctx: ReturnType<typeof market>): Promise<Universe> {
  return await buildUniverse(ctx, DEFAULT_RULEBOOK, {
    maxSymbols: 2,
    cacheFile: join(tempDir("kaaval-perc-uni-"), "universe.json"),
    ttlMs: 60_000,
    now: NIGHT,
  });
}

interface Counting {
  deps: PerceptionDeps;
  newsCalls: number;
  calendarCalls: number;
}

function deps(ctx: ReturnType<typeof market>, cacheDir: string): Counting {
  const counting: Counting = {
    newsCalls: 0,
    calendarCalls: 0,
    deps: {
      bitget: ctx,
      cacheDir,
      log: () => {},
      news: async (): Promise<NewsItem[]> => {
        counting.newsCalls += 1;
        return [
          {
            id: "test-1",
            ts: NIGHT.getTime() - 60_000,
            source: "sec-edgar",
            headline: "Tesla files an 8-K",
            summary: null,
            url: null,
            symbols: ["RTSLAUSDT"],
          },
        ];
      },
      calendar: async (): Promise<CalendarEvent[]> => {
        counting.calendarCalls += 1;
        return [];
      },
    },
  };
  return counting;
}

describe("perceive", () => {
  it("reads every instrument in the universe once and keeps the book beside the quote", async () => {
    const ctx = market();
    const universe = await universeOf(ctx);
    const counting = deps(ctx, tempDir("kaaval-perc-news-"));

    const perceived = await perceive(counting.deps, universe, NIGHT, NIGHT.getTime() - 3_600_000);

    expect(perceived.world.symbols.map((s) => s.symbol)).toEqual([
      "RTSLAUSDT",
      "TSLAUSDT",
      "RNVDAUSDT",
      "NVDAUSDT",
      "SPYUSDT",
      "BTCUSDT",
      "ETHUSDT",
    ]);
    expect(perceived.books.get("SPOT:RTSLAUSDT")?.bids[0]?.price).toBe(403.8);
    expect(perceived.quotes.get("SPOT:RTSLAUSDT")).toEqual({ bid: 403.8, ask: 404.2 });
    expect(perceived.instruments.get("SPOT:RTSLAUSDT")?.pricePrecision).toBe(2);
    expect(perceived.world.news).toHaveLength(1);
    expect(perceived.world.clock.regularSessionOpen).toBe(false);

    const tsla = perceived.world.symbols.find((s) => s.symbol === "TSLAUSDT");
    expect(tsla?.fundingRate).toBe(0.0001);
    expect(tsla?.underlying).toBe("TSLA");

    const orderbookCalls = ctx.calls.filter((c) => c.args["action"] === "orderbook");
    expect(orderbookCalls).toHaveLength(7);
  });

  it("measures divergence while New York is shut and reports none while it is open", async () => {
    const night = market();
    const shut = await perceive(
      deps(night, tempDir("kaaval-perc-news-")).deps,
      await universeOf(night),
      NIGHT,
      NIGHT.getTime() - 3_600_000,
    );
    const rtslaShut = shut.world.symbols.find((s) => s.symbol === "RTSLAUSDT");
    expect(rtslaShut?.divergencePct).toBeCloseTo(1, 6);

    const day = market();
    const open = await perceive(
      deps(day, tempDir("kaaval-perc-news-")).deps,
      await universeOf(day),
      SESSION,
      SESSION.getTime() - 3_600_000,
    );
    expect(open.world.clock.regularSessionOpen).toBe(true);
    expect(open.world.symbols.find((s) => s.symbol === "RTSLAUSDT")?.divergencePct).toBeNull();
  });

  it("gathers news once for a quarter hour, however many ticks land in it", async () => {
    const ctx = market();
    const universe = await universeOf(ctx);
    const counting = deps(ctx, tempDir("kaaval-perc-news-"));

    await perceive(counting.deps, universe, NIGHT, NIGHT.getTime() - 3_600_000);
    await perceive(counting.deps, universe, new Date(NIGHT.getTime() + 120_000), NIGHT.getTime());

    expect(counting.newsCalls).toBe(1);
    expect(counting.calendarCalls).toBe(1);
  });

  it("leaves out a symbol whose ticker did not come back", async () => {
    const ctx = fakeMarket({
      quotes: { ...quotes, RNVDAUSDT: undefined as never },
      books,
      tradedOverWeekend: ["RTSLAUSDT", "RNVDAUSDT"],
      candleClose: 400,
    });
    const universe = await universeOf(market());
    const lines: string[] = [];
    const counting = deps(ctx, tempDir("kaaval-perc-news-"));
    counting.deps.log = (line) => lines.push(line);

    const perceived = await perceive(counting.deps, universe, NIGHT, NIGHT.getTime() - 3_600_000);

    expect(perceived.world.symbols.map((s) => s.symbol)).not.toContain("RNVDAUSDT");
    expect(perceived.quotes.has("SPOT:RNVDAUSDT")).toBe(false);
    expect(lines.some((line) => line.includes("RNVDAUSDT skipped"))).toBe(true);
  });
});
