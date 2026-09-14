// Hits the real Bitget public API, so it runs only with LIVE=1 in the environment.
// It checks shapes, never values: prices move, and a test that asserts a price is a
// test that fails at random. Does NOT cover: private endpoints, order placement, rate
// limit behaviour under load, or how the data looks while the US market is open.
import { describe, expect, it } from "vitest";
import { createBitget } from "../../src/bitget/client.js";
import { getCandles, getOrderBook, getTicker } from "../../src/bitget/market.js";

const live = process.env["LIVE"] === "1";
const TIMEOUT_MS = 30_000;

describe.runIf(live)("live Bitget reads", () => {
  const ctx = createBitget();

  it(
    "returns a ticker with a two sided quote",
    async () => {
      const ticker = await getTicker(ctx, "SPOT", "RTSLAUSDT");

      expect(ticker.symbol).toBe("RTSLAUSDT");
      expect(ticker.last).toBeGreaterThan(0);
      expect(ticker.ask).toBeGreaterThanOrEqual(ticker.bid);
      expect(ticker.ts).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  it(
    "pages roughly 200 candles in ascending order with no repeats",
    async () => {
      const until = Date.now();
      const since = until - 200 * 15 * 60 * 1000;
      const candles = await getCandles(ctx, "USDT-FUTURES", "TSLAUSDT", "15m", { since, until });

      expect(candles.length).toBeGreaterThan(150);
      expect(new Set(candles.map((c) => c.ts)).size).toBe(candles.length);
      expect(candles.map((c) => c.ts)).toEqual([...candles.map((c) => c.ts)].sort((a, b) => a - b));
      expect(candles.every((c) => c.high >= c.low && c.close > 0)).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    "returns a book whose best ask is not below its best bid",
    async () => {
      const book = await getOrderBook(ctx, "USDT-FUTURES", "TSLAUSDT", 25);

      expect(book.asks.length).toBeGreaterThan(0);
      expect(book.bids.length).toBeGreaterThan(0);
      expect(book.asks[0]?.price).toBeGreaterThanOrEqual(book.bids[0]?.price ?? 0);
      expect(book.asks.every((l) => l.size > 0)).toBe(true);
    },
    TIMEOUT_MS,
  );
});
