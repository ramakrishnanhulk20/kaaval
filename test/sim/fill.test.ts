import { describe, expect, it } from "vitest";
import { fillAgainstBook } from "../../src/sim/fill.js";
import type { Fill, FeeSchedule, OrderBook, Rejection, SimOrder, SlippageModel } from "../../src/sim/types.js";

// Covers filling one order against one recorded book. It does not cover balances or
// positions (account.test.ts), queue position, or whether a resting limit order would
// really have been filled: the model assumes it is, and says so.

const book: OrderBook = {
  symbol: "RTSLAUSDT",
  category: "SPOT",
  asks: [
    { price: 100, size: 1 },
    { price: 101, size: 2 },
    { price: 102, size: 3 },
  ],
  bids: [
    { price: 99, size: 1 },
    { price: 98, size: 2 },
    { price: 97, size: 3 },
  ],
  ts: 1788878648858,
};

const fees: FeeSchedule = { makerRate: 0.001, takerRate: 0.001 };
const model: SlippageModel = { maxBookFraction: 1, extraBps: 0 };

function order(over: Partial<SimOrder> = {}): SimOrder {
  return {
    id: "o1",
    account: "claude",
    category: "SPOT",
    symbol: "RTSLAUSDT",
    side: "buy",
    type: "market",
    qty: 1,
    ts: 1788878648000,
    source: "brain",
    ...over,
  };
}

function filled(result: Fill | Rejection): Fill {
  if ("rejected" in result) throw new Error(`expected a fill, got ${result.reason}`);
  return result;
}

function refused(result: Fill | Rejection): Rejection {
  if (!("rejected" in result)) throw new Error("expected a rejection, got a fill");
  return result;
}

