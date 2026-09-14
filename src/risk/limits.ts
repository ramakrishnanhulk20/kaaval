import type { Category } from "../bitget/types.js";
import type { AccountView, PositionView, Target, WorldState, WorldSymbol } from "../brain/types.js";
import { positionKey } from "../sim/account.js";
import type { Rulebook } from "./rulebook.js";

/**
 * Everything the rulebook needs to judge one tick. It is all data: no client, no model,
 * no clock of its own. universe keys are "CATEGORY:SYMBOL", the same key sim/account.ts
 * uses for positions, so the two never drift apart.
 */
export interface RiskContext {
  world: WorldState;
  account: AccountView;
  rulebook: Rulebook;
  universe: Set<string>;
  startOfDayEquity: number;
  peakEquity: number;
  halted: boolean;
}

export interface OrderIntent {
  category: Category;
  symbol: string;
  side: "buy" | "sell";
  notionalUsdt: number;
  reduceOnly: boolean;
  hedgeFor: string | null;
  brain: string;
  source: "brain" | "stop" | "rebalance" | "kill";
}

export type Verdict =
  | { allowed: true; intent: OrderIntent; clipped: boolean; notes: string[] }
  | { allowed: false; intent: OrderIntent; reason: string; rule: string };

/** Below this many USDT a difference is rounding, not a trade. */
// A target that differs from the position by less than a dollar is the mark moving, not a
// decision; below this the intent would only be refused as dust downstream and clutter the record.
const DUST_USDT = 1;

const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

/**
 * Turns a brain's targets into the orders that would reach them.
 *
 * Targets are absolute and signed: 800 means hold 800 USDT long, -800 means hold 800
 * USDT short, 0 means flat. The intent is the difference from what the account holds
 * now. Several targets on one symbol compose in order, so a brain that names a symbol
 * twice gets one path to its last target rather than two overlapping orders.
 *
 * A negative SPOT target becomes flat. Spot cannot go short on Bitget, and silently
 * turning a short request into a sale of everything held is the only reading that
 * cannot lose money by accident.
 */
export function targetsToIntents(targets: Target[], account: AccountView, brain: string): OrderIntent[] {
  const running = signedByKey(account.positions);
  const intents: OrderIntent[] = [];

  for (const target of targets) {
    const key = positionKey(target.category, target.symbol);
    const current = running.get(key) ?? 0;
    const wanted =
      target.category === "SPOT"
        ? Math.max(0, target.targetNotionalUsdt)
        : target.targetNotionalUsdt;
    if (!Number.isFinite(wanted)) continue;

    const delta = wanted - current;
    if (Math.abs(delta) < DUST_USDT) continue;

    const reduceOnly =
      current !== 0 &&
      Math.abs(wanted) < Math.abs(current) &&
      (wanted === 0 || Math.sign(wanted) === Math.sign(current));

    intents.push({
      category: target.category,
      symbol: target.symbol,
      side: delta > 0 ? "buy" : "sell",
      notionalUsdt: Math.abs(delta),
      reduceOnly,
      hedgeFor: target.hedgeFor,
      brain,
      source: "brain",
    });
    running.set(key, wanted);
  }

  return intents;
}

/**
 * One intent against every rule in docs/rulebook.md, in the order the rulebook reads.
 *
 * Size limits cut the order down and say so in notes. Everything else refuses outright,
 * and the rule field names the section and the line that refused it, for example
 * "exposure.perSymbolPct", so the ledger entry explains itself without a human.
 *
 * alreadyAllowed carries the intents this tick that passed before this one, so the
 * gross, net and position count limits see the whole tick and not one order at a time.
 *
 * Orders that cut risk (reduceOnly, or the kill switch flattening the book) skip the
 * entry gates and the order size band. Refusing to shrink a position is how a risk
 * layer traps a loss instead of stopping one.
 */
