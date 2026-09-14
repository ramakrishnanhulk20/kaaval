// The drift between the round-the-clock price and the last regular US close, and the
// anchor candle kept between ticks. Does NOT cover: the live API, symbols whose 15 minute candles are missing for more
// than four hours before the bell, or any comparison against a non-Bitget quote. The
// anchor is Bitget's own tape by design, so this says nothing about the real NYSE
// print for the same instant.
import { describe, expect, it } from "vitest";
import { divergence } from "../../src/bitget/divergence.js";
import { getTicker } from "../../src/bitget/market.js";
import { fakeBitget, fixtureData } from "./fake.js";

const rtslaDaily = fixtureData<unknown[][]>("spot-candles-rtsla.json");
const rtslaTicker = fixtureData<Array<Record<string, unknown>>>("spot-ticker-rtsla.json");

const SATURDAY = new Date(Date.parse("2026-09-05T15:00:00Z"));
const FRIDAY_CLOSE = Date.parse("2026-09-04T20:00:00Z");
const TUESDAY_OPEN = Date.parse("2026-09-08T13:30:00Z");
const FIFTEEN_MIN = 15 * 60 * 1000;

/**
 * The recorded closes are daily rows. Placing them on 15 minute slots that end at the
 * Friday bell keeps the prices real while putting them where the anchor lookup reads.
 */
function quarterHourRows(count: number, skipAnchor = false): unknown[][] {
  const closes = rtslaDaily.slice(-count);
  const rows: unknown[][] = [];
  closes.forEach((row, index) => {
    const ts = FRIDAY_CLOSE - (count - index) * FIFTEEN_MIN;
    if (skipAnchor && ts === FRIDAY_CLOSE - FIFTEEN_MIN) return;
    rows.push([String(ts), row[1], row[2], row[3], row[4], row[5], row[6]]);
  });
  return rows;
}

const tickerHandler = () => rtslaTicker;

describe("divergence", () => {
  it("anchors on the 15 minute candle that ends at the bell", async () => {
    const ctx = fakeBitget({ tickers: tickerHandler, candlesHistory: () => quarterHourRows(16) });
    const result = await divergence(ctx, "SPOT", "RTSLAUSDT", SATURDAY);

    expect(result.anchorTs).toBe(FRIDAY_CLOSE - FIFTEEN_MIN);
    expect(result.anchorPrice).toBe(364.265);
    expect(result.price).toBe(364.23);
    expect(result.pct).toBeCloseTo(-0.0096, 4);
    expect(result.msToNextOpen).toBe(TUESDAY_OPEN - SATURDAY.getTime());
  });

  it("falls back to the newest candle before the bell when that quarter hour is missing", async () => {
    const ctx = fakeBitget({
      tickers: tickerHandler,
      candlesHistory: () => quarterHourRows(16, true),
    });
    const result = await divergence(ctx, "SPOT", "RTSLAUSDT", SATURDAY);

    expect(result.anchorTs).toBe(FRIDAY_CLOSE - 2 * FIFTEEN_MIN);
    expect(result.anchorPrice).toBe(354.63);
    expect(result.pct).toBeCloseTo(2.707, 3);
  });

  it("asks for the anchor candle once per close and only for the ticker after that", async () => {
    const ctx = fakeBitget({ tickers: tickerHandler, candlesHistory: () => quarterHourRows(16) });

    const first = await divergence(ctx, "SPOT", "RTSLAUSDT", SATURDAY);
    const afterFirst = ctx.calls.filter((call) => call.args["action"] === "candlesHistory").length;
    const second = await divergence(ctx, "SPOT", "RTSLAUSDT", new Date(SATURDAY.getTime() + FIFTEEN_MIN));

    expect(afterFirst).toBe(1);
    expect(ctx.calls.filter((call) => call.args["action"] === "candlesHistory")).toHaveLength(1);
    expect(ctx.calls.filter((call) => call.args["action"] === "tickers")).toHaveLength(2);
    expect(second.anchorPrice).toBe(first.anchorPrice);
    expect(second.anchorTs).toBe(first.anchorTs);
  });

  it("uses a ticker the caller already read instead of reading it again", async () => {
    const ctx = fakeBitget({ tickers: tickerHandler, candlesHistory: () => quarterHourRows(16) });
    const ticker = await getTicker(ctx, "SPOT", "RTSLAUSDT");
    const reads = ctx.calls.length;

    const result = await divergence(ctx, "SPOT", "RTSLAUSDT", SATURDAY, ticker);

    expect(result.price).toBe(ticker.last);
    expect(ctx.calls.filter((call) => call.args["action"] === "tickers")).toHaveLength(1);
    expect(ctx.calls.length).toBe(reads + 1);
  });

  it("throws rather than guessing when the symbol did not trade before the bell", async () => {
    const ctx = fakeBitget({ tickers: tickerHandler, candlesHistory: () => [] });

    await expect(divergence(ctx, "SPOT", "RTSLAUSDT", SATURDAY)).rejects.toThrow(/no 15m candle/);
  });
});
