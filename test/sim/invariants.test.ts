import { describe, expect, it } from "vitest";
import { fillAgainstBook } from "../../src/sim/fill.js";
import { AccountError, applyFill, createAccount, markToMarket, positionKey } from "../../src/sim/account.js";
import type { PaperAccount } from "../../src/sim/account.js";
import type { Category, FeeSchedule, OrderBook, SimOrder, SlippageModel } from "../../src/sim/types.js";

// Covers the money identity across random order sequences: equity, balance floor and
// position sizes. It does not cover whether the fill prices are realistic, funding,
// or the ledger. The random books are shaped like a real one but they are generated,
// so this file proves the arithmetic, not the market.

const SEQUENCES = 2000;
const SEED = 20260908;

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

function makeBook(symbol: string, category: Category, ts: number): OrderBook {
  const mid = between(20, 500);
  const halfSpread = mid * between(0.00002, 0.002);
  const depth = 2 + Math.floor(rand() * 8);
  const asks = [];
  const bids = [];
  let ask = mid + halfSpread;
  let bid = mid - halfSpread;
  for (let i = 0; i < depth; i += 1) {
    asks.push({ price: ask, size: between(0.01, 40) });
    bids.push({ price: bid, size: between(0.01, 40) });
    ask += mid * between(0.00001, 0.0004);
    bid -= mid * between(0.00001, 0.0004);
  }
  return { symbol, category, asks, bids, ts };
}

function midOf(book: OrderBook): number {
  return (book.asks[0]!.price + book.bids[0]!.price) / 2;
}

describe("money invariants over random order sequences", () => {
  it(`holds equity, the balance floor and position sizes over ${SEQUENCES} sequences`, () => {
    let fills = 0;
    let rejections = 0;
    let refusals = 0;

    for (let sequence = 0; sequence < SEQUENCES; sequence += 1) {
      const startBalance = between(200, 50_000);
      let acc: PaperAccount = createAccount(`fuzz-${sequence}`, startBalance);
      const fees: FeeSchedule = { makerRate: between(0, 0.001), takerRate: between(0, 0.001) };
      const model: SlippageModel = { maxBookFraction: between(0.02, 0.5), extraBps: between(0, 25) };
      const spotOnly = rand() < 0.5;
      const marks = new Map<string, number>();
      let ts = 1788878648858;
      let feeTotal = 0;

      const steps = 1 + Math.floor(rand() * 8);
      for (let step = 0; step < steps; step += 1) {
        ts += Math.floor(between(1_000, 900_000));
        const category: Category = spotOnly ? "SPOT" : pick(["SPOT", "USDT-FUTURES"] as const);
        const symbol = category === "SPOT" ? pick(["RTSLAUSDT", "RAAPLUSDT"]) : pick(["TSLAUSDT", "AAPLUSDT"]);
        const book = makeBook(symbol, category, ts);
        marks.set(positionKey(category, symbol), midOf(book));

        const held = acc.positions.get(positionKey(category, symbol));
        const side: "buy" | "sell" = held && rand() < 0.6 ? (held.side === "long" ? "sell" : "buy") : pick(["buy", "sell"] as const);
        const visible = (side === "buy" ? book.asks : book.bids).reduce((sum, level) => sum + level.size, 0);
        const type = rand() < 0.5 ? "market" : "limit";
        const order: SimOrder = {
          id: `s${sequence}-${step}`,
          account: acc.id,
          category,
          symbol,
          side,
          type,
          qty: between(0.001, visible * 0.6),
          ts,
          source: "brain",
          ...(type === "limit" ? { limitPrice: midOf(book) * between(0.995, 1.005) } : {}),
        };

        const result = fillAgainstBook(order, book, fees, model);
        if ("rejected" in result) {
          refusals += 1;
          continue;
        }

        expect(result.qty).toBeGreaterThan(0);
        expect(result.qty).toBeLessThanOrEqual(order.qty + 1e-12);
        expect(result.feeUsdt).toBeCloseTo(result.notionalUsdt * (result.levelsConsumed === 0 ? fees.makerRate : fees.takerRate), 9);
        expect(result.slippageBps).toBeGreaterThanOrEqual(-1e-9);

        const balanceBefore = acc.balanceUsdt;
        try {
          const applied = applyFill(acc, result);
          acc = applied.account;
          feeTotal += result.feeUsdt;
          fills += 1;
          expect(applied.row.balanceChange).toBeCloseTo(applied.row.balanceAfter - balanceBefore, 12);
        } catch (error) {
          expect(error).toBeInstanceOf(AccountError);
          rejections += 1;
          continue;
        }

        const { equity, unrealised } = markToMarket(acc, marks);
        expect(Math.abs(equity - (startBalance + acc.realisedPnl + unrealised))).toBeLessThan(1e-6);
        expect(acc.feesPaid).toBeCloseTo(feeTotal, 9);

        if (spotOnly) {
          expect(acc.balanceUsdt).toBeGreaterThanOrEqual(-1e-9);
        }
        for (const position of acc.positions.values()) {
          expect(position.qty).toBeGreaterThan(0);
          expect(position.avgEntry).toBeGreaterThan(0);
          if (position.category === "SPOT") expect(position.side).toBe("long");
        }
      }
    }

    expect(fills).toBeGreaterThan(SEQUENCES);
    expect(refusals + rejections).toBeGreaterThan(0);
  });
});
