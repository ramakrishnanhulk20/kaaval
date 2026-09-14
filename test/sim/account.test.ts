import { describe, expect, it } from "vitest";
import { AccountError, applyFill, createAccount, markToMarket, positionKey, toCsvRows } from "../../src/sim/account.js";
import type { Fill } from "../../src/sim/types.js";
import type { LogRow, PaperAccount } from "../../src/sim/account.js";

// Covers what a fill does to balances, positions and the log row. It does not cover
// how the fill price was reached (fill.test.ts), funding payments on perps, borrow
// interest, or any account state that Bitget itself would hold.

const TS = 1788878648858;

function fill(over: Partial<Fill> = {}): Fill {
  const base: Fill = {
    orderId: "o1",
    account: "claude",
    category: "SPOT",
    symbol: "RTSLAUSDT",
    side: "buy",
    qty: 2,
    avgPrice: 100,
    notionalUsdt: 200,
    feeUsdt: 0.2,
    slippageBps: 1,
    levelsConsumed: 1,
    partial: false,
    ts: TS,
    bookHash: "a".repeat(64),
  };
  const merged = { ...base, ...over };
  return { ...merged, notionalUsdt: over.notionalUsdt ?? merged.qty * merged.avgPrice };
}

function perpFill(over: Partial<Fill>): Fill {
  return fill({ category: "USDT-FUTURES", symbol: "TSLAUSDT", ...over });
}

describe("spot", () => {
  it("buys then sells, realising the price move minus both fees", () => {
    const start = createAccount("claude", 1000);
    const bought = applyFill(start, fill());
    expect(bought.account.balanceUsdt).toBeCloseTo(799.8, 9);
    expect(bought.realisedDelta).toBeCloseTo(-0.2, 12);
    const held = bought.account.positions.get(positionKey("SPOT", "RTSLAUSDT"));
    expect(held).toMatchObject({ side: "long", qty: 2, avgEntry: 100, openedTs: TS });

    const sold = applyFill(bought.account, fill({ side: "sell", avgPrice: 110, feeUsdt: 0.22 }));
    expect(sold.realisedDelta).toBeCloseTo(19.78, 9);
    expect(sold.account.balanceUsdt).toBeCloseTo(1019.58, 9);
    expect(sold.account.realisedPnl).toBeCloseTo(19.58, 9);
    expect(sold.account.feesPaid).toBeCloseTo(0.42, 9);
    expect(sold.account.positions.size).toBe(0);
    expect(sold.account.balanceUsdt - 1000).toBeCloseTo(sold.account.realisedPnl, 9);
  });

  it("averages the entry when it buys the same symbol twice", () => {
    const first = applyFill(createAccount("claude", 1000), fill());
    const second = applyFill(first.account, fill({ avgPrice: 120, feeUsdt: 0.24 }));
    expect(second.account.positions.get(positionKey("SPOT", "RTSLAUSDT"))?.avgEntry).toBeCloseTo(110, 9);
    expect(second.row.note).toContain("SPOT add");
  });

  it("refuses to sell what it does not hold and to sell more than it holds", () => {
    const start = createAccount("claude", 1000);
    expect(() => applyFill(start, fill({ side: "sell" }))).toThrow(AccountError);
    try {
      applyFill(start, fill({ side: "sell" }));
    } catch (error) {
      expect((error as AccountError).code).toBe("no_spot_position");
    }
    const bought = applyFill(start, fill());
    try {
      applyFill(bought.account, fill({ side: "sell", qty: 3 }));
    } catch (error) {
      expect((error as AccountError).code).toBe("sell_exceeds_position");
    }
  });

  it("refuses a buy the balance cannot pay for", () => {
    const start = createAccount("claude", 50);
    try {
      applyFill(start, fill());
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as AccountError).code).toBe("insufficient_balance");
    }
  });

  it("keeps the old account untouched", () => {
    const start = createAccount("claude", 1000);
    applyFill(start, fill());
    expect(start.balanceUsdt).toBe(1000);
    expect(start.positions.size).toBe(0);
  });
});

