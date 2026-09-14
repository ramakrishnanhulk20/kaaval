import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BitgetRestClient,
  buildTools,
  loadConfig,
  safeInvoke,
  type ToolContext,
  type ToolSpec,
} from "@bitget-ai/bitget-agent-sdk";
import { getTickerBoard } from "./bitget";
import { getStoredProof } from "./proof";
import { dataDir, getUniverse } from "./record";
import { loadRecord, recordUrl } from "./record-http";
import {
  parseEntries,
  parseJson,
  readRecord,
  type LedgerEntry,
  type RecordData,
} from "./record-parse";

/**
 * The readers behind the story page, one per beat.
 *
 * Nothing here invents a number. Each reader answers from the signed ledger, from the plan
 * file the engine writes, or from a public Bitget read at request time, and says null when
 * the thing it wants is not measurable right now. Both record modes work: with
 * KAAVAL_RECORD_URL set the ledger comes over HTTPS, and the readers that need a file the
 * publisher does not carry, the news cache and the plan, answer null instead of guessing.
 */

/** Bitget's own words about weekend rToken prices, quoted on beat two. */
export const BITGET_WEEKEND_WORDS =
  "Weekend prices are reference quotes and are not real-time matched prices from the " +
  "NYSE/NASDAQ. When the regular market opens on Monday, token prices will re-anchor to " +
  "the real-time prices of the underlying stocks.";

export const BITGET_WEEKEND_SOURCE = "Bitget Academy";

/** The sister site. Local until Vidiyal has a public address. */
export function vidiyalUrl(): string {
  const configured = process.env.VIDIYAL_URL;
  return configured === undefined || configured.trim() === ""
    ? "http://localhost:3001"
    : configured.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/* The record, read whole, with the chain fields kept. */

/** An entry as it sits in the file: the hashes the typed reader drops. */
export interface SignedEntry {
  seq: number;
  ts: number;
  kind: string;
  account: string;
  hash: string | null;
  prevHash: string | null;
  signed: boolean;
}

function fileText(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function diskRecord(): RecordData {
  const dir = join(dataDir(), "ledger");
  const names = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".jsonl"))
        .sort()
    : [];
  const entries: LedgerEntry[] = [];
  for (const name of names) entries.push(...parseEntries(fileText(join(dir, name)) ?? ""));

  return {
    entries,
    days: names.map((name) => name.replace(/\.jsonl$/, "")),
    engine: parseJson(fileText(join(dataDir(), "engine.json"))),
    universe: parseJson(fileText(join(dataDir(), "universe.json"))),
  };
}

/**
 * One whole read of the record. lib/record.ts keeps its own copy of this private, and the
 * story needs the raw entries with their hashes on them, which the typed reader drops.
 */
async function wholeRecord(): Promise<RecordData> {
  if (recordUrl() !== null) return loadRecord();
  return diskRecord();
}

function signedEntry(entry: LedgerEntry): SignedEntry {
  const raw = entry as unknown as Record<string, unknown>;
  return {
    seq: entry.seq,
    ts: entry.ts,
    kind: entry.kind,
    account: entry.account,
    hash: stringOf(raw["hash"]),
    prevHash: stringOf(raw["prevHash"]),
    signed: typeof raw["sig"] === "string" && raw["sig"] !== "",
  };
}

/* The New York clock. The engine's own version is src/bitget/hours.ts; the site cannot
   import from src, so the same rules are written again here. Daylight saving comes from
   Intl, never from a hand-written rule. */

const ET_ZONE = "America/New_York";
const OPEN_HOUR = 9;
const OPEN_MINUTE = 30;
const CLOSE_HOUR = 16;

/** NYSE full day closures, from the exchange's own calendar. Early closes are not here. */
const HOLIDAYS = new Set<string>([
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03",
  "2026-09-07",
  "2026-11-26",
  "2026-12-25",
  "2027-01-01",
  "2027-01-18",
  "2027-02-15",
  "2027-03-26",
  "2027-05-31",
  "2027-06-18",
  "2027-07-05",
  "2027-09-06",
  "2027-11-25",
  "2027-12-24",
]);

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: ET_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface EtParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function etParts(date: Date): EtParts {
  const found: Record<string, number> = {};
  for (const part of ET_PARTS.formatToParts(date)) {
    if (part.type !== "literal") found[part.type] = Number(part.value);
  }
  return {
    year: found["year"] ?? 0,
    month: found["month"] ?? 0,
    day: found["day"] ?? 0,
    hour: found["hour"] ?? 0,
    minute: found["minute"] ?? 0,
    second: found["second"] ?? 0,
  };
}

