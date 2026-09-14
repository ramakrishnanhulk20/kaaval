// Parsing and paging for the Bitget market reads, against recorded responses.
// Does NOT cover: the live API (see live.test.ts), rate limiting or retry behaviour
// inside the SDK, categories other than SPOT and USDT-FUTURES, or granularities other
// than the ones exercised here.
import { describe, expect, it } from "vitest";
import { BitgetError } from "../../src/bitget/client.js";
import {
  getCandles,
  getFunding,
  getFundingHistory,
  getOpenInterest,
  getOrderBook,
  getTicker,
  listInstruments,
  listStockInstruments,
} from "../../src/bitget/market.js";
import { fakeBitget, fixtureData } from "./fake.js";

const spotInstruments = fixtureData<Array<Record<string, unknown>>>("inst-SPOT.json");
const futuresInstruments = fixtureData<Array<Record<string, unknown>>>("inst-USDT-FUTURES.json");
const rtslaDaily = fixtureData<unknown[][]>("spot-candles-rtsla.json");
const tslaTicker = fixtureData<Array<Record<string, unknown>>>("ticker-tsla.json");
const rtslaTicker = fixtureData<Array<Record<string, unknown>>>("spot-ticker-rtsla.json");
const tslaBook = fixtureData<Record<string, unknown>>("orderbook-tsla.json");

const instrumentHandler = (args: Record<string, unknown>): unknown => {
  const rows = args["category"] === "SPOT" ? spotInstruments : futuresInstruments;
  const symbol = args["symbol"];
  return symbol === undefined ? rows : rows.filter((r) => r["symbol"] === symbol);
};

describe("instruments", () => {
  it("separates the two stock families Bitget publishes", async () => {
    const ctx = fakeBitget({ instruments: instrumentHandler });
    const { rTokens, perps } = await listStockInstruments(ctx);

    expect(rTokens).toHaveLength(699);
    expect(perps).toHaveLength(300);
    expect(rTokens.every((i) => i.category === "SPOT" && i.baseCoin.startsWith("r"))).toBe(true);
    expect(perps.every((i) => i.category === "USDT-FUTURES")).toBe(true);
  });

  it("reads the fields the rest of Kaaval trades on", async () => {
    const ctx = fakeBitget({ instruments: instrumentHandler });
    const spot = await listInstruments(ctx, "SPOT");
    const futures = await listInstruments(ctx, "USDT-FUTURES");
    const rtsla = spot.find((i) => i.symbol === "RTSLAUSDT");
    const tsla = futures.find((i) => i.symbol === "TSLAUSDT");

    expect(rtsla).toMatchObject({
      baseCoin: "rTSLA",
      quoteCoin: "USDT",
      isStock: true,
      minOrderUsdt: 10,
      pricePrecision: 2,
      quantityPrecision: 4,
      status: "online",
    });
    expect(rtsla?.takerFeeRate).toBeNull();
    expect(tsla).toMatchObject({
      isStock: true,
      makerFeeRate: 0.0002,
      takerFeeRate: 0.0006,
      minOrderUsdt: 5,
    });
    expect(futures.find((i) => i.symbol === "BTCUSDT")?.isStock).toBe(false);
  });
});

describe("candle paging", () => {
  const newest = rtslaDaily.slice(100);
  const older = rtslaDaily.slice(80, 180);
  const tsOf = (row: unknown[]): number => Number(row[0]);

  const pagedHandler = () => {
    let call = 0;
    return (args: Record<string, unknown>): unknown => {
      const endTime = Number(args["endTime"]);
      call += 1;
      if (call === 1) return newest;
      if (endTime === tsOf(newest[0] as unknown[])) return older;
      return [];
    };
  };

  it("merges overlapping pages into one ascending series with no repeats", async () => {
    const ctx = fakeBitget({ candlesHistory: pagedHandler() });
    const candles = await getCandles(ctx, "SPOT", "RTSLAUSDT", "1D", {
      since: 0,
      until: Date.now(),
    });

    expect(candles).toHaveLength(120);
    expect(new Set(candles.map((c) => c.ts)).size).toBe(120);
    expect(candles.map((c) => c.ts)).toEqual([...candles.map((c) => c.ts)].sort((a, b) => a - b));
    expect(candles[0]?.ts).toBe(tsOf(older[0] as unknown[]));
    expect(ctx.calls).toHaveLength(3);
    expect(ctx.calls[1]?.args["endTime"]).toBe(String(tsOf(newest[0] as unknown[])));
  });

  it("keeps only the candles inside the window and reads the recorded numbers", async () => {
    const ctx = fakeBitget({ candlesHistory: pagedHandler() });
    const since = tsOf(rtslaDaily[150] as unknown[]);
    const until = tsOf(rtslaDaily[159] as unknown[]);
    const candles = await getCandles(ctx, "SPOT", "RTSLAUSDT", "1D", { since, until });

    expect(candles).toHaveLength(10);
    const first = rtslaDaily[150] as unknown[];
    expect(candles[0]).toEqual({
      ts: Number(first[0]),
      open: Number(first[1]),
      high: Number(first[2]),
      low: Number(first[3]),
      close: Number(first[4]),
      volume: Number(first[5]),
      quoteVolume: Number(first[6]),
    });
  });

  it("refuses a window that ends before it starts", async () => {
    const ctx = fakeBitget({ candlesHistory: () => [] });
    await expect(
      getCandles(ctx, "SPOT", "RTSLAUSDT", "15m", { since: 2, until: 1 }),
    ).rejects.toThrow(RangeError);
  });

  it("stops when a page comes back empty", async () => {
    const ctx = fakeBitget({ candlesHistory: () => [] });
    const candles = await getCandles(ctx, "SPOT", "RTSLAUSDT", "15m", {
      since: 0,
      until: Date.now(),
    });

    expect(candles).toEqual([]);
    expect(ctx.calls).toHaveLength(1);
  });
});

