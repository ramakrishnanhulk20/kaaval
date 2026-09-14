import { invoke, type BitgetContext } from "./client.js";
import type {
  BookLevel,
  Candle,
  Category,
  Funding,
  Granularity,
  Instrument,
  OrderBook,
  Ticker,
} from "./types.js";

/**
 * The v3 UTA API takes the same interval strings for SPOT and USDT-FUTURES: see the
 * interval enum in docs/dev/market-schemas.md under "market action: candles". The
 * older v2 endpoints used a different spelling per category (15min, 1day), so this
 * table is the one place to change if we ever fall back to v2 for a symbol.
 */
const INTERVAL: Record<Granularity, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1H": "1H",
  "4H": "4H",
  "1D": "1D",
};

/** history-candles rejects limit above 100 with "Parameter limit error", tested live. */
const HISTORY_PAGE_LIMIT = 100;

/** A stuck endTime would page forever, so the walk stops after 20,000 candles. */
const MAX_HISTORY_PAGES = 200;

/** orderbook caps at 200 levels a side (docs/dev/market-schemas.md, action orderbook). */
const MAX_BOOK_DEPTH = 200;

type Row = Record<string, unknown>;

function asRows(payload: unknown, tool: string): Row[] {
  if (!Array.isArray(payload)) {
    throw new TypeError(`${tool}: expected an array, got ${typeof payload}`);
  }
  return payload as Row[];
}

function pick(row: Row, names: string[]): unknown {
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
}

function num(row: Row, names: string[], context: string): number {
  const value = pick(row, names);
  if (value === undefined) {
    throw new TypeError(`${context}: none of ${names.join(", ")} present`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`${context}: ${String(value)} is not a number`);
  }
  return parsed;
}

function optNum(row: Row, names: string[]): number | null {
  const value = pick(row, names);
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function str(row: Row, names: string[], context: string): string {
  const value = pick(row, names);
  if (typeof value !== "string") {
    throw new TypeError(`${context}: none of ${names.join(", ")} is a string`);
  }
  return value;
}

/**
 * Every field lookup below names the v3 UTA field first and the v2 field second.
 * Bitget's two live REST generations spell the same value differently (lastPrice
 * against lastPr, a against asks) and the recorded responses in test/fixtures are
 * from the v2 era, so both spellings are read and a missing value throws.
 */
export async function getTicker(
  ctx: BitgetContext,
  category: Category,
  symbol: string,
): Promise<Ticker> {
  const rows = asRows(
    await invoke(ctx, "market", { action: "tickers", category, symbol }),
    "tickers",
  );
  const row = rows.find((r) => r["symbol"] === symbol) ?? rows[0];
  if (!row) {
    throw new Error(`tickers: Bitget returned no row for ${category} ${symbol}`);
  }
  const where = `ticker ${symbol}`;
  return {
    symbol,
    category,
    last: num(row, ["lastPrice", "lastPr"], where),
    bid: num(row, ["bid1Price", "bidPr"], where),
    ask: num(row, ["ask1Price", "askPr"], where),
    bidSize: num(row, ["bid1Size", "bidSz"], where),
    askSize: num(row, ["ask1Size", "askSz"], where),
    volume24h: num(row, ["volume24h", "baseVolume"], where),
    ts: num(row, ["ts"], where),
  };
}

export async function getOrderBook(
  ctx: BitgetContext,
  category: Category,
  symbol: string,
  depth = 50,
): Promise<OrderBook> {
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_BOOK_DEPTH) {
    throw new RangeError(`orderbook depth must be 1 to ${MAX_BOOK_DEPTH}, got ${depth}`);
  }
  const payload = (await invoke(ctx, "market", {
    action: "orderbook",
    category,
    symbol,
    limit: String(depth),
  })) as Row;
  const asks = levels(payload["a"] ?? payload["asks"], `book ${symbol} asks`);
  const bids = levels(payload["b"] ?? payload["bids"], `book ${symbol} bids`);
  asks.sort((x, y) => x.price - y.price);
  bids.sort((x, y) => y.price - x.price);
  return { symbol, category, bids, asks, ts: num(payload, ["ts"], `book ${symbol}`) };
}