function etOffsetMs(date: Date): number {
  const p = etParts(date);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime();
}

/** The UTC instant of an ET wall clock time, resolved twice for the two clock change days. */
function etInstant(year: number, month: number, day: number, hour: number, minute: number): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - etOffsetMs(new Date(wall));
  return wall - etOffsetMs(new Date(first));
}

function dateKey(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function isTradingDay(year: number, month: number, day: number): boolean {
  const weekday = weekdayOf(year, month, day);
  if (weekday === 0 || weekday === 6) return false;
  return !HOLIDAYS.has(dateKey(year, month, day));
}

function shiftDay(p: EtParts, days: number): { year: number; month: number; day: number } {
  const moved = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

/** Two weeks covers the longest run of weekend and holiday closures on the calendar. */
const SEARCH_DAYS = 14;

export interface MarketClock {
  nowEt: string;
  /** The ET wall clock, hours and minutes only, for the big type. */
  nowEtTime: string;
  regularSessionOpen: boolean;
  isWeekend: boolean;
  isHoliday: boolean;
  lastRegularClose: number;
  nextRegularOpen: number;
  msToNextOpen: number;
}

export function nyseClock(now: Date = new Date()): MarketClock {
  const nowMs = now.getTime();
  const p = etParts(now);
  const minuteOfDay = p.hour * 60 + p.minute;
  const weekday = weekdayOf(p.year, p.month, p.day);
  const weekend = weekday === 0 || weekday === 6;
  const holiday = HOLIDAYS.has(dateKey(p.year, p.month, p.day));

  let lastClose = 0;
  for (let back = 0; back <= SEARCH_DAYS; back += 1) {
    const d = shiftDay(p, -back);
    if (!isTradingDay(d.year, d.month, d.day)) continue;
    const close = etInstant(d.year, d.month, d.day, CLOSE_HOUR, 0);
    if (close <= nowMs) {
      lastClose = close;
      break;
    }
  }

  let nextOpen = 0;
  for (let ahead = 0; ahead <= SEARCH_DAYS; ahead += 1) {
    const d = shiftDay(p, ahead);
    if (!isTradingDay(d.year, d.month, d.day)) continue;
    const open = etInstant(d.year, d.month, d.day, OPEN_HOUR, OPEN_MINUTE);
    if (open > nowMs) {
      nextOpen = open;
      break;
    }
  }

  const hhmm = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  return {
    nowEt: `${dateKey(p.year, p.month, p.day)} ${hhmm}:${String(p.second).padStart(2, "0")} ET`,
    nowEtTime: hhmm,
    regularSessionOpen:
      !weekend &&
      !holiday &&
      minuteOfDay >= OPEN_HOUR * 60 + OPEN_MINUTE &&
      minuteOfDay < CLOSE_HOUR * 60,
    isWeekend: weekend,
    isHoliday: holiday,
    lastRegularClose: lastClose,
    nextRegularOpen: nextOpen,
    msToNextOpen: nextOpen - nowMs,
  };
}

/* Beat two: four o'clock in New York. */

const FIFTEEN_MINUTES_MS = 15 * 60_000;

/** Four hours back covers a thin rToken with gaps in its afternoon candles. */
const ANCHOR_LOOKBACK_MS = 4 * 60 * 60_000;

/** One page of 15 minute candles reaches back a day, well past the lookback above. */
const CANDLE_PAGE = 100;

interface Anchor {
  ts: number;
  close: number;
}

const anchors = new Map<string, { closeTs: number; anchor: Anchor }>();

let marketTool: { spec: ToolSpec; context: ToolContext } | null = null;

/**
 * Read only and with no credentials, the same way lib/bitget.ts builds its board: the
 * surface is built without the trade module, so no code path on the site can send an order.
 */
function market(): { spec: ToolSpec; context: ToolContext } {
  if (marketTool) return marketTool;
  const config = loadConfig({ modules: "market", readOnly: true });
  const client = new BitgetRestClient(config);
  const spec = buildTools(config).find((tool) => tool.name === "market");
  if (!spec) throw new Error("the Bitget SDK built no market tool");
  marketTool = { spec, context: { config, client } as ToolContext };
  return marketTool;
}

/**
 * The close of the 15 minute candle that ends at the last 16:00 ET bell, from Bitget's own
 * market for this exact symbol. This is the anchor the engine measures divergence against
 * in src/bitget/divergence.ts. It cannot change until the next regular close, so it is kept
 * per symbol and per close rather than asked for again on every request.
 */
async function anchorFor(symbol: string, closeTs: number): Promise<Anchor | null> {
  const held = anchors.get(symbol);
  if (held && held.closeTs === closeTs) return held.anchor;

  try {
    const { spec, context } = market();
    const result = await safeInvoke(
      spec,
      {
        action: "candlesHistory",
        category: "SPOT",
        symbol,
        interval: "15m",
        limit: String(CANDLE_PAGE),
        endTime: String(Math.floor(closeTs)),
      },
      context,
    );
    if (!result.ok || !Array.isArray(result.data)) return null;

    const candles: Anchor[] = [];
    for (const row of result.data) {
      if (!Array.isArray(row) || row.length < 5) continue;
      const ts = Number(row[0]);
      const close = Number(row[4]);
      if (!Number.isFinite(ts) || !Number.isFinite(close) || close <= 0) continue;
      candles.push({ ts, close });
    }
    candles.sort((a, b) => a.ts - b.ts);

    const wanted = closeTs - FIFTEEN_MINUTES_MS;
    const anchor =
      candles.find((candle) => candle.ts === wanted) ??
      candles
        .filter((candle) => candle.ts < closeTs && candle.ts >= closeTs - ANCHOR_LOOKBACK_MS)
        .at(-1) ??
      null;
    if (anchor === null) return null;

    anchors.set(symbol, { closeTs, anchor });
    return anchor;
  } catch {
    return null;
  }
}

export interface StretchRow {
  symbol: string;
  name: string;
  last: number;
  anchorClose: number;
  anchorTs: number;
  pct: number;
}

export interface HeadlineTicker {
  symbol: string;
  name: string;
  last: number;
  changePct: number | null;
}

export interface FourOClock {
  /** rTSLA when tonight's universe holds it, otherwise the first rToken in the universe. */
  headline: HeadlineTicker | null;
  headlineIsTsla: boolean;
  asOf: number;
  tickerError: string | null;
  clock: MarketClock;
  rows: StretchRow[];
  most: StretchRow | null;
  /** Why there is no number, when there is none. */
  note: string | null;
}

const TSLA_SYMBOL = "RTSLAUSDT";

/** Why there is no divergence to draw, naming the read that came back empty. */
function stretchNote(tickers: number, measured: number): string | null {
  if (measured > 0) return null;
  if (tickers === 0) return "not measurable now: Bitget's tickers did not answer this read";
  return "not measurable now: Bitget served no candle at the last close for tonight's rTokens";
}

/**
 * The live board for tonight's rTokens, and how far each one has walked from the last
 * regular US close. While the New York session is open that walk is not a measurable thing,
 * so the rows come back empty and the note says why.
 */
export async function getFourOClock(now: Date = new Date()): Promise<FourOClock> {
  const clock = nyseClock(now);
  const [board, universe] = await Promise.all([getTickerBoard(), getUniverse()]);

  const bySymbol = new Map(board.rows.map((row) => [row.symbol, row]));
  const tsla = bySymbol.get(TSLA_SYMBOL) ?? null;
  const pick = tsla ?? board.rows[0] ?? null;

  const headline: HeadlineTicker | null = pick
    ? { symbol: pick.symbol, name: pick.name, last: pick.last, changePct: pick.changePct }
    : null;

  if (clock.regularSessionOpen) {
    return {
      headline,
      headlineIsTsla: tsla !== null,
      asOf: board.asOf,
      tickerError: board.error,
      clock,
      rows: [],
      most: null,
      note: "not measurable now: the New York session is open, so the rToken and the stock trade against the same tape",
    };
  }

  const rows: StretchRow[] = [];
  await Promise.all(
    universe.map(async (instrument) => {
      const row = bySymbol.get(instrument.symbol);
      if (!row) return;
      const anchor = await anchorFor(instrument.symbol, clock.lastRegularClose);
      if (anchor === null) return;
      rows.push({
        symbol: instrument.symbol,
        name: instrument.name,
        last: row.last,
        anchorClose: anchor.close,
        anchorTs: anchor.ts,
        pct: ((row.last - anchor.close) / anchor.close) * 100,
      });
    }),
  );

  rows.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));

  return {
    headline,
    headlineIsTsla: tsla !== null,
    asOf: board.asOf,
    tickerError: board.error,
    clock,
    rows,
    most: rows[0] ?? null,
    note: stretchNote(board.rows.length, rows.length),
  };
}

