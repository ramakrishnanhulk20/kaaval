import type { AccountView, PositionView, WorldState, WorldSymbol } from "../../src/brain/types.js";
import type { OrderIntent, RiskContext } from "../../src/risk/limits.js";
import { DEFAULT_RULEBOOK } from "../../src/risk/rulebook.js";

/**
 * A small world for the risk tests. The default is a Thursday night: the NYSE is shut,
 * it reopens in twelve hours, TSLA has a tokenized stock and a perpetual, SPY has a
 * perpetual only. Every field is overridable, so a test names the one number it is
 * about and nothing else.
 */

export const NOW_TS = 1_789_099_200_000;

const HOUR = 3_600_000;

export function symbol(over: Partial<WorldSymbol> = {}): WorldSymbol {
  return {
    category: "SPOT",
    symbol: "RTSLAUSDT",
    underlying: "TSLA",
    last: 400,
    bid: 399.8,
    ask: 400.2,
    spreadBps: 10,
    volume24hUsdt: 1_500_000,
    divergencePct: 0.2,
    fundingRate: null,
    openInterest: null,
    roundTheClock: true,
    tradable: true,
    ...over,
  };
}

export function position(over: Partial<PositionView> = {}): PositionView {
  const base: PositionView = {
    category: "SPOT",
    symbol: "RTSLAUSDT",
    side: "long",
    qty: 2,
    avgEntry: 400,
    mark: 400,
    notionalUsdt: 800,
    unrealised: 0,
    ...over,
  };
  return base;
}

export function account(over: Partial<AccountView> = {}): AccountView {
  return {
    id: "rules",
    equity: 10_000,
    balanceUsdt: 10_000,
    realisedPnl: 0,
    unrealised: 0,
    drawdownPct: 0,
    dayPnlPct: 0,
    positions: [],
    ...over,
  };
}

export function world(over: Partial<WorldState> = {}): WorldState {
  return {
    ts: NOW_TS,
    clock: {
      nowEt: "2026-09-10 22:00:00 ET",
      regularSessionOpen: false,
      isWeekend: false,
      msToNextOpen: 12 * HOUR,
      msToNextClose: 18 * HOUR,
      ...over.clock,
    },
    window: "normal",
    symbols: over.symbols ?? [
      symbol(),
      symbol({ category: "USDT-FUTURES", symbol: "TSLAUSDT", last: 401, bid: 400.9, ask: 401.1 }),
      symbol({ category: "USDT-FUTURES", symbol: "SPYUSDT", underlying: "SPY", last: 600, bid: 599.9, ask: 600.1 }),
    ],
    news: [],
    calendar: [],
    ...over,
  };
}

export function universeOf(state: WorldState): Set<string> {
  return new Set(state.symbols.map((s) => `${s.category}:${s.symbol}`));
}

export function context(over: Partial<RiskContext> = {}): RiskContext {
  const state = over.world ?? world();
  const view = over.account ?? account();
  return {
    world: state,
    account: view,
    rulebook: over.rulebook ?? DEFAULT_RULEBOOK,
    universe: over.universe ?? universeOf(state),
    startOfDayEquity: over.startOfDayEquity ?? view.equity,
    peakEquity: over.peakEquity ?? view.equity,
    halted: over.halted ?? false,
  };
}

export function intent(over: Partial<OrderIntent> = {}): OrderIntent {
  return {
    category: "SPOT",
    symbol: "RTSLAUSDT",
    side: "buy",
    notionalUsdt: 400,
    reduceOnly: false,
    hedgeFor: null,
    brain: "rules",
    source: "brain",
    ...over,
  };
}