export function checkIntent(intent: OrderIntent, ctx: RiskContext, alreadyAllowed: OrderIntent[]): Verdict {
  const rb = ctx.rulebook;
  const notes: string[] = [];
  const key = positionKey(intent.category, intent.symbol);
  const cutsRisk = intent.reduceOnly || intent.source === "kill";
  const hedge = intent.hedgeFor !== null;

  if (!Number.isFinite(intent.notionalUsdt) || intent.notionalUsdt <= 0) {
    return refuse(intent, "input.notionalUsdt", `order size ${intent.notionalUsdt} is not a positive number of USDT`);
  }

  if (ctx.halted && !cutsRisk) {
    return refuse(intent, "safety.kill", "the kill switch is on: only reduce-only and kill orders pass");
  }

  if (!ctx.universe.has(key)) {
    return refuse(intent, "universe.symbol", `${key} is not in today's universe`);
  }

  const market = ctx.world.symbols.find((s) => s.category === intent.category && s.symbol === intent.symbol);
  if (!market) {
    return refuse(
      intent,
      "universe.symbol",
      hedge
        ? `${key} could not be read this tick, so the hedge for ${intent.hedgeFor ?? "it"} has no market data and is not placed`
        : `${key} has no market data this tick`,
    );
  }
  if (!market.tradable) {
    return refuse(intent, "universe.tradable", `${key} is not tradable at ${ctx.world.clock.nowEt}`);
  }

  const loss = lossState(ctx);
  if (!cutsRisk && loss.halt) {
    return refuse(
      intent,
      "loss.drawdownHaltPct",
      `equity is ${pct(drawdownPct(ctx))} percent below the peak, past the ${rb.loss.drawdownHaltPct} percent halt`,
    );
  }
  if (!cutsRisk && loss.dailyLossHit) {
    return refuse(
      intent,
      "loss.dailyLossPct",
      `the day is ${pct(-dayPnlPct(ctx))} percent down, past the ${rb.loss.dailyLossPct} percent daily loss limit`,
    );
  }

  let notional = intent.notionalUsdt;
  if (!cutsRisk && loss.sizeMultiplier < 1) {
    notional *= loss.sizeMultiplier;
    notes.push(
      `loss.drawdownTightenPct: halved to ${round2(notional)} USDT, ${pct(drawdownPct(ctx))} percent below the equity peak`,
    );
  }

  if (!cutsRisk) {
    if (inNoEntryWindow(ctx.world.clock.nowEt, rb)) {
      return refuse(
        intent,
        "gates.noEntryWindow",
        `no entries between ${rb.gates.noEntryStartEt} and ${rb.gates.noEntryEndEt} ET, the clock reads ${ctx.world.clock.nowEt}`,
      );
    }
    if (market.spreadBps > rb.gates.maxSpreadBps) {
      return refuse(
        intent,
        "gates.maxSpreadBps",
        `the spread is ${round2(market.spreadBps)} basis points, over the ${rb.gates.maxSpreadBps} allowed`,
      );
    }

    // Hedges skip the divergence and pre-open gates on purpose: the cross-asset rule
    // wants a hedge on exactly the nights those gates fire.
    const newUnhedgedLong = intent.category === "SPOT" && intent.side === "buy" && !hedge;
    if (newUnhedgedLong) {
      const divergenceRefusal = checkDivergence(intent, market, ctx);
      if (divergenceRefusal) return divergenceRefusal;
    }
  }

  const equity = ctx.account.equity;
  const signed = signedByKey(ctx.account.positions);
  for (const earlier of alreadyAllowed) {
    const earlierKey = positionKey(earlier.category, earlier.symbol);
    signed.set(earlierKey, (signed.get(earlierKey) ?? 0) + signedDelta(earlier));
  }

  const direction = intent.side === "buy" ? 1 : -1;
  const here = signed.get(key) ?? 0;
  let othersGross = 0;
  let total = 0;
  for (const [otherKey, value] of signed) {
    total += value;
    if (otherKey !== key) othersGross += Math.abs(value);
  }

  const caps: Array<{ rule: string; room: number; what: string }> = [
    {
      rule: "exposure.perSymbolPct",
      room: headroom(here, direction, (rb.exposure.perSymbolPct / 100) * equity),
      what: `${rb.exposure.perSymbolPct} percent of equity in ${intent.symbol}`,
    },
    {
      rule: "exposure.grossPct",
      room: headroom(here, direction, (rb.exposure.grossPct / 100) * equity - othersGross),
      what: `${rb.exposure.grossPct} percent gross`,
    },
    {
      rule: "exposure.netPct",
      room: headroom(total, direction, (rb.exposure.netPct / 100) * equity),
      what: `${rb.exposure.netPct} percent net`,
    },
  ];

  for (const cap of caps) {
    if (notional <= cap.room) continue;
    if (cap.room < DUST_USDT) {
      return refuse(intent, cap.rule, `no room left under the ${cap.what} limit`);
    }
    notional = cap.room;
    notes.push(`${cap.rule}: cut to ${round2(notional)} USDT by the ${cap.what} limit`);
  }

  if (!cutsRisk) {
    const open = new Set<string>();
    for (const [openKey, value] of signed) {
      if (Math.abs(value) >= DUST_USDT) open.add(openKey);
    }
    if (!open.has(key) && open.size >= rb.exposure.maxPositions) {
      return refuse(
        intent,
        "exposure.maxPositions",
        `${open.size} positions are already open, the limit is ${rb.exposure.maxPositions}`,
      );
    }

    if (notional > rb.exposure.maxOrderUsdt) {
      notional = rb.exposure.maxOrderUsdt;
      notes.push(`exposure.maxOrderUsdt: cut to the ${rb.exposure.maxOrderUsdt} USDT order cap`);
    }
    if (notional < rb.exposure.minOrderUsdt) {
      return refuse(
        intent,
        "exposure.minOrderUsdt",
        `${round2(notional)} USDT is under the ${rb.exposure.minOrderUsdt} USDT minimum order`,
      );
    }
  }

  return {
    allowed: true,
    intent: { ...intent, notionalUsdt: notional },
    clipped: notes.length > 0,
    notes,
  };
}