/* Beat three: what the watch does. */

export interface SeesReading {
  /** The instruments the rulebook had in force when the newest run entry was written. */
  symbols: string[];
  hedges: string[];
  configTs: number | null;
  /** The newest order book the record stored, with the spread it was stored at. */
  book: {
    symbol: string;
    ts: number;
    bid: number;
    ask: number;
    spreadBps: number;
    levels: number;
    bookHash: string;
  } | null;
  /** The headlines the news feed returned at its newest gather. Null when not published. */
  news: { items: number; gatheredTs: number } | null;
  clock: MarketClock;
  lastEntryTs: number | null;
}

export interface DecidesReading {
  seq: number;
  ts: number;
  brain: string;
  summary: string;
  symbol: string;
  rationale: string;
  confidence: number | null;
  targets: number;
  latencyMs: number | null;
  modelCalls: number | null;
}

export interface RefusesReading {
  seq: number;
  ts: number;
  brain: string;
  rule: string;
  reason: string;
  symbol: string | null;
  side: string | null;
  notionalUsdt: number | null;
}

export interface SignsReading {
  links: SignedEntry[];
  publicKeyHex: string | null;
  keySource: string;
  entries: number;
}

export interface WatchReading {
  sees: SeesReading;
  decides: DecidesReading | null;
  refuses: RefusesReading | null;
  signs: SignsReading;
}