function levels(raw: unknown, context: string): BookLevel[] {
  if (!Array.isArray(raw)) {
    throw new TypeError(`${context}: expected an array of levels`);
  }
  return raw.map((entry) => {
    if (!Array.isArray(entry) || entry.length < 2) {
      throw new TypeError(`${context}: level is not a price and size pair`);
    }
    const price = Number(entry[0]);
    const size = Number(entry[1]);
    if (!Number.isFinite(price) || !Number.isFinite(size)) {
      throw new TypeError(`${context}: level holds a value that is not a number`);
    }
    return { price, size };
  });
}

export function parseCandle(entry: unknown): Candle {
  if (!Array.isArray(entry) || entry.length < 7) {
    throw new TypeError("candle: expected ts, open, high, low, close, volume, quoteVolume");
  }
  const values = entry.slice(0, 7).map(Number);
  if (values.some((v) => !Number.isFinite(v))) {
    throw new TypeError(`candle: a field is not a number in ${JSON.stringify(entry)}`);
  }
  return {
    ts: values[0] as number,
    open: values[1] as number,
    high: values[2] as number,
    low: values[3] as number,
    close: values[4] as number,
    volume: values[5] as number,
    quoteVolume: values[6] as number,
  };
}

/**
 * Candles covering since to until, oldest first, no duplicates.
 *
 * Bitget serves at most 100 rows per history call, so this walks backwards with the
 * endTime parameter until the window is covered or a page comes back empty. Rows are
 * keyed by their timestamp, so overlapping pages cannot produce a duplicate candle.
 * history-candles trails the live tape by roughly half an hour, so read the ticker,
 * not the newest candle, when the current price matters.
 */
export async function getCandles(
  ctx: BitgetContext,
  category: Category,
  symbol: string,
  granularity: Granularity,
  range: { since: number; until?: number },
): Promise<Candle[]> {
  const until = range.until ?? Date.now();
  if (!Number.isFinite(range.since) || !Number.isFinite(until)) {
    throw new RangeError(`candles ${symbol}: since and until must be timestamps in ms`);
  }
  if (range.since >= until) {
    throw new RangeError(`candles ${symbol}: since ${range.since} is not before until ${until}`);
  }
  const interval = INTERVAL[granularity];
  const collected = new Map<number, Candle>();
  let endTime = until;

  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    const rows = asRows(
      await invoke(ctx, "market", {
        action: "candlesHistory",
        category,
        symbol,
        interval,
        limit: String(HISTORY_PAGE_LIMIT),
        endTime: String(Math.floor(endTime)),
      }),
      `candles ${symbol}`,
    );
    if (rows.length === 0) break;

    let oldest = Number.POSITIVE_INFINITY;
    for (const row of rows) {
      const candle = parseCandle(row);
      if (candle.ts < oldest) oldest = candle.ts;
      if (candle.ts >= range.since && candle.ts <= until) {
        collected.set(candle.ts, candle);
      }
    }
    if (oldest <= range.since) break;
    if (oldest >= endTime) break;
    endTime = oldest;
  }

  return [...collected.values()].sort((a, b) => a.ts - b.ts);
}

function parseInstrument(row: Row, category: Category): Instrument {
  const symbol = str(row, ["symbol"], "instrument");
  const where = `instrument ${symbol}`;
  return {
    symbol,
    category,
    baseCoin: str(row, ["baseCoin"], where),
    quoteCoin: str(row, ["quoteCoin"], where),
    isStock: row["symbolType"] === "stock",
    minOrderUsdt: optNum(row, ["minOrderAmount", "minTradeUSDT"]),
    minOrderQty: optNum(row, ["minOrderQty", "minTradeAmount"]),
    pricePrecision: num(row, ["pricePrecision"], where),
    quantityPrecision: num(row, ["quantityPrecision"], where),
    makerFeeRate: optNum(row, ["makerFeeRate"]),
    takerFeeRate: optNum(row, ["takerFeeRate"]),
    status: str(row, ["status"], where),
  };
}

