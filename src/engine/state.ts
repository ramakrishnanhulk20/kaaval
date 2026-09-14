import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AccountView, PositionView } from "../brain/types.js";
import type { StopOrder } from "../risk/stops.js";
import { createAccount, markToMarket, positionKey, type PaperAccount, type Position } from "../sim/account.js";
import { utcDayKey } from "./clock.js";

export interface BrainState {
  account: PaperAccount;
  stops: StopOrder[];
  startOfDayEquity: number;
  dayKey: string;
  peakEquity: number;
  halted: boolean;
  lastDecisionTs: number;
  lastSummary: string;
  /** The last price we saw for each "CATEGORY:SYMBOL", so a tick with no quote still marks. */
  lastMarks: Record<string, number>;
}

/** A position with the provenance of its mark attached, so a stale price is visible. */
export interface MarkedPosition extends PositionView {
  markSource: "quote" | "last" | "entry";
}

export interface EngineState {
  version: 1;
  brains: Record<string, BrainState>;
  lastTickTs: number;
  lastNewsTs: number;
  startedTs: number;
}

/** What goes on disk. PaperAccount.positions is a Map, which JSON.stringify writes as {}. */
interface StoredBrain extends Omit<BrainState, "account"> {
  account: Omit<PaperAccount, "positions"> & { positions: Array<[string, Position]> };
}

interface StoredState extends Omit<EngineState, "brains"> {
  brains: Record<string, StoredBrain>;
}

export function newEngineState(brains: string[], balanceUsdt: number, now: Date): EngineState {
  const state: EngineState = {
    version: 1,
    brains: {},
    lastTickTs: 0,
    lastNewsTs: 0,
    startedTs: now.getTime(),
  };
  for (const name of brains) {
    state.brains[name] = newBrainState(name, balanceUsdt, now);
  }
  return state;
}

export function newBrainState(name: string, balanceUsdt: number, now: Date): BrainState {
  return {
    account: createAccount(name, balanceUsdt),
    stops: [],
    startOfDayEquity: balanceUsdt,
    dayKey: utcDayKey(now.getTime()),
    peakEquity: balanceUsdt,
    halted: false,
    lastDecisionTs: 0,
    lastSummary: "",
    lastMarks: {},
  };
}

/**
 * The engine's memory across restarts. A missing file means a first run and returns
 * null; a file that exists but cannot be read throws, because silently starting a fresh
 * paper account would wipe the record the whole project is built to publish.
 */
export function loadState(file: string): EngineState | null {
  if (!existsSync(file)) return null;
  const stored = JSON.parse(readFileSync(file, "utf8")) as StoredState;
  if (stored.version !== 1) {
    throw new Error(`${file} is engine state version ${String(stored.version)}, this build reads version 1`);
  }

  const brains: Record<string, BrainState> = {};
  for (const [name, brain] of Object.entries(stored.brains)) {
    brains[name] = {
      ...brain,
      // A state file written before marks were remembered has no lastMarks at all. It
      // starts empty rather than failing the load, which would cost the record a night.
      lastMarks: brain.lastMarks ?? {},
      account: { ...brain.account, positions: new Map(brain.account.positions) },
    };
  }
  return { ...stored, brains };
}

/** Written to a temp file and renamed, so a crash mid-write cannot leave half a state. */
export function saveState(file: string, state: EngineState): void {
  mkdirSync(dirname(file), { recursive: true });
  const brains: Record<string, StoredBrain> = {};
  for (const [name, brain] of Object.entries(state.brains)) {
    brains[name] = {
      ...brain,
      account: { ...brain.account, positions: [...brain.account.positions.entries()] },
    };
  }
  const stored: StoredState = { ...state, brains };
  const temp = join(dirname(file), `.${process.pid}.engine.tmp`);
  writeFileSync(temp, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  renameSync(temp, file);
}

/**
 * The account as a brain and the risk layer see it.
 *
 * A position with no mark this tick falls back to the last price we did see, and only to
 * its entry price when there has never been one. That order matters: marking a losing
 * position at its own entry price hides the loss for exactly as long as the data gap
 * lasts, which is when a stop and a drawdown limit most need to see it. Every position
 * says which of the three its mark came from. drawdownPct is never negative: above the
 * old peak the drawdown is zero, not a gain.
 */
export function accountView(
  state: BrainState,
  marks: Map<string, number>,
  quotes: Map<string, { bid: number; ask: number }>,
): AccountView & { positions: MarkedPosition[] } {
  const priced = new Map(marks);
  const source = new Map<string, MarkedPosition["markSource"]>();
  for (const key of priced.keys()) source.set(key, "quote");
  for (const position of state.account.positions.values()) {
    const key = positionKey(position.category, position.symbol);
    if (priced.has(key)) continue;
    const quote = quotes.get(key);
    if (quote) {
      priced.set(key, (quote.bid + quote.ask) / 2);
      source.set(key, "quote");
      continue;
    }
    const last = state.lastMarks[key];
    if (typeof last === "number" && Number.isFinite(last) && last > 0) {
      priced.set(key, last);
      source.set(key, "last");
    }
  }

  const { equity, unrealised } = markToMarket(state.account, priced);
  const positions: MarkedPosition[] = [];
  for (const position of state.account.positions.values()) {
    const key = positionKey(position.category, position.symbol);
    const mark = priced.get(key) ?? position.avgEntry;
    const direction = position.side === "long" ? 1 : -1;
    positions.push({
      category: position.category,
      symbol: position.symbol,
      side: position.side,
      qty: position.qty,
      avgEntry: position.avgEntry,
      mark,
      notionalUsdt: position.qty * mark,
      unrealised: position.qty * (mark - position.avgEntry) * direction,
      markSource: source.get(key) ?? "entry",
    });
  }

  return {
    id: state.account.id,
    equity,
    balanceUsdt: state.account.balanceUsdt,
    realisedPnl: state.account.realisedPnl,
    unrealised,
    drawdownPct: state.peakEquity > 0 ? Math.max(0, ((state.peakEquity - equity) / state.peakEquity) * 100) : 0,
    dayPnlPct:
      state.startOfDayEquity > 0 ? ((equity - state.startOfDayEquity) / state.startOfDayEquity) * 100 : 0,
    positions,
  };
}

/**
 * Remembers this tick's prices, so a symbol that goes unreadable next tick is still
 * marked at a real price rather than at the price we bought it.
 */
export function rememberMarks(state: BrainState, marks: Map<string, number>): void {
  for (const [key, mark] of marks) {
    if (Number.isFinite(mark) && mark > 0) state.lastMarks[key] = mark;
  }
}

/**
 * Rolls the day over when the UTC date changes, which is what the daily loss limit is
 * measured against. Returns true when it moved, so the caller can log the reset.
 */
export function rollDay(state: BrainState, equity: number, now: Date): boolean {
  const key = utcDayKey(now.getTime());
  if (key === state.dayKey) return false;
  state.dayKey = key;
  state.startOfDayEquity = equity;
  return true;
}
