import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadOrCreateKeyPair, type KeyPair } from "../../src/ledger/keys.js";
import { GENESIS_HASH, Ledger, replayFills, verifyLedger } from "../../src/ledger/ledger.js";
import type { ConfigPayload, FillPayload, SnapshotPayload } from "../../src/ledger/ledger.js";
import { bookHash } from "../../src/sim/book.js";
import { fillAgainstBook } from "../../src/sim/fill.js";
import { loadRecordedBook } from "../../src/sim/recorded.js";
import type { Fill, SimOrder } from "../../src/sim/types.js";

// Covers the chain, the signatures, tamper detection and the fill replay. It does not
// cover concurrent writers (one process owns a ledger directory), disk failures, or
// what happens if the signing key itself leaks: a thief with the key can write new
// entries, which is why the replay against the recorded book is the second check.

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kaaval-ledger-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function keysIn(dir: string): KeyPair {
  return loadOrCreateKeyPair(join(dir, "ledger-key.pem"));
}

const CONFIG: ConfigPayload = {
  fees: { SPOT: { makerRate: 0.001, takerRate: 0.001 }, "USDT-FUTURES": { makerRate: 0.0002, takerRate: 0.0006 } },
  model: { maxBookFraction: 0.1, extraBps: 5 },
  feeSource: "Bitget published rates, recorded 8 September 2026",
};

function order(over: Partial<SimOrder> = {}): SimOrder {
  return {
    id: "o1",
    account: "claude",
    category: "USDT-FUTURES",
    symbol: "TSLAUSDT",
    side: "buy",
    type: "market",
    qty: 1.5,
    ts: 1788878648000,
    source: "brain",
    ...over,
  };
}

/** Writes a config, a snapshot of the recorded book and two fills against it. */
function seedLedger(dir: string, keys: KeyPair): { ledger: Ledger; fills: Fill[] } {
  const ledger = new Ledger(dir, keys);
  const book = loadRecordedBook("TSLAUSDT");
  ledger.append("config", "kaaval", CONFIG);
  const snapshot: SnapshotPayload = { bookHash: bookHash(book), book };
  ledger.append("snapshot", "kaaval", snapshot);

  const fills: Fill[] = [];
  for (const spec of [order(), order({ id: "o2", side: "sell", qty: 0.4, type: "limit", limitPrice: 364.5 })]) {
    const result = fillAgainstBook(spec, book, CONFIG.fees[spec.category], CONFIG.model);
    if ("rejected" in result) throw new Error(`fixture order was refused: ${result.reason}`);
    ledger.append("order", spec.account, spec);
    ledger.append("fill", spec.account, { order: spec, fill: result } satisfies FillPayload);
    fills.push(result);
  }
  return { ledger, fills };
}

function firstFile(dir: string): string {
  return join(dir, readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort()[0]!);
}

