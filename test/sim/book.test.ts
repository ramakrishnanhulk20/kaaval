import { describe, expect, it } from "vitest";
import { bookHash, canonicalJson } from "../../src/sim/book.js";
import type { OrderBook } from "../../src/sim/types.js";

// Covers the hash and the canonical text only. It does not cover fills, fees, the
// ledger, or whether a recorded book matches what Bitget actually returned.

const base: OrderBook = {
  symbol: "RTSLAUSDT",
  category: "SPOT",
  bids: [
    { price: 363.98, size: 0.21 },
    { price: 363.96, size: 2.16 },
  ],
  asks: [
    { price: 364.01, size: 0.13 },
    { price: 364.02, size: 28.75 },
  ],
  ts: 1788878648858,
};

describe("bookHash", () => {
  it("gives the same hash when the same levels arrive in a different order", () => {
    const shuffled: OrderBook = {
      ts: base.ts,
      asks: [...base.asks].reverse(),
      bids: [...base.bids].reverse(),
      category: base.category,
      symbol: base.symbol,
    };
    expect(bookHash(shuffled)).toBe(bookHash(base));
  });

  it("changes when one size changes", () => {
    const nudged: OrderBook = {
      ...base,
      asks: [{ price: 364.01, size: 0.14 }, { price: 364.02, size: 28.75 }],
    };
    expect(bookHash(nudged)).not.toBe(bookHash(base));
  });

  it("changes when one price, the symbol or the timestamp changes", () => {
    expect(bookHash({ ...base, ts: base.ts + 1 })).not.toBe(bookHash(base));
    expect(bookHash({ ...base, symbol: "RAAPLUSDT" })).not.toBe(bookHash(base));
    expect(
      bookHash({ ...base, bids: [{ price: 363.99, size: 0.21 }, { price: 363.96, size: 2.16 }] }),
    ).not.toBe(bookHash(base));
  });

  it("is 64 hex characters", () => {
    expect(bookHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("canonicalJson", () => {
  it("sorts object keys so key order cannot change the text", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2.000000000000,"b":1.000000000000}');
  });

  it("keeps arrays in their given order", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("writes different numbers as different text", () => {
    expect(canonicalJson(0.1 + 0.2)).not.toBe(canonicalJson(0.3));
    expect(canonicalJson(-0)).toBe(canonicalJson(0));
    expect(canonicalJson(1e-15)).not.toBe(canonicalJson(2e-15));
  });

  it("drops undefined members and refuses values it cannot encode", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1.000000000000}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: 1n })).toThrow(TypeError);
  });
});