/** The newest config entry that carries a run, which is the one the brains worked under. */
function newestRunConfig(data: RecordData): { payload: Record<string, unknown>; ts: number } | null {
  let newest: { payload: Record<string, unknown>; ts: number } | null = null;
  for (const entry of data.entries) {
    if (entry.kind !== "config") continue;
    if (!isRecord(entry.payload)) continue;
    if (!Array.isArray(entry.payload["brains"])) continue;
    newest = { payload: entry.payload, ts: entry.ts };
  }
  return newest;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * How many headlines the feed handed the brains at its newest gather.
 *
 * The engine caches each tick's merged news list beside the ledger, so this is the same
 * list the prompt carried. A host reading the published record has no such file, and the
 * count comes back null rather than as a zero it cannot stand behind.
 */
function newestNews(): { items: number; gatheredTs: number } | null {
  if (recordUrl() !== null) return null;
  const dir = join(dataDir(), "news-cache");
  if (!existsSync(dir)) return null;

  let newest: { items: number; gatheredTs: number } | null = null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const parsed = parseJson(fileText(join(dir, name)));
    if (!isRecord(parsed)) continue;
    const request = parsed["request"];
    if (!isRecord(request) || request["kind"] !== "kaaval-tick-news") continue;
    const fetchedAt = stringOf(parsed["fetchedAt"]);
    const value = parsed["value"];
    if (fetchedAt === null || !Array.isArray(value)) continue;
    const gatheredTs = Date.parse(fetchedAt);
    if (!Number.isFinite(gatheredTs)) continue;
    if (newest === null || gatheredTs > newest.gatheredTs) {
      newest = { items: value.length, gatheredTs };
    }
  }
  return newest;
}

