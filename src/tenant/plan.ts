import { invoke, type BitgetContext } from "../bitget/client.js";
import { nyseClock } from "../bitget/hours.js";
import type { Instrument } from "../bitget/types.js";
import type { AccountView, Brain, Decision } from "../brain/types.js";
import { tickWindow, type TickWindow } from "../engine/clock.js";
import { placeArgs } from "../engine/execution.js";
import { perceive, type Perceived, type PerceptionDeps } from "../engine/perception.js";
import { universeKeys, type Universe } from "../engine/universe.js";
import type { Ledger } from "../ledger/ledger.js";
import {
  checkAll,
  requiredHedges,
  targetsToIntents,
  type OrderIntent,
  type RiskContext,
  type Verdict,
} from "../risk/limits.js";
import { rulebookText, type Rulebook } from "../risk/rulebook.js";
import { AccountError, applyFill, createAccount, markToMarket, positionKey, type PaperAccount } from "../sim/account.js";
import { bookHash, canonicalJson, sha256Hex } from "../sim/book.js";
import { fillAgainstBook } from "../sim/fill.js";
import type { Category, FeeSchedule, Fill, Rejection, SimOrder, SlippageModel } from "../sim/types.js";
import { realAccountView } from "./account.js";

export interface PlanOrder {
  intent: OrderIntent;
  dryRun: Record<string, unknown>;
  shadowFill: Fill | Rejection | null;
  bookHash: string | null;
}

export interface PlanBrainResult {
  brain: string;
  decision: Decision | null;
  error: string | null;
  verdicts: Verdict[];
  orders: PlanOrder[];
  shadowMark: { equityAfter: number; realised: number; unrealised: number };
}

export interface Plan {
  id: string;
  accountId: string;
  ts: number;
  window: TickWindow;
  universe: string[];
  before: AccountView;
  brains: PlanBrainResult[];
  rulebookHash: string;
  ledgerSeqRange: [number, number] | null;
}

export interface PlanDeps {
  perception: PerceptionDeps;
  universe: Universe;
  brains: Brain[];
  rulebook: Rulebook;
  ctx: BitgetContext;
  ledger: Ledger | null;
  startOfDayEquity: number | null;
  peakEquity: number | null;
  now?: Date;
}

/**
 * Bitget's published rates, the same numbers scripts/run-engine.ts records in the
 * engine's ledger: rToken spot 0.1 percent, stock perpetuals 0.02 maker and 0.06 taker,
 * read on 8 September 2026. A shadow fill that charged nothing would flatter the plan.
 */
const FEES: Record<Category, FeeSchedule> = {
  SPOT: { makerRate: 0.001, takerRate: 0.001 },
  "USDT-FUTURES": { makerRate: 0.0002, takerRate: 0.0006 },
};

/** Five basis points against the trader on every fill, on top of walking the book. */
const EXTRA_SLIPPAGE_BPS = 5;

/** How far back a plan looks for news, the same window the engine's first tick uses. */
const NEWS_WINDOW_MS = 24 * 60 * 60 * 1000;

const DEFAULT_DECISION_TIMEOUT_MS = 180_000;

const QTY_EPSILON = 1e-12;

/**
 * Tonight's plan for one real Bitget account: what every brain would do, judged by the
 * rulebook, priced against the book, and not sent.
 *
 * The shape is the engine's tick on purpose. One world is perceived and handed to every
 * brain unchanged, the account is the trader's real one, each brain's targets become
 * intents, the rulebook judges them, and what survives becomes an order. The one
 * difference is the last step: instead of an order going anywhere, the plan records the
 * Agent Hub request Bitget would have received, rendered by the SDK's own dry run, and a
 * fill against the order book that was read in this same pass.
 *
 * Nothing here can write. The only two calls made with the trader's credentials are the
 * account snapshot and the dry-run preview, the context they go through is read-only by
 * construction, and the preview is answered by the SDK's safety layer before it reaches
 * the network. A test asserts on the calls actually made, not on this paragraph.
 */
