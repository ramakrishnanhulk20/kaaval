import { bookHash, sortedLevels } from "./book.js";
import type { BookLevel, Fill, FeeSchedule, OrderBook, Rejection, SimOrder, SlippageModel } from "./types.js";

const BPS = 10_000;
const QTY_EPSILON = 1e-12;

/**
 * What this model assumes, so nobody has to guess when reading the record:
 * a market order walks the recorded book level by level and pays the taker rate;
 * a limit order that crosses the spread does the same but stops at its price;
 * a limit order that does not cross is treated as resting and filled at its own
 * price for the maker rate, which is the one optimistic assumption here, and
 * maxBookFraction is what keeps that assumption small. Every fill also gives up
 * extraBps against the trader, and no order may take more than maxBookFraction of
 * the size visible on the side it would hit.
 */
export function fillAgainstBook(
  order: SimOrder,
  book: OrderBook,
  fees: FeeSchedule,
  model: SlippageModel,
): Fill | Rejection {
  const reject = (reason: string): Rejection => ({ rejected: true, orderId: order.id, reason });

  if (!Number.isFinite(order.qty) || order.qty <= 0) {
    return reject("quantity must be a positive number");
  }
  if (order.symbol !== book.symbol || order.category !== book.category) {
    return reject(`book is ${book.category} ${book.symbol}, order is ${order.category} ${order.symbol}`);
  }
  if (!Number.isFinite(model.maxBookFraction) || model.maxBookFraction <= 0 || model.maxBookFraction > 1) {
    return reject("maxBookFraction must be greater than 0 and at most 1");
  }
  if (!Number.isFinite(model.extraBps) || model.extraBps < 0) {
    return reject("extraBps must be zero or more");
  }
  if (!Number.isFinite(fees.makerRate) || !Number.isFinite(fees.takerRate) || fees.makerRate < 0 || fees.takerRate < 0) {
    return reject("fee rates must be zero or more");
  }

  const isBuy = order.side === "buy";
  const levels = tradable(isBuy ? sortedLevels(book.asks, "asks") : sortedLevels(book.bids, "bids"));
  if (levels.length === 0) {
    return reject(`no liquidity on the ${isBuy ? "ask" : "bid"} side of the recorded book`);
  }

  const visible = levels.reduce((sum, level) => sum + level.size, 0);
  const cap = visible * model.maxBookFraction;
  if (order.qty > cap + QTY_EPSILON) {
    return reject(
      `order of ${order.qty} is more than ${model.maxBookFraction * 100} percent of the ${visible} visible on that side`,
    );
  }

  const best = levels[0]!.price;
  let limitPrice: number | undefined;
  if (order.type === "limit") {
    limitPrice = order.limitPrice;
    if (limitPrice === undefined || !Number.isFinite(limitPrice) || limitPrice <= 0) {
      return reject("a limit order needs a positive limit price");
    }
  }

  const crosses = limitPrice === undefined || (isBuy ? limitPrice >= best : limitPrice <= best);

  if (!crosses) {
    const rawAvg = limitPrice!;
    return settle(order, book, fees.makerRate, model, order.qty, rawAvg, rawAvg, 0, false);
  }

  let remaining = order.qty;
  let cost = 0;
  let levelsConsumed = 0;
  for (const level of levels) {
    if (limitPrice !== undefined && (isBuy ? level.price > limitPrice : level.price < limitPrice)) break;
    const take = Math.min(remaining, level.size);
    cost += take * level.price;
    remaining -= take;
    levelsConsumed += 1;
    if (remaining <= QTY_EPSILON) {
      remaining = 0;
      break;
    }
  }

  const filled = order.qty - remaining;
  if (filled <= QTY_EPSILON) {
    return reject("no level on the book was at or better than the limit price");
  }

  const rawAvg = cost / filled;
  return settle(order, book, fees.takerRate, model, filled, rawAvg, best, levelsConsumed, remaining > QTY_EPSILON);
}

function tradable(levels: BookLevel[]): BookLevel[] {
  return levels.filter(
    (level) => Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.size) && level.size > 0,
  );
}

function settle(
  order: SimOrder,
  book: OrderBook,
  rate: number,
  model: SlippageModel,
  filled: number,
  rawAvg: number,
  reference: number,
  levelsConsumed: number,
  partial: boolean,
): Fill {
  const isBuy = order.side === "buy";
  const avgPrice = isBuy ? rawAvg * (1 + model.extraBps / BPS) : rawAvg * (1 - model.extraBps / BPS);
  const notionalUsdt = filled * avgPrice;
  const slippageBps = ((isBuy ? avgPrice - reference : reference - avgPrice) / reference) * BPS;

  return {
    orderId: order.id,
    account: order.account,
    category: order.category,
    symbol: order.symbol,
    side: order.side,
    qty: filled,
    avgPrice,
    notionalUsdt,
    feeUsdt: notionalUsdt * rate,
    slippageBps,
    levelsConsumed,
    partial,
    // The later of the two stamps: the order cannot fill before it was sent, and it
    // cannot fill against a book that had not been recorded yet.
    ts: Math.max(order.ts, book.ts),
    bookHash: bookHash(book),
  };
}
