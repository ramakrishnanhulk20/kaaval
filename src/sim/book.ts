import { createHash } from "node:crypto";
import type { BookLevel, OrderBook } from "./types.js";

/**
 * Numbers are written as a fixed twelve decimal string when that string reads back
 * as the exact same double, and at full precision when it does not. Two different
 * numbers can never produce the same text, so a tampered digit always changes the
 * hash, and the same book always produces the same hash on any machine.
 */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError(`canonical JSON cannot encode the number ${String(value)}`);
  }
  const zeroSafe = Object.is(value, -0) ? 0 : value;
  const fixed = zeroSafe.toFixed(12);
  return Number(fixed) === zeroSafe ? fixed : zeroSafe.toPrecision(17);
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return formatNumber(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const entry = record[key];
        if (entry === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new TypeError(`canonical JSON cannot encode a value of type ${typeof value}`);
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Best price first: the highest bid a seller can hit, the lowest ask a buyer can lift.
 * Sorting here is what lets a book recorded in any order hash and fill the same way.
 */
export function sortedLevels(levels: readonly BookLevel[], side: "bids" | "asks"): BookLevel[] {
  const copy = levels.map((level) => ({ price: level.price, size: level.size }));
  copy.sort((a, b) => (side === "bids" ? b.price - a.price : a.price - b.price) || a.size - b.size);
  return copy;
}

export function bookHash(book: OrderBook): string {
  return sha256Hex(
    canonicalJson({
      symbol: book.symbol,
      category: book.category,
      ts: book.ts,
      bids: sortedLevels(book.bids, "bids"),
      asks: sortedLevels(book.asks, "asks"),
    }),
  );
}
