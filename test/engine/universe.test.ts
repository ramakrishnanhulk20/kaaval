// The nightly tradable list: which rTokens survive the rulebook's filters, in what
// order, and how the cache and the weekend scan behave. Does NOT cover the live Bitget
// API, the real weekend classifier's retry behaviour (it is exercised through generated
// candles here), or what happens when Bitget publishes no ticker row at all for a
// listed symbol.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildUniverse, lastCompletedWeekend, underlyingOf, universeKeys } from "../../src/engine/universe.js";
import { DEFAULT_RULEBOOK } from "../../src/risk/rulebook.js";
import { fakeMarket, spotInstrumentRows } from "../support/fake-bitget.js";

const NOW = new Date("2026-09-10T22:00:00Z");

const quotes = {
  RTSLAUSDT: { last: 400, bid: 399.9, ask: 400.1, usdtVolume: 50_000_000 },
  RNVDAUSDT: { last: 180, bid: 179.9, ask: 180.1, usdtVolume: 9_000_000 },
  RAAPLUSDT: { last: 230, bid: 229.9, ask: 230.1, usdtVolume: 2_000_000 },
  RMSTRUSDT: { last: 300, bid: 299.9, ask: 300.1, usdtVolume: 5_000_000 },
  RSPYUSDT: { last: 660, bid: 659.9, ask: 660.1, baseVolume: 1_000_000, usdtVolume: 150_000 },
};

const tradedOverWeekend = ["RTSLAUSDT", "RNVDAUSDT", "RAAPLUSDT", "RSPYUSDT"];

function cacheFile(): string {
  return join(mkdtempSync(join(tmpdir(), "kaaval-universe-")), "universe.json");
}

function market(overrides: Parameters<typeof fakeMarket>[0] = {}) {
  return fakeMarket({ quotes, tradedOverWeekend, ...overrides });
}

