// One real account turned into the AccountView the brains already read: a futures
// position, an rToken balance read as a long, the marks, the equity and the entry price
// provenance. Does NOT cover a live Bitget account (no read-only key exists yet, so the
// payloads are the hand-written fixtures described in fixtures/SOURCES.md), the rulebook's
// view of that account (risk tests), or the plan built from it (plan.test.ts).
import { describe, expect, it } from "vitest";
import { realAccountView } from "../../src/tenant/account.js";
import { fakeTenant } from "./fake-tenant.js";

const QUOTES = new Map([
  ["SPOT:RTSLAUSDT", { bid: 403.9, ask: 404.1 }],
  ["USDT-FUTURES:TSLAUSDT", { bid: 401.8, ask: 402.0 }],
]);

describe("realAccountView", () => {
  it("reads the futures position and the rToken balance as one list of positions", async () => {
    const { view, balanceUsdt, raw } = await realAccountView(fakeTenant(), "tenant-1", QUOTES);

    expect(view.id).toBe("tenant-1");
    expect(balanceUsdt).toBeCloseTo(3120.1, 2);
    expect(view.balanceUsdt).toBeCloseTo(3120.1, 2);
    expect(view.positions).toHaveLength(2);

    const perp = view.positions.find((p) => p.symbol === "TSLAUSDT");
    expect(perp).toMatchObject({ category: "USDT-FUTURES", side: "short", qty: 2, entrySource: "record" });
    expect(perp?.avgEntry).toBeCloseTo(402.5, 2);
    expect(perp?.mark).toBeCloseTo(401.9, 2);
    // Short two at 402.50, marked at 401.90: a dollar twenty in hand.
    expect(perp?.unrealised).toBeCloseTo(1.2, 2);

    const rToken = view.positions.find((p) => p.symbol === "RTSLAUSDT");
    expect(rToken).toMatchObject({ category: "SPOT", side: "long", qty: 5, entrySource: "mark" });
    expect(rToken?.mark).toBeCloseTo(404, 2);
    expect(rToken?.notionalUsdt).toBeCloseTo(2020, 2);
    // Nothing on Bitget says what the trader paid for the rToken, so it is carried at
    // the mark and shows no profit either way.
    expect(rToken?.unrealised).toBe(0);

    expect(raw.assets).toBeTruthy();
    expect(raw.positions).toBeTruthy();
  });

  it("takes the equity Bitget publishes rather than working one out", async () => {
    const { view } = await realAccountView(fakeTenant(), "tenant-1", QUOTES);
    expect(view.equity).toBeCloseTo(7246.44, 2);
    expect(view.realisedPnl).toBe(0);
    expect(view.drawdownPct).toBe(0);
    expect(view.dayPnlPct).toBe(0);
  });

  it("works out the equity itself when the account read publishes no total", async () => {
    const ctx = fakeTenant({
      assets: [
        { coin: "USDT", available: "1000", balance: "1000" },
        { coin: "rTSLA", available: "5", balance: "5", equity: "2015" },
      ],
      positions: [],
    });
    const { view } = await realAccountView(ctx, "tenant-1", QUOTES);
    // Free cash plus five rTSLA marked at 404, and no open profit on either.
    expect(view.equity).toBeCloseTo(1000 + 5 * 404, 2);
    expect(view.unrealised).toBe(0);
  });

  it("uses the entry price from a position record when there is one for the rToken", async () => {
    const ctx = fakeTenant({
      positions: [
        { symbol: "RTSLAUSDT", category: "SPOT", posSide: "long", total: "5", averageOpenPrice: "380" },
      ],
    });
    const { view } = await realAccountView(ctx, "tenant-1", QUOTES);
    const rToken = view.positions.filter((p) => p.symbol === "RTSLAUSDT");
    expect(rToken).toHaveLength(1);
    expect(rToken[0]?.entrySource).toBe("record");
    expect(rToken[0]?.avgEntry).toBeCloseTo(380, 2);
    expect(rToken[0]?.unrealised).toBeCloseTo(5 * (404 - 380), 2);
  });

  it("leaves out a holding it cannot price, so equity never rests on a guess", async () => {
    const ctx = fakeTenant({
      assets: [
        { coin: "USDT", available: "1000", balance: "1000" },
        { coin: "rNVDA", available: "3", balance: "3" },
      ],
      positions: [],
    });
    const { view } = await realAccountView(ctx, "tenant-1", new Map());
    expect(view.positions).toHaveLength(0);
    expect(view.equity).toBeCloseTo(1000, 2);
  });

  it("ignores coins that are not tokenized stocks, and positions with no size", async () => {
    const ctx = fakeTenant({
      assets: [
        { coin: "USDT", available: "1000", balance: "1000" },
        { coin: "BGB", available: "50", balance: "50", equity: "40" },
        { coin: "BTC", available: "0.1", balance: "0.1", equity: "6000" },
      ],
      positions: [{ symbol: "TSLAUSDT", category: "USDT-FUTURES", posSide: "short", total: "0" }],
    });
    const { view } = await realAccountView(ctx, "tenant-1", QUOTES);
    expect(view.positions).toHaveLength(0);
  });

  it("reads the direction from the size when the account names no side", async () => {
    const ctx = fakeTenant({
      assets: [{ coin: "USDT", available: "1000", balance: "1000" }],
      positions: [{ symbol: "TSLAUSDT", category: "USDT-FUTURES", total: "-2", averageOpenPrice: "402.5" }],
    });
    const { view } = await realAccountView(ctx, "tenant-1", QUOTES);
    expect(view.positions[0]).toMatchObject({ side: "short", qty: 2 });
  });
});
