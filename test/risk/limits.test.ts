import { describe, expect, it } from "vitest";
import { checkAll, checkIntent, inNoEntryWindow, targetsToIntents } from "../../src/risk/limits.js";
import { DEFAULT_RULEBOOK } from "../../src/risk/rulebook.js";
import type { Target } from "../../src/brain/types.js";
import { account, context, intent, position, symbol, world } from "./world.js";

// Covers one rule of docs/rulebook.md per test, plus the walk from targets to intents.
// The loss limits live in loss.test.ts, the cross-asset rule in hedges.test.ts and the
// stops in stops.test.ts. Nothing here proves an order would fill: whether the book
// could take the size is the fill model's job, and the book fraction limit is carried
// in the rulebook for it rather than checked here.

describe("the control case", () => {
  it("allows an ordinary night entry untouched", () => {
    const verdict = checkIntent(intent(), context(), []);
    expect(verdict.allowed).toBe(true);
    if (!verdict.allowed) return;
    expect(verdict.intent.notionalUsdt).toBe(400);
    expect(verdict.clipped).toBe(false);
    expect(verdict.notes).toEqual([]);
  });
});

describe("input", () => {
  it("refuses an order size that is not a positive number", () => {
    for (const size of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      const verdict = checkIntent(intent({ notionalUsdt: size }), context(), []);
      expect(verdict.allowed).toBe(false);
      if (verdict.allowed) return;
      expect(verdict.rule).toBe("input.notionalUsdt");
    }
  });
});

describe("safety.kill", () => {
  it("refuses new risk while the kill switch is on and still lets risk out", () => {
    const halted = context({ halted: true });

    const blocked = checkIntent(intent(), halted, []);
    expect(blocked.allowed).toBe(false);
    if (blocked.allowed) return;
    expect(blocked.rule).toBe("safety.kill");
    expect(blocked.reason).toContain("kill switch");

    const flattening = checkIntent(
      intent({ side: "sell", reduceOnly: true, notionalUsdt: 800 }),
      context({ halted: true, account: account({ positions: [position()] }) }),
      [],
    );
    expect(flattening.allowed).toBe(true);

    const killed = checkIntent(
      intent({ side: "sell", source: "kill", notionalUsdt: 800 }),
      context({ halted: true, account: account({ positions: [position()] }) }),
      [],
    );
    expect(killed.allowed).toBe(true);
  });
});

describe("universe", () => {
  it("refuses a symbol that is not in today's universe", () => {
    const verdict = checkIntent(intent({ symbol: "RNVDAUSDT" }), context(), []);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.rule).toBe("universe.symbol");
    expect(verdict.reason).toContain("SPOT:RNVDAUSDT");
  });

  it("refuses a universe symbol with no market data this tick", () => {
    const state = world({ symbols: [symbol({ symbol: "ROTHERUSDT" })] });
    const ctx = context({ world: state, universe: new Set(["SPOT:RTSLAUSDT"]) });
    const verdict = checkIntent(intent(), ctx, []);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.rule).toBe("universe.symbol");
    expect(verdict.reason).toContain("no market data");
  });

  it("refuses a symbol whose market is shut", () => {
    const state = world({ symbols: [symbol({ tradable: false })] });
    const verdict = checkIntent(intent(), context({ world: state }), []);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.rule).toBe("universe.tradable");
  });
});

describe("gates.noEntryWindow", () => {
  it("refuses an entry inside the re-anchoring minutes and lets a reduction through", () => {
    const state = world({ clock: { ...world().clock, nowEt: "2026-09-11 09:30:00 ET" } });
    const ctx = context({ world: state, account: account({ positions: [position()] }) });

    const entry = checkIntent(intent(), ctx, []);
    expect(entry.allowed).toBe(false);
    if (entry.allowed) return;
    expect(entry.rule).toBe("gates.noEntryWindow");

    const exit = checkIntent(intent({ side: "sell", reduceOnly: true, notionalUsdt: 800 }), ctx, []);
    expect(exit.allowed).toBe(true);
  });

  it("reads the clock as nyseClock writes it, and shuts on a clock it cannot read", () => {
    expect(inNoEntryWindow("2026-09-11 09:24:00 ET", DEFAULT_RULEBOOK)).toBe(false);
    expect(inNoEntryWindow("2026-09-11 09:25:00 ET", DEFAULT_RULEBOOK)).toBe(true);
    expect(inNoEntryWindow("09:40", DEFAULT_RULEBOOK)).toBe(true);
    expect(inNoEntryWindow("09:41", DEFAULT_RULEBOOK)).toBe(false);
    expect(inNoEntryWindow("22:00", DEFAULT_RULEBOOK)).toBe(false);
    expect(inNoEntryWindow("no clock", DEFAULT_RULEBOOK)).toBe(true);
  });
});

describe("gates.maxSpreadBps", () => {
  it("refuses an entry when the spread is wider than the limit", () => {
    const state = world({ symbols: [symbol({ spreadBps: 31 })] });
    const verdict = checkIntent(intent(), context({ world: state }), []);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.rule).toBe("gates.maxSpreadBps");
    expect(verdict.reason).toContain("31.00 basis points");
  });
});

