import { fakeBitget, fixtureData, type FakeBitget } from "../bitget/fake.js";

/**
 * A Bitget stand-in for the engine tests, one step up from test/bitget/fake.ts: it
 * answers every market action the engine touches in a tick, from a description of a
 * market rather than from a handler per test. Instrument rows come from the recorded
 * fixtures, so precision, minimums and status are Bitget's own.
 *
 * Candles are generated rather than recorded because the only thing the engine asks a
 * candle is whether the symbol traded in a window, and a recorded weekend would pin the
 * tests to a date.
 */

export interface FakeQuote {
  last: number;
  bid: number;
  ask: number;
  baseVolume?: number;
  usdtVolume?: number;
}

export interface FakeBook {
  asks: Array<[number, number]>;
  bids: Array<[number, number]>;
  ts?: number;
}

export interface FakeMarketSpec {
  instruments?: { SPOT?: Array<Record<string, unknown>>; "USDT-FUTURES"?: Array<Record<string, unknown>> };
  quotes?: Record<string, FakeQuote>;
  books?: Record<string, FakeBook>;
  /** Symbols whose candles carry volume in the weekend window. Everything else is flat. */
  tradedOverWeekend?: string[];
  funding?: Record<string, number>;
  /** Close of every generated candle, so divergence is a known number. */
  candleClose?: number;
}

export const spotInstrumentRows = fixtureData<Array<Record<string, unknown>>>("inst-SPOT.json");
export const futuresInstrumentRows = fixtureData<Array<Record<string, unknown>>>("inst-USDT-FUTURES.json");

const HOUR_MS = 3_600_000;

export function fakeMarket(spec: FakeMarketSpec = {}): FakeBitget {
  const instruments = {
    SPOT: spec.instruments?.SPOT ?? spotInstrumentRows,
    "USDT-FUTURES": spec.instruments?.["USDT-FUTURES"] ?? futuresInstrumentRows,
  };
  const quotes = spec.quotes ?? {};
  const books = spec.books ?? {};
  const traded = new Set(spec.tradedOverWeekend ?? []);
  const funding = spec.funding ?? {};
  const candleClose = spec.candleClose ?? 100;

  const tickerRow = (symbol: string): Record<string, unknown> => {
    const quote = quotes[symbol];
    if (!quote) throw new Error(`fake market has no quote for ${symbol}`);
    const baseVolume = quote.baseVolume ?? 1_000;
    return {
      symbol,
      lastPr: String(quote.last),
      bidPr: String(quote.bid),
      askPr: String(quote.ask),
      bidSz: "10",
      askSz: "10",
      baseVolume: String(baseVolume),
      quoteVolume: String(quote.usdtVolume ?? baseVolume * quote.last),
      usdtVolume: String(quote.usdtVolume ?? baseVolume * quote.last),
      ts: "1789099200000",
    };
  };

  return fakeBitget({
    instruments: (args) => {
      const category = String(args["category"]) as keyof typeof instruments;
      const rows = instruments[category] ?? [];
      const symbol = args["symbol"];
      return symbol === undefined ? rows : rows.filter((r) => r["symbol"] === symbol);
    },
    tickers: (args) => {
      const symbol = args["symbol"];
      if (typeof symbol === "string") return [tickerRow(symbol)];
      const category = String(args["category"]);
      const known = new Set(
        (instruments[category as keyof typeof instruments] ?? []).map((r) => String(r["symbol"])),
      );
      return Object.keys(quotes)
        .filter((s) => known.has(s))
        .map(tickerRow);
    },
    orderbook: (args) => {
      const symbol = String(args["symbol"]);
      const book = books[symbol];
      if (!book) throw new Error(`fake market has no book for ${symbol}`);
      return { a: book.asks, b: book.bids, ts: String(book.ts ?? 1_789_099_200_000) };
    },
    candlesHistory: (args) => {
      const symbol = String(args["symbol"]);
      const step = String(args["interval"]) === "1H" ? HOUR_MS : 15 * 60_000;
      const endTime = Number(args["endTime"]);
      const volume = traded.has(symbol) ? 250 : 0;
      return Array.from({ length: 100 }, (_, i) => {
        const ts = endTime - (i + 1) * step;
        return [
          String(ts),
          String(candleClose),
          String(candleClose),
          String(candleClose),
          String(candleClose),
          String(volume),
          String(volume * candleClose),
        ];
      });
    },
    fundingRate: (args) => [
      {
        symbol: String(args["symbol"]),
        fundingRate: String(funding[String(args["symbol"])] ?? 0),
        nextUpdate: "1789120000000",
        fundingRateInterval: "8",
      },
    ],
  });
}

/** A book two levels deep either side of a price, enough to fill a small order. */
export function bookAround(price: number, size = 50): FakeBook {
  return {
    asks: [
      [round2(price * 1.0005), size],
      [round2(price * 1.001), size * 2],
    ],
    bids: [
      [round2(price * 0.9995), size],
      [round2(price * 0.999), size * 2],
    ],
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface FakeDesk {
  config: unknown;
  client: unknown;
  tools: Map<string, unknown>;
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
}

/**
 * A stand-in for the SDK's order tool. The real one answers a dryRun from its own safety
 * layer before it touches the network, so the fake does the same and a test can also make
 * it refuse, which is the path where Kaaval builds the request itself.
 */
export function fakeOrderDesk(handler: (args: Record<string, unknown>) => unknown): FakeDesk {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const spec = {
    name: "order",
    method: "POST",
    path: "(composite)",
    handler: async (args: Record<string, unknown>) => {
      calls.push({ tool: "order", args });
      return { endpoint: "(composite) order", requestTime: "0", data: handler(args) };
    },
  };
  return { config: {}, client: {}, tools: new Map<string, unknown>([["order", spec]]), calls };
}

/** What the SDK returns for a dry run: its own rendering of the request it would send. */
export function previewOf(args: Record<string, unknown>): Record<string, unknown> {
  const { dryRun: _dryRun, action: _action, ...rest } = args;
  return {
    dryRun: true,
    operationId: "placeOrder",
    method: "POST",
    path: "/api/v3/trade/place-order",
    riskLevel: "write",
    wouldSend: rest,
  };
}
