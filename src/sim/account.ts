import type { Category, Fill } from "./types.js";

const QTY_EPSILON = 1e-12;
const CASH_EPSILON = 1e-9;

export interface Position {
  category: Category;
  symbol: string;
  side: "long" | "short";
  qty: number;
  avgEntry: number;
  openedTs: number;
}

export interface PaperAccount {
  id: string;
  balanceUsdt: number;
  positions: Map<string, Position>;
  realisedPnl: number;
  feesPaid: number;
}

/** The six fields the hackathon form asks for come first, then who traded and why. */
export interface LogRow {
  timestamp: string;
  instrument: string;
  direction: "buy" | "sell";
  price: number;
  quantity: number;
  balanceChange: number;
  balanceAfter: number;
  account: string;
  note: string;
}

export class AccountError extends Error {
  constructor(
    readonly code: "insufficient_balance" | "no_spot_position" | "sell_exceeds_position" | "insufficient_margin",
    message: string,
  ) {
    super(message);
    this.name = "AccountError";
  }
}

export function positionKey(category: Category, symbol: string): string {
  return `${category}:${symbol}`;
}

export function createAccount(id: string, balanceUsdt: number): PaperAccount {
  if (!Number.isFinite(balanceUsdt) || balanceUsdt < 0) {
    throw new AccountError("insufficient_balance", "a paper account starts with zero or more USDT");
  }
  return { id, balanceUsdt, positions: new Map(), realisedPnl: 0, feesPaid: 0 };
}

/**
 * Applies one fill and returns a new account, so a caller can replay a day from the
 * ledger without a stale object getting in the way. Fees count as a realised loss the
 * moment they are paid, which keeps one identity true at every step:
 * equity equals starting balance plus realised plus unrealised.
 */
export function applyFill(
  acc: PaperAccount,
  fill: Fill,
): { account: PaperAccount; row: LogRow; realisedDelta: number } {
  const positions = new Map(acc.positions);
  const key = positionKey(fill.category, fill.symbol);
  const existing = positions.get(key);

  let balance = acc.balanceUsdt;
  let realisedDelta = -fill.feeUsdt;
  let effect: string;

  if (fill.category === "SPOT") {
    if (fill.side === "buy") {
      const cost = fill.notionalUsdt + fill.feeUsdt;
      if (cost > balance + CASH_EPSILON) {
        throw new AccountError(
          "insufficient_balance",
          `${fill.symbol} buy needs ${cost.toFixed(6)} USDT and the account holds ${balance.toFixed(6)}`,
        );
      }
      balance -= cost;
      const heldQty = existing ? existing.qty : 0;
      const heldCost = existing ? existing.qty * existing.avgEntry : 0;
      const newQty = heldQty + fill.qty;
      positions.set(key, {
        category: fill.category,
        symbol: fill.symbol,
        side: "long",
        qty: newQty,
        avgEntry: (heldCost + fill.notionalUsdt) / newQty,
        openedTs: existing ? existing.openedTs : fill.ts,
      });
      effect = existing ? "add" : "open";
    } else {
      if (!existing) {
        throw new AccountError("no_spot_position", `no ${fill.symbol} to sell: a spot account cannot go short`);
      }
      if (fill.qty > existing.qty + QTY_EPSILON) {
        throw new AccountError(
          "sell_exceeds_position",
          `selling ${fill.qty} ${fill.symbol} would short the account, which holds ${existing.qty}`,
        );
      }
      balance += fill.notionalUsdt - fill.feeUsdt;
      realisedDelta += fill.qty * (fill.avgPrice - existing.avgEntry);
      const remaining = existing.qty - fill.qty;
      if (remaining <= QTY_EPSILON) {
        positions.delete(key);
        effect = "close";
      } else {
        positions.set(key, { ...existing, qty: remaining });
        effect = "reduce";
      }
    }
  } else {
    const direction = fill.side === "buy" ? 1 : -1;
    const heldSigned = existing ? (existing.side === "long" ? existing.qty : -existing.qty) : 0;
    const newSigned = heldSigned + direction * fill.qty;

    if (existing && Math.sign(heldSigned) !== direction) {
      const closedQty = Math.min(fill.qty, existing.qty);
      realisedDelta += closedQty * (fill.avgPrice - existing.avgEntry) * Math.sign(heldSigned);
    }
    balance += realisedDelta;

    if (Math.abs(newSigned) <= QTY_EPSILON) {
      positions.delete(key);
      effect = "close";
    } else if (!existing || Math.sign(newSigned) !== Math.sign(heldSigned)) {
      positions.set(key, {
        category: fill.category,
        symbol: fill.symbol,
        side: newSigned > 0 ? "long" : "short",
        qty: Math.abs(newSigned),
        avgEntry: fill.avgPrice,
        openedTs: fill.ts,
      });
      effect = existing ? "flip" : "open";
    } else if (Math.abs(newSigned) > Math.abs(heldSigned)) {
      const addedCost = Math.abs(heldSigned) * existing.avgEntry + fill.qty * fill.avgPrice;
      positions.set(key, { ...existing, qty: Math.abs(newSigned), avgEntry: addedCost / Math.abs(newSigned) });
      effect = "add";
    } else {
      positions.set(key, { ...existing, qty: Math.abs(newSigned) });
      effect = "reduce";
    }

    // Only a position that grew has to justify its margin. Cutting risk is always allowed.
    if (Math.abs(newSigned) > Math.abs(heldSigned) + QTY_EPSILON) {
      const used = usedMargin(positions);
      if (used > balance + CASH_EPSILON) {
        throw new AccountError(
          "insufficient_margin",
          `${fill.symbol} would hold ${used.toFixed(6)} USDT of position at 1x against a ${balance.toFixed(6)} USDT balance`,
        );
      }
    }
  }

  const account: PaperAccount = {
    id: acc.id,
    balanceUsdt: balance,
    positions,
    realisedPnl: acc.realisedPnl + realisedDelta,
    feesPaid: acc.feesPaid + fill.feeUsdt,
  };

  const row: LogRow = {
    timestamp: new Date(fill.ts).toISOString(),
    instrument: fill.symbol,
    direction: fill.side,
    price: fill.avgPrice,
    quantity: fill.qty,
    balanceChange: balance - acc.balanceUsdt,
    balanceAfter: balance,
    account: acc.id,
    note: describe(fill, effect),
  };

  return { account, row, realisedDelta };
}