export async function listInstruments(
  ctx: BitgetContext,
  category: Category,
): Promise<Instrument[]> {
  const rows = asRows(
    await invoke(ctx, "market", { action: "instruments", category }),
    "instruments",
  );
  return rows.map((row) => parseInstrument(row, category));
}

/** One instrument, so a caller that needs fees or precision does not pull 1,300 rows. */
export async function getInstrument(
  ctx: BitgetContext,
  category: Category,
  symbol: string,
): Promise<Instrument> {
  const rows = asRows(
    await invoke(ctx, "market", { action: "instruments", category, symbol }),
    "instruments",
  );
  const row = rows.find((r) => r["symbol"] === symbol);
  if (!row) {
    throw new Error(`instruments: ${category} has no instrument ${symbol}`);
  }
  return parseInstrument(row, category);
}

export function isRToken(instrument: Instrument): boolean {
  return instrument.isStock && instrument.baseCoin.startsWith("r");
}

/**
 * The two stock families Kaaval reads: rToken spot pairs and stock perpetuals.
 *
 * Bitget flags more SPOT instruments as stock than there are rTokens. The extras are
 * pre-listing tokens such as preSPCX whose base coin has no rToken "r" prefix, so the
 * prefix does the filtering rather than symbolType on its own.
 */
export async function listStockInstruments(
  ctx: BitgetContext,
): Promise<{ rTokens: Instrument[]; perps: Instrument[] }> {
  const [spot, futures] = await Promise.all([
    listInstruments(ctx, "SPOT"),
    listInstruments(ctx, "USDT-FUTURES"),
  ]);
  return {
    rTokens: spot.filter(isRToken),
    perps: futures.filter((i) => i.isStock),
  };
}

export async function getFunding(ctx: BitgetContext, symbol: string): Promise<Funding> {
  const rows = asRows(
    await invoke(ctx, "market", { action: "fundingRate", symbol }),
    "fundingRate",
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`fundingRate: Bitget returned no row for ${symbol}`);
  }
  const where = `funding ${symbol}`;
  return {
    symbol,
    rate: num(row, ["fundingRate"], where),
    nextTime: num(row, ["nextUpdate", "nextFundingTime"], where),
    intervalHours: num(row, ["fundingRateInterval", "fundInterval"], where),
  };
}

export async function getFundingHistory(
  ctx: BitgetContext,
  symbol: string,
  since: number,
): Promise<Array<{ ts: number; rate: number }>> {
  const payload = (await invoke(ctx, "market", {
    action: "fundingRateHistory",
    category: "USDT-FUTURES",
    symbol,
    // Bitget refuses a funding-history page above 100 with "Parameter limit error", seen live on 11 September 2026.
    limit: "100",
  })) as Row;
  const rows = asRows(payload["resultList"] ?? payload, "fundingRateHistory");
  const where = `funding history ${symbol}`;
  return rows
    .map((row) => ({
      ts: num(row, ["fundingRateTimestamp", "fundingTime", "ts"], where),
      rate: num(row, ["fundingRate"], where),
    }))
    .filter((entry) => entry.ts >= since)
    .sort((a, b) => a.ts - b.ts);
}

export async function getOpenInterest(
  ctx: BitgetContext,
  symbol: string,
): Promise<{ symbol: string; amount: number; ts: number }> {
  const payload = (await invoke(ctx, "market", {
    action: "openInterest",
    category: "USDT-FUTURES",
    symbol,
  })) as Row;
  const rows = asRows(payload["list"] ?? payload, "openInterest");
  const row = rows.find((r) => r["symbol"] === symbol) ?? rows[0];
  if (!row) {
    throw new Error(`openInterest: Bitget returned no row for ${symbol}`);
  }
  return {
    symbol,
    amount: num(row, ["openInterest", "amount"], `open interest ${symbol}`),
    ts: optNum(payload, ["ts"]) ?? optNum(row, ["ts"]) ?? Date.now(),
  };
}