export async function planForAccount(deps: PlanDeps, accountId: string): Promise<Plan> {
  const now = deps.now ?? new Date();
  const rb = deps.rulebook;
  const perceived = await perceive(deps.perception, deps.universe, now, now.getTime() - NEWS_WINDOW_MS);
  const clock = nyseClock(now);
  const { window } = tickWindow(now, clock, perceived.world.calendar, rb);
  perceived.world.window = window;

  const real = await realAccountView(deps.ctx, accountId, perceived.quotes);
  const before: AccountView = {
    ...real.view,
    drawdownPct: drawdownPct(real.view.equity, deps.peakEquity),
    dayPnlPct: dayPnlPct(real.view.equity, deps.startOfDayEquity),
  };

  const keys = universeKeys(deps.universe);
  const text = rulebookText(rb);
  const model: SlippageModel = { maxBookFraction: rb.gates.maxBookFraction, extraBps: EXTRA_SLIPPAGE_BPS };
  const id = `plan-${accountId}-${now.getTime()}`;
  const seqs: number[] = [];
  const write = (kind: "decision" | "reject" | "order" | "mark", payload: Record<string, unknown>): void => {
    if (!deps.ledger) return;
    seqs.push(deps.ledger.append(kind, accountId, { plan: id, ...payload }).seq);
  };

  const brains: PlanBrainResult[] = [];
  for (const brain of deps.brains) {
    brains.push(await planBrain({ deps, brain, perceived, before, keys, text, model, now, write }));
  }

  return {
    id,
    accountId,
    ts: now.getTime(),
    window,
    universe: [...keys].sort(),
    before,
    brains,
    rulebookHash: sha256Hex(canonicalJson(rb)),
    ledgerSeqRange: seqs.length > 0 ? [Math.min(...seqs), Math.max(...seqs)] : null,
  };
}

interface BrainRun {
  deps: PlanDeps;
  brain: Brain;
  perceived: Perceived;
  before: AccountView;
  keys: Set<string>;
  text: string;
  model: SlippageModel;
  now: Date;
  write: (kind: "decision" | "reject" | "order" | "mark", payload: Record<string, unknown>) => void;
}

/**
 * One brain's whole plan for this account.
 *
 * A brain that throws or runs past the timeout costs its own entry in the plan and
 * nothing more: the error is recorded, the next brain still runs, and the plan says
 * plainly that this one had no answer rather than showing an empty night.
 */