describe("fillAgainstBook", () => {
  it("walks three ask levels on a market buy and averages them", () => {
    const fill = filled(fillAgainstBook(order({ qty: 4 }), book, fees, model));
    expect(fill.qty).toBe(4);
    expect(fill.avgPrice).toBeCloseTo(101, 12);
    expect(fill.levelsConsumed).toBe(3);
    expect(fill.partial).toBe(false);
    expect(fill.notionalUsdt).toBeCloseTo(404, 12);
    expect(fill.ts).toBe(book.ts);
    expect(fill.bookHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("walks the bid side on a market sell", () => {
    const fill = filled(fillAgainstBook(order({ side: "sell", qty: 4 }), book, fees, model));
    expect(fill.avgPrice).toBeCloseTo(98, 12);
    expect(fill.notionalUsdt).toBeCloseTo(392, 12);
    expect(fill.levelsConsumed).toBe(3);
  });

  it("rests a limit buy under the best ask and charges the maker rate", () => {
    const maker: FeeSchedule = { makerRate: 0.0002, takerRate: 0.0006 };
    const fill = filled(fillAgainstBook(order({ type: "limit", limitPrice: 99.5, qty: 2 }), book, maker, model));
    expect(fill.avgPrice).toBe(99.5);
    expect(fill.levelsConsumed).toBe(0);
    expect(fill.partial).toBe(false);
    expect(fill.feeUsdt).toBeCloseTo(2 * 99.5 * 0.0002, 12);
    expect(fill.slippageBps).toBe(0);
  });

  it("treats a limit that crosses the spread as a taker", () => {
    const rates: FeeSchedule = { makerRate: 0.0002, takerRate: 0.0006 };
    const fill = filled(fillAgainstBook(order({ type: "limit", limitPrice: 101, qty: 3 }), book, rates, model));
    expect(fill.avgPrice).toBeCloseTo((100 + 2 * 101) / 3, 12);
    expect(fill.levelsConsumed).toBe(2);
    expect(fill.feeUsdt).toBeCloseTo(fill.notionalUsdt * rates.takerRate, 12);
  });

  it("marks a partial when the limit price runs out of levels", () => {
    const fill = filled(fillAgainstBook(order({ type: "limit", limitPrice: 101, qty: 5 }), book, fees, model));
    expect(fill.qty).toBe(3);
    expect(fill.partial).toBe(true);
  });

  it("refuses an order bigger than the allowed share of visible size", () => {
    const strict: SlippageModel = { maxBookFraction: 0.5, extraBps: 0 };
    const rejection = refused(fillAgainstBook(order({ qty: 4 }), book, fees, strict));
    expect(rejection.reason).toContain("50 percent");
    expect(rejection.orderId).toBe("o1");
    expect(filled(fillAgainstBook(order({ qty: 3 }), book, fees, strict)).qty).toBe(3);
  });

  it("refuses an empty side, a zero quantity and a limit without a price", () => {
    expect(refused(fillAgainstBook(order({ qty: 1 }), { ...book, asks: [] }, fees, model)).reason).toContain("ask side");
    expect(refused(fillAgainstBook(order({ side: "sell" }), { ...book, bids: [] }, fees, model)).reason).toContain("bid side");
    expect(refused(fillAgainstBook(order({ qty: 0 }), book, fees, model)).reason).toContain("positive");
    expect(refused(fillAgainstBook(order({ qty: -2 }), book, fees, model)).reason).toContain("positive");
    expect(refused(fillAgainstBook(order({ type: "limit" }), book, fees, model)).reason).toContain("limit price");
    expect(refused(fillAgainstBook(order({ symbol: "RAAPLUSDT" }), book, fees, model)).reason).toContain("RAAPLUSDT");
  });

  it("charges the extra slippage against the trader on both sides", () => {
    const wide: SlippageModel = { maxBookFraction: 1, extraBps: 10 };
    const buy = filled(fillAgainstBook(order({ qty: 1 }), book, fees, wide));
    expect(buy.avgPrice).toBeCloseTo(100 * 1.001, 12);
    expect(buy.slippageBps).toBeCloseTo(10, 9);

    const sell = filled(fillAgainstBook(order({ side: "sell", qty: 1 }), book, fees, wide));
    expect(sell.avgPrice).toBeCloseTo(99 * 0.999, 12);
    expect(sell.slippageBps).toBeCloseTo(10, 9);
  });

  it("reports walking the book plus the extra as one slippage number", () => {
    const wide: SlippageModel = { maxBookFraction: 1, extraBps: 10 };
    const fill = filled(fillAgainstBook(order({ qty: 4 }), book, fees, wide));
    expect(fill.slippageBps).toBeCloseTo(((101 * 1.001 - 100) / 100) * 10_000, 9);
  });

  it("charges the fee on notional at the rate the caller passed", () => {
    const spot: FeeSchedule = { makerRate: 0.001, takerRate: 0.001 };
    const perp: FeeSchedule = { makerRate: 0.0002, takerRate: 0.0006 };
    const spotFill = filled(fillAgainstBook(order({ qty: 2 }), book, spot, model));
    expect(spotFill.feeUsdt).toBeCloseTo(spotFill.notionalUsdt * 0.001, 12);

    const perpBook: OrderBook = { ...book, symbol: "TSLAUSDT", category: "USDT-FUTURES" };
    const perpFill = filled(
      fillAgainstBook(order({ symbol: "TSLAUSDT", category: "USDT-FUTURES", qty: 2 }), perpBook, perp, model),
    );
    expect(perpFill.feeUsdt).toBeCloseTo(perpFill.notionalUsdt * 0.0006, 12);
  });

  it("refuses a model or fee schedule that makes no sense", () => {
    expect(refused(fillAgainstBook(order(), book, fees, { maxBookFraction: 0, extraBps: 0 })).reason).toContain("maxBookFraction");
    expect(refused(fillAgainstBook(order(), book, fees, { maxBookFraction: 2, extraBps: 0 })).reason).toContain("maxBookFraction");
    expect(refused(fillAgainstBook(order(), book, fees, { maxBookFraction: 1, extraBps: -1 })).reason).toContain("extraBps");
    expect(refused(fillAgainstBook(order(), book, { makerRate: -0.1, takerRate: 0.001 }, model)).reason).toContain("fee rates");
  });
});
