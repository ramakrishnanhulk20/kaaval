import type { BitgetContext } from "../bitget/client.js";
import type { AccountView, PositionView } from "../brain/types.js";
import { positionKey } from "../sim/account.js";
import type { Category } from "../sim/types.js";
import { isRTokenRow } from "./credentials.js";
import { availableUsdt, optNum, pick, readOverview, reportedEquityUsdt, type Row, type Snapshot } from "./overview.js";

/**
 * A position with the provenance of its entry price attached.
 *
 * Bitget publishes an average open price for a futures position but not for a spot
 * holding: on spot it publishes a balance, and what you paid for it is your own record.
 * A holding whose entry we do not know is carried at its current mark, which makes its
 * unrealised profit zero rather than an invented number, and entrySource says so on
 * every line so nobody reads a zero as a flat trade.
 */
export interface TenantPosition extends PositionView {
  entrySource: "record" | "mark";
}

export interface RealAccount {
  /** An AccountView in every respect, with the entry price provenance on each position. */
  view: Omit<AccountView, "positions"> & { positions: TenantPosition[] };
  balanceUsdt: number;
  raw: { assets: unknown; positions: unknown };
}

const SYMBOL_NAMES = ["symbol", "instId", "instrument"];
const SIDE_NAMES = ["posSide", "holdSide", "side"];
const QTY_NAMES = ["total", "size", "qty", "positionAmt", "available"];
const ENTRY_NAMES = ["averageOpenPrice", "openPriceAvg", "avgPrice", "averageOpenPrice", "entryPrice", "openAvgPrice"];
const MARK_NAMES = ["markPrice", "marketPrice", "indexPrice", "lastPr"];
const COIN_NAMES = ["coin", "coinName", "currency"];
/** The whole holding, not just the free part: a token resting in an open order is still owned. */
const HOLDING_NAMES = ["balance", "available", "total"];
const HOLDING_VALUE_NAMES = ["equity", "usdtEquity", "usdValue", "usdBalance"];

/**
 * One real Bitget account in the shape the brains and the rulebook already speak.
 *
 * Two kinds of holding become one list of positions. A futures position is read as
 * Bitget reports it, side and size and average open price. An rToken sitting in the
 * spot balance becomes a long SPOT position in its own pair, because that is what it
 * is to this strategy: rTSLA in the wallet is a long in RTSLAUSDT, and the rulebook's
 * hedge rule, the exposure caps and every brain already reason in those terms.
 *
 * Prices come from the quotes of the tick that is being planned, so the account and the
 * world are marked at the same instant. A holding that has no quote and no published
 * value is left out of the view rather than marked at a guess: it would otherwise enter
 * the equity number, and every exposure limit is a percentage of equity.
 *
 * drawdownPct and dayPnlPct come back zero. This function reads one instant and has no
 * memory; the caller that knows the peak and the start of the day fills them in.
 */
export async function realAccountView(
  ctx: BitgetContext,
  id: string,
  quotes: Map<string, { bid: number; ask: number }>,
): Promise<RealAccount> {
  const snapshot = await readOverview(ctx);
  const balanceUsdt = availableUsdt(snapshot);
  const positions = [...futuresPositions(snapshot, quotes), ...spotHoldings(snapshot, quotes)];

  let unrealised = 0;
  let spotValue = 0;
  for (const position of positions) {
    unrealised += position.unrealised;
    if (position.category === "SPOT") spotValue += position.notionalUsdt;
  }

  // Bitget's own equity is preferred because it is the number the trader sees in the
  // app, and a plan that argues with the exchange about the size of the account starts
  // every conversation wrong. The fallback keeps the identity the paper account holds:
  // equity is free cash plus what the spot holdings are worth plus the open profit.
  const reported = reportedEquityUsdt(snapshot);
  const equity = reported ?? balanceUsdt + spotValue + unrealised;

  return {
    balanceUsdt,
    raw: { assets: snapshot.assets, positions: snapshot.positions },
    view: {
      id,
      equity,
      balanceUsdt,
      realisedPnl: 0,
      unrealised,
      drawdownPct: 0,
      dayPnlPct: 0,
      positions,
    },
  };
}