/** Every intent in order, so each one is judged against the tick built so far. */
export function checkAll(intents: OrderIntent[], ctx: RiskContext): Verdict[] {
  const allowed: OrderIntent[] = [];
  const verdicts: Verdict[] = [];
  for (const intent of intents) {
    const verdict = checkIntent(intent, ctx, allowed);
    if (verdict.allowed) allowed.push(verdict.intent);
    verdicts.push(verdict);
  }
  return verdicts;
}

/**
 * The hedges the cross-asset rule demands right now, as orders.
 *
 * Any rToken position over hedgeAbovePct of equity has to carry hedgeRatio of its delta
 * in a perpetual whenever its price has drifted past hedgeDivergencePct from the last
 * regular close, or the NYSE will stay shut for more than closedHoursThreshold hours.
 * The hedge goes in the stock's own perpetual when that perpetual is in today's
 * universe, and in SPYUSDT otherwise.
 *
 * A short already on the books counts towards the hedge and is claimed by the largest
 * position first, so one SPYUSDT short covering three rTokens is never counted three
 * times.
 */
export function requiredHedges(ctx: RiskContext): OrderIntent[] {
  const rb = ctx.rulebook;
  const equity = ctx.account.equity;
  if (!(equity > 0)) return [];

  const threshold = (rb.crossAsset.hedgeAbovePct / 100) * equity;
  const closedLong =
    !ctx.world.clock.regularSessionOpen &&
    ctx.world.clock.msToNextOpen > rb.crossAsset.closedHoursThreshold * MS_PER_HOUR;

  const supply = new Map<string, number>();
  for (const position of ctx.account.positions) {
    if (position.category !== "USDT-FUTURES" || position.side !== "short") continue;
    const key = positionKey(position.category, position.symbol);
    supply.set(key, (supply.get(key) ?? 0) + position.notionalUsdt);
  }

  const holdings = ctx.account.positions
    .filter((p) => p.category === "SPOT" && p.side === "long" && p.notionalUsdt > threshold)
    .sort((a, b) => b.notionalUsdt - a.notionalUsdt || a.symbol.localeCompare(b.symbol));

  const hedges: OrderIntent[] = [];
  for (const position of holdings) {
    const market = ctx.world.symbols.find((s) => s.category === "SPOT" && s.symbol === position.symbol);
    const divergent =
      market?.divergencePct != null && Math.abs(market.divergencePct) > rb.crossAsset.hedgeDivergencePct;
    if (!divergent && !closedLong) continue;

    const hedgeSymbol = hedgeSymbolFor(position, market, ctx);
    const hedgeKey = positionKey("USDT-FUTURES", hedgeSymbol);
    const want = rb.crossAsset.hedgeRatio * position.notionalUsdt;
    const available = supply.get(hedgeKey) ?? 0;
    const used = Math.min(want, available);
    supply.set(hedgeKey, available - used);

    const shortfall = want - used;
    if (shortfall < DUST_USDT) continue;

    hedges.push({
      category: "USDT-FUTURES",
      symbol: hedgeSymbol,
      side: "sell",
      notionalUsdt: shortfall,
      reduceOnly: false,
      hedgeFor: position.symbol,
      brain: ctx.account.id,
      source: "rebalance",
    });
  }

  return hedges;
}

