// The New York trading clock, the tradable-now rule and the weekend volume scan.
// Does NOT cover: NYSE early closes (1:00 pm ET days), years outside 2026 and 2027,
// pre-market or after-hours sessions, or half-day holiday schedules on other
// exchanges. Bitget's own maintenance windows are not modelled either.
import { describe, expect, it } from "vitest";
import { classifyWeekendTrading, nyseClock, tradableNow } from "../../src/bitget/hours.js";
import type { Instrument } from "../../src/bitget/types.js";
import { fakeBitget } from "./fake.js";

const at = (iso: string): Date => new Date(Date.parse(iso));

const FRIDAY_CLOSE = Date.parse("2026-09-04T20:00:00Z");
const TUESDAY_OPEN = Date.parse("2026-09-08T13:30:00Z");

const rToken: Instrument = {
  symbol: "RTSLAUSDT",
  category: "SPOT",
  baseCoin: "rTSLA",
  quoteCoin: "USDT",
  isStock: true,
  minOrderUsdt: 10,
  minOrderQty: 0.0001,
  pricePrecision: 2,
  quantityPrecision: 4,
  makerFeeRate: null,
  takerFeeRate: null,
  status: "online",
};

const stockPerp: Instrument = {
  ...rToken,
  symbol: "TSLAUSDT",
  category: "USDT-FUTURES",
  baseCoin: "TSLA",
  makerFeeRate: 0.0002,
  takerFeeRate: 0.0006,
};

const cryptoPerp: Instrument = { ...stockPerp, symbol: "BTCUSDT", baseCoin: "BTC", isStock: false };

describe("nyseClock", () => {
  it("reports a Saturday as closed and skips the Labor Day holiday to Tuesday", () => {
    const clock = nyseClock(at("2026-09-05T15:00:00Z"));

    expect(clock.nowEt).toBe("2026-09-05 11:00:00 ET");
    expect(clock.isWeekend).toBe(true);
    expect(clock.isHoliday).toBe(false);
    expect(clock.regularSessionOpen).toBe(false);
    expect(clock.lastRegularClose).toBe(FRIDAY_CLOSE);
    expect(clock.nextRegularOpen).toBe(TUESDAY_OPEN);
  });

  it("reports Thanksgiving 2026 as a holiday and opens again the next morning", () => {
    const clock = nyseClock(at("2026-11-26T15:00:00Z"));

    expect(clock.isHoliday).toBe(true);
    expect(clock.isWeekend).toBe(false);
    expect(clock.regularSessionOpen).toBe(false);
    expect(clock.nextRegularOpen).toBe(Date.parse("2026-11-27T14:30:00Z"));
  });

  it("opens at 09:30 ET exactly and not a minute before", () => {
    expect(nyseClock(at("2026-09-08T13:29:00Z")).regularSessionOpen).toBe(false);
    expect(nyseClock(at("2026-09-08T13:30:00Z")).regularSessionOpen).toBe(true);
  });

  it("closes at 16:00 ET exactly and records that instant as the last close", () => {
    const atBell = nyseClock(at("2026-09-08T20:00:00Z"));
    const afterBell = nyseClock(at("2026-09-08T20:01:00Z"));

    expect(atBell.regularSessionOpen).toBe(false);
    expect(atBell.lastRegularClose).toBe(Date.parse("2026-09-08T20:00:00Z"));
    expect(afterBell.regularSessionOpen).toBe(false);
    expect(afterBell.nextRegularOpen).toBe(Date.parse("2026-09-09T13:30:00Z"));
  });

  it("reads the same wall clock on both sides of the November 2026 clock change", () => {
    const beforeChange = nyseClock(at("2026-11-01T05:00:00Z"));
    const afterChange = nyseClock(at("2026-11-01T06:30:00Z"));

    expect(beforeChange.nowEt).toBe("2026-11-01 01:00:00 ET");
    expect(afterChange.nowEt).toBe("2026-11-01 01:30:00 ET");
    expect(beforeChange.nextRegularOpen).toBe(Date.parse("2026-11-02T14:30:00Z"));
    expect(afterChange.nextRegularOpen).toBe(Date.parse("2026-11-02T14:30:00Z"));
    expect(beforeChange.lastRegularClose).toBe(Date.parse("2026-10-30T20:00:00Z"));
  });
});

