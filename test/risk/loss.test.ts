import { describe, expect, it } from "vitest";
import { checkIntent, lossState } from "../../src/risk/limits.js";
import { account, context, intent, position } from "./world.js";

// Covers the three loss limits and what each one does to an order. It does not cover
// how equity was computed: that is sim/account.ts, and this file trusts the number it
// is handed. The UTC day boundary that resets the daily limit is the engine's to move;
// here it arrives as startOfDayEquity.

describe("lossState", () => {
  it("flags nothing on a flat day", () => {
    expect(lossState(context())).toEqual({
      dailyLossHit: false,
      tighten: false,
      halt: false,
      sizeMultiplier: 1,
    });
  });

  it("hits the daily limit at exactly two percent down", () => {
    const ctx = context({ account: account({ equity: 9_800 }), startOfDayEquity: 10_000, peakEquity: 10_000 });
    expect(lossState(ctx).dailyLossHit).toBe(true);
    expect(lossState(context({ account: account({ equity: 9_801 }), startOfDayEquity: 10_000 })).dailyLossHit).toBe(
      false,
    );
  });

  it("halves the size between the eight and twelve percent drawdown lines", () => {
    const ctx = context({ account: account({ equity: 9_200 }), startOfDayEquity: 9_200, peakEquity: 10_000 });
    expect(lossState(ctx)).toMatchObject({ tighten: true, halt: false, sizeMultiplier: 0.5 });
  });

  it("halts past twelve percent from the peak, and on an account with no equity left", () => {
    const deep = context({ account: account({ equity: 8_800 }), startOfDayEquity: 8_800, peakEquity: 10_000 });
    expect(lossState(deep)).toMatchObject({ tighten: false, halt: true, sizeMultiplier: 0 });

    const wiped = context({ account: account({ equity: 0 }), startOfDayEquity: 0, peakEquity: 0 });
    expect(lossState(wiped).halt).toBe(true);
  });

  it("reads a missing start-of-day or peak as no loss rather than a false alarm", () => {
    const ctx = context({ account: account({ equity: 10_000 }), startOfDayEquity: 0, peakEquity: 0 });
    expect(lossState(ctx)).toMatchObject({ dailyLossHit: false, tighten: false, halt: false });
  });
});

describe("what the loss limits do to an order", () => {
  it("refuses new risk after the daily loss and still lets a position out", () => {
    const ctx = context({
      account: account({ equity: 9_700, positions: [position()] }),
      startOfDayEquity: 10_000,
      peakEquity: 10_000,
    });

    const entry = checkIntent(intent(), ctx, []);
    expect(entry.allowed).toBe(false);
    if (entry.allowed) return;
    expect(entry.rule).toBe("loss.dailyLossPct");
    expect(entry.reason).toContain("3.00 percent down");

    expect(checkIntent(intent({ side: "sell", reduceOnly: true, notionalUsdt: 800 }), ctx, []).allowed).toBe(true);
  });

  it("halves an entry inside the tighten band and says why", () => {
    const ctx = context({ account: account({ equity: 9_200 }), startOfDayEquity: 9_200, peakEquity: 10_000 });
    const verdict = checkIntent(intent({ notionalUsdt: 400 }), ctx, []);
    expect(verdict.allowed).toBe(true);
    if (!verdict.allowed) return;
    expect(verdict.intent.notionalUsdt).toBeCloseTo(200, 9);
    expect(verdict.notes[0]).toContain("loss.drawdownTightenPct");
  });

  it("refuses everything but the way out past the halt line", () => {
    const ctx = context({
      account: account({ equity: 8_700, positions: [position()] }),
      startOfDayEquity: 8_700,
      peakEquity: 10_000,
    });

    const entry = checkIntent(intent(), ctx, []);
    expect(entry.allowed).toBe(false);
    if (entry.allowed) return;
    expect(entry.rule).toBe("loss.drawdownHaltPct");

    expect(checkIntent(intent({ side: "sell", source: "kill", notionalUsdt: 800 }), ctx, []).allowed).toBe(true);
  });
});