describe("the chain", () => {
  it("numbers entries from one and links each to the one before", () => {
    const dir = tempDir();
    const ledger = new Ledger(join(dir, "ledger"), keysIn(dir));
    const first = ledger.append("config", "kaaval", CONFIG);
    const second = ledger.append("decision", "claude", { note: "no trade, spread too wide" });

    expect(first.seq).toBe(1);
    expect(first.prevHash).toBe(GENESIS_HASH);
    expect(second.seq).toBe(2);
    expect(second.prevHash).toBe(first.hash);
    expect(ledger.readAll()).toHaveLength(2);
    expect(ledger.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps one file per UTC day and chains across the day boundary", () => {
    const dir = tempDir();
    const ledgerDir = join(dir, "ledger");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T23:59:30Z"));
    const ledger = new Ledger(ledgerDir, keysIn(dir));
    const before = ledger.append("mark", "claude", { equity: 1000 });
    vi.setSystemTime(new Date("2026-09-09T00:00:30Z"));
    const after = ledger.append("mark", "claude", { equity: 1001 });

    const files = readdirSync(ledgerDir).filter((name) => name.endsWith(".jsonl")).sort();
    expect(files).toEqual(["2026-09-08.jsonl", "2026-09-09.jsonl"]);
    expect(after.prevHash).toBe(before.hash);
    expect(after.seq).toBe(2);

    const check = verifyLedger(ledgerDir, ledger.publicKeyHex);
    expect(check).toEqual({ ok: true, entries: 2, firstBad: null, reason: null });
  });

  it("picks up where it left off when the process restarts", () => {
    const dir = tempDir();
    const ledgerDir = join(dir, "ledger");
    const keys = keysIn(dir);
    new Ledger(ledgerDir, keys).append("config", "kaaval", CONFIG);
    const reopened = new Ledger(ledgerDir, keys);
    const next = reopened.append("halt", "kaaval", { reason: "kill switch" });
    expect(next.seq).toBe(2);
    expect(verifyLedger(ledgerDir, keys.publicKeyHex).ok).toBe(true);
  });
});

describe("verifyLedger", () => {
  it("passes a clean ledger and counts its entries", () => {
    const dir = tempDir();
    const ledgerDir = join(dir, "ledger");
    const keys = keysIn(dir);
    seedLedger(ledgerDir, keys);
    expect(verifyLedger(ledgerDir, keys.publicKeyHex)).toEqual({ ok: true, entries: 6, firstBad: null, reason: null });
  });

  it("passes on an empty directory", () => {
    expect(verifyLedger(join(tempDir(), "nothing-here"), "ab".repeat(32))).toMatchObject({ ok: true, entries: 0 });
  });

  it("fails against the wrong public key", () => {
    const dir = tempDir();
    const ledgerDir = join(dir, "ledger");
    const keys = keysIn(dir);
    seedLedger(ledgerDir, keys);
    const stranger = loadOrCreateKeyPair(join(dir, "stranger.pem"));

    const check = verifyLedger(ledgerDir, stranger.publicKeyHex);
    expect(check.ok).toBe(false);
    expect(check.firstBad).toBe(1);
    expect(check.reason).toContain("not signed by this public key");
  });

  it("names the entry when one character of a payload changes", () => {
    const dir = tempDir();
    const ledgerDir = join(dir, "ledger");
    const keys = keysIn(dir);
    seedLedger(ledgerDir, keys);

    const file = firstFile(ledgerDir);
    const lines = readFileSync(file, "utf8").split("\n");
    lines[3] = lines[3]!.replace('"qty":1.5', '"qty":1.6');
    writeFileSync(file, lines.join("\n"), "utf8");

    const check = verifyLedger(ledgerDir, keys.publicKeyHex);
    expect(check.ok).toBe(false);
    expect(check.firstBad).toBe(4);
    expect(check.reason).toContain("was edited after it was written");
  });

  it("notices a deleted line", () => {
    const dir = tempDir();
    const ledgerDir = join(dir, "ledger");
    const keys = keysIn(dir);
    seedLedger(ledgerDir, keys);

    const file = firstFile(ledgerDir);
    const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
    lines.splice(2, 1);
    writeFileSync(file, `${lines.join("\n")}\n`, "utf8");

    const check = verifyLedger(ledgerDir, keys.publicKeyHex);
    expect(check.ok).toBe(false);
    expect(check.firstBad).toBe(4);
    expect(check.reason).toContain("removed or reordered");
  });

  it("notices a line that is no longer JSON", () => {
    const dir = tempDir();
    const ledgerDir = join(dir, "ledger");
    const keys = keysIn(dir);
    seedLedger(ledgerDir, keys);

    const file = firstFile(ledgerDir);
    const lines = readFileSync(file, "utf8").split("\n");
    lines[1] = lines[1]!.slice(0, -5);
    writeFileSync(file, lines.join("\n"), "utf8");

    const check = verifyLedger(ledgerDir, keys.publicKeyHex);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("not valid JSON");
  });
});

describe("replayFills", () => {
  it("reproduces every recorded fill from the recorded book", () => {
    const dir = tempDir();
    const ledgerDir = join(dir, "ledger");
    const { fills } = seedLedger(ledgerDir, keysIn(dir));

    const replay = replayFills(ledgerDir);
    expect(replay).toHaveLength(2);
    expect(replay.every((row) => row.matches)).toBe(true);
    expect(replay[0]!.expected.avgPrice).toBeCloseTo(fills[0]!.avgPrice, 12);
    expect(replay[1]!.recorded.levelsConsumed).toBe(0);
  });

  it("catches a fill that was written with a better price, even when it is signed", () => {
    const dir = tempDir();
    const ledgerDir = join(dir, "ledger");
    const keys = keysIn(dir);
    const book = loadRecordedBook("TSLAUSDT");
    const ledger = new Ledger(ledgerDir, keys);
    ledger.append("config", "kaaval", CONFIG);
    ledger.append("snapshot", "kaaval", { bookHash: bookHash(book), book } satisfies SnapshotPayload);

    const spec = order();
    const honest = fillAgainstBook(spec, book, CONFIG.fees[spec.category], CONFIG.model);
    if ("rejected" in honest) throw new Error(honest.reason);
    const flattered: Fill = { ...honest, avgPrice: honest.avgPrice * 0.99, notionalUsdt: honest.notionalUsdt * 0.99 };
    ledger.append("fill", spec.account, { order: spec, fill: flattered } satisfies FillPayload);

    expect(verifyLedger(ledgerDir, keys.publicKeyHex).ok).toBe(true);
    const replay = replayFills(ledgerDir);
    expect(replay[0]!.matches).toBe(false);
    expect(replay[0]!.expected.avgPrice).toBeCloseTo(honest.avgPrice, 12);
  });

  it("reads past a config entry that is not a fee schedule, like the daily universe rebuild", () => {
    const dir = tempDir();
    const ledgerDir = join(dir, "ledger");
    const keys = keysIn(dir);
    const book = loadRecordedBook("TSLAUSDT");
    const ledger = new Ledger(ledgerDir, keys);
    ledger.append("config", "kaaval", CONFIG);
    ledger.append("snapshot", "kaaval", { bookHash: bookHash(book), book } satisfies SnapshotPayload);
    ledger.append("config", "kaaval", {
      universe: ["RTSLAUSDT"],
      hedges: ["SPYUSDT"],
      note: "the daily universe rebuild",
    });

    const spec = order();
    const result = fillAgainstBook(spec, book, CONFIG.fees[spec.category], CONFIG.model);
    if ("rejected" in result) throw new Error(result.reason);
    ledger.append("fill", spec.account, { order: spec, fill: result } satisfies FillPayload);

    const replay = replayFills(ledgerDir);
    expect(replay).toHaveLength(1);
    expect(replay[0]!.matches).toBe(true);
  });

  it("refuses to replay a fill whose book is not in the ledger", () => {
    const dir = tempDir();
    const ledgerDir = join(dir, "ledger");
    const keys = keysIn(dir);
    const book = loadRecordedBook("TSLAUSDT");
    const ledger = new Ledger(ledgerDir, keys);
    ledger.append("config", "kaaval", CONFIG);
    const spec = order();
    const result = fillAgainstBook(spec, book, CONFIG.fees[spec.category], CONFIG.model);
    if ("rejected" in result) throw new Error(result.reason);
    ledger.append("fill", spec.account, { order: spec, fill: result } satisfies FillPayload);

    expect(() => replayFills(ledgerDir)).toThrow(/not in this ledger/);
  });

  it("refuses to replay a fill with no fee settings recorded before it", () => {
    const dir = tempDir();
    const ledgerDir = join(dir, "ledger");
    const keys = keysIn(dir);
    const book = loadRecordedBook("TSLAUSDT");
    const ledger = new Ledger(ledgerDir, keys);
    ledger.append("snapshot", "kaaval", { bookHash: bookHash(book), book } satisfies SnapshotPayload);
    const spec = order();
    const result = fillAgainstBook(spec, book, CONFIG.fees[spec.category], CONFIG.model);
    if ("rejected" in result) throw new Error(result.reason);
    ledger.append("fill", spec.account, { order: spec, fill: result } satisfies FillPayload);

    expect(() => replayFills(ledgerDir)).toThrow(/no config entry/);
  });
});
