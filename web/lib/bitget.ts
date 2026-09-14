import {
  BitgetRestClient,
  buildTools,
  loadConfig,
  safeInvoke,
  type ToolContext,
  type ToolSpec,
} from "@bitget-ai/bitget-agent-sdk";
import { getUniverse } from "./record";

export interface TickerRow {
  symbol: string;
  name: string;
  last: number;
  changePct: number | null;
}

export interface TickerBoard {
  rows: TickerRow[];
  /** When these prices were read, in epoch milliseconds. */
  asOf: number;
  /** Set when the last read failed; the rows are then the last good read, or empty. */
  error: string | null;
}

const CACHE_MS = 30_000;

let cache: { board: TickerBoard; readAt: number } | null = null;

type Row = Record<string, unknown>;

function num(row: Row, names: string[]): number | null {
  for (const name of names) {
    const value = row[name];
    if (value === undefined || value === null || value === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Read-only and with no credentials: every call here is a public market read, and the
 * surface is built without the trade module so no code path in the site can place an order.
 */
function tickersTool(): { spec: ToolSpec; context: ToolContext } {
  const config = loadConfig({ modules: "market", readOnly: true });
  const client = new BitgetRestClient(config);
  const spec = buildTools(config).find((tool) => tool.name === "market");
  if (!spec) throw new Error("the Bitget SDK built no market tool");
  return { spec, context: { config, client } as ToolContext };
}

async function readSpotTickers(): Promise<Row[]> {
  const { spec, context } = tickersTool();
  const result = await safeInvoke(spec, { action: "tickers", category: "SPOT" }, context);
  if (!result.ok) throw new Error(`Bitget tickers failed: ${JSON.stringify(result)}`);
  if (!Array.isArray(result.data)) throw new TypeError("Bitget tickers did not return an array");
  return result.data as Row[];
}

/**
 * The 24 hour move as a percentage. Bitget spells this two ways across its live REST
 * generations, so the open price is preferred when it is there (it needs no convention)
 * and the ratio field is only used as a fallback.
 */
function changePct(row: Row, last: number): number | null {
  const open = num(row, ["openPrice24h", "open24h", "openUtc"]);
  if (open !== null && open > 0) return ((last - open) / open) * 100;
  const ratio = num(row, ["price24hPcnt", "change24h", "chgUtc"]);
  if (ratio === null) return null;
  return ratio * 100;
}

/**
 * Last price and 24 hour move for every symbol in tonight's universe, read from Bitget's
 * public tickers. Cached for 30 seconds so a room full of judges refreshing the page
 * still makes two calls a minute. A failed read keeps the last good prices and says when
 * they were read, rather than showing a number that is not from the exchange.
 */
export async function getTickerBoard(): Promise<TickerBoard> {
  const now = Date.now();
  if (cache && now - cache.readAt < CACHE_MS) return cache.board;

  try {
    const universe = await getUniverse();
    const rows = await readSpotTickers();
    const bySymbol = new Map<string, Row>();
    for (const row of rows) {
      const symbol = row["symbol"];
      if (typeof symbol === "string") bySymbol.set(symbol, row);
    }

    const board: TickerBoard = { rows: [], asOf: now, error: null };
    for (const instrument of universe) {
      const row = bySymbol.get(instrument.symbol);
      if (!row) continue;
      const last = num(row, ["lastPrice", "lastPr"]);
      if (last === null) continue;
      board.rows.push({
        symbol: instrument.symbol,
        name: instrument.name,
        last,
        changePct: changePct(row, last),
      });
    }
    cache = { board, readAt: now };
    return board;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const board: TickerBoard = {
      rows: cache?.board.rows ?? [],
      asOf: cache?.board.asOf ?? now,
      error: message,
    };
    return board;
  }
}