function newestBook(data: RecordData): SeesReading["book"] {
  for (let index = data.entries.length - 1; index >= 0; index -= 1) {
    const entry = data.entries[index];
    if (!entry || entry.kind !== "snapshot" || !isRecord(entry.payload)) continue;
    const book = entry.payload["book"];
    if (!isRecord(book)) continue;
    const bids = Array.isArray(book["bids"]) ? book["bids"] : [];
    const asks = Array.isArray(book["asks"]) ? book["asks"] : [];
    const firstBid = bids[0];
    const firstAsk = asks[0];
    const bestBid = isRecord(firstBid) ? numberOf(firstBid["price"]) : null;
    const bestAsk = isRecord(firstAsk) ? numberOf(firstAsk["price"]) : null;
    const symbol = stringOf(book["symbol"]);
    if (bestBid === null || bestAsk === null || symbol === null || bestBid <= 0) continue;
    const mid = (bestBid + bestAsk) / 2;
    return {
      symbol,
      ts: numberOf(book["ts"]) ?? entry.ts,
      bid: bestBid,
      ask: bestAsk,
      spreadBps: ((bestAsk - bestBid) / mid) * 10_000,
      levels: Math.min(bids.length, asks.length),
      bookHash: stringOf(entry.payload["bookHash"]) ?? "",
    };
  }
  return null;
}

/** The four artefacts of beat three, all from the newest stretch of the same record. */
export async function getWatch(now: Date = new Date()): Promise<WatchReading> {
  const data = await wholeRecord();
  const typed = readRecord(data.entries);
  const config = newestRunConfig(data);

  const decision =
    typed.decisions.filter((row) => row.brain !== "rules" && row.targets.length > 0).at(-1) ??
    typed.decisions.filter((row) => row.targets.length > 0).at(-1) ??
    null;
  const target = decision?.targets[0] ?? null;

  const refusal = typed.refusals.at(-1) ?? null;

  const around = decision?.seq ?? data.entries.at(-1)?.seq ?? null;
  const index = around === null ? -1 : data.entries.findIndex((entry) => entry.seq === around);
  const start = index < 0 ? Math.max(0, data.entries.length - 3) : Math.max(0, index - 1);
  const links = data.entries.slice(start, start + 3).map(signedEntry);

  const proof = await getStoredProof();
  const configKey = config === null ? null : stringOf(config.payload["publicKeyHex"]);
  const fromProof = proof?.publicKeyHex ?? null;

  return {
    sees: {
      symbols: config === null ? [] : stringList(config.payload["universe"]),
      hedges: config === null ? [] : stringList(config.payload["hedges"]),
      configTs: config?.ts ?? null,
      book: newestBook(data),
      news: newestNews(),
      clock: nyseClock(now),
      lastEntryTs: data.entries.at(-1)?.ts ?? null,
    },
    decides:
      decision === null
        ? null
        : {
            seq: decision.seq,
            ts: decision.ts,
            brain: decision.brain,
            summary: decision.summary,
            symbol: target?.symbol ?? "",
            rationale: target?.rationale ?? "",
            confidence: target?.confidence ?? null,
            targets: decision.targets.length,
            latencyMs: decision.latencyMs,
            modelCalls: decision.modelCalls,
          },
    refuses:
      refusal === null
        ? null
        : {
            seq: refusal.seq,
            ts: refusal.ts,
            brain: refusal.brain,
            rule: refusal.rule,
            reason: refusal.reason,
            symbol: refusal.intent?.symbol ?? null,
            side: refusal.intent?.side ?? null,
            notionalUsdt: refusal.intent?.notionalUsdt ?? null,
          },
    signs: {
      links,
      publicKeyHex: fromProof ?? configKey,
      keySource: fromProof === null ? "the rulebook entry in the ledger" : "the stored proof run",
      entries: data.entries.length,
    },
  };
}

/* Beat five: try before you trust. */

export interface PlanOrder {
  symbol: string;
  side: string;
  notionalUsdt: number | null;
  qty: string | null;
  price: string | null;
  path: string | null;
  dryRun: boolean;
  fill: {
    avgPrice: number;
    feeUsdt: number | null;
    slippageBps: number | null;
    bookHash: string;
  } | null;
  refusedFill: string | null;
}

export interface PlanVerdict {
  allowed: boolean;
  rule: string | null;
  reason: string | null;
  symbol: string;
  side: string;
  notionalUsdt: number | null;
}

export interface PlanBrain {
  brain: string;
  summary: string;
  targets: Array<{ symbol: string; notionalUsdt: number | null; rationale: string }>;
  verdicts: PlanVerdict[];
  orders: PlanOrder[];
  shadowMark: {
    equityAfter: number | null;
    realised: number | null;
    unrealised: number | null;
  } | null;
}