describe("buildUniverse", () => {
  it("keeps liquid rTokens with a perp that traded through the weekend, richest first", async () => {
    const universe = await buildUniverse(market(), DEFAULT_RULEBOOK, {
      maxSymbols: 3,
      cacheFile: cacheFile(),
      ttlMs: 60_000,
      now: NOW,
    });

    expect(universe.entries.map((e) => e.rToken.symbol)).toEqual([
      "RTSLAUSDT",
      "RNVDAUSDT",
      "RAAPLUSDT",
    ]);
    expect(universe.entries[0]?.perp?.symbol).toBe("TSLAUSDT");
    expect(universe.entries[0]?.underlying).toBe("TSLA");
    expect(universe.entries.every((e) => e.roundTheClock)).toBe(true);
    expect(universe.hedges.map((h) => h.symbol)).toEqual(DEFAULT_RULEBOOK.universe.hedgeSymbols);
    expect(universe.weekendChecked).toEqual(lastCompletedWeekend(NOW));
  });

  it("drops a symbol whose weekend was flat, whose turnover is thin, or whose listing is not online", async () => {
    const rows = spotInstrumentRows.map((row) =>
      row["symbol"] === "RAAPLUSDT" ? { ...row, status: "limit_open" } : row,
    );
    const universe = await buildUniverse(
      market({ instruments: { SPOT: rows } }),
      DEFAULT_RULEBOOK,
      { maxSymbols: 10, cacheFile: cacheFile(), ttlMs: 60_000, now: NOW },
    );

    const symbols = universe.entries.map((e) => e.rToken.symbol);
    expect(symbols).toEqual(["RTSLAUSDT", "RNVDAUSDT"]);
    // RMSTR is liquid and has a perp but did not trade over the weekend, RSPY turns over
    // 150,000 USDT on a million tokens, and rAAPL is not online.
    expect(symbols).not.toContain("RMSTRUSDT");
    expect(symbols).not.toContain("RSPYUSDT");
    expect(symbols).not.toContain("RAAPLUSDT");
  });

  it("cuts at maxSymbols", async () => {
    const universe = await buildUniverse(market(), DEFAULT_RULEBOOK, {
      maxSymbols: 1,
      cacheFile: cacheFile(),
      ttlMs: 60_000,
      now: NOW,
    });
    expect(universe.entries).toHaveLength(1);
    expect(universe.entries[0]?.rToken.symbol).toBe("RTSLAUSDT");
  });

  it("reuses the cache inside the ttl and rebuilds after it", async () => {
    const file = cacheFile();
    const first = market();
    await buildUniverse(first, DEFAULT_RULEBOOK, { maxSymbols: 2, cacheFile: file, ttlMs: 60_000, now: NOW });
    expect(first.calls.length).toBeGreaterThan(0);

    const second = market();
    const cached = await buildUniverse(second, DEFAULT_RULEBOOK, {
      maxSymbols: 2,
      cacheFile: file,
      ttlMs: 60_000,
      now: new Date(NOW.getTime() + 30_000),
    });
    expect(second.calls).toHaveLength(0);
    expect(cached.entries.map((e) => e.rToken.symbol)).toEqual(["RTSLAUSDT", "RNVDAUSDT"]);

    const third = market();
    await buildUniverse(third, DEFAULT_RULEBOOK, {
      maxSymbols: 2,
      cacheFile: file,
      ttlMs: 60_000,
      now: new Date(NOW.getTime() + 120_000),
    });
    expect(third.calls.length).toBeGreaterThan(0);
  });

  it("rebuilds when the cache file is not readable as a universe", async () => {
    const file = cacheFile();
    writeFileSync(file, "half a json file", "utf8");
    const ctx = market();
    const universe = await buildUniverse(ctx, DEFAULT_RULEBOOK, {
      maxSymbols: 2,
      cacheFile: file,
      ttlMs: 60_000,
      now: NOW,
    });
    expect(universe.entries.length).toBe(2);
    expect(ctx.calls.length).toBeGreaterThan(0);
  });

  it("keeps an rToken with no perpetual when the rulebook stops requiring one", async () => {
    const rulebook = {
      ...DEFAULT_RULEBOOK,
      universe: { ...DEFAULT_RULEBOOK.universe, requirePerp: false, requireWeekendTrade: false },
    };
    const universe = await buildUniverse(
      fakeMarket({ quotes: { RPBRUSDT: { last: 15, bid: 14.9, ask: 15.1, usdtVolume: 800_000 } } }),
      rulebook,
      { maxSymbols: 5, cacheFile: cacheFile(), ttlMs: 60_000, now: NOW },
    );
    expect(universe.entries.map((e) => e.rToken.symbol)).toEqual(["RPBRUSDT"]);
    expect(universe.entries[0]?.perp).toBeNull();
    expect(universe.weekendChecked).toBeNull();
  });
});

describe("universeKeys", () => {
  it("names every rToken, perpetual and hedge in the account key form", async () => {
    const universe = await buildUniverse(market(), DEFAULT_RULEBOOK, {
      maxSymbols: 1,
      cacheFile: cacheFile(),
      ttlMs: 60_000,
      now: NOW,
    });
    expect([...universeKeys(universe)].sort()).toEqual([
      "SPOT:RTSLAUSDT",
      "USDT-FUTURES:BTCUSDT",
      "USDT-FUTURES:ETHUSDT",
      "USDT-FUTURES:SPYUSDT",
      "USDT-FUTURES:TSLAUSDT",
    ]);
  });
});

describe("lastCompletedWeekend", () => {
  it("takes Saturday to Monday of the weekend that has finished", () => {
    const thursday = lastCompletedWeekend(new Date("2026-09-10T22:00:00Z"));
    expect(new Date(thursday.start).toISOString()).toBe("2026-09-05T00:00:00.000Z");
    expect(new Date(thursday.end).toISOString()).toBe("2026-09-07T00:00:00.000Z");

    const sunday = lastCompletedWeekend(new Date("2026-09-06T12:00:00Z"));
    expect(new Date(sunday.start).toISOString()).toBe("2026-08-29T00:00:00.000Z");
    expect(new Date(sunday.end).toISOString()).toBe("2026-08-31T00:00:00.000Z");
  });
});

describe("underlyingOf", () => {
  it("strips the tokenized stock prefix", () => {
    const rtsla = spotInstrumentRows.find((r) => r["symbol"] === "RTSLAUSDT");
    expect(underlyingOf({ baseCoin: String(rtsla?.["baseCoin"]) } as never)).toBe("TSLA");
  });
});