describe("ticker and book", () => {
  it("reads a futures and a spot ticker through the same shape", async () => {
    const ctx = fakeBitget({ tickers: (args) => (args["category"] === "SPOT" ? rtslaTicker : tslaTicker) });

    await expect(getTicker(ctx, "USDT-FUTURES", "TSLAUSDT")).resolves.toMatchObject({
      last: 364.06,
      bid: 364.07,
      ask: 364.12,
      bidSize: 93.27,
      askSize: 2.74,
      volume24h: 34249.15,
    });
    await expect(getTicker(ctx, "SPOT", "RTSLAUSDT")).resolves.toMatchObject({
      last: 364.23,
      bid: 364.19,
      ask: 364.33,
    });
  });

  it("sorts the book best price first and validates the depth asked for", async () => {
    const ctx = fakeBitget({ orderbook: () => tslaBook });
    const book = await getOrderBook(ctx, "USDT-FUTURES", "TSLAUSDT", 15);

    expect(book.asks[0]?.price).toBe(364.01);
    expect(book.bids[0]?.price).toBe(363.98);
    expect(book.asks.map((l) => l.price)).toEqual([...book.asks.map((l) => l.price)].sort((a, b) => a - b));
    expect(book.bids.map((l) => l.price)).toEqual([...book.bids.map((l) => l.price)].sort((a, b) => b - a));
    await expect(getOrderBook(ctx, "USDT-FUTURES", "TSLAUSDT", 500)).rejects.toThrow(RangeError);
  });
});

describe("funding and open interest", () => {
  it("reads the current rate, the history above a cutoff and open interest", async () => {
    const ctx = fakeBitget({
      fundingRate: () => [
        {
          symbol: "TSLAUSDT",
          fundingRate: "0.000221",
          fundingRateInterval: "8",
          nextUpdate: "1788883200000",
        },
      ],
      fundingRateHistory: () => ({
        resultList: [
          { symbol: "TSLAUSDT", fundingRate: "0.0003", fundingRateTimestamp: "1788854400000" },
          { symbol: "TSLAUSDT", fundingRate: "0.0001", fundingRateTimestamp: "1788825600000" },
          { symbol: "TSLAUSDT", fundingRate: "0.0002", fundingRateTimestamp: "1788796800000" },
        ],
      }),
      openInterest: () => ({ list: [{ symbol: "TSLAUSDT", openInterest: "49206.99" }], ts: "1788882065218" }),
    });

    await expect(getFunding(ctx, "TSLAUSDT")).resolves.toEqual({
      symbol: "TSLAUSDT",
      rate: 0.000221,
      nextTime: 1788883200000,
      intervalHours: 8,
    });
    await expect(getFundingHistory(ctx, "TSLAUSDT", 1788825600000)).resolves.toEqual([
      { ts: 1788825600000, rate: 0.0001 },
      { ts: 1788854400000, rate: 0.0003 },
    ]);
    await expect(getOpenInterest(ctx, "TSLAUSDT")).resolves.toEqual({
      symbol: "TSLAUSDT",
      amount: 49206.99,
      ts: 1788882065218,
    });
  });
});

describe("failures", () => {
  it("turns a failed tool call into a BitgetError naming the tool and the arguments", async () => {
    const ctx = fakeBitget({
      tickers: () => {
        throw new Error("Bitget said no");
      },
    });

    await expect(getTicker(ctx, "SPOT", "RTSLAUSDT")).rejects.toBeInstanceOf(BitgetError);
    await expect(getTicker(ctx, "SPOT", "RTSLAUSDT")).rejects.toMatchObject({ tool: "market" });
  });

  it("throws when Bitget returns no row for the symbol", async () => {
    const ctx = fakeBitget({ tickers: () => [] });
    await expect(getTicker(ctx, "SPOT", "RTSLAUSDT")).rejects.toThrow(/no row/);
  });
});
