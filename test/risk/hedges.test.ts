import { describe, expect, it } from "vitest";
import { checkIntent, requiredHedges } from "../../src/risk/limits.js";
import { account, context, position, symbol, universeOf, world } from "./world.js";

// Covers the cross-asset rule: when a hedge is demanded, how big it is, which perpetual
// it goes in, and how a short already on the books counts towards it. It does not cover
// whether the hedge would fill, and it does not prove the hedge works as a hedge: that
// is a claim about correlation, and the ledger has to answer it with real nights.

const HOUR = 3_600_000;

const shutForTheWeekend = { ...world().clock, msToNextOpen: 60 * HOUR };

describe("requiredHedges", () => {
  it("hedges half the delta of a big rToken position when the market is shut for the weekend", () => {
    const ctx = context({
      world: world({ clock: shutForTheWeekend }),
      account: account({ positions: [position({ notionalUsdt: 800 })] }),
    });

    expect(requiredHedges(ctx)).toEqual([
      {
        category: "USDT-FUTURES",
        symbol: "TSLAUSDT",
        side: "sell",
        notionalUsdt: 400,
        reduceOnly: false,
        hedgeFor: "RTSLAUSDT",
        brain: "rules",
        source: "rebalance",
      },
    ]);
  });

  it("leaves a position under five percent of equity alone", () => {
    const ctx = context({
      world: world({ clock: shutForTheWeekend }),
      account: account({ positions: [position({ notionalUsdt: 400 })] }),
    });
    expect(requiredHedges(ctx)).toEqual([]);
  });

  it("hedges on divergence alone on an ordinary overnight", () => {
    const drifted = context({
      world: world({ symbols: [symbol({ divergencePct: 0.9 }), symbol({ category: "USDT-FUTURES", symbol: "TSLAUSDT" })] }),
      account: account({ positions: [position({ notionalUsdt: 800 })] }),
    });
    expect(requiredHedges(drifted)).toHaveLength(1);

    const quiet = context({
      world: world({ symbols: [symbol({ divergencePct: 0.2 }), symbol({ category: "USDT-FUTURES", symbol: "TSLAUSDT" })] }),
      account: account({ positions: [position({ notionalUsdt: 800 })] }),
    });
    expect(requiredHedges(quiet)).toEqual([]);
  });

  it("asks only for the shortfall when a short is already on the books", () => {
    const covered = context({
      world: world({ clock: shutForTheWeekend }),
      account: account({
        positions: [
          position({ notionalUsdt: 800 }),
          position({ category: "USDT-FUTURES", symbol: "TSLAUSDT", side: "short", notionalUsdt: 400 }),
        ],
      }),
    });
    expect(requiredHedges(covered)).toEqual([]);

    const partial = context({
      world: world({ clock: shutForTheWeekend }),
      account: account({
        positions: [
          position({ notionalUsdt: 800 }),
          position({ category: "USDT-FUTURES", symbol: "TSLAUSDT", side: "short", notionalUsdt: 150 }),
        ],
      }),
    });
    expect(requiredHedges(partial)[0]?.notionalUsdt).toBeCloseTo(250, 9);
  });

  it("falls back to SPYUSDT and never counts one SPY short twice", () => {
    const state = world({
      clock: shutForTheWeekend,
      symbols: [
        symbol({ symbol: "RAMDUSDT", underlying: "AMD" }),
        symbol({ symbol: "RINTCUSDT", underlying: "INTC" }),
        symbol({ category: "USDT-FUTURES", symbol: "SPYUSDT", underlying: "SPY" }),
      ],
    });
    const ctx = context({
      world: state,
      account: account({
        positions: [
          position({ symbol: "RAMDUSDT", notionalUsdt: 800 }),
          position({ symbol: "RINTCUSDT", notionalUsdt: 800 }),
          position({ category: "USDT-FUTURES", symbol: "SPYUSDT", side: "short", notionalUsdt: 500 }),
        ],
      }),
    });

    const hedges = requiredHedges(ctx);
    expect(hedges).toHaveLength(1);
    expect(hedges[0]).toMatchObject({ symbol: "SPYUSDT", side: "sell", hedgeFor: "RINTCUSDT" });
    expect(hedges[0]?.notionalUsdt).toBeCloseTo(300, 9);
  });
});

describe("an own perpetual that did not answer this tick", () => {
  const unreadable = () => {
    const state = world({
      clock: shutForTheWeekend,
      symbols: [symbol(), symbol({ category: "USDT-FUTURES", symbol: "SPYUSDT", underlying: "SPY" })],
    });
    return context({
      world: state,
      // Tonight's universe holds the Tesla perpetual even though it could not be read.
      universe: new Set([...universeOf(state), "USDT-FUTURES:TSLAUSDT"]),
      account: account({ positions: [position({ notionalUsdt: 800 })] }),
    });
  };

  it("still names the stock's own perpetual rather than swapping in SPY", () => {
    const hedges = requiredHedges(unreadable());
    expect(hedges).toHaveLength(1);
    expect(hedges[0]?.symbol).toBe("TSLAUSDT");
  });

  it("is refused with the reason, instead of hedging on a market we could not see", () => {
    const ctx = unreadable();
    const [hedge] = requiredHedges(ctx);
    expect(hedge).toBeDefined();
    if (!hedge) return;
    const verdict = checkIntent(hedge, ctx, []);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.rule).toBe("universe.symbol");
    expect(verdict.reason).toContain("could not be read this tick");
  });

  it("uses SPY when the stock has no perpetual in the universe at all", () => {
    const state = world({
      clock: shutForTheWeekend,
      symbols: [
        symbol({ symbol: "RAMDUSDT", underlying: "AMD" }),
        symbol({ category: "USDT-FUTURES", symbol: "SPYUSDT", underlying: "SPY" }),
      ],
    });
    const ctx = context({
      world: state,
      account: account({ positions: [position({ symbol: "RAMDUSDT", notionalUsdt: 800 })] }),
    });
    expect(requiredHedges(ctx)[0]?.symbol).toBe("SPYUSDT");
  });
});

describe("a hedge against the entry gates", () => {
  it("passes at a divergence that would refuse a naked long, and still respects the spread", () => {
    const state = world({
      clock: shutForTheWeekend,
      symbols: [
        symbol({ divergencePct: 3 }),
        symbol({ category: "USDT-FUTURES", symbol: "TSLAUSDT", divergencePct: 3 }),
      ],
    });
    const ctx = context({ world: state, account: account({ positions: [position({ notionalUsdt: 800 })] }) });
    const [hedge] = requiredHedges(ctx);
    expect(hedge).toBeDefined();
    if (!hedge) return;
    expect(checkIntent(hedge, ctx, []).allowed).toBe(true);

    const wide = context({
      world: world({
        clock: shutForTheWeekend,
        symbols: [
          symbol({ divergencePct: 3 }),
          symbol({ category: "USDT-FUTURES", symbol: "TSLAUSDT", spreadBps: 45 }),
        ],
      }),
      account: account({ positions: [position({ notionalUsdt: 800 })] }),
    });
    const verdict = checkIntent(hedge, wide, []);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.rule).toBe("gates.maxSpreadBps");
  });
});