function describe(fill: Fill, effect: string): string {
  const parts = [
    `${fill.category} ${effect}`,
    `fee ${fill.feeUsdt.toFixed(6)} USDT`,
    `slippage ${fill.slippageBps.toFixed(2)} bps`,
    `${fill.levelsConsumed} book levels`,
    `book ${fill.bookHash.slice(0, 12)}`,
  ];
  if (fill.partial) parts.push("partial");
  return parts.join(", ");
}

function usedMargin(positions: Map<string, Position>): number {
  let used = 0;
  for (const position of positions.values()) {
    if (position.category === "USDT-FUTURES") used += position.qty * position.avgEntry;
  }
  return used;
}

/**
 * Marks may be keyed by "CATEGORY:SYMBOL" or by the bare symbol. A position with no
 * mark is held at its entry price, so a missing price can never invent a profit.
 */
export function markToMarket(
  acc: PaperAccount,
  marks: Map<string, number>,
): { equity: number; unrealised: number } {
  let equity = acc.balanceUsdt;
  let unrealised = 0;

  for (const position of acc.positions.values()) {
    const mark =
      marks.get(positionKey(position.category, position.symbol)) ?? marks.get(position.symbol) ?? position.avgEntry;
    if (position.category === "SPOT") {
      equity += position.qty * mark;
      unrealised += position.qty * (mark - position.avgEntry);
    } else {
      const pnl = position.qty * (mark - position.avgEntry) * (position.side === "long" ? 1 : -1);
      equity += pnl;
      unrealised += pnl;
    }
  }

  return { equity, unrealised };
}

const CSV_HEADER = [
  "timestamp",
  "instrument",
  "direction",
  "price",
  "quantity",
  "balanceChange",
  "balanceAfter",
  "account",
  "note",
];

export function toCsvRows(rows: LogRow[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const row of rows) {
    lines.push(
      [
        quote(row.timestamp),
        quote(row.instrument),
        quote(row.direction),
        amount(row.price),
        amount(row.quantity),
        amount(row.balanceChange),
        amount(row.balanceAfter),
        quote(row.account),
        quote(row.note),
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

function amount(value: number): string {
  if (!Number.isFinite(value)) return "";
  const fixed = value.toFixed(8);
  const trimmed = fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
  return trimmed === "-0" ? "0" : trimmed;
}

function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
