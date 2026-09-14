// What an order costs against a recorded order book: impact, fees, funding, warnings.
// Does NOT cover: hidden or iceberg liquidity, the queue a maker order would sit in,
// slippage between the quote and the fill, partial fills over time, or borrow costs on
// margin. The book is a snapshot, so the estimate is a snapshot too.
import { describe, expect, it } from "vitest";
import { estimateCost } from "../../src/bitget/cost.js";
import { fakeBitget, fixtureData } from "./fake.js";

const spotInstruments = fixtureData<Array<Record<string, unknown>>>("inst-SPOT.json");
const futuresInstruments = fixtureData<Array<Record<string, unknown>>>("inst-USDT-FUTURES.json");
const tslaBook = fixtureData<Record<string, unknown>>("orderbook-tsla.json");
const tslaTicker = fixtureData<Array<Record<string, unknown>>>("ticker-tsla.json");

const FIFTEEN_MIN = 15 * 60 * 1000;
const LAST_PRICE = 364.06;

/**
 * Sixteen quarter-hour candles ending at whatever close the clock asks for, all at one
 * price. That fixes the divergence the estimate reads without freezing the real clock.
 */
const anchorCandles =
  (close: number) =>
  (args: Record<string, unknown>): unknown[][] => {
    const endTime = Number(args["endTime"]);
    return Array.from({ length: 16 }, (_, i) => {
      const ts = endTime - (16 - i) * FIFTEEN_MIN;
      return [String(ts), String(close), String(close), String(close), String(close), "10", "3640"];
    });
  };

const funding = () => [
  {
    symbol: "TSLAUSDT",
    fundingRate: "0.000221",
    fundingRateInterval: "8",
    nextUpdate: "1788883200000",
  },
];

function ctxFor(options?: { anchor?: number; category?: "SPOT" | "USDT-FUTURES" }) {
  const anchor = options?.anchor ?? LAST_PRICE;
  return fakeBitget({
    instruments: (args) => {
      const rows = args["category"] === "SPOT" ? spotInstruments : futuresInstruments;
      return rows.filter((r) => r["symbol"] === args["symbol"]);
    },
    // The recorded TSLA ladder stands in for depth on both venues: what varies between
    // the cases below is the fee and funding handling, not the shape of the book.
    orderbook: () => tslaBook,
    tickers: () => tslaTicker,
    fundingRate: funding,
    candlesHistory: anchorCandles(anchor),
  });
}

