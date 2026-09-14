import { describe, expect, it } from "vitest";
import { checkAll, inNoEntryWindow, type OrderIntent, type RiskContext } from "../../src/risk/limits.js";
import { DEFAULT_RULEBOOK } from "../../src/risk/rulebook.js";
import type { PositionView } from "../../src/brain/types.js";
import { account, context, symbol, world } from "./world.js";

// Covers what must hold for any list of intents against any account: the caps are never
// breached by an order we allowed, nothing enters during the re-anchoring minutes, and
// every refusal names a rule. It does not cover whether the refusals are the right ones
// for the right reasons: that is limits.test.ts, one rule at a time. The accounts are
// generated, so this proves the arithmetic of the limits, not the shape of a real book.

const CASES = 2000;
const SEED = 20260908;

const SYMBOLS = [
  { category: "SPOT" as const, symbol: "RTSLAUSDT", underlying: "TSLA" },
  { category: "SPOT" as const, symbol: "RAAPLUSDT", underlying: "AAPL" },
  { category: "SPOT" as const, symbol: "RNVDAUSDT", underlying: "NVDA" },
  { category: "USDT-FUTURES" as const, symbol: "TSLAUSDT", underlying: "TSLA" },
  { category: "USDT-FUTURES" as const, symbol: "AAPLUSDT", underlying: "AAPL" },
  { category: "USDT-FUTURES" as const, symbol: "SPYUSDT", underlying: "SPY" },
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(SEED);

function between(low: number, high: number): number {
  return low + rand() * (high - low);
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

function key(intentOrPosition: { category: string; symbol: string }): string {
  return `${intentOrPosition.category}:${intentOrPosition.symbol}`;
}

function randomContext(): RiskContext {
  const equity = between(500, 50_000);
  const positions: PositionView[] = [];
  for (const listing of SYMBOLS) {
    if (rand() > 0.45) continue;
    const notional = between(10, equity * 0.35);
    positions.push({
      category: listing.category,
      symbol: listing.symbol,
      side: listing.category === "SPOT" || rand() < 0.5 ? "long" : "short",
      qty: notional / 100,
      avgEntry: 100,
      mark: 100,
      notionalUsdt: notional,
      unrealised: 0,
    });
  }

  const state = world({
    clock: {
      ...world().clock,
      nowEt: pick(["2026-09-11 09:30:00 ET", "2026-09-11 22:00:00 ET", "2026-09-11 09:10:00 ET"]),
      msToNextOpen: between(10 * 60_000, 60 * 3_600_000),
      regularSessionOpen: false,
    },
    symbols: SYMBOLS.map((listing) =>
      symbol({
        ...listing,
        spreadBps: between(1, 45),
        divergencePct: rand() < 0.1 ? null : between(-2, 2),
        tradable: rand() > 0.05,
      }),
    ),
  });

  return context({
    world: state,
    account: account({ equity, balanceUsdt: equity, positions }),
    startOfDayEquity: equity * between(0.95, 1.05),
    peakEquity: equity * between(1, 1.2),
    halted: rand() < 0.1,
    universe: new Set(SYMBOLS.filter(() => rand() > 0.05).map(key)),
  });
}

function randomIntents(): OrderIntent[] {
  const count = 1 + Math.floor(rand() * 6);
  return Array.from({ length: count }, () => {
    const listing = pick(SYMBOLS);
    const reduceOnly = rand() < 0.2;
    return {
      category: listing.category,
      symbol: rand() < 0.05 ? "RGMEUSDT" : listing.symbol,
      side: rand() < 0.5 ? ("buy" as const) : ("sell" as const),
      notionalUsdt: between(1, 40_000),
      reduceOnly,
      hedgeFor: rand() < 0.2 ? "RTSLAUSDT" : null,
      brain: "fuzz",
      source: pick(["brain", "brain", "stop", "rebalance", "kill"] as const),
    };
  });
}

function exposures(ctx: RiskContext, allowed: OrderIntent[]): { gross: number; net: number; perSymbol: number } {
  const signed = new Map<string, number>();
  for (const p of ctx.account.positions) {
    const value = p.side === "long" ? p.notionalUsdt : -p.notionalUsdt;
    signed.set(key(p), (signed.get(key(p)) ?? 0) + value);
  }
  for (const order of allowed) {
    const value = order.side === "buy" ? order.notionalUsdt : -order.notionalUsdt;
    signed.set(key(order), (signed.get(key(order)) ?? 0) + value);
  }

  let gross = 0;
  let net = 0;
  let perSymbol = 0;
  for (const value of signed.values()) {
    gross += Math.abs(value);
    net += value;
    perSymbol = Math.max(perSymbol, Math.abs(value));
  }
  return { gross, net: Math.abs(net), perSymbol };
}

describe("the limits over random intents and accounts", () => {
  it(`holds the caps, the entry window and the reasons over ${CASES} cases`, () => {
    let allowedCount = 0;
    let refusedCount = 0;
    let clippedCount = 0;

    for (let i = 0; i < CASES; i += 1) {
      const ctx = randomContext();
      const intents = randomIntents();
      const before = exposures(ctx, []);
      const verdicts = checkAll(intents, ctx);
      const allowed: OrderIntent[] = [];

      for (let n = 0; n < verdicts.length; n += 1) {
        const verdict = verdicts[n]!;
        const asked = intents[n]!;
        if (!verdict.allowed) {
          refusedCount += 1;
          expect(verdict.rule).toMatch(/^[a-z]+\.[A-Za-z]+$/);
          expect(verdict.reason.length).toBeGreaterThan(0);
          continue;
        }

        allowedCount += 1;
        if (verdict.clipped) clippedCount += 1;
        expect(verdict.intent.notionalUsdt).toBeLessThanOrEqual(asked.notionalUsdt + 1e-9);
        expect(verdict.intent.notionalUsdt).toBeGreaterThan(0);

        const cutsRisk = asked.reduceOnly || asked.source === "kill";
        if (!cutsRisk) {
          expect(ctx.halted).toBe(false);
          expect(inNoEntryWindow(ctx.world.clock.nowEt, DEFAULT_RULEBOOK)).toBe(false);
          expect(verdict.intent.notionalUsdt).toBeGreaterThanOrEqual(DEFAULT_RULEBOOK.exposure.minOrderUsdt - 1e-9);
          expect(verdict.intent.notionalUsdt).toBeLessThanOrEqual(DEFAULT_RULEBOOK.exposure.maxOrderUsdt + 1e-9);
        }
        allowed.push(verdict.intent);
      }

      const after = exposures(ctx, allowed);
      const equity = ctx.account.equity;
      const tolerance = 1e-6;
      expect(after.gross).toBeLessThanOrEqual(
        Math.max((DEFAULT_RULEBOOK.exposure.grossPct / 100) * equity, before.gross) + tolerance,
      );
      expect(after.net).toBeLessThanOrEqual(
        Math.max((DEFAULT_RULEBOOK.exposure.netPct / 100) * equity, before.net) + tolerance,
      );
      expect(after.perSymbol).toBeLessThanOrEqual(
        Math.max((DEFAULT_RULEBOOK.exposure.perSymbolPct / 100) * equity, before.perSymbol) + tolerance,
      );
    }

    expect(allowedCount).toBeGreaterThan(100);
    expect(refusedCount).toBeGreaterThan(100);
    expect(clippedCount).toBeGreaterThan(100);
  });
});
