export type Category = "SPOT" | "USDT-FUTURES";

export interface BookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  symbol: string;
  category: Category;
  bids: BookLevel[];
  asks: BookLevel[];
  ts: number;
}

export interface FeeSchedule {
  makerRate: number;
  takerRate: number;
}

/**
 * The two knobs of the pessimistic fill model. maxBookFraction is the most of the
 * visible size on the side we would take that one order is allowed to claim, so a
 * paper run cannot pretend to trade liquidity that was never on screen. extraBps is
 * charged against the trader on every fill on top of walking the book, which stands
 * in for the queue, the latency and the spread we did not measure.
 */
export interface SlippageModel {
  maxBookFraction: number;
  extraBps: number;
}

export interface SimOrder {
  id: string;
  account: string;
  category: Category;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  qty: number;
  limitPrice?: number;
  reduceOnly?: boolean;
  ts: number;
  source: "brain" | "stop" | "kill" | "rebalance";
}

export interface Fill {
  orderId: string;
  account: string;
  category: Category;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  avgPrice: number;
  notionalUsdt: number;
  feeUsdt: number;
  slippageBps: number;
  levelsConsumed: number;
  partial: boolean;
  ts: number;
  bookHash: string;
}

export interface Rejection {
  rejected: true;
  orderId: string;
  reason: string;
}