describe("futures", () => {
  it("opens, adds, reduces and flips with the realised part correct", () => {
    const opened = applyFill(createAccount("qwen", 1000), perpFill({ qty: 2, avgPrice: 100, feeUsdt: 0.12 }));
    expect(opened.account.balanceUsdt).toBeCloseTo(999.88, 9);
    expect(opened.account.positions.get(positionKey("USDT-FUTURES", "TSLAUSDT"))).toMatchObject({
      side: "long",
      qty: 2,
      avgEntry: 100,
    });

    const added = applyFill(opened.account, perpFill({ qty: 2, avgPrice: 110, feeUsdt: 0.132 }));
    expect(added.account.positions.get(positionKey("USDT-FUTURES", "TSLAUSDT"))).toMatchObject({
      qty: 4,
      avgEntry: 105,
    });

    const reduced = applyFill(added.account, perpFill({ side: "sell", qty: 1, avgPrice: 120, feeUsdt: 0.072 }));
    expect(reduced.realisedDelta).toBeCloseTo(15 - 0.072, 9);
    expect(reduced.account.positions.get(positionKey("USDT-FUTURES", "TSLAUSDT"))).toMatchObject({
      qty: 3,
      avgEntry: 105,
    });

    const flipped = applyFill(reduced.account, perpFill({ side: "sell", qty: 5, avgPrice: 90, feeUsdt: 0.27 }));
    expect(flipped.realisedDelta).toBeCloseTo(-45 - 0.27, 9);
    expect(flipped.account.positions.get(positionKey("USDT-FUTURES", "TSLAUSDT"))).toMatchObject({
      side: "short",
      qty: 2,
      avgEntry: 90,
    });
    expect(flipped.account.balanceUsdt - 1000).toBeCloseTo(flipped.account.realisedPnl, 9);
    expect(flipped.row.note).toContain("USDT-FUTURES flip");
  });

  it("realises a short that is bought back lower", () => {
    const shorted = applyFill(createAccount("qwen", 1000), perpFill({ side: "sell", qty: 2, avgPrice: 100, feeUsdt: 0.12 }));
    const covered = applyFill(shorted.account, perpFill({ side: "buy", qty: 2, avgPrice: 90, feeUsdt: 0.108 }));
    expect(covered.realisedDelta).toBeCloseTo(20 - 0.108, 9);
    expect(covered.account.positions.size).toBe(0);
  });

  it("refuses to open more position than the balance covers at 1x", () => {
    const start = createAccount("qwen", 100);
    try {
      applyFill(start, perpFill({ qty: 5, avgPrice: 100, feeUsdt: 0.3 }));
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as AccountError).code).toBe("insufficient_margin");
    }
  });
});

describe("markToMarket", () => {
  it("values a spot long, a futures long and a futures short", () => {
    const spot = applyFill(createAccount("claude", 1000), fill()).account;
    const spotMark = markToMarket(spot, new Map([["RTSLAUSDT", 110]]));
    expect(spotMark.unrealised).toBeCloseTo(20, 9);
    expect(spotMark.equity).toBeCloseTo(799.8 + 220, 9);

    const long = applyFill(createAccount("qwen", 1000), perpFill({ qty: 2, avgPrice: 100, feeUsdt: 0.12 })).account;
    expect(markToMarket(long, new Map([["USDT-FUTURES:TSLAUSDT", 110]])).unrealised).toBeCloseTo(20, 9);

    const short = applyFill(createAccount("qwen", 1000), perpFill({ side: "sell", qty: 2, avgPrice: 100, feeUsdt: 0.12 }))
      .account;
    const shortMark = markToMarket(short, new Map([["TSLAUSDT", 80]]));
    expect(shortMark.unrealised).toBeCloseTo(40, 9);
    expect(shortMark.equity).toBeCloseTo(999.88 + 40, 9);
  });

  it("holds a position at entry when no mark is given", () => {
    const long = applyFill(createAccount("qwen", 1000), perpFill({ qty: 2, avgPrice: 100, feeUsdt: 0.12 })).account;
    expect(markToMarket(long, new Map()).unrealised).toBe(0);
  });
});

describe("the log row", () => {
  it("carries the six required fields and a balance change equal to the balance delta", () => {
    const start = createAccount("claude", 1000);
    const { row, account } = applyFill(start, fill());
    expect(row.timestamp).toBe(new Date(TS).toISOString());
    expect(row.timestamp.endsWith("Z")).toBe(true);
    expect(row.instrument).toBe("RTSLAUSDT");
    expect(row.direction).toBe("buy");
    expect(row.price).toBe(100);
    expect(row.quantity).toBe(2);
    expect(row.balanceChange).toBeCloseTo(account.balanceUsdt - start.balanceUsdt, 12);
    expect(row.balanceAfter).toBe(account.balanceUsdt);
    expect(row.account).toBe("claude");
    expect(row.note).toContain("book aaaaaaaaaaaa");
  });

  it("marks a partial fill in the note", () => {
    const { row } = applyFill(createAccount("claude", 1000), fill({ partial: true }));
    expect(row.note).toContain("partial");
  });
});

describe("toCsvRows", () => {
  it("writes a header, quotes what needs quoting and doubles inner quotes", () => {
    const rows: LogRow[] = [
      {
        timestamp: "2026-09-08T12:00:00.000Z",
        instrument: "RTSLAUSDT",
        direction: "buy",
        price: 364.01,
        quantity: 0.5,
        balanceChange: -182.19,
        balanceAfter: 817.81,
        account: 'claude "night" desk',
        note: "SPOT open, fee 0.182005 USDT",
      },
    ];
    const csv = toCsvRows(rows);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("timestamp,instrument,direction,price,quantity,balanceChange,balanceAfter,account,note");
    expect(lines[1]).toBe(
      '2026-09-08T12:00:00.000Z,RTSLAUSDT,buy,364.01,0.5,-182.19,817.81,"claude ""night"" desk","SPOT open, fee 0.182005 USDT"',
    );
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("writes only a header for an empty log", () => {
    expect(toCsvRows([])).toBe(
      "timestamp,instrument,direction,price,quantity,balanceChange,balanceAfter,account,note\r\n",
    );
  });
});

describe("createAccount", () => {
  it("refuses a negative opening balance", () => {
    expect(() => createAccount("claude", -1)).toThrow(AccountError);
  });

  it("starts flat", () => {
    const acc: PaperAccount = createAccount("claude", 250);
    expect(acc).toMatchObject({ id: "claude", balanceUsdt: 250, realisedPnl: 0, feesPaid: 0 });
    expect(acc.positions.size).toBe(0);
  });
});
