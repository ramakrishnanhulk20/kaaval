import { withCache } from "./cache.js";
import { httpGet, type HttpGet } from "./http.js";
import { GDELT_MIN_SPACING_MS, pace, sleep } from "./pace.js";

const BASE_URL = "https://api.gdeltproject.org/api/v2/doc/doc";

/** A refusal waits twenty seconds before the one retry, because six was still refused. */
const RETRY_AFTER_429_MS = 20_000;

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 25;
const DEFAULT_TIMESPAN_HOURS = 24;

/**
 * How many tickers one batched question may carry. GDELT matches loosely and a very long
 * OR block returns mush, so beyond this the callers split the list into several queries.
 */
const MAX_UNDERLYINGS_PER_QUERY = 25;

/** An older trade under review needs the window it happened in, not the last few hours. */
export interface GdeltRange {
  fromTs: number;
  toTs: number;
}

export interface GdeltOptions {
  cacheDir: string;
  /** Ignored when range is set. Defaults to a day when neither is given. */
  timespanHours?: number;
  range?: GdeltRange;
  maxRecords?: number;
  ttlMs?: number;
  minSpacingMs?: number;
  retryDelayMs?: number;
  /** How long one GDELT request may take. Defaults to KAAVAL_HTTP_TIMEOUT_MS. */
  timeoutMs?: number;
  get?: HttpGet;
  log?: (line: string) => void;
}

export interface GdeltArticle {
  url: string;
  title: string;
  ts: number;
  domain: string;
  language: string;
  sourceCountry: string;
}

interface RawArticle {
  url?: string;
  title?: string;
  seendate?: string;
  domain?: string;
  language?: string;
  sourcecountry?: string;
}

/**
 * Recent English articles GDELT has indexed for this query, newest first.
 *
 * GDELT needs no key, which is why it is in the feed at all: the agent keeps a news
 * sense on a machine with no paid subscription. Matching is loose, so an article here
 * is a hint about attention, not a confirmed fact about the company, and the prompt
 * quotes it as data for exactly that reason. Returns an empty list, never a throw, so
 * one dead source cannot stop a tick.
 */
export async function fetchGdelt(query: string, opts: GdeltOptions): Promise<GdeltArticle[]> {
  const log = opts.log ?? (() => {});
  const get = opts.get ?? httpGet;
  const params = new URLSearchParams({
    query,
    mode: "artlist",
    maxrecords: String(opts.maxRecords ?? DEFAULT_MAX_RECORDS),
    format: "json",
    sort: "datedesc",
  });
  if (opts.range) {
    params.set("startdatetime", stamp(opts.range.fromTs));
    params.set("enddatetime", stamp(opts.range.toTs));
  } else {
    const hours = Math.max(1, Math.round(opts.timespanHours ?? DEFAULT_TIMESPAN_HOURS));
    params.set("timespan", `${hours}h`);
  }
  const url = `${BASE_URL}?${params.toString()}`;
  const asked = opts.range
    ? `${params.get("startdatetime")}-${params.get("enddatetime")}`
    : params.get("timespan");

  try {
    const { value } = await withCache<RawArticle[]>(
      { dir: opts.cacheDir, ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS },
      { source: "gdelt", query, window: asked },
      async () => {
        await pace("gdelt", opts.minSpacingMs ?? GDELT_MIN_SPACING_MS);
        log(`gdelt: requesting "${query}" over ${asked}`);
        let res = await get(url, {}, opts.timeoutMs);
        if (res.status === 429) {
          log(`gdelt: rate limited, retrying "${query}" once after a pause`);
          await sleep(opts.retryDelayMs ?? RETRY_AFTER_429_MS);
          // Mark the pacer again so the next query waits a full gap after this retry
          // rather than following it immediately. Without this, a tick that hits one 429
          // sends its remaining queries back to back and GDELT refuses all of them.
          await pace("gdelt", opts.minSpacingMs ?? GDELT_MIN_SPACING_MS);
          res = await get(url, {}, opts.timeoutMs);
        }
        if (res.status !== 200) {
          throw new Error(`gdelt answered ${res.status}`);
        }
        const body = JSON.parse(res.body) as { articles?: RawArticle[] };
        return body.articles ?? [];
      },
    );
    return value
      .map(toArticle)
      .filter((a): a is GdeltArticle => a !== null)
      .sort((a, b) => b.ts - a.ts);
  } catch (err) {
    log(`gdelt: "${query}" failed, skipping it (${message(err)})`);
    return [];
  }
}

