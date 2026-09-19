import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { invoke, type BitgetContext } from "../bitget/client.js";
import { classifyWeekendTrading } from "../bitget/hours.js";
import { isRToken, listInstruments } from "../bitget/market.js";
import type { Instrument } from "../bitget/types.js";
import type { Rulebook } from "../risk/rulebook.js";

export interface UniverseEntry {
  rToken: Instrument;
  perp: Instrument | null;
  underlying: string;
  roundTheClock: boolean;
  volume24hUsdt: number;
}

export interface Universe {
  entries: UniverseEntry[];
  hedges: Instrument[];
  builtTs: number;
  weekendChecked: { start: number; end: number } | null;
}

const MS_PER_DAY = 86_400_000;
const WEEKEND_MS = 2 * MS_PER_DAY;

/**
 * The tradable list for the night, built from Bitget's own data and nothing else.
 *
 * Order of work matters for the request count, not for the answer: the two instrument
 * lists and one whole-category ticker snapshot are three calls, and only the symbols
 * that survive those cheap filters are asked about the weekend, which costs a candle
 * walk each. The result is cached so the daily rebuild happens once even if the engine
 * restarts, because a restart must not re-scan seven hundred symbols.
 *
 * Volume is compared as turnover in USDT, the quote-coin figure Bitget publishes, not
 * the base-coin volume: one rTSLA is four hundred dollars and one rPBR is fifteen, so
 * a base-coin threshold would rank the cheap tokens above the liquid ones.
 */
export async function buildUniverse(
  ctx: BitgetContext,
  rb: Rulebook,
  opts: {
    maxSymbols: number;
    cacheFile: string;
    ttlMs: number;
    now?: Date;
    /**
     * Symbols some account still holds, rToken or perpetual. They stay in the list past
     * the volume cut and the size cap. Without this a name that fell out of the day's top
     * few was no longer quoted: its position was marked at a stale price, its stop could
     * not fire, and the rulebook refused even the order that would have closed it.
     */
    held?: string[];
  },
): Promise<Universe> {
  const now = opts.now ?? new Date();
  const held = new Set(opts.held ?? []);
  const cached = readCache(opts.cacheFile, now.getTime(), opts.ttlMs);
  if (cached && [...held].every((symbol) => names(cached).has(symbol))) return cached;

  const [spot, futures] = await Promise.all([
    listInstruments(ctx, "SPOT"),
    listInstruments(ctx, "USDT-FUTURES"),
  ]);

  const perpBySymbol = new Map(futures.map((i) => [i.symbol, i]));
  const turnover = await turnoverBySymbol(ctx, "SPOT");

  const candidates = spot
    .filter((i) => isRToken(i) && i.status === "online")
    .map((rToken) => {
      const underlying = underlyingOf(rToken);
      return {
        rToken,
        underlying,
        perp: perpBySymbol.get(`${underlying}USDT`) ?? null,
        volume24hUsdt: turnover.get(rToken.symbol) ?? 0,
      };
    })
    .filter((c) => c.volume24hUsdt >= rb.universe.minVolume24hUsdt)
    .filter((c) => !rb.universe.requirePerp || c.perp !== null);

  let weekendChecked: { start: number; end: number } | null = null;
  let tradedOverWeekend = new Map<string, boolean>();
  if (rb.universe.requireWeekendTrade && candidates.length > 0) {
    weekendChecked = lastCompletedWeekend(now);
    tradedOverWeekend = await classifyWeekendTrading(
      ctx,
      "SPOT",
      candidates.map((c) => c.rToken.symbol),
      weekendChecked,
    );
  }

  const ranked: UniverseEntry[] = candidates
    .map((c) => ({
      rToken: c.rToken,
      perp: c.perp,
      underlying: c.underlying,
      roundTheClock: tradedOverWeekend.get(c.rToken.symbol) ?? false,
      volume24hUsdt: c.volume24hUsdt,
    }))
    .filter((e) => !rb.universe.requireWeekendTrade || e.roundTheClock)
    .sort((a, b) => b.volume24hUsdt - a.volume24hUsdt || a.rToken.symbol.localeCompare(b.rToken.symbol))
    .slice(0, Math.max(0, Math.floor(opts.maxSymbols)));

  const entries = [...ranked];
  for (const rToken of spot) {
    if (!isRToken(rToken) || rToken.status !== "online") continue;
    if (entries.some((entry) => entry.rToken.symbol === rToken.symbol)) continue;
    const underlying = underlyingOf(rToken);
    const perp = perpBySymbol.get(`${underlying}USDT`) ?? null;
    if (!held.has(rToken.symbol) && !(perp !== null && held.has(perp.symbol))) continue;
    entries.push({
      rToken,
      perp,
      underlying,
      roundTheClock: tradedOverWeekend.get(rToken.symbol) ?? false,
      volume24hUsdt: turnover.get(rToken.symbol) ?? 0,
    });
  }

  const hedges: Instrument[] = [];
  for (const symbol of rb.universe.hedgeSymbols) {
    const instrument = perpBySymbol.get(symbol);
    if (instrument) hedges.push(instrument);
  }

  const universe: Universe = { entries, hedges, builtTs: now.getTime(), weekendChecked };
  writeCache(opts.cacheFile, universe);
  return universe;
}

