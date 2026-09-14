export type Category = "SPOT" | "USDT-FUTURES";

export interface Ticker {
  symbol: string;
  category: Category;
  last: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  volume24h: number;
  ts: number;
}

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

export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
}

export type Granularity = "1m" | "5m" | "15m" | "1H" | "4H" | "1D";

export interface Instrument {
  symbol: string;
  category: Category;
  baseCoin: string;
  quoteCoin: string;
  isStock: boolean;
  minOrderUsdt: number | null;
  minOrderQty: number | null;
  pricePrecision: number;
  quantityPrecision: number;
  makerFeeRate: number | null;
  takerFeeRate: number | null;
  status: string;
}

export interface Funding {
  symbol: string;
  rate: number;
  nextTime: number;
  intervalHours: number;
}
