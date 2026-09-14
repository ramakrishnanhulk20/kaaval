import { invoke, type BitgetContext } from "../bitget/client.js";
import type { Instrument } from "../bitget/types.js";
import type { PositionView } from "../brain/types.js";
import type { Ledger } from "../ledger/ledger.js";
import type { FillPayload, SnapshotPayload } from "../ledger/ledger.js";
import type { OrderIntent, Verdict } from "../risk/limits.js";
import type { Rulebook } from "../risk/rulebook.js";
import { formatAmount, stopDryRunRequest, stopFor, type StopOrder } from "../risk/stops.js";
import { AccountError, applyFill, positionKey, type LogRow } from "../sim/account.js";
import { bookHash } from "../sim/book.js";
import { fillAgainstBook } from "../sim/fill.js";
import type { Category, FeeSchedule, Fill, OrderBook, SimOrder, SlippageModel } from "../sim/types.js";
import type { Perceived } from "./perception.js";
import type { BrainState } from "./state.js";

export interface ExecutionDeps {
  bitget: BitgetContext;
  demo: BitgetContext | null;
  ledger: Ledger;
  rulebook: Rulebook;
  fees: Record<Category, FeeSchedule>;
  model: SlippageModel;
  log: (line: string) => void;
}

export interface Executed {
  state: BrainState;
  fills: Fill[];
  rows: LogRow[];
  rejected: Array<{ intent: OrderIntent; reason: string }>;
}

/**
 * The three contracts Bitget's demo environment carries. It has no stock symbols at all,
 * which is why the stock legs fill in our simulator and only a crypto hedge can be sent
 * to a real Bitget matching engine.
 */
export const DEMO_CONTRACTS: Record<string, string> = {
  BTCUSDT: "SBTCSUSDT",
  ETHUSDT: "SETHSUSDT",
  XRPUSDT: "SXRPSUSDT",
};

const QTY_EPSILON = 1e-12;

/** Which books this ledger has already snapshotted, per tick. */
const snapshotted = new WeakMap<Ledger, { tickTs: number; hashes: Set<string> }>();

/** Ledgers that have already been told, once, that previews are being built locally. */
const localPreviewNoted = new WeakSet<Ledger>();

/**
 * Turns the verdicts the rulebook allowed into orders, requests, fills and ledger entries.
 *
 * Every order exists twice on purpose. First as the Agent Hub request Bitget would have
 * received, built through the SDK's own dry-run path so the record shows the real call
 * and not our description of it. Then as a fill against the order book recorded in this
 * same tick, which is what moves the paper account. The two sit next to each other in the
 * ledger, so a reader can check the order we claim we would have sent against the fill we
 * claim we got.
 *
 * rToken legs rest at the touch as limit orders and crypto or perpetual hedges go at
 * market, which is the execution section of docs/rulebook.md. Sizes are rounded down to
 * the instrument's own precision, never up: rounding a size up is how a paper run quietly
 * trades more than the exchange would have let it.
 */
export async function executeVerdicts(
  deps: ExecutionDeps,
  brain: string,
  verdicts: Verdict[],
  perceived: Perceived,
  state: BrainState,
  now: Date,
): Promise<Executed> {
  const fills: Fill[] = [];
  const rows: LogRow[] = [];
  const rejected: Array<{ intent: OrderIntent; reason: string }> = [];
  let account = state.account;
  const qtyBefore = new Map<string, number>();
  for (const [key, position] of account.positions) qtyBefore.set(key, position.qty);

  const refuse = (intent: OrderIntent, reason: string, extra: Record<string, unknown> = {}): void => {
    deps.ledger.append("reject", brain, { intent, reason, rule: "execution", ...extra });
    rejected.push({ intent, reason });
    deps.log(`${brain} ${intent.symbol}: ${reason}`);
  };

  let index = 0;
  for (const verdict of verdicts) {
    if (!verdict.allowed) continue;
    const intent = verdict.intent;
    index += 1;
    const key = positionKey(intent.category, intent.symbol);
    const instrument = perceived.instruments.get(key);
    const quote = perceived.quotes.get(key);
    if (!instrument || !quote) {
      refuse(intent, `no ${instrument ? "quote" : "instrument"} for ${key} this tick`);
      continue;
    }

    const sized = size(intent, instrument, quote);
    if ("reason" in sized) {
      refuse(intent, sized.reason);
      continue;
    }

    const qty = closeExactly(intent, sized.qty, account.positions.get(key)?.qty, instrument);
    const order = buildOrder(brain, intent, qty, sized.price, now, index);
    const request = await agentHubRequest(deps, order, brain);
    deps.ledger.append("order", brain, {
      intent,
      notes: verdict.notes,
      order,
      agentHubRequest: request,
      stopRequest: armedStop(deps, order, sized.price, now),
    });

    const book = perceived.books.get(key);
    const demoSymbol = deps.demo && order.category === "USDT-FUTURES" ? DEMO_CONTRACTS[order.symbol] : undefined;
    let fill: Fill;
    let demo = false;

    if (deps.demo && demoSymbol) {
      const placed = await placeOnDemo(deps, order, demoSymbol, brain);
      if ("reason" in placed) {
        refuse(intent, placed.reason);
        continue;
      }
      fill = placed.fill;
      demo = true;
      if (book) writeSnapshot(deps.ledger, now, book);
    } else {
      if (!book) {
        refuse(intent, `no order book for ${key} this tick, so nothing to fill against`);
        continue;
      }
      writeSnapshot(deps.ledger, now, book);
      const result = fillAgainstBook(order, book, deps.fees[order.category], deps.model);
      if ("rejected" in result) {
        refuse(intent, result.reason, { order });
        continue;
      }
      fill = result;
    }

    let applied: ReturnType<typeof applyFill>;
    try {
      applied = applyFill(account, fill);
    } catch (error) {
      if (!(error instanceof AccountError)) throw error;
      refuse(intent, error.message, { order, code: error.code });
      continue;
    }

    account = applied.account;
    fills.push(fill);
    rows.push(applied.row);
    deps.ledger.append("fill", brain, { order, fill, demo } satisfies FillPayload & { demo: boolean });
    deps.log(
      `${brain} ${demo ? "demo" : "sim"} ${order.side} ${fill.qty} ${order.symbol} at ${fill.avgPrice.toFixed(4)}`,
    );
  }

  const next: BrainState = {
    ...state,
    account,
    stops: refreshStops(state, account, qtyBefore, perceived, deps.rulebook, now),
  };
  return { state: next, fills, rows, rejected };
}