/**
 * One question that covers every underlying given, up to twenty five of them.
 *
 * GDELT refuses roughly one call every eight seconds, so asking it once per symbol meant
 * fourteen questions a tick and thirteen refusals. The OR block asks for all of them in
 * a single call, the trading words keep the matches on markets, and sourcelang:eng keeps
 * the feed readable. Beyond twenty five underlyings use gdeltBatchQueries, which splits
 * the list and returns one query per group. Returns an empty string for an empty list,
 * which callers treat as nothing to ask.
 */
export function gdeltBatchQuery(underlyings: string[]): string {
  const list = cleanUnderlyings(underlyings).slice(0, MAX_UNDERLYINGS_PER_QUERY);
  if (list.length === 0) return "";
  // GDELT rejects parentheses around a single term ("Parentheses may only be used around
  // OR'd statements", answered as plain text with HTTP 200), so one ticker goes bare.
  const names = list.length === 1 ? list[0]! : `(${list.join(" OR ")})`;
  return `${names} (stock OR shares OR earnings) sourcelang:eng`;
}

/** The batched queries needed to cover a list of any length, in the order given. */
export function gdeltBatchQueries(underlyings: string[]): string[] {
  const list = cleanUnderlyings(underlyings);
  const out: string[] = [];
  for (let i = 0; i < list.length; i += MAX_UNDERLYINGS_PER_QUERY) {
    out.push(gdeltBatchQuery(list.slice(i, i + MAX_UNDERLYINGS_PER_QUERY)));
  }
  return out;
}

/**
 * Which Kaaval symbols an article is about, read from its own title and url.
 *
 * A batched question comes back as one pile of articles, so the answer no longer says
 * which ticker it belongs to. A ticker or a well known company name written as a whole
 * word in the headline or in the url path is the evidence used here. It is a hint, not a
 * fact: "MU" in a headline can be something other than Micron, and an article about a
 * company can name none of these. An empty list means the story stays as macro news.
 */
export function tagSymbols(
  article: { title: string; url: string },
  symbols: Array<{ symbol: string; underlying: string }>,
): string[] {
  const text = `${flatten(article.title)} ${flatten(pathOf(article.url))}`;
  const found: string[] = [];
  for (const entry of symbols) {
    const underlying = entry.underlying.toUpperCase();
    const phrases = [underlying.toLowerCase(), ...(COMPANY_NAMES[underlying] ?? [])];
    if (phrases.some((phrase) => mentions(text, phrase)) && !found.includes(entry.symbol)) {
      found.push(entry.symbol);
    }
  }
  return found;
}

/**
 * The names the biggest tickers are actually written under in a headline. Only names that
 * are useless as ordinary words are listed: "Meta" and "Nasdaq" on their own would tag
 * half the feed, so they are absent, and the index funds match the index they track.
 */
const COMPANY_NAMES: Record<string, string[]> = {
  AAPL: ["apple"],
  MSFT: ["microsoft"],
  NVDA: ["nvidia"],
  GOOGL: ["alphabet", "google"],
  GOOG: ["alphabet", "google"],
  AMZN: ["amazon"],
  META: ["meta platforms", "facebook"],
  TSLA: ["tesla"],
  AVGO: ["broadcom"],
  NFLX: ["netflix"],
  AMD: ["advanced micro devices"],
  MU: ["micron"],
  COIN: ["coinbase"],
  SPY: ["s p 500"],
  VOO: ["s p 500"],
  QQQ: ["nasdaq 100"],
};

function cleanUnderlyings(underlyings: string[]): string[] {
  return [...new Set(underlyings.map((u) => u.trim().toUpperCase()).filter((u) => u.length > 0))];
}

/** Everything that is not a letter or a digit becomes a space, so "TSLA-stock" is two words. */
function flatten(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function mentions(text: string, phrase: string): boolean {
  if (phrase.length === 0) return false;
  return new RegExp(`(^| )${phrase}( |$)`).test(text);
}

/** The domain is skipped on purpose: reuters.com is not a story about Reuters. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

/** GDELT reads a window as YYYYMMDDHHMMSS in UTC, the same shape it stamps articles with. */
function stamp(ts: number): string {
  return new Date(ts).toISOString().replace(/[-:]/g, "").replace("T", "").slice(0, 14);
}

function toArticle(raw: RawArticle): GdeltArticle | null {
  const ts = parseSeenDate(raw.seendate ?? "");
  if (!raw.url || !raw.title || ts === null) return null;
  return {
    url: raw.url,
    title: raw.title.replace(/\s+/g, " ").trim(),
    ts,
    domain: raw.domain ?? "",
    language: raw.language ?? "",
    sourceCountry: raw.sourcecountry ?? "",
  };
}

/** GDELT stamps an article "20260908T143000Z", which Date.parse does not read. */
function parseSeenDate(seen: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(seen);
  if (!m) return null;
  const ms = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
  return Number.isFinite(ms) ? ms : null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
