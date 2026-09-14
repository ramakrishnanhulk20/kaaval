import type { Category } from "../bitget/types.js";

/**
 * Everything a brain is allowed to know at one tick. Built once per tick by the engine
 * and handed unchanged to all three brains, so a difference in their decisions can only
 * come from the brain, never from what it saw.
 */
export interface WorldSymbol {
  category: Category;
  symbol: string;
  underlying: string;
  last: number;
  bid: number;
  ask: number;
  spreadBps: number;
  volume24hUsdt: number;
  divergencePct: number | null;
  fundingRate: number | null;
  openInterest: number | null;
  roundTheClock: boolean;
  tradable: boolean;
}

export interface NewsItem {
  id: string;
  ts: number;
  source: string;
  headline: string;
  summary: string | null;
  url: string | null;
  symbols: string[];
}

export interface CalendarEvent {
  ts: number;
  kind: "earnings" | "macro";
  title: string;
  symbol: string | null;
  timing: "before-open" | "after-close" | "during" | "unknown";
}

export interface PositionView {
  category: Category;
  symbol: string;
  side: "long" | "short";
  qty: number;
  avgEntry: number;
  mark: number;
  notionalUsdt: number;
  unrealised: number;
}

export interface AccountView {
  id: string;
  equity: number;
  balanceUsdt: number;
  realisedPnl: number;
  unrealised: number;
  drawdownPct: number;
  dayPnlPct: number;
  positions: PositionView[];
}

export interface WorldState {
  ts: number;
  clock: {
    nowEt: string;
    regularSessionOpen: boolean;
    isWeekend: boolean;
    msToNextOpen: number;
    msToNextClose: number;
  };
  window: "normal" | "event" | "open";
  symbols: WorldSymbol[];
  news: NewsItem[];
  calendar: CalendarEvent[];
}

/**
 * A brain proposes targets, never orders. targetNotionalUsdt is signed: positive is
 * long, negative is short, zero is flat. hedgeFor names the symbol this target hedges,
 * so the rulebook can tell a hedge from a bet.
 */
export interface Target {
  category: Category;
  symbol: string;
  targetNotionalUsdt: number;
  hedgeFor: string | null;
  rationale: string;
  confidence: number;
  horizonMinutes: number;
}

export interface Decision {
  brain: string;
  ts: number;
  targets: Target[];
  summary: string;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

export interface Brain {
  readonly name: string;
  decide(world: WorldState, account: AccountView, rulebookText: string): Promise<Decision>;
}