describe("estimateCost", () => {
  it("prices a small taker buy off the top of the book", async () => {
    const estimate = await estimateCost(ctxFor(), {
      category: "USDT-FUTURES",
      symbol: "TSLAUSDT",
      side: "buy",
      notionalUsdt: 20,
    });

    expect(estimate.fillable).toBe(true);
    expect(estimate.levelsConsumed).toBe(1);
    expect(estimate.mid).toBe(363.995);
    expect(estimate.avgFillPrice).toBe(364.01);
    expect(estimate.impactBps).toBeCloseTo(0.4121, 3);
    expect(estimate.feeBps).toBeCloseTo(6, 6);
    expect(estimate.fundingBpsPerDay).toBeCloseTo(6.63, 6);
    expect(estimate.totalBps).toBeCloseTo(13.042, 3);
    expect(estimate.warnings).toEqual([]);
  });

  it("walks deeper levels for a larger order and charges the worse average price", async () => {
    const estimate = await estimateCost(ctxFor(), {
      category: "USDT-FUTURES",
      symbol: "TSLAUSDT",
      side: "buy",
      notionalUsdt: 2000,
    });

    expect(estimate.fillable).toBe(true);
    expect(estimate.levelsConsumed).toBe(2);
    expect(estimate.avgFillPrice).toBeCloseTo(364.0198, 4);
    expect(estimate.impactBps).toBeCloseTo(0.6803, 3);
    expect(estimate.warnings).toEqual([]);
  });

  it("refuses to pretend a 200,000 USDT order fits in the visible book", async () => {
    const estimate = await estimateCost(ctxFor(), {
      category: "USDT-FUTURES",
      symbol: "TSLAUSDT",
      side: "buy",
      notionalUsdt: 200_000,
    });

    expect(estimate.fillable).toBe(false);
    expect(estimate.levelsConsumed).toBe(15);
    expect(estimate.warnings.some((w) => w.includes("less than the 200000 USDT order"))).toBe(true);
    expect(estimate.warnings.some((w) => w.includes("quarter"))).toBe(true);
  });

  it("turns the funding sign around for a sell and reads the bid side", async () => {
    const estimate = await estimateCost(ctxFor(), {
      category: "USDT-FUTURES",
      symbol: "TSLAUSDT",
      side: "sell",
      notionalUsdt: 20,
    });

    expect(estimate.avgFillPrice).toBe(363.98);
    expect(estimate.impactBps).toBeCloseTo(0.4121, 3);
    expect(estimate.fundingBpsPerDay).toBeCloseTo(-6.63, 6);
  });

  it("charges the maker rate when the order is not a taker", async () => {
    const estimate = await estimateCost(ctxFor(), {
      category: "USDT-FUTURES",
      symbol: "TSLAUSDT",
      side: "buy",
      notionalUsdt: 20,
      taker: false,
    });

    expect(estimate.feeBps).toBeCloseTo(2, 6);
  });

  it("warns when the price has drifted more than one percent from the last close", async () => {
    const estimate = await estimateCost(ctxFor({ anchor: 300 }), {
      category: "USDT-FUTURES",
      symbol: "TSLAUSDT",
      side: "buy",
      notionalUsdt: 20,
    });

    expect(estimate.warnings.some((w) => w.includes("re-anchor"))).toBe(true);
  });

  it("says so when Bitget publishes no fee rate for a spot rToken, and skips funding", async () => {
    const estimate = await estimateCost(ctxFor(), {
      category: "SPOT",
      symbol: "RTSLAUSDT",
      side: "buy",
      notionalUsdt: 20,
    });

    expect(estimate.feeBps).toBe(0);
    expect(estimate.fundingBpsPerDay).toBeNull();
    expect(estimate.warnings.some((w) => w.includes("no taker fee rate"))).toBe(true);
    expect(estimate.warnings.some((w) => w.includes("below the 10 USDT minimum"))).toBe(false);
  });

  it("flags an order under the instrument minimum", async () => {
    const estimate = await estimateCost(ctxFor(), {
      category: "SPOT",
      symbol: "RTSLAUSDT",
      side: "buy",
      notionalUsdt: 4,
    });

    expect(estimate.warnings.some((w) => w.includes("below the 10 USDT minimum"))).toBe(true);
  });

  it("rejects a notional of zero or less", async () => {
    await expect(
      estimateCost(ctxFor(), {
        category: "SPOT",
        symbol: "RTSLAUSDT",
        side: "buy",
        notionalUsdt: 0,
      }),
    ).rejects.toThrow(RangeError);
  });

  it("treats a top-of-book price of zero as an empty side", async () => {
    const ctx = fakeBitget({
      instruments: () => futuresInstruments.filter((r) => r["symbol"] === "TSLAUSDT"),
      orderbook: () => ({ a: [["0", "5"]], b: [["363.98", "5"]], ts: "1788878648858" }),
      tickers: () => tslaTicker,
      fundingRate: funding,
      candlesHistory: anchorCandles(LAST_PRICE),
    });

    const estimate = await estimateCost(ctx, {
      category: "USDT-FUTURES",
      symbol: "TSLAUSDT",
      side: "buy",
      notionalUsdt: 20,
    });

    expect(estimate.fillable).toBe(false);
    expect(estimate.mid).toBe(0);
    expect(estimate.totalBps).toBe(0);
    expect(estimate.warnings.some((w) => w.includes("empty"))).toBe(true);
  });

  it("returns an unfillable estimate instead of dividing by an empty book", async () => {
    const ctx = fakeBitget({
      instruments: () => futuresInstruments.filter((r) => r["symbol"] === "TSLAUSDT"),
      orderbook: () => ({ a: [], b: [], ts: "1788878648858" }),
      tickers: () => tslaTicker,
      fundingRate: funding,
      candlesHistory: anchorCandles(LAST_PRICE),
    });

    const estimate = await estimateCost(ctx, {
      category: "USDT-FUTURES",
      symbol: "TSLAUSDT",
      side: "buy",
      notionalUsdt: 20,
    });

    expect(estimate.fillable).toBe(false);
    expect(estimate.totalBps).toBe(0);
    expect(estimate.warnings.some((w) => w.includes("empty"))).toBe(true);
  });
});
