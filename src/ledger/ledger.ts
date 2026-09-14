import { createPrivateKey, sign, verify, type KeyObject } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "../sim/book.js";
import { fillAgainstBook } from "../sim/fill.js";
import { publicKeyFromHex, type KeyPair } from "./keys.js";
import type { Category, FeeSchedule, Fill, OrderBook, SimOrder, SlippageModel } from "../sim/types.js";

export const GENESIS_HASH = "0".repeat(64);

export type LedgerKind = "config" | "decision" | "order" | "fill" | "reject" | "snapshot" | "halt" | "mark";

export interface LedgerEntry {
  seq: number;
  ts: number;
  kind: LedgerKind;
  account: string;
  payload: unknown;
  prevHash: string;
  hash: string;
  sig: string;
}

/** The fee rates and slippage model a replay must use for the fills that follow. */
export interface ConfigPayload {
  fees: Record<Category, FeeSchedule>;
  model: SlippageModel;
  feeSource?: string;
}

export interface SnapshotPayload {
  bookHash: string;
  book: OrderBook;
}

export interface FillPayload {
  order: SimOrder;
  fill: Fill;
}

export function entryHash(entry: Pick<LedgerEntry, "seq" | "ts" | "kind" | "account" | "payload" | "prevHash">): string {
  return sha256Hex(
    canonicalJson({
      seq: entry.seq,
      ts: entry.ts,
      kind: entry.kind,
      account: entry.account,
      payload: entry.payload,
      prevHash: entry.prevHash,
    }),
  );
}

function dayFile(ts: number): string {
  return `${new Date(ts).toISOString().slice(0, 10)}.jsonl`;
}

/** The day files of a ledger, oldest first. The name is the UTC date, so a sort is a sort by time. */
export function ledgerDayFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
}

/** One day of the ledger, for a reader that wants the newest day and not the whole history. */
export function readDay(dir: string, file: string): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
    if (line.trim() === "") continue;
    entries.push(JSON.parse(line) as LedgerEntry);
  }
  return entries;
}

/**
 * An append-only record. Every entry carries the hash of the one before it and an
 * Ed25519 signature over its own hash, so a single changed character anywhere breaks
 * the chain from that point on and verifyLedger names the entry that broke.
 * Entries are split into one file per UTC day for reading, and chained across files.
 */
export class Ledger {
  readonly publicKeyHex: string;
  readonly #dir: string;
  readonly #privateKey: KeyObject;
  #lastHash: string;
  #lastSeq: number;

  constructor(dir: string, keys: KeyPair) {
    this.#dir = dir;
    this.#privateKey = createPrivateKey(keys.privateKeyPem);
    this.publicKeyHex = keys.publicKeyHex;
    mkdirSync(dir, { recursive: true });

    const existing = this.readAll();
    const last = existing.at(-1);
    this.#lastHash = last ? last.hash : GENESIS_HASH;
    this.#lastSeq = last ? last.seq : 0;
  }