export interface PlanReading {
  /** Which path this came from, so the page can caption it honestly. */
  source: "plan-file" | "record";
  id: string;
  accountId: string;
  ts: number;
  window: string | null;
  before: { equity: number | null; balanceUsdt: number | null; positions: number } | null;
  brains: PlanBrain[];
  caption: string;
}

function planOrder(value: unknown): PlanOrder | null {
  if (!isRecord(value)) return null;
  const intent = isRecord(value["intent"]) ? value["intent"] : {};
  const dryRun = isRecord(value["dryRun"]) ? value["dryRun"] : null;
  const sent = dryRun !== null && isRecord(dryRun["wouldSend"]) ? dryRun["wouldSend"] : null;
  const fill = isRecord(value["shadowFill"]) ? value["shadowFill"] : null;
  const avgPrice = fill === null ? null : numberOf(fill["avgPrice"]);

  return {
    symbol: stringOf(intent["symbol"]) ?? (sent === null ? null : stringOf(sent["symbol"])) ?? "",
    side: stringOf(intent["side"]) ?? (sent === null ? null : stringOf(sent["side"])) ?? "",
    notionalUsdt: numberOf(intent["notionalUsdt"]),
    qty: sent === null ? null : stringOf(sent["qty"]),
    price: sent === null ? null : stringOf(sent["price"]),
    path: dryRun === null ? null : stringOf(dryRun["path"]),
    dryRun: dryRun !== null && dryRun["dryRun"] === true,
    fill:
      fill === null || avgPrice === null
        ? null
        : {
            avgPrice,
            feeUsdt: numberOf(fill["feeUsdt"]),
            slippageBps: numberOf(fill["slippageBps"]),
            bookHash: stringOf(fill["bookHash"]) ?? "",
          },
    refusedFill: fill === null ? null : stringOf(fill["reason"]),
  };
}

function planFromFile(parsed: unknown): PlanReading | null {
  if (!isRecord(parsed)) return null;
  const accountId = stringOf(parsed["accountId"]);
  const ts = numberOf(parsed["ts"]);
  if (accountId === null || ts === null) return null;

  const before = isRecord(parsed["before"]) ? parsed["before"] : null;
  const brains: PlanBrain[] = [];
  for (const item of Array.isArray(parsed["brains"]) ? parsed["brains"] : []) {
    if (!isRecord(item)) continue;
    const decision = isRecord(item["decision"]) ? item["decision"] : null;
    const targets =
      decision !== null && Array.isArray(decision["targets"]) ? decision["targets"] : [];

    const verdicts: PlanVerdict[] = [];
    for (const verdict of Array.isArray(item["verdicts"]) ? item["verdicts"] : []) {
      if (!isRecord(verdict)) continue;
      const intent = isRecord(verdict["intent"]) ? verdict["intent"] : {};
      verdicts.push({
        allowed: verdict["allowed"] === true,
        rule: stringOf(verdict["rule"]),
        reason: stringOf(verdict["reason"]),
        symbol: stringOf(intent["symbol"]) ?? "",
        side: stringOf(intent["side"]) ?? "",
        notionalUsdt: numberOf(intent["notionalUsdt"]),
      });
    }

    const orders: PlanOrder[] = [];
    for (const order of Array.isArray(item["orders"]) ? item["orders"] : []) {
      const read = planOrder(order);
      if (read) orders.push(read);
    }

    const mark = isRecord(item["shadowMark"]) ? item["shadowMark"] : null;

    brains.push({
      brain: stringOf(item["brain"]) ?? "",
      summary: decision === null ? "" : (stringOf(decision["summary"]) ?? ""),
      targets: targets.filter(isRecord).map((target) => ({
        symbol: stringOf(target["symbol"]) ?? "",
        notionalUsdt: numberOf(target["targetNotionalUsdt"]),
        rationale: stringOf(target["rationale"]) ?? "",
      })),
      verdicts,
      orders,
      shadowMark:
        mark === null
          ? null
          : {
              equityAfter: numberOf(mark["equityAfter"]),
              realised: numberOf(mark["realised"]),
              unrealised: numberOf(mark["unrealised"]),
            },
    });
  }
  if (brains.length === 0) return null;

  const positions = before !== null && Array.isArray(before["positions"]) ? before["positions"].length : 0;

  return {
    source: "plan-file",
    id: stringOf(parsed["id"]) ?? "",
    accountId,
    ts,
    window: stringOf(parsed["window"]),
    before:
      before === null
        ? null
        : {
            equity: numberOf(before["equity"]),
            balanceUsdt: numberOf(before["balanceUsdt"]),
            positions,
          },
    brains,
    caption: "the account the read-only key belongs to",
  };
}