function names(u: Universe): Set<string> {
  const all = new Set<string>();
  for (const entry of u.entries) {
    all.add(entry.rToken.symbol);
    if (entry.perp) all.add(entry.perp.symbol);
  }
  for (const hedge of u.hedges) all.add(hedge.symbol);
  return all;
}

/** The keys the risk layer checks a target against, in sim/account's "CATEGORY:SYMBOL" form. */
export function universeKeys(u: Universe): Set<string> {
  const keys = new Set<string>();
  for (const entry of u.entries) {
    keys.add(`${entry.rToken.category}:${entry.rToken.symbol}`);
    if (entry.perp) keys.add(`${entry.perp.category}:${entry.perp.symbol}`);
  }
  for (const hedge of u.hedges) keys.add(`${hedge.category}:${hedge.symbol}`);
  return keys;
}

/** rTSLA is TSLA. The prefix is Bitget's marker for a tokenized stock, not part of the name. */
export function underlyingOf(rToken: Instrument): string {
  const base = rToken.baseCoin;
  return (base.startsWith("r") ? base.slice(1) : base).toUpperCase();
}

/**
 * Saturday 00:00 UTC to Monday 00:00 UTC of the last weekend that has finished.
 *
 * Asked on a Sunday this reaches back to the weekend before, because a weekend still
 * running is not evidence that a symbol trades through one.
 */
export function lastCompletedWeekend(now: Date): { start: number; end: number } {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  let end = midnight - daysSinceMonday * MS_PER_DAY;
  if (end > now.getTime()) end -= 7 * MS_PER_DAY;
  return { start: end - WEEKEND_MS, end };
}

/**
 * One tickers call for a whole category. getTicker in bitget/market reports 24 hour
 * volume in the base coin, which is the wrong unit for a size filter, so the quote-coin
 * turnover is read here from the same row and the base figure is only a fallback.
 */
async function turnoverBySymbol(ctx: BitgetContext, category: "SPOT" | "USDT-FUTURES"): Promise<Map<string, number>> {
  const rows = (await invoke(ctx, "market", { action: "tickers", category })) as Array<Record<string, unknown>>;
  const out = new Map<string, number>();
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    const symbol = row["symbol"];
    if (typeof symbol !== "string") continue;
    const quote = firstNumber(row, ["usdtVolume", "quoteVolume", "turnover24h"]);
    if (quote !== null) {
      out.set(symbol, quote);
      continue;
    }
    const base = firstNumber(row, ["volume24h", "baseVolume"]);
    const last = firstNumber(row, ["lastPrice", "lastPr"]);
    if (base !== null && last !== null) out.set(symbol, base * last);
  }
  return out;
}

function firstNumber(row: Record<string, unknown>, names: string[]): number | null {
  for (const name of names) {
    const value = row[name];
    if (value === undefined || value === null || value === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readCache(file: string, nowMs: number, ttlMs: number): Universe | null {
  if (!existsSync(file)) return null;
  try {
    const universe = JSON.parse(readFileSync(file, "utf8")) as Universe;
    if (!Number.isFinite(universe.builtTs)) return null;
    const age = nowMs - universe.builtTs;
    if (age < 0 || age > ttlMs) return null;
    return universe;
  } catch {
    return null;
  }
}

function writeCache(file: string, universe: Universe): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.${Date.now()}.universe.tmp`);
  writeFileSync(temp, `${JSON.stringify(universe, null, 2)}\n`, "utf8");
  renameSync(temp, file);
}
