import { invoke, type BitgetContext } from "../bitget/client.js";

/**
 * One read of a trader's account, and the small amount of parsing both the connection
 * check and the account view need.
 *
 * The verb is account_overview, which the SDK documents as a one-call snapshot that
 * fans out to assets, settings, funding assets and, when a category is given, the
 * positions for that category. Its parameter names come from
 * vidiyal/docs/dev/account-schemas.md, which was generated from the SDK itself: the
 * verb takes coin, category, symbol and view, and it has no action parameter.
 *
 * Each section reports ok or an error independently, so a snapshot can come back with
 * assets present and positions missing. Nothing here treats a failed section as an
 * empty one: the failure is carried in failures and the caller decides.
 */

export type Row = Record<string, unknown>;

export interface Snapshot {
  raw: unknown;
  assets: unknown;
  positions: unknown;
  assetRows: Row[];
  positionRows: Row[];
  settings: Row | null;
  failures: Array<{ section: string; message: string }>;
}

/**
 * The names Bitget uses for the same number across its two REST generations and across
 * the UTA sections. The schema doc pins every request parameter but carries no response
 * bodies, so each list starts with the v3 UTA name and keeps the older ones after it.
 * A name that is not found is a null, never a zero: a zero equity is a real number and
 * must not stand in for a field we could not read.
 */
const ACCOUNT_EQUITY_NAMES = ["totalEquity", "accountEquity", "usdtEquity", "equity"];
const COIN_NAMES = ["coin", "coinName", "currency"];
const COIN_AVAILABLE_NAMES = ["available", "availableBalance", "balance", "free"];
const UID_NAMES = ["userId", "uid", "accountId", "userID"];

export async function readOverview(
  ctx: BitgetContext,
  opts: { category?: string } = {},
): Promise<Snapshot> {
  const category = opts.category ?? "USDT-FUTURES";
  const raw = await invoke(ctx, "account_overview", { category, view: "full" });

  const assets = sectionData(raw, "assets");
  const positions = sectionData(raw, "positions");
  const settings = sectionData(raw, "settings");

  return {
    raw,
    assets: assets.data,
    positions: positions.data,
    assetRows: rowsOf(assets.data),
    positionRows: rowsOf(positions.data),
    settings: firstRow(settings.data),
    failures: [...assets.failures, ...positions.failures, ...settings.failures],
  };
}

/**
 * The equity Bitget itself reports for the account, or null when no section carries it.
 *
 * Only account level objects are read. The USDT row's own equity is deliberately not a
 * fallback: on an account holding tokenized stocks it is a fraction of the account, and
 * a number that is quietly too small would loosen every limit that is a percentage of
 * equity. A caller that gets null works the total out from the holdings instead.
 */
export function reportedEquityUsdt(snapshot: Snapshot): number | null {
  for (const candidate of [snapshot.assets, snapshot.settings, snapshot.raw]) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const value = optNum(candidate as Row, ACCOUNT_EQUITY_NAMES);
      if (value !== null) return value;
    }
  }
  return null;
}

/** Free USDT the account can spend, which is the paper account's balance for a plan. */
export function availableUsdt(snapshot: Snapshot): number {
  const usdt = usdtRow(snapshot);
  return usdt ? (optNum(usdt, COIN_AVAILABLE_NAMES) ?? 0) : 0;
}

export function accountUid(snapshot: Snapshot): string | null {
  for (const candidate of [snapshot.settings, snapshot.raw]) {
    if (candidate && typeof candidate === "object") {
      const value = pick(candidate as Row, UID_NAMES);
      if (value !== undefined) return String(value);
    }
  }
  return null;
}

export function usdtRow(snapshot: Snapshot): Row | null {
  for (const row of snapshot.assetRows) {
    if (String(pick(row, COIN_NAMES) ?? "").toUpperCase() === "USDT") return row;
  }
  return null;
}

export function pick(row: Row, names: string[]): unknown {
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

export function optNum(row: Row, names: string[]): number | null {
  const value = pick(row, names);
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A section as the composite returns it: { ok: true, data } or { ok: false, error }. */
function sectionData(raw: unknown, key: string): { data: unknown; failures: Array<{ section: string; message: string }> } {
  if (!raw || typeof raw !== "object") return { data: null, failures: [{ section: key, message: "the snapshot came back empty" }] };
  const section = (raw as Row)[key];
  if (section === undefined) return { data: null, failures: [] };
  if (section && typeof section === "object" && "ok" in (section as Row)) {
    const holder = section as { ok: unknown; data?: unknown; error?: unknown };
    if (holder.ok === true) return { data: holder.data ?? null, failures: [] };
    return { data: null, failures: [{ section: key, message: String(holder.error ?? "no reason given") }] };
  }
  return { data: section, failures: [] };
}

/** Bitget answers a list under several different field names, or as a bare array. */
export function rowsOf(data: unknown): Row[] {
  if (Array.isArray(data)) return data as Row[];
  if (data && typeof data === "object") {
    for (const key of ["list", "assets", "positions", "rows", "items", "data"]) {
      const value = (data as Row)[key];
      if (Array.isArray(value)) return value as Row[];
    }
  }
  return [];
}

function firstRow(data: unknown): Row | null {
  if (Array.isArray(data)) return (data[0] as Row | undefined) ?? null;
  if (data && typeof data === "object") return data as Row;
  return null;
}
