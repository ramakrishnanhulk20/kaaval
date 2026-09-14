import type { Category } from "../bitget/types.js";
import type { PositionView } from "../brain/types.js";
import { positionKey } from "../sim/account.js";
import type { Rulebook } from "./rulebook.js";

export interface StopOrder {
  category: Category;
  symbol: string;
  side: "buy" | "sell";
  triggerPrice: number;
  qty: number;
  positionSide: "long" | "short";
  createdTs: number;
}

/**
 * The stop that goes with a position the moment it opens.
 *
 * The distance is measured from the entry price, not from the best price since, so the
 * stop never moves on its own and the loss it caps is the one the rulebook promises.
 * rTokens get the wider stop because their book is thinner and a two percent stop would
 * be hit by the spread alone on a quiet night.
 */
export function stopFor(position: PositionView, rb: Rulebook, now: number = Date.now()): StopOrder {
  const pct = position.category === "SPOT" ? rb.loss.stopPctRToken : rb.loss.stopPctPerp;
  const away = position.avgEntry * (pct / 100);

  return {
    category: position.category,
    symbol: position.symbol,
    side: position.side === "long" ? "sell" : "buy",
    triggerPrice: position.side === "long" ? position.avgEntry - away : position.avgEntry + away,
    qty: position.qty,
    positionSide: position.side,
    createdTs: now,
  };
}

/**
 * Which stops the recorded book has already passed through.
 *
 * A long is measured against the bid and a short against the ask, the price each one
 * would actually get out at, so a stop can never be counted as hit at a price nobody
 * was offering. A stop with no quote this tick is left alone: a missing price is a gap
 * in our data, not a move in the market.
 */
export function triggeredStops(
  stops: StopOrder[],
  quotes: Map<string, { bid: number; ask: number }>,
): StopOrder[] {
  const hit: StopOrder[] = [];
  for (const stop of stops) {
    const quote = quotes.get(positionKey(stop.category, stop.symbol));
    if (!quote) continue;
    if (stop.positionSide === "long" ? quote.bid <= stop.triggerPrice : quote.ask >= stop.triggerPrice) {
      hit.push(stop);
    }
  }
  return hit;
}

/**
 * The same stop written as the Agent Hub call that would place it on Bitget's servers.
 *
 * Parameter names and types come from operation placeStrategyOrder in the SDK catalog,
 * reference/agent-hub/agent-sdk/src/generated/catalog.ts line 124: category, symbol and
 * posSide are required, qty is required for tpslMode partial, and every value is a
 * string. That catalog entry lists only the futures categories, so a spot rToken stop
 * has no server-side home today: it runs in our simulator and this request is recorded
 * beside it so the record shows the exact order Bitget would have received.
 */
export function stopDryRunRequest(stop: StopOrder): Record<string, unknown> {
  return {
    category: stop.category,
    symbol: stop.symbol,
    type: "tpsl",
    tpslMode: "partial",
    qty: formatAmount(stop.qty),
    posSide: stop.positionSide,
    slTriggerBy: "market",
    stopLoss: formatAmount(stop.triggerPrice),
    slOrderType: "market",
    clientOid: `kaaval-stop-${stop.symbol.toLowerCase()}-${stop.createdTs}`,
  };
}

/**
 * A quantity or a price as Bitget's v3 API wants it: a plain decimal string, eight places
 * at most, no exponent and no trailing zeros.
 *
 * A number that is not finite comes back as "0" rather than "NaN" or "Infinity". Bitget
 * refuses a zero size, which is the honest outcome: an order whose size we could not
 * compute must not reach the exchange wearing a number that looks real. Negative zero
 * comes back as "0" too, because "-0" reads as a short of nothing.
 *
 * sim/account.ts keeps its own copy of this for the CSV export, which is a different
 * contract: that one is a file format for a judge, this one is Bitget's wire format.
 */
export function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const fixed = value.toFixed(8);
  const trimmed = fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
  return trimmed === "-0" ? "0" : trimmed;
}