/**
 * Where the account stands against the three loss limits.
 *
 * sizeMultiplier is what every new order is multiplied by: a half between the tighten
 * and halt lines, zero past the halt. halt here is the drawdown halt only. The kill
 * switch is RiskContext.halted and is checked separately, so the ledger can tell a
 * human pulling the switch from the account hitting its own limit.
 */
export function lossState(ctx: RiskContext): {
  dailyLossHit: boolean;
  tighten: boolean;
  halt: boolean;
  sizeMultiplier: number;
} {
  const rb = ctx.rulebook;
  const drawdown = drawdownPct(ctx);
  const dayPnl = dayPnlPct(ctx);

  const halt = drawdown >= rb.loss.drawdownHaltPct || ctx.account.equity <= 0;
  const tighten = !halt && drawdown >= rb.loss.drawdownTightenPct;
  const dailyLossHit = dayPnl <= -rb.loss.dailyLossPct;

  return { dailyLossHit, tighten, halt, sizeMultiplier: halt ? 0 : tighten ? 0.5 : 1 };
}

/**
 * Whether the clock is inside the minutes around the open when Bitget's own guidance
 * says rToken prices re-anchor. Both ends count as inside.
 *
 * nowEt arrives as nyseClock writes it, "YYYY-MM-DD HH:MM:SS ET", and a bare "HH:MM"
 * is accepted too. A clock this cannot read is treated as inside the window, because a
 * broken clock must not open the gate.
 */
export function inNoEntryWindow(nowEt: string, rb: Rulebook): boolean {
  const now = minuteOfDay(nowEt);
  const start = minuteOfDay(rb.gates.noEntryStartEt);
  const end = minuteOfDay(rb.gates.noEntryEndEt);
  if (now === null) return true;
  if (start === null || end === null) return true;
  if (start <= end) return now >= start && now <= end;
  return now >= start || now <= end;
}

