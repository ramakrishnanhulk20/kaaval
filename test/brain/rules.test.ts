import { describe, expect, it } from "vitest";
import { RulesBrain } from "../../src/brain/rules.js";
import { DEFAULT_RULEBOOK, rulebookText } from "../../src/risk/rulebook.js";
import { account, position, symbol, world } from "../risk/world.js";

// Covers what the baseline proposes: the basis buy, the flat, the weekend hedge and
// nothing else. It does not cover whether the proposal is allowed, which is the
// rulebook's job in risk/limits.ts, and it does not judge whether the strategy makes
// money. That answer only comes from the ledger after real nights.

const HOUR = 3_600_000;
const brain = new RulesBrain();
const text = rulebookText(DEFAULT_RULEBOOK);

function nightWorld(rTokenLast: number, msToNextOpen = 12 * HOUR) {
  return world({
    clock: { ...world().clock, msToNextOpen },
    symbols: [
      symbol({ last: rTokenLast, divergencePct: 0.2 }),
      symbol({ category: "USDT-FUTURES", symbol: "TSLAUSDT", last: 400 }),
    ],
  });
}

describe("RulesBrain", () => {
  it("buys the rToken to eight percent of equity when it trades under its perpetual", async () => {
    const decision = await brain.decide(nightWorld(397.5), account(), text);

    expect(decision.brain).toBe("rules");
    expect(decision.modelCalls).toBe(0);
    expect(decision.targets).toHaveLength(1);
    expect(decision.targets[0]).toMatchObject({
      category: "SPOT",
      symbol: "RTSLAUSDT",
      targetNotionalUsdt: 800,
      hedgeFor: null,
    });
    expect(decision.targets[0]?.rationale).toContain("-62.50 basis points below");
    expect(decision.targets[0]?.rationale).toContain("800.00 USDT");
  });

  it("flats a holding once the gap has closed or turned the other way", async () => {
    const held = account({ positions: [position({ notionalUsdt: 800 })] });

    const closed = await brain.decide(nightWorld(399), held, text);
    expect(closed.targets).toHaveLength(1);
    expect(closed.targets[0]).toMatchObject({ symbol: "RTSLAUSDT", targetNotionalUsdt: 0 });

    const above = await brain.decide(nightWorld(403), held, text);
    expect(above.targets[0]).toMatchObject({ symbol: "RTSLAUSDT", targetNotionalUsdt: 0 });
    expect(above.targets[0]?.rationale).toContain("75.00 basis points above");
  });

  it("carries half the delta short in the matching perpetual over a weekend", async () => {
    const decision = await brain.decide(nightWorld(397.5, 60 * HOUR), account(), text);

    expect(decision.targets).toHaveLength(2);
    expect(decision.targets[1]).toMatchObject({
      category: "USDT-FUTURES",
      symbol: "TSLAUSDT",
      targetNotionalUsdt: -400,
      hedgeFor: "RTSLAUSDT",
    });
    expect(decision.targets[1]?.rationale).toContain("60.00 hours");
    expect(decision.summary).toContain("1 hedges");
  });

  it("hedges on divergence alone when the market is only shut overnight", async () => {
    const drifted = world({
      symbols: [
        symbol({ last: 397.5, divergencePct: 0.9 }),
        symbol({ category: "USDT-FUTURES", symbol: "TSLAUSDT", last: 400 }),
      ],
    });
    const decision = await brain.decide(drifted, account(), text);
    expect(decision.targets[1]).toMatchObject({ symbol: "TSLAUSDT", hedgeFor: "RTSLAUSDT" });
    expect(decision.targets[1]?.rationale).toContain("0.90 percent");
  });

  it("proposes nothing on a quiet book and closes anything it cannot explain", async () => {
    const quiet = await brain.decide(nightWorld(399), account(), text);
    expect(quiet.targets).toEqual([]);

    const orphan = account({
      positions: [position({ category: "USDT-FUTURES", symbol: "SPYUSDT", side: "short", notionalUsdt: 300 })],
    });
    const decision = await brain.decide(nightWorld(399), orphan, text);
    expect(decision.targets).toHaveLength(1);
    expect(decision.targets[0]).toMatchObject({ symbol: "SPYUSDT", targetNotionalUsdt: 0 });
    expect(decision.targets[0]?.rationale).toContain("no basis signal");
  });

  it("ignores an rToken with no perpetual to measure it against", async () => {
    const lonely = world({ symbols: [symbol({ symbol: "RAMDUSDT", underlying: "AMD", last: 10 })] });
    const decision = await brain.decide(lonely, account(), text);
    expect(decision.targets).toEqual([]);
  });
});
