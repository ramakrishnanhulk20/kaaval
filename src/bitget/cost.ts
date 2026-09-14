import type { BitgetContext } from "./client.js";
import { divergence } from "./divergence.js";
import { getFunding, getInstrument, getOrderBook } from "./market.js";
import type { BookLevel, Category } from "./types.js";

export interface CostEstimate {
  symbol: string;
  category: Category;
  side: "buy" | "sell";
  notionalUsdt: number;
  mid: number;
  avgFillPrice: number;
  impactBps: number;
  feeBps: number;
  fundingBpsPerDay: number | null;
  totalBps: number;
  fillable: boolean;
  levelsConsumed: number;
  warnings: string[];
}

/** The deepest book Bitget serves, so the estimate sees every level it can. */
const BOOK_DEPTH = 200;

/** Past a quarter of the visible book, the quote stops being a quote. */
const LIQUIDITY_WARN_SHARE = 0.25;

/** Bitget re-anchors weekend prices at the open, so a wide gap is worth saying out loud. */
const DIVERGENCE_WARN_PCT = 1;

const BPS = 10_000;

/**
 * What an order would really cost against the book that exists right now.
 *
 * The walk is over live depth, the fee comes from the instrument's own maker and taker
 * rates rather than a guessed schedule, and a perpetual adds the funding it would pay
 * over a day. Everything is reported in basis points of the order, and every reason
 * the number might mislead is in warnings rather than hidden.
 */
export async function estimateCost(
  ctx: BitgetContext,
  args: {
    category: Category;
    symbol: string;
    side: "buy" | "sell";
    notionalUsdt: number;
    taker?: boolean;
  },
): Promise<CostEstimate> {
  const { category, symbol, side } = args;
  const notionalUsdt = args.notionalUsdt;
  const taker = args.taker ?? true;
  if (!Number.isFinite(notionalUsdt) || notionalUsdt <= 0) {
    throw new RangeError(`estimateCost ${symbol}: notionalUsdt must be above zero`);
  }

  const [instrument, book] = await Promise.all([
    getInstrument(ctx, category, symbol),
    getOrderBook(ctx, category, symbol, BOOK_DEPTH),
  ]);
  const warnings: string[] = [];

  if (instrument.status !== "online") {
    warnings.push(`Bitget lists ${symbol} with status ${instrument.status}`);
  }
  if (instrument.minOrderUsdt !== null && notionalUsdt < instrument.minOrderUsdt) {
    warnings.push(
      `order of ${notionalUsdt} USDT is below the ${instrument.minOrderUsdt} USDT minimum for ${symbol}`,
    );
  }

  const bestBid = book.bids[0];
  const bestAsk = book.asks[0];
  // A top-of-book row priced at zero or below is a side with nothing on it, whatever the
  // row says. Treating it as a price would make the mid half the other side and turn every
  // number below into nonsense.
  if (!bestBid || !bestAsk || !(bestBid.price > 0) || !(bestAsk.price > 0)) {
    return {
      symbol,
      category,
      side,
      notionalUsdt,
      mid: 0,
      avgFillPrice: 0,
      impactBps: 0,
      feeBps: 0,
      fundingBpsPerDay: null,
      totalBps: 0,
      fillable: false,
      levelsConsumed: 0,
      warnings: [...warnings, "one side of the order book is empty, no price to work from"],
    };
  }

  const mid = (bestBid.price + bestAsk.price) / 2;
  const levels = side === "buy" ? book.asks : book.bids;
  const walk = walkBook(levels, notionalUsdt);
  if (!walk.fillable) {
    warnings.push(
      `the visible book holds ${walk.spent.toFixed(2)} USDT on the ${side === "buy" ? "ask" : "bid"} side, less than the ${notionalUsdt} USDT order`,
    );
  }
  const visible = levels.reduce((sum, level) => sum + level.price * level.size, 0);
  if (notionalUsdt > visible * LIQUIDITY_WARN_SHARE) {
    warnings.push(
      `order takes more than a quarter of the ${visible.toFixed(0)} USDT visible on that side`,
    );
  }

  const avgFillPrice = walk.qty > 0 ? walk.spent / walk.qty : 0;
  const impactBps =
    walk.qty > 0
      ? ((side === "buy" ? avgFillPrice - mid : mid - avgFillPrice) / mid) * BPS
      : 0;

  const feeRate = taker ? instrument.takerFeeRate : instrument.makerFeeRate;
  if (feeRate === null) {
    warnings.push(
      `Bitget publishes no ${taker ? "taker" : "maker"} fee rate for ${symbol}, fees are not in the total`,
    );
  }
  const feeBps = (feeRate ?? 0) * BPS;

  let fundingBpsPerDay: number | null = null;
  if (category === "USDT-FUTURES") {
    const funding = await getFunding(ctx, symbol);
    if (funding.intervalHours <= 0) {
      warnings.push(`funding interval for ${symbol} came back as ${funding.intervalHours} hours`);
    } else {
      const periodsPerDay = 24 / funding.intervalHours;
      const direction = side === "buy" ? 1 : -1;
      fundingBpsPerDay = funding.rate * periodsPerDay * BPS * direction;
    }
  }

  const drift = await divergence(ctx, category, symbol);
  if (Math.abs(drift.pct) > DIVERGENCE_WARN_PCT) {
    warnings.push(
      `price sits ${drift.pct.toFixed(2)} percent from the last regular close and can re-anchor at the open`,
    );
  }

  return {
    symbol,
    category,
    side,
    notionalUsdt,
    mid,
    avgFillPrice,
    impactBps,
    feeBps,
    fundingBpsPerDay,
    totalBps: impactBps + feeBps + (fundingBpsPerDay ?? 0),
    fillable: walk.fillable,
    levelsConsumed: walk.levelsConsumed,
    warnings,
  };
}

function walkBook(
  levels: BookLevel[],
  notionalUsdt: number,
): { qty: number; spent: number; levelsConsumed: number; fillable: boolean } {
  let remaining = notionalUsdt;
  let qty = 0;
  let spent = 0;
  let levelsConsumed = 0;

  for (const level of levels) {
    if (remaining <= 0) break;
    if (level.price <= 0 || level.size <= 0) continue;
    const available = level.price * level.size;
    const take = Math.min(remaining, available);
    qty += take / level.price;
    spent += take;
    remaining -= take;
    levelsConsumed += 1;
  }

  return { qty, spent, levelsConsumed, fillable: remaining <= 1e-9 };
}