/**
 * What a reduce-only order may really sell: never more than the account holds, and the
 * whole position when what is left would be under one tick of the instrument's precision.
 *
 * The size arrives as a notional worked out from a mark and it is filled at the touch, and
 * those are two different prices, so an order meant to close a position can round to a hair
 * more or a hair less than it. More is refused by the account, which would leave a halt
 * unable to flatten; less leaves a dust position nobody decided to hold. Rounding up here
 * is bounded by the position itself, so it can never trade size the exchange would not have.
 */
function closeExactly(
  intent: OrderIntent,
  qty: number,
  held: number | undefined,
  instrument: Instrument,
): number {
  if (!intent.reduceOnly || held === undefined) return qty;
  const step = 10 ** -Math.max(0, Math.floor(instrument.quantityPrecision));
  const capped = Math.min(qty, held);
  return held - capped <= step + QTY_EPSILON ? held : capped;
}

function size(
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

function buildOrder(
  brain: string,
  intent: OrderIntent,
  qty: number,
  price: number,
  now: Date,
  index: number,
): SimOrder {
  const type = intent.category === "SPOT" ? "limit" : "market";
  return {
    id: `kaaval-${brain}-${now.getTime()}-${index}`,
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

/**
 * The order as Bitget's Agent Hub would receive it.
 *
 * The SDK's safety layer answers a dryRun before it looks at credentials or the network,
 * so this is the SDK's own rendering of the request, not ours. If a build of the SDK ever
 * refuses to preview without a key, the same arguments are recorded from the tool's schema
 * instead and the ledger says so once per run, so nobody reading the record later has to
 * wonder which of the two they are looking at.
 */
async function agentHubRequest(
  deps: ExecutionDeps,
  order: SimOrder,
  brain: string,
): Promise<Record<string, unknown>> {
  const args = placeArgs(order);
  try {
    return (await invoke(deps.bitget, "order", { ...args, dryRun: true })) as Record<string, unknown>;
  } catch (error) {
    if (!localPreviewNoted.has(deps.ledger)) {
      localPreviewNoted.add(deps.ledger);
      deps.ledger.append("config", brain, {
        agentHubPreview: "built locally",
        reason: (error as Error).message,
        note: "the SDK would not preview this order, so the request below is built from the order tool's own schema",
      });
    }
    return {
      dryRun: true,
      builtLocally: true,
      operationId: "placeOrder",
      method: "POST",
      path: "/api/v3/trade/place-order",
      wouldSend: args,
    };
  }
}

/**
 * The arguments the SDK's order tool takes for action place, all strings, as v3 wants.
 *
 * Exported because src/tenant/plan.ts builds the same request for a real trader's
 * account. One definition, so the preview a trader is shown and the preview the engine
 * records can never drift apart.
 */
export function placeArgs(order: SimOrder): Record<string, unknown> {
  return {
    action: "place",
    category: order.category,
    symbol: order.symbol,
    side: order.side,
    orderType: order.type,
    qty: formatAmount(order.qty),
    ...(order.type === "limit" ? { price: formatAmount(order.limitPrice ?? 0), timeInForce: "gtc" } : {}),
    reduceOnly: order.reduceOnly ? "yes" : "no",
    clientOid: order.id,
  };
}

/**
 * Sends a crypto hedge to Bitget's demo environment and records what came back.
 *
 * The demo contracts are separate symbols (SBTCSUSDT and friends), so the order goes out
 * under the demo name and the fill is recorded under the real one, which is the symbol
 * the account, the rulebook and the world state all speak. The price is the touch we
 * sized against: the demo endpoint acknowledges an order id rather than a fill price, and
 * inventing a better number than the one we sized at would flatter the record.
 */
async function placeOnDemo(
  deps: ExecutionDeps,
  order: SimOrder,
  demoSymbol: string,
  brain: string,
): Promise<{ fill: Fill } | { reason: string }> {
  if (!deps.demo) return { reason: "no demo environment is configured" };
  const args = { ...placeArgs(order), symbol: demoSymbol };
  let response: unknown;
  try {
    response = await invoke(deps.demo, "order", args);
  } catch (error) {
    return { reason: `Bitget demo refused the order: ${(error as Error).message}` };
  }

  const price = order.limitPrice ?? 0;
  const notionalUsdt = order.qty * price;
  deps.ledger.append("order", brain, { demoSymbol, request: args, response });
  return {
    fill: {
      orderId: order.id,
      account: order.account,
      category: order.category,
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      avgPrice: price,
      notionalUsdt,
      feeUsdt: notionalUsdt * (deps.fees[order.category]?.takerRate ?? 0),
      slippageBps: 0,
      levelsConsumed: 0,
      partial: false,
      ts: order.ts,
      bookHash: "",
    },
  };
}

/** One snapshot per book per tick: a fill names a book by hash and the book must be here. */
function writeSnapshot(ledger: Ledger, now: Date, book: OrderBook): string {
  const tickTs = now.getTime();
  let seen = snapshotted.get(ledger);
  if (!seen || seen.tickTs !== tickTs) {
    seen = { tickTs, hashes: new Set<string>() };
    snapshotted.set(ledger, seen);
  }
  const hash = bookHash(book);
  if (!seen.hashes.has(hash)) {
    seen.hashes.add(hash);
    ledger.append("snapshot", "kaaval", { bookHash: hash, book } satisfies SnapshotPayload);
  }
  return hash;
}

/**
 * The stop this order arms, as the Agent Hub request that would place it on Bitget.
 *
 * It is priced off the touch this order was sized against, which a limit order rests at and
 * a market order pays, so it is the stop that goes with this entry if it fills where we
 * expected. The stop the engine then tracks is recomputed from the average
 * fill price in the entry beside this one, which can sit a few basis points away. An order
 * that only cuts a position arms nothing and records null.
 */
function armedStop(
  deps: ExecutionDeps,
  order: SimOrder,
  price: number,
  now: Date,
): Record<string, unknown> | null {
  if (order.reduceOnly) return null;
  if (!(price > 0)) return null;
  const side = order.side === "buy" ? "long" : "short";
  const view: PositionView = {
    category: order.category,
    symbol: order.symbol,
    side,
    qty: order.qty,
    avgEntry: price,
    mark: price,
    notionalUsdt: order.qty * price,
    unrealised: 0,
  };
  return stopDryRunRequest(stopFor(view, deps.rulebook, now.getTime()));
}

/**
 * Every open position carries a stop, no closed one keeps its own, and a position that
 * turned around gets a stop pointing the new way.
 *
 * A position that grew gets a fresh stop off the new average entry, because a stop left
 * on the old size would only protect part of the position, and a position that was cut
 * keeps its trigger with the smaller size. A perpetual that flipped from long to short
 * keeps neither: its old stop would sit on the wrong side of the price and would either
 * fire at once or never.
 */
function refreshStops(
  state: BrainState,
  account: BrainState["account"],
  qtyBefore: Map<string, number>,
  perceived: Perceived,
  rb: Rulebook,
  now: Date,
): StopOrder[] {
  const kept = state.stops.filter((stop) => account.positions.has(positionKey(stop.category, stop.symbol)));
  const byKey = new Map(kept.map((stop) => [positionKey(stop.category, stop.symbol), stop]));

  for (const [key, position] of account.positions) {
    const before = qtyBefore.get(key) ?? 0;
    const existing = byKey.get(key);
    if (existing && existing.positionSide !== position.side) byKey.delete(key);
    else if (existing && position.qty <= before + QTY_EPSILON) {
      // A position that was cut keeps its trigger price and gives up the quantity it no
      // longer holds. A stop for more than the account owns cannot fill at all.
      if (existing.qty > position.qty) byKey.set(key, { ...existing, qty: position.qty });
      continue;
    }
    const quote = perceived.quotes.get(key);
    const mark = quote ? (quote.bid + quote.ask) / 2 : position.avgEntry;
    const view: PositionView = {
      category: position.category,
      symbol: position.symbol,
      side: position.side,
      qty: position.qty,
      avgEntry: position.avgEntry,
      mark,
      notionalUsdt: position.qty * mark,
      unrealised: position.qty * (mark - position.avgEntry) * (position.side === "long" ? 1 : -1),
    };
    byKey.set(key, stopFor(view, rb, now.getTime()));
  }

  return [...byKey.values()];
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** Math.max(0, Math.floor(decimals));
  return Math.round(value * factor) / factor;
}

function floorTo(value: number, decimals: number): number {
  const factor = 10 ** Math.max(0, Math.floor(decimals));
  return Math.floor(value * factor + 1e-9) / factor;
}