  append(kind: LedgerKind, account: string, payload: unknown): LedgerEntry {
    const seq = this.#lastSeq + 1;
    const ts = Date.now();
    const prevHash = this.#lastHash;
    const hash = entryHash({ seq, ts, kind, account, payload, prevHash });
    const sig = sign(null, Buffer.from(hash, "hex"), this.#privateKey).toString("hex");
    const entry: LedgerEntry = { seq, ts, kind, account, payload, prevHash, hash, sig };

    appendFileSync(join(this.#dir, dayFile(ts)), `${JSON.stringify(entry)}\n`, "utf8");
    this.#lastHash = hash;
    this.#lastSeq = seq;
    return entry;
  }

  readAll(): LedgerEntry[] {
    return readEntries(this.#dir);
  }
}

export function readEntries(dir: string): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const file of ledgerDayFiles(dir)) entries.push(...readDay(dir, file));
  return entries;
}

export function verifyLedger(
  dir: string,
  publicKeyHex: string,
): { ok: boolean; entries: number; firstBad: number | null; reason: string | null } {
  let key: KeyObject;
  try {
    key = publicKeyFromHex(publicKeyHex);
  } catch (error) {
    return { ok: false, entries: 0, firstBad: null, reason: (error as Error).message };
  }

  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;
  let entries = 0;

  for (const file of ledgerDayFiles(dir)) {
    const lines = readFileSync(join(dir, file), "utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (line.trim() === "") continue;

      let entry: LedgerEntry;
      try {
        entry = JSON.parse(line) as LedgerEntry;
      } catch {
        return { ok: false, entries, firstBad: expectedSeq, reason: `${file} line ${index + 1} is not valid JSON` };
      }

      const shapeProblem = badShape(entry);
      if (shapeProblem) {
        return { ok: false, entries, firstBad: expectedSeq, reason: `${file} line ${index + 1} ${shapeProblem}` };
      }
      if (entry.seq !== expectedSeq) {
        return {
          ok: false,
          entries,
          firstBad: entry.seq,
          reason: `entry ${entry.seq} arrived where entry ${expectedSeq} should be, so an entry was removed or reordered`,
        };
      }
      if (entry.prevHash !== prevHash) {
        return { ok: false, entries, firstBad: entry.seq, reason: `entry ${entry.seq} does not point at the entry before it` };
      }
      if (entryHash(entry) !== entry.hash) {
        return { ok: false, entries, firstBad: entry.seq, reason: `entry ${entry.seq} was edited after it was written` };
      }
      if (!signatureHolds(entry, key)) {
        return { ok: false, entries, firstBad: entry.seq, reason: `entry ${entry.seq} is not signed by this public key` };
      }

      prevHash = entry.hash;
      expectedSeq += 1;
      entries += 1;
    }
  }

  return { ok: true, entries, firstBad: null, reason: null };
}

function signatureHolds(entry: LedgerEntry, key: KeyObject): boolean {
  try {
    return verify(null, Buffer.from(entry.hash, "hex"), key, Buffer.from(entry.sig, "hex"));
  } catch {
    return false;
  }
}

function badShape(entry: LedgerEntry): string | null {
  if (typeof entry !== "object" || entry === null) return "is not an entry";
  if (!Number.isInteger(entry.seq)) return "has no sequence number";
  if (!Number.isFinite(entry.ts)) return "has no timestamp";
  if (typeof entry.kind !== "string") return "has no kind";
  if (typeof entry.account !== "string") return "has no account";
  if (!/^[0-9a-f]{64}$/.test(entry.prevHash ?? "")) return "has no previous hash";
  if (!/^[0-9a-f]{64}$/.test(entry.hash ?? "")) return "has no hash";
  if (typeof entry.sig !== "string" || entry.sig.length === 0) return "has no signature";
  return null;
}

/**
 * Re-runs every recorded fill against the book snapshot it names and the fee and
 * slippage settings in force at the time. A fill that will not reproduce comes back
 * with matches false and an expected fill of zero size, which is what a rejected
 * replay means: on this book, that order could not have filled that way.
 */
export function replayFills(dir: string): Array<{ seq: number; matches: boolean; expected: Fill; recorded: Fill }> {
  const results: Array<{ seq: number; matches: boolean; expected: Fill; recorded: Fill }> = [];
  const books = new Map<string, OrderBook>();
  let config: ConfigPayload | null = null;

  for (const entry of readEntries(dir)) {
    if (entry.kind === "config") {
      // A config entry is also how the run records a universe rebuild and the note that a
      // preview was built locally. Only an entry that carries a fee schedule changes how a
      // fill is replayed, so the others are read past instead of replacing the settings.
      const payload = entry.payload;
      if (isFeeConfig(payload)) config = payload;
      continue;
    }
    if (entry.kind === "snapshot") {
      const snapshot = entry.payload as SnapshotPayload;
      books.set(snapshot.bookHash, snapshot.book);
      continue;
    }
    if (entry.kind !== "fill") continue;

    const { order, fill } = entry.payload as FillPayload;
    // A fill placed on Bitget's demo environment was matched by Bitget, not by our simulator,
    // so there is no recorded book to replay it against; it is verified by the chain alone.
    if ((entry.payload as { demo?: boolean }).demo === true) continue;
    if (!config) {
      throw new Error(`fill at entry ${entry.seq} has no config entry before it, so it cannot be replayed`);
    }
    const book = books.get(fill.bookHash);
    if (!book) {
      throw new Error(`fill at entry ${entry.seq} names book ${fill.bookHash.slice(0, 12)}, which is not in this ledger`);
    }

    const fees = config.fees[order.category];
    if (!fees) {
      throw new Error(`fill at entry ${entry.seq} is ${order.category}, which the config entry before it prices no fees for`);
    }
    const replayed = fillAgainstBook(order, book, fees, config.model);
    const expected: Fill = "rejected" in replayed ? { ...fill, qty: 0, avgPrice: 0, notionalUsdt: 0, feeUsdt: 0, slippageBps: 0, levelsConsumed: 0, partial: true } : replayed;
    results.push({ seq: entry.seq, matches: sameFill(expected, fill), recorded: fill, expected });
  }

  return results;
}

function isFeeConfig(payload: unknown): payload is ConfigPayload {
  if (typeof payload !== "object" || payload === null) return false;
  const fees = (payload as { fees?: unknown }).fees;
  return typeof fees === "object" && fees !== null;
}

function sameFill(left: Fill, right: Fill): boolean {
  const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  return (
    left.orderId === right.orderId &&
    left.account === right.account &&
    left.category === right.category &&
    left.symbol === right.symbol &&
    left.side === right.side &&
    left.partial === right.partial &&
    left.levelsConsumed === right.levelsConsumed &&
    left.ts === right.ts &&
    left.bookHash === right.bookHash &&
    close(left.qty, right.qty) &&
    close(left.avgPrice, right.avgPrice) &&
    close(left.notionalUsdt, right.notionalUsdt) &&
    close(left.feeUsdt, right.feeUsdt) &&
    close(left.slippageBps, right.slippageBps)
  );
}
