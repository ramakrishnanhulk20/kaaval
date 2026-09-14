import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BookLevel, Category, OrderBook } from "./types.js";

/**
 * Order books recorded straight from Bitget's public endpoints and kept in the repo
 * so the demo and the replay run without a key and without inventing a market. The
 * .source.txt beside each file is the exact curl that produced it.
 */
const RECORDED = {
  TSLAUSDT: { file: "tslausdt-merge-depth.json", symbol: "TSLAUSDT", category: "USDT-FUTURES" as Category },
} as const;

export type RecordedBookName = keyof typeof RECORDED;

interface MergeDepthResponse {
  code: string;
  data: { asks: Array<[number | string, number | string]>; bids: Array<[number | string, number | string]>; ts: string };
}

export function recordedBookNames(): RecordedBookName[] {
  return Object.keys(RECORDED) as RecordedBookName[];
}

export function recordedBookPath(name: RecordedBookName): string {
  return join(dirname(fileURLToPath(import.meta.url)), "recorded", RECORDED[name].file);
}

export function loadRecordedBook(name: RecordedBookName): OrderBook {
  const meta = RECORDED[name];
  const response = JSON.parse(readFileSync(recordedBookPath(name), "utf8")) as MergeDepthResponse;
  if (response.code !== "00000") {
    throw new Error(`the recorded ${name} book is an error response from Bitget, code ${response.code}`);
  }
  return {
    symbol: meta.symbol,
    category: meta.category,
    asks: toLevels(response.data.asks),
    bids: toLevels(response.data.bids),
    ts: Number(response.data.ts),
  };
}

function toLevels(rows: Array<[number | string, number | string]>): BookLevel[] {
  return rows.map(([price, size]) => ({ price: Number(price), size: Number(size) }));
}