function futuresPositions(snapshot: Snapshot, quotes: Map<string, { bid: number; ask: number }>): TenantPosition[] {
  const positions: TenantPosition[] = [];
  for (const row of snapshot.positionRows) {
    const symbol = String(pick(row, SYMBOL_NAMES) ?? "");
    const signedQty = optNum(row, QTY_NAMES);
    if (symbol === "" || signedQty === null || signedQty === 0) continue;

    // A row that says SPOT is a holding, not a futures position, and it is read as one
    // below. Bitget files the two separately and mixing them would count a holding twice.
    const category = String(pick(row, ["category"]) ?? "USDT-FUTURES") as Category;
    if (category === "SPOT") continue;
    const qty = Math.abs(signedQty);
    const declared = String(pick(row, SIDE_NAMES) ?? "").toLowerCase();
    // A one-way account reports the direction in the sign of the size rather than in a
    // side field, so the sign decides when no side is named.
    const side: "long" | "short" = declared === "short" || declared === "sell" ? "short" : declared === "long" || declared === "buy" ? "long" : signedQty < 0 ? "short" : "long";

    const quoted = markFrom(quotes, category, symbol);
    const mark = quoted ?? optNum(row, MARK_NAMES) ?? optNum(row, ENTRY_NAMES);
    if (mark === null || !(mark > 0)) continue;

    const recorded = optNum(row, ENTRY_NAMES);
    const avgEntry = recorded !== null && recorded > 0 ? recorded : mark;
    const direction = side === "long" ? 1 : -1;
    positions.push({
      category,
      symbol,
      side,
      qty,
      avgEntry,
      mark,
      notionalUsdt: qty * mark,
      unrealised: qty * (mark - avgEntry) * direction,
      entrySource: recorded !== null && recorded > 0 ? "record" : "mark",
    });
  }
  return positions;
}

function spotHoldings(snapshot: Snapshot, quotes: Map<string, { bid: number; ask: number }>): TenantPosition[] {
  const bySymbol = new Map<string, Row>();
  for (const row of snapshot.positionRows) {
    const symbol = String(pick(row, SYMBOL_NAMES) ?? "");
    if (symbol !== "") bySymbol.set(symbol, row);
  }

  const positions: TenantPosition[] = [];
  for (const row of snapshot.assetRows) {
    if (!isRTokenRow(row)) continue;
    const coin = String(pick(row, COIN_NAMES) ?? "");
    const qty = optNum(row, HOLDING_NAMES);
    if (coin === "" || qty === null || qty <= 0) continue;

    const symbol = `${coin.toUpperCase()}USDT`;
    const value = optNum(row, HOLDING_VALUE_NAMES);
    // Bitget's own valuation of the holding is the fallback mark: value divided by size
    // is the price the exchange is using, which beats dropping the position entirely.
    const mark = markFrom(quotes, "SPOT", symbol) ?? (value !== null && value > 0 ? value / qty : null);
    if (mark === null || !(mark > 0)) continue;

    const recorded = optNum(bySymbol.get(symbol) ?? {}, ENTRY_NAMES);
    const avgEntry = recorded !== null && recorded > 0 ? recorded : mark;
    positions.push({
      category: "SPOT",
      symbol,
      side: "long",
      qty,
      avgEntry,
      mark,
      notionalUsdt: qty * mark,
      unrealised: qty * (mark - avgEntry),
      entrySource: recorded !== null && recorded > 0 ? "record" : "mark",
    });
  }
  return positions;
}

function markFrom(
  quotes: Map<string, { bid: number; ask: number }>,
  category: Category,
  symbol: string,
): number | null {
  const quote = quotes.get(positionKey(category, symbol));
  if (!quote) return null;
  const mid = (quote.bid + quote.ask) / 2;
  return mid > 0 ? mid : null;
}