describe("gates.maxDivergencePctForNewLong", () => {
  it("refuses a new unhedged rToken long that has drifted too far, and allows the hedged one", () => {
    const state = world({ symbols: [symbol({ divergencePct: 1.4 })] });
    const ctx = context({ world: state });

    const naked = checkIntent(intent(), ctx, []);
    expect(naked.allowed).toBe(false);
    if (naked.allowed) return;
    expect(naked.rule).toBe("gates.maxDivergencePctForNewLong");

    const hedged = checkIntent(intent({ hedgeFor: "TSLAUSDT" }), ctx, []);
    expect(hedged.allowed).toBe(true);
  });

  it("refuses a new unhedged rToken long when divergence is unknown", () => {
    const state = world({ symbols: [symbol({ divergencePct: null })] });
    const verdict = checkIntent(intent(), context({ world: state }), []);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.rule).toBe("gates.maxDivergencePctForNewLong");
    expect(verdict.reason).toContain("unknown");
  });

  it("stands down while the regular session is open, even with divergence unknown", () => {
    const state = world({ symbols: [symbol({ divergencePct: null })] });
    state.clock.regularSessionOpen = true;
    const verdict = checkIntent(intent(), context({ world: state }), []);
    expect(verdict.allowed).toBe(true);
  });
});

describe("gates.preOpenDivergencePct", () => {
  it("refuses a stretched unhedged long in the half hour before the open", () => {
    const state = world({
      clock: { ...world().clock, nowEt: "2026-09-11 09:10:00 ET", msToNextOpen: 20 * 60_000 },
      symbols: [symbol({ divergencePct: 0.8 })],
    });
    const ctx = context({ world: state });

    const naked = checkIntent(intent(), ctx, []);
    expect(naked.allowed).toBe(false);
    if (naked.allowed) return;
    expect(naked.rule).toBe("gates.preOpenDivergencePct");

    expect(checkIntent(intent({ hedgeFor: "TSLAUSDT" }), ctx, []).allowed).toBe(true);
  });
});

describe("exposure.perSymbolPct", () => {
  it("cuts an order down to the room left in that one symbol", () => {
    const ctx = context({ account: account({ positions: [position({ notionalUsdt: 800 })] }) });
    const verdict = checkIntent(intent(), ctx, []);
    expect(verdict.allowed).toBe(true);
    if (!verdict.allowed) return;
    expect(verdict.intent.notionalUsdt).toBeCloseTo(200, 9);
    expect(verdict.clipped).toBe(true);
    expect(verdict.notes[0]).toContain("exposure.perSymbolPct");
  });
});

describe("exposure.grossPct", () => {
  it("counts positions and earlier allowed intents against the gross limit", () => {
    const ctx = context({
      account: account({
        positions: [
          position({ category: "USDT-FUTURES", symbol: "TSLAUSDT", side: "short", notionalUsdt: 5_500 }),
        ],
      }),
    });
    const earlier = [intent({ category: "USDT-FUTURES", symbol: "SPYUSDT", side: "sell", notionalUsdt: 200 })];

    const verdict = checkIntent(intent(), ctx, earlier);
    expect(verdict.allowed).toBe(true);
    if (!verdict.allowed) return;
    expect(verdict.intent.notionalUsdt).toBeCloseTo(300, 9);
    expect(verdict.notes[0]).toContain("exposure.grossPct");
  });
});

describe("exposure.netPct", () => {
  it("cuts an order down to the room left in the net direction", () => {
    const earlier = [intent({ category: "USDT-FUTURES", symbol: "SPYUSDT", side: "buy", notionalUsdt: 3_800 })];
    const verdict = checkIntent(intent(), context(), earlier);
    expect(verdict.allowed).toBe(true);
    if (!verdict.allowed) return;
    expect(verdict.intent.notionalUsdt).toBeCloseTo(200, 9);
    expect(verdict.notes[0]).toContain("exposure.netPct");
  });
});

describe("exposure.maxPositions", () => {
  it("refuses a new symbol once the book is full and still allows adding to an open one", () => {
    const positions = Array.from({ length: 8 }, (_, i) =>
      position({ category: "USDT-FUTURES", symbol: `HELD${i}USDT`, notionalUsdt: 10 }),
    );
    const ctx = context({ account: account({ positions }) });

    const fresh = checkIntent(intent(), ctx, []);
    expect(fresh.allowed).toBe(false);
    if (fresh.allowed) return;
    expect(fresh.rule).toBe("exposure.maxPositions");

    const topUp = checkIntent(
      intent({ category: "USDT-FUTURES", symbol: "HELD0USDT" }),
      context({
        account: account({ positions }),
        universe: new Set(["USDT-FUTURES:HELD0USDT"]),
        world: world({ symbols: [symbol({ category: "USDT-FUTURES", symbol: "HELD0USDT" })] }),
      }),
      [],
    );
    expect(topUp.allowed).toBe(true);
  });
});