/**
 * The newest plan the engine wrote, when there is one beside it. The file is named
 * account-timestamp, so the newest is the largest timestamp, not the last name in the
 * alphabet: two accounts would otherwise sort by their names rather than by their clocks.
 */
function newestPlanFile(): unknown {
  if (recordUrl() !== null) return null;
  const dir = join(dataDir(), "plans");
  if (!existsSync(dir)) return null;

  let newest: { name: string; ts: number } | null = null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    // Fixture plans are written elsewhere now; this guard keeps an old one off the page.
    if (name.startsWith("fake")) continue;
    const stamp = Number(/-(\d+)\.json$/.exec(name)?.[1] ?? "0");
    const ts = Number.isFinite(stamp) ? stamp : 0;
    if (newest === null || ts > newest.ts) newest = { name, ts };
  }
  if (newest === null) return null;
  return parseJson(fileText(join(dir, newest.name)));
}

/**
 * Tonight's plan for the demo account. When the engine has written a plan file it is read
 * straight off it; when it has not, the same shape is rebuilt from the newest tick of the
 * record, so the beat shows a real artefact either way and the caption says which.
 */
export async function getPlan(): Promise<PlanReading | null> {
  const fromFile = planFromFile(newestPlanFile());
  if (fromFile !== null) return fromFile;

  const data = await wholeRecord();
  const typed = readRecord(data.entries);
  const newest = typed.decisions.at(-1);
  if (newest === undefined) return null;

  const brains: PlanBrain[] = [];
  for (const name of [...new Set(typed.decisions.map((row) => row.brain))]) {
    const decision = typed.decisions.filter((row) => row.brain === name).at(-1);
    if (decision === undefined) continue;
    const after = <T extends { seq: number; brain: string }>(rows: T[]): T[] =>
      rows.filter((row) => row.brain === name && row.seq > decision.seq);
    const fills = after(typed.fills);
    const mark = typed.marks.filter((row) => row.brain === name).at(-1) ?? null;

    brains.push({
      brain: name,
      summary: decision.summary,
      targets: decision.targets.map((target) => ({
        symbol: target.symbol,
        notionalUsdt: target.targetNotionalUsdt,
        rationale: target.rationale,
      })),
      verdicts: after(typed.refusals).map((refusal) => ({
        allowed: false,
        rule: refusal.rule,
        reason: refusal.reason,
        symbol: refusal.intent?.symbol ?? "",
        side: refusal.intent?.side ?? "",
        notionalUsdt: refusal.intent?.notionalUsdt ?? null,
      })),
      orders: after(typed.orders).map((order) => {
        const fill = fills.find((row) => row.orderId === order.orderId) ?? null;
        return {
          symbol: order.symbol,
          side: order.side,
          notionalUsdt: fill?.notionalUsdt ?? null,
          qty: order.qty === null ? null : String(order.qty),
          price: order.limitPrice === null ? null : String(order.limitPrice),
          path: null,
          dryRun: false,
          fill:
            fill === null || fill.avgPrice === null
              ? null
              : {
                  avgPrice: fill.avgPrice,
                  feeUsdt: fill.feeUsdt,
                  slippageBps: fill.slippageBps,
                  bookHash: fill.bookHash,
                },
          refusedFill: null,
        };
      }),
      shadowMark:
        mark === null
          ? null
          : { equityAfter: mark.equity, realised: mark.realised, unrealised: mark.unrealised },
    });
  }

  return {
    source: "record",
    id: `tick-${String(newest.seq)}`,
    accountId: "the record's own accounts",
    ts: newest.ts,
    window: null,
    before: null,
    brains,
    caption: "tonight, for the record's own account",
  };
}