describe("tradableNow", () => {
  it("keeps a round-the-clock rToken tradable through the weekend", () => {
    const result = tradableNow(rToken, true, at("2026-09-05T15:00:00Z"));

    expect(result).toMatchObject({ tradable: true, venue: "rtoken-spot" });
    expect(result.nextOpen).toBeUndefined();
  });

  it("shuts a US-hours rToken over the weekend and points at the next open", () => {
    const result = tradableNow(rToken, false, at("2026-09-05T15:00:00Z"));

    expect(result.tradable).toBe(false);
    expect(result.venue).toBe("rtoken-spot");
    expect(result.reason).toContain("weekend");
    expect(result.nextOpen).toBe(TUESDAY_OPEN);
  });

  it("opens a US-hours rToken during the session and points at the bell", () => {
    const result = tradableNow(rToken, false, at("2026-09-08T15:00:00Z"));

    expect(result.tradable).toBe(true);
    expect(result.nextClose).toBe(Date.parse("2026-09-08T20:00:00Z"));
  });

  it("keeps both kinds of perpetual tradable and names the venue", () => {
    expect(tradableNow(stockPerp, false, at("2026-09-05T15:00:00Z"))).toMatchObject({
      tradable: true,
      venue: "stock-perp",
    });
    expect(tradableNow(cryptoPerp, false, at("2026-09-05T15:00:00Z"))).toMatchObject({
      tradable: true,
      venue: "crypto-perp",
    });
  });

  it("refuses an instrument Bitget has not marked online", () => {
    const halted = { ...rToken, status: "limit_open" };
    const result = tradableNow(halted, true, at("2026-09-08T15:00:00Z"));

    expect(result.tradable).toBe(false);
    expect(result.reason).toContain("limit_open");
  });
});

describe("classifyWeekendTrading", () => {
  const start = Date.parse("2026-09-05T04:00:00Z");
  const end = Date.parse("2026-09-07T04:00:00Z");
  const hourly = (ts: number, volume: number): unknown[] => [
    String(ts),
    "364",
    "364",
    "364",
    "364",
    String(volume),
    "0",
  ];

  it("calls a symbol round-the-clock only when a weekend candle carries volume", async () => {
    const ctx = fakeBitget({
      candlesHistory: (args) => {
        const symbol = String(args["symbol"]);
        if (symbol === "RQUIETUSDT") {
          return [hourly(start, 0), hourly(start + 3_600_000, 0)];
        }
        return [hourly(start, 0), hourly(start + 3_600_000, 12.5)];
      },
    });

    const map = await classifyWeekendTrading(ctx, "SPOT", ["RTSLAUSDT", "RQUIETUSDT"], {
      start,
      end,
    });

    expect(map.get("RTSLAUSDT")).toBe(true);
    expect(map.get("RQUIETUSDT")).toBe(false);
    expect(map.size).toBe(2);
  });

  it("retries a symbol once before giving up, so a blip is not read as a closed market", async () => {
    let attempts = 0;
    const ctx = fakeBitget({
      candlesHistory: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("network hiccup");
        return [hourly(start, 4)];
      },
    });

    const map = await classifyWeekendTrading(ctx, "SPOT", ["RTSLAUSDT"], { start, end });

    expect(map.get("RTSLAUSDT")).toBe(true);
    expect(attempts).toBe(2);
  });

  it("refuses a window that ends before it starts", async () => {
    const ctx = fakeBitget({ candlesHistory: () => [] });
    await expect(
      classifyWeekendTrading(ctx, "SPOT", ["RTSLAUSDT"], { start: end, end: start }),
    ).rejects.toThrow(RangeError);
  });
});