describe("exposure.minOrderUsdt", () => {
  it("refuses a dust order, including one the caps cut down to dust", () => {
    const small = checkIntent(intent({ notionalUsdt: 50 }), context(), []);
    expect(small.allowed).toBe(false);
    if (small.allowed) return;
    expect(small.rule).toBe("exposure.minOrderUsdt");

    const squeezed = checkIntent(
      intent(),
      context({ account: account({ positions: [position({ notionalUsdt: 950 })] }) }),
      [],
    );
    expect(squeezed.allowed).toBe(false);
    if (squeezed.allowed) return;
    expect(squeezed.rule).toBe("exposure.minOrderUsdt");

    const closing = checkIntent(
      intent({ side: "sell", reduceOnly: true, notionalUsdt: 50 }),
      context({ account: account({ positions: [position({ notionalUsdt: 50 })] }) }),
      [],
    );
    expect(closing.allowed).toBe(true);
  });
});

describe("exposure.maxOrderUsdt", () => {
  it("cuts an oversize order to the cap instead of refusing it", () => {
    const verdict = checkIntent(intent({ notionalUsdt: 9_000 }), context(), []);
    expect(verdict.allowed).toBe(true);
    if (!verdict.allowed) return;
    expect(verdict.intent.notionalUsdt).toBe(500);
    expect(verdict.notes.some((note) => note.includes("exposure.maxOrderUsdt"))).toBe(true);
  });
});

describe("checkAll", () => {
  it("judges intents in order, so the last one sees what the first one took", () => {
    const ctx = context({
      account: account({
        positions: [
          position({ category: "USDT-FUTURES", symbol: "TSLAUSDT", side: "short", notionalUsdt: 5_200 }),
        ],
      }),
    });
    const verdicts = checkAll(
      [
        intent({ notionalUsdt: 400 }),
        intent({ category: "USDT-FUTURES", symbol: "SPYUSDT", side: "buy", notionalUsdt: 400 }),
      ],
      ctx,
    );

    expect(verdicts[0]?.allowed).toBe(true);
    const second = verdicts[1];
    expect(second?.allowed).toBe(true);
    if (!second?.allowed) return;
    expect(second.intent.notionalUsdt).toBeCloseTo(400, 9);
    expect(verdicts.every((v) => v.allowed || typeof v.rule === "string")).toBe(true);
  });
});

describe("targetsToIntents", () => {
  const target = (over: Partial<Target> = {}): Target => ({
    category: "SPOT",
    symbol: "RTSLAUSDT",
    targetNotionalUsdt: 800,
    hedgeFor: null,
    rationale: "test",
    confidence: 0.5,
    horizonMinutes: 60,
    ...over,
  });

  it("turns a target on a flat book into one buy", () => {
    const [order] = targetsToIntents([target()], account(), "rules");
    expect(order).toMatchObject({ side: "buy", notionalUsdt: 800, reduceOnly: false, brain: "rules", source: "brain" });
  });

  it("sells the difference and marks it reduce-only", () => {
    const held = account({ positions: [position({ notionalUsdt: 800 })] });
    const [trim] = targetsToIntents([target({ targetNotionalUsdt: 300 })], held, "rules");
    expect(trim).toMatchObject({ side: "sell", notionalUsdt: 500, reduceOnly: true });

    const [close] = targetsToIntents([target({ targetNotionalUsdt: 0 })], held, "rules");
    expect(close).toMatchObject({ side: "sell", notionalUsdt: 800, reduceOnly: true });
  });

  it("turns a short spot target into flat, because spot cannot go short", () => {
    const held = account({ positions: [position({ notionalUsdt: 800 })] });
    const [order] = targetsToIntents(
      [target({ targetNotionalUsdt: -500, hedgeFor: "TSLAUSDT" })],
      held,
      "rules",
    );
    expect(order).toMatchObject({ side: "sell", notionalUsdt: 800, reduceOnly: true, hedgeFor: "TSLAUSDT" });
  });

  it("flips a perpetual through zero in one order and does not call it a reduction", () => {
    const held = account({
      positions: [position({ category: "USDT-FUTURES", symbol: "TSLAUSDT", notionalUsdt: 400 })],
    });
    const [order] = targetsToIntents(
      [target({ category: "USDT-FUTURES", symbol: "TSLAUSDT", targetNotionalUsdt: -200 })],
      held,
      "rules",
    );
    expect(order).toMatchObject({ side: "sell", notionalUsdt: 600, reduceOnly: false });
  });

  it("composes two targets on one symbol and skips a target already held", () => {
    const held = account({ positions: [position({ notionalUsdt: 800 })] });
    const composed = targetsToIntents(
      [target({ targetNotionalUsdt: 1_000 }), target({ targetNotionalUsdt: 400 })],
      held,
      "rules",
    );
    expect(composed).toHaveLength(2);
    expect(composed[0]).toMatchObject({ side: "buy", notionalUsdt: 200 });
    expect(composed[1]).toMatchObject({ side: "sell", notionalUsdt: 600 });

    expect(targetsToIntents([target({ targetNotionalUsdt: 800 })], held, "rules")).toEqual([]);
  });
});