async function planBrain(run: BrainRun): Promise<PlanBrainResult> {
  const { deps, brain, perceived, before, model, now, write } = run;
  const rb = deps.rulebook;
  const ctx: RiskContext = {
    world: perceived.world,
    account: before,
    rulebook: rb,
    universe: run.keys,
    startOfDayEquity: deps.startOfDayEquity ?? before.equity,
    peakEquity: deps.peakEquity ?? before.equity,
    // There is no kill switch on a trader's own account. The drawdown halt still applies
    // and is worked out from peakEquity inside the rulebook, like it is for the engine.
    halted: false,
  };

  let decision: Decision | null = null;
  let error: string | null = null;
  const started = Date.now();
  try {
    decision = await withTimeout(
      brain.decide(perceived.world, before, run.text),
      decisionTimeoutMs(),
      `${brain.name} took longer than ${Math.round(decisionTimeoutMs() / 1000)} seconds`,
    );
  } catch (thrown) {
    error = (thrown as Error).message;
  }

  write("decision", {
    brain: brain.name,
    ts: perceived.world.ts,
    targets: decision?.targets ?? [],
    summary: decision?.summary ?? `no decision for this plan: ${error ?? "unknown"}`,
    modelCalls: decision?.modelCalls ?? 0,
    promptTokens: decision?.promptTokens ?? 0,
    completionTokens: decision?.completionTokens ?? 0,
    latencyMs: decision?.latencyMs ?? Date.now() - started,
    ...(error === null ? {} : { error }),
  });

  const intents = decision
    ? [...requiredHedges(ctx), ...targetsToIntents(decision.targets, before, brain.name)]
    : [];
  const verdicts = checkAll(intents, ctx);
  for (const verdict of verdicts) {
    if (verdict.allowed) continue;
    write("reject", { brain: brain.name, intent: verdict.intent, rule: verdict.rule, reason: verdict.reason });
  }

  const shadow = shadowAccountOf(before, run.now);
  const orders: PlanOrder[] = [];
  let account = shadow;
  let index = 0;

  for (const verdict of verdicts) {
    if (!verdict.allowed) continue;
    index += 1;
    const intent = verdict.intent;
    const key = positionKey(intent.category, intent.symbol);
    const instrument = perceived.instruments.get(key);
    const quote = perceived.quotes.get(key);
    if (!instrument || !quote) {
      const reason = `no ${instrument ? "quote" : "instrument"} for ${key} in this pass`;
      write("reject", { brain: brain.name, intent, rule: "execution", reason });
      continue;
    }

    const sized = sizeFor(intent, instrument, quote);
    if ("reason" in sized) {
      write("reject", { brain: brain.name, intent, rule: "execution", reason: sized.reason });
      continue;
    }

    const held = account.positions.get(key)?.qty;
    const qty = closeExactly(intent, sized.qty, held, instrument);
    const order = buildOrder(brain.name, intent, qty, sized.price, now, index);
    const dryRun = await dryRunRequest(deps.ctx, order);
    const book = perceived.books.get(key);
    let shadowFill: Fill | Rejection | null = null;
    if (book) {
      const result = fillAgainstBook(order, book, FEES[order.category], model);
      shadowFill = result;
      if (!("rejected" in result)) {
        try {
          account = applyFill(account, result).account;
        } catch (thrown) {
          if (!(thrown instanceof AccountError)) throw thrown;
          // The order the rulebook allowed is still the order Kaaval would have sent.
          // What the account could not take is recorded as the shadow fill's refusal, so
          // the mark below never counts a fill the balance could not have paid for.
          shadowFill = { rejected: true, orderId: order.id, reason: thrown.message };
        }
      }
    }

    const hash = book ? bookHash(book) : null;
    orders.push({ intent, dryRun, shadowFill, bookHash: hash });
    write("order", {
      brain: brain.name,
      intent,
      notes: verdict.notes,
      order,
      agentHubRequest: dryRun,
      shadowFill,
      bookHash: hash,
      note: "a plan, not an order: nothing was sent to Bitget",
    });
  }

  const marks = marksOf(run.perceived, before);
  const { equity, unrealised } = markToMarket(account, marks);
  const shadowMark = { equityAfter: equity, realised: account.realisedPnl, unrealised };
  write("mark", {
    brain: brain.name,
    equity,
    balance: account.balanceUsdt,
    realised: account.realisedPnl,
    unrealised,
    orders: orders.length,
    simulated: true,
    note: "what this account would be worth if every order in this plan had filled",
  });

  return { brain: brain.name, decision, error, verdicts, orders, shadowMark };
}

/**
 * The trader's account as a paper account the simulator can move.
 *
 * It starts from the real balance and the real positions, so a shadow fill is judged
 * against what the account actually holds: an order that would need cash the trader does
 * not have is refused here exactly as Bitget would refuse it.
 */
function shadowAccountOf(view: AccountView, now: Date): PaperAccount {
  const account = createAccount(view.id, Math.max(0, view.balanceUsdt));
  for (const position of view.positions) {
    account.positions.set(positionKey(position.category, position.symbol), {
      category: position.category,
      symbol: position.symbol,
      side: position.side,
      qty: position.qty,
      avgEntry: position.avgEntry,
      openedTs: now.getTime(),
    });
  }
  return account;
}

/** This pass's quotes, with each position's own mark behind them for anything unquoted. */
function marksOf(perceived: Perceived, before: AccountView): Map<string, number> {
  const marks = new Map<string, number>();
  for (const position of before.positions) {
    marks.set(positionKey(position.category, position.symbol), position.mark);
  }
  for (const [key, quote] of perceived.quotes) marks.set(key, (quote.bid + quote.ask) / 2);
  return marks;
}

/**
 * The order as Bitget's Agent Hub would receive it, rendered by the SDK.
 *
 * dryRun is answered by the SDK's safety layer before it looks at a credential or the
 * network, so this never sends anything. If a build of the SDK ever refuses to preview,
 * the same arguments are recorded from the order tool's own schema and the record says
 * which of the two it is holding.
 */
async function dryRunRequest(ctx: BitgetContext, order: SimOrder): Promise<Record<string, unknown>> {
  const args = placeArgs(order);
  try {
    return (await invoke(ctx, "order", { ...args, dryRun: true })) as Record<string, unknown>;
  } catch (error) {
    return {
      dryRun: true,
      builtLocally: true,
      operationId: "placeOrder",
      method: "POST",
      path: "/api/v3/trade/place-order",
      wouldSend: args,
      reason: (error as Error).message,
    };
  }
}

