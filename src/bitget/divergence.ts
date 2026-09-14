import type { BitgetContext } from "./client.js";
import { nyseClock } from "./hours.js";
import { getCandles, getTicker } from "./market.js";
import type { Candle, Category, Ticker } from "./types.js";

export interface Divergence {
  symbol: string;
  category: Category;
  price: number;
  anchorPrice: number;
  anchorTs: number;
  pct: number;
  msToNextOpen: number;
}

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

/** Four hours back covers a thin rToken with gaps in its afternoon candles. */
const ANCHOR_LOOKBACK_MS = 4 * 60 * 60 * 1000;

/**
 * The anchor candle already found for a symbol, per context.
 *
 * The anchor is the close of one fixed quarter hour and it cannot change until the next
 * regular close, so asking for it every fifteen minutes is a request that can only return
 * the same number. Keeping it here means a tick between two closes reads one ticker per
 * symbol instead of a ticker and a candle page. It is keyed by context and holds one entry
 * per symbol, so two contexts never share an answer and the map cannot grow past the
 * universe. A restart empties it, which costs one extra candle page per symbol.
 */
const anchors = new WeakMap<BitgetContext, Map<string, { closeTs: number; candle: Candle }>>();

/**
 * How far the round-the-clock price has walked away from the last regular US close.
 *
 * The anchor is the close of the 15 minute candle that ends at 16:00 ET on the last
 * trading day, taken from Bitget's own market for this exact symbol. That matters:
 * it needs no NYSE price feed and no third-party quote, so the number is computable
 * from Bitget data alone and compares like with like. anchorTs is the start of that
 * candle, which closes fifteen minutes later at the bell. When the exact candle is
 * missing, because the symbol did not trade in that quarter hour, the newest candle
 * before the bell is used instead and anchorTs shows which one.
 *
 * A caller that has already read this symbol's ticker in this tick passes it as `known`,
 * so the drift is measured against the same price the rest of the tick is using and the
 * symbol costs one request rather than two.
 */
export async function divergence(
  ctx: BitgetContext,
  category: Category,
  symbol: string,
  now: Date = new Date(),
  known?: Ticker,
): Promise<Divergence> {
  const clock = nyseClock(now);
  const closeTs = clock.lastRegularClose;
  const [ticker, anchor] = await Promise.all([
    known ?? getTicker(ctx, category, symbol),
    anchorFor(ctx, category, symbol, closeTs),
  ]);

  return {
    symbol,
    category,
    price: ticker.last,
    anchorPrice: anchor.close,
    anchorTs: anchor.ts,
    pct: ((ticker.last - anchor.close) / anchor.close) * 100,
    msToNextOpen: clock.nextRegularOpen - now.getTime(),
  };
}

async function anchorFor(
  ctx: BitgetContext,
  category: Category,
  symbol: string,
  closeTs: number,
): Promise<Candle> {
  const key = `${category}:${symbol}`;
  let bySymbol = anchors.get(ctx);
  if (!bySymbol) {
    bySymbol = new Map<string, { closeTs: number; candle: Candle }>();
    anchors.set(ctx, bySymbol);
  }
  const held = bySymbol.get(key);
  if (held && held.closeTs === closeTs) return held.candle;

  const candles = await getCandles(ctx, category, symbol, "15m", {
    since: closeTs - ANCHOR_LOOKBACK_MS,
    until: closeTs,
  });
  const wanted = closeTs - FIFTEEN_MINUTES_MS;
  const anchor = candles.find((c) => c.ts === wanted) ?? candles.filter((c) => c.ts < closeTs).at(-1);
  if (!anchor) {
    throw new Error(
      `divergence ${symbol}: no 15m candle in the four hours before the ${new Date(closeTs).toISOString()} close`,
    );
  }
  if (anchor.close <= 0) {
    throw new Error(`divergence ${symbol}: anchor candle closed at ${anchor.close}`);
  }

  bySymbol.set(key, { closeTs, candle: anchor });
  return anchor;
}