function checkDivergence(intent: OrderIntent, market: WorldSymbol, ctx: RiskContext): Verdict | null {
  const rb = ctx.rulebook;
  // Divergence measures drift while the NYSE is shut. During the regular session the 24/7
  // price is the market itself, there is nothing to re-anchor, and the gate stands down.
  if (ctx.world.clock.regularSessionOpen) return null;
  if (market.divergencePct === null) {
    return refuse(
      intent,
      "gates.maxDivergencePctForNewLong",
      `divergence for ${intent.symbol} is unknown this tick, so a new unhedged long cannot clear the gate`,
    );
  }

  const divergence = Math.abs(market.divergencePct);
  if (divergence > rb.gates.maxDivergencePctForNewLong) {
    return refuse(
      intent,
      "gates.maxDivergencePctForNewLong",
      `${intent.symbol} sits ${pct(market.divergencePct)} percent from the last regular close, over the ${rb.gates.maxDivergencePctForNewLong} percent gate`,
    );
  }

  const msToOpen = ctx.world.clock.msToNextOpen;
  const preOpen = msToOpen > 0 && msToOpen <= rb.gates.preOpenMinutes * MS_PER_MINUTE;
  if (preOpen && divergence > rb.gates.preOpenDivergencePct) {
    return refuse(
      intent,
      "gates.preOpenDivergencePct",
      `${Math.round(msToOpen / MS_PER_MINUTE)} minutes to the open with ${pct(market.divergencePct)} percent divergence, over the ${rb.gates.preOpenDivergencePct} percent pre-open gate`,
    );
  }

  return null;
}

/**
 * The most an order of this direction may add before it breaks a limit, given where the
 * measured exposure stands now.
 *
 * The second term is what lets the layer unwind a breach it inherited: when the limit
 * leaves no room at all, an order pointed the other way may still run all the way to
 * flat, because every unit of it makes the breach smaller.
 */
function headroom(current: number, direction: number, limit: number): number {
  const toLimit = Math.max(0, limit - direction * current);
  const toFlat = direction * current < 0 ? Math.abs(current) : 0;
  return Math.max(toLimit, toFlat);
}

/**
 * Which perpetual hedges this rToken: its own if tonight's universe has one, SPYUSDT if not.
 *
 * Membership of the universe decides it, not whether the perpetual answered this tick. A
 * perpetual we could not read is a gap in our data, and swapping in SPY on the strength of
 * a failed request would hedge Tesla with the whole market for as long as the gap lasts.
 * The intent is built on the right symbol either way, and an unreadable market is refused
 * by checkIntent with the reason written to the ledger.
 */
function hedgeSymbolFor(position: PositionView, market: WorldSymbol | undefined, ctx: RiskContext): string {
  const underlying = market?.underlying;
  if (!underlying) return "SPYUSDT";
  const seen = ctx.world.symbols.find(
    (s) => s.category === "USDT-FUTURES" && s.underlying === underlying && ctx.universe.has(positionKey(s.category, s.symbol)),
  );
  if (seen) return seen.symbol;
  // engine/universe.ts pairs an rToken with the perpetual named after its underlying, so
  // this is the same symbol the universe put in the list, looked up without a quote.
  const own = `${underlying}USDT`;
  return ctx.universe.has(positionKey("USDT-FUTURES", own)) ? own : "SPYUSDT";
}

function signedByKey(positions: PositionView[]): Map<string, number> {
  const signed = new Map<string, number>();
  for (const position of positions) {
    const key = positionKey(position.category, position.symbol);
    const value = position.side === "long" ? position.notionalUsdt : -position.notionalUsdt;
    signed.set(key, (signed.get(key) ?? 0) + value);
  }
  return signed;
}

function signedDelta(intent: OrderIntent): number {
  return intent.side === "buy" ? intent.notionalUsdt : -intent.notionalUsdt;
}

function drawdownPct(ctx: RiskContext): number {
  if (!(ctx.peakEquity > 0)) return 0;
  return ((ctx.peakEquity - ctx.account.equity) / ctx.peakEquity) * 100;
}

function dayPnlPct(ctx: RiskContext): number {
  if (!(ctx.startOfDayEquity > 0)) return 0;
  return ((ctx.account.equity - ctx.startOfDayEquity) / ctx.startOfDayEquity) * 100;
}

function minuteOfDay(text: string): number | null {
  const match = /(\d{1,2}):(\d{2})/.exec(text);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function refuse(intent: OrderIntent, rule: string, reason: string): Verdict {
  return { allowed: false, intent, reason, rule };
}

function round2(value: number): string {
  return value.toFixed(2);
}

function pct(value: number): string {
  return value.toFixed(2);
}