/**
 * The size this intent becomes, rounded down to the instrument's own precision.
 *
 * This is the engine's own sizing rule, kept to the same two decisions: rest an rToken
 * leg at the touch and take a perpetual hedge at market, and never round a size up. It
 * is a short copy of the private sizing in src/engine/execution.ts because that module
 * owns a live tick and this one owns a plan, and only the request builder is shared.
 */
function sizeFor(
  intent: OrderIntent,
  instrument: Instrument,
  quote: { bid: number; ask: number },
): { qty: number; price: number } | { reason: string } {
  const touch = intent.side === "buy" ? quote.ask : quote.bid;
  const price = roundTo(touch, instrument.pricePrecision);
  if (!(price > 0)) return { reason: `the touch for ${intent.symbol} is ${touch}, which is not a price` };

  const qty = floorTo(intent.notionalUsdt / price, instrument.quantityPrecision);
  const notional = qty * price;
  if (qty <= 0) {
    return {
      reason: `${intent.notionalUsdt.toFixed(2)} USDT of ${intent.symbol} rounds to zero at ${instrument.quantityPrecision} decimals`,
    };
  }
  if (instrument.minOrderQty !== null && qty < instrument.minOrderQty) {
    return { reason: `${qty} ${intent.symbol} is under the ${instrument.minOrderQty} minimum order quantity` };
  }
  if (instrument.minOrderUsdt !== null && notional < instrument.minOrderUsdt) {
    return {
      reason: `${notional.toFixed(2)} USDT is under Bitget's ${instrument.minOrderUsdt} USDT minimum for ${intent.symbol}`,
    };
  }
  return { qty, price };
}

/**
 * What an order that only cuts a position may really sell: never more than the account
 * holds, and the whole position when what is left would be under one tick of size.
 *
 * The size arrives as a notional worked out from a mark and it is filled at the touch,
 * and those are two different prices, so an order meant to close a position can round to
 * a hair more than it. A hair more is an order the exchange would refuse, and a plan that
 * shows a trader an order Bitget would bounce is worth nothing. This is the same rule
 * src/engine/execution.ts applies to a live tick.
 */
function closeExactly(intent: OrderIntent, qty: number, held: number | undefined, instrument: Instrument): number {
  if (!intent.reduceOnly || held === undefined) return qty;
  const step = 10 ** -Math.max(0, Math.floor(instrument.quantityPrecision));
  const capped = Math.min(qty, held);
  return held - capped <= step + QTY_EPSILON ? held : capped;
}

function buildOrder(brain: string, intent: OrderIntent, qty: number, price: number, now: Date, index: number): SimOrder {
  const type = intent.category === "SPOT" ? "limit" : "market";
  return {
    id: `kaaval-plan-${brain}-${now.getTime()}-${index}`,
    account: brain,
    category: intent.category,
    symbol: intent.symbol,
    side: intent.side,
    type,
    qty,
    ...(type === "limit" ? { limitPrice: price } : {}),
    reduceOnly: intent.reduceOnly,
    ts: now.getTime(),
    source: intent.source,
  };
}

function drawdownPct(equity: number, peak: number | null): number {
  if (peak === null || !(peak > 0)) return 0;
  return Math.max(0, ((peak - equity) / peak) * 100);
}

function dayPnlPct(equity: number, startOfDay: number | null): number {
  if (startOfDay === null || !(startOfDay > 0)) return 0;
  return ((equity - startOfDay) / startOfDay) * 100;
}

/** The same budget the engine gives a brain, so a plan is not kinder than a live tick. */
function decisionTimeoutMs(): number {
  const raw = process.env["KAAVAL_DECISION_TIMEOUT_MS"];
  const parsed = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_DECISION_TIMEOUT_MS;
  }
  return parsed;
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** Math.max(0, Math.floor(decimals));
  return Math.round(value * factor) / factor;
}

function floorTo(value: number, decimals: number): number {
  const factor = 10 ** Math.max(0, Math.floor(decimals));
  return Math.floor(value * factor + 1e-9) / factor;
}
