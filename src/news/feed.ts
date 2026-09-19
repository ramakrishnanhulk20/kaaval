import { createHash } from "node:crypto";
import type { CalendarEvent, NewsItem } from "../brain/types.js";
import { fetchAskNews } from "./asknews.js";
import { fetchEdgar8k } from "./edgar.js";
import {
  fetchFinnhub,
  type FinnhubEarningsRow,
  type FinnhubEconomicRow,
  type FinnhubNewsRow,
} from "./finnhub.js";
import { fetchGdelt, gdeltBatchQueries, tagSymbols } from "./gdelt.js";

export interface FeedOptions {
  symbols: Array<{ symbol: string; underlying: string }>;
  sinceTs: number;
  cacheDir: string;
}

export interface CalendarOptions {
  underlyings: string[];
  fromTs: number;
  toTs: number;
  cacheDir: string;
}

type Log = (line: string) => void;

/** A tick's prompt has to stay readable and cheap, so the feed is capped after merging. */
const MAX_ITEMS = 80;

/** Per source, per underlying, before merging. */
const MAX_PER_SOURCE = 12;

const MAX_ECONOMIC_EVENTS = 40;

/** One batched question covers every underlying, so GDELT gets its own, larger caps. */
const GDELT_MAX_RECORDS = 75;
const MAX_GDELT_ITEMS = 40;

/** AskNews answers one batched question too, and it is asked for thirty articles. */
const MAX_ASKNEWS_ITEMS = 30;

/** Below this many tagged stories the batch's macro headlines are worth keeping. */
const MIN_TAGGED_BEFORE_DROP = 3;

/** GDELT is asked once an hour for the same window, whatever the tick rate is. */
const GDELT_TTL_MS = 60 * 60 * 1000;

const CALENDAR_TTL_MS = 6 * 60 * 60 * 1000;

const ET_ZONE = "America/New_York";

/**
 * Everything published about these symbols since sinceTs, newest first, deduplicated.
 *
 * Four sources with different failure modes: Finnhub carries company news but needs a
 * key, SEC EDGAR carries the filing itself and needs none, GDELT carries what the rest
 * of the web is saying and needs none, and AskNews searches across many outlets for a
 * key and one metered credit, asked once a clock hour for the whole universe. AskNews is
 * what keeps the brains reading something on a night GDELT throttles us. A source that
 * is missing or broken is written to the log and skipped; it never appears in the
 * returned items and never throws, because a tick with three feeds is worth more than a
 * tick that failed. Items are tagged with every Kaaval symbol they touch: the one the
 * source was queried for, or for the batched questions GDELT and AskNews each ask, the
 * tickers and names the story's own words and url carry, plus any other ticker named in
 * the headline.
 */
export async function gatherNews(opts: FeedOptions, log: Log = () => {}): Promise<NewsItem[]> {
  const now = Date.now();
  const underlyings = [...new Set(opts.symbols.map((s) => s.underlying.toUpperCase()))];
  const fromDate = isoDate(opts.sinceTs);
  const toDate = isoDate(now);
  const timespanHours = Math.max(1, Math.ceil((now - opts.sinceTs) / 3_600_000));

  const finnhub = async (): Promise<NewsItem[]> => {
    const out: NewsItem[] = [];
    for (const underlying of underlyings) {
      const rows = await fetchFinnhub<FinnhubNewsRow[]>(
        "/company-news",
        { symbol: underlying, from: fromDate, to: toDate },
        { cacheDir: opts.cacheDir, log },
      );
      if (!rows) continue;
      for (const row of rows.slice(0, MAX_PER_SOURCE)) {
        const ts = Number(row.datetime ?? 0) * 1000;
        const headline = (row.headline ?? "").trim();
        if (!headline || !Number.isFinite(ts) || ts < opts.sinceTs) continue;
        out.push({
          id: idFor("finnhub", row.url ?? headline),
          ts,
          source: `finnhub/${row.source ?? "unknown"}`,
          headline,
          summary: trimOrNull(row.summary),
          url: row.url ?? null,
          symbols: symbolsFor(opts, underlying),
        });
      }
    }
    return out;
  };

  const edgar = async (): Promise<NewsItem[]> => {
    const out: NewsItem[] = [];
    for (const underlying of underlyings) {
      const filings = await fetchEdgar8k(underlying, {
        cacheDir: opts.cacheDir,
        fromDate,
        toDate,
        log,
      });
      for (const filing of filings.slice(0, MAX_PER_SOURCE)) {
        out.push({
          id: idFor("edgar", filing.accession),
          ts: filing.ts,
          source: "sec-edgar",
          headline: filing.headline,
          summary: filing.description,
          url: filing.url,
          symbols: symbolsFor(opts, underlying),
        });
      }
    }
    return out;
  };

  /**
   * One question per twenty five underlyings, not one per underlying. The old version
   * asked once per name and GDELT refused nearly all of them, so the brains saw no news
   * at all. What comes back is one pile, so each article is sorted by the tickers and
   * company names it carries itself. A story that names nothing we hold is macro news:
   * it is kept with no symbol only when the tagged haul is thin, otherwise it is dropped
   * so the prompt spends its room on stories about our own positions.
   */
  const gdelt = async (): Promise<NewsItem[]> => {
    const tagged: NewsItem[] = [];
    const macro: NewsItem[] = [];
    const queries = gdeltBatchQueries(underlyings);
    let articleCount = 0;

    for (const query of queries) {
      const articles = await fetchGdelt(query, {
        cacheDir: opts.cacheDir,
        timespanHours,
        maxRecords: GDELT_MAX_RECORDS,
        ttlMs: GDELT_TTL_MS,
        log,
      });
      articleCount += articles.length;
      for (const article of articles) {
        if (article.ts < opts.sinceTs) continue;
        const symbols = tagSymbols(article, opts.symbols);
        const item: NewsItem = {
          id: idFor("gdelt", article.url),
          ts: article.ts,
          source: `gdelt/${article.domain}`,
          headline: article.title,
          summary: null,
          url: article.url,
          symbols,
        };
        (symbols.length > 0 ? tagged : macro).push(item);
      }
    }

    log(
      `gdelt: ${queries.length} batched request(s) for ${underlyings.length} underlyings answered ` +
        `${articleCount} articles, ${tagged.length} tagged`,
    );

    const newest = (list: NewsItem[]): NewsItem[] => [...list].sort((a, b) => b.ts - a.ts);
    const kept = newest(tagged).slice(0, MAX_GDELT_ITEMS);
    if (tagged.length >= MIN_TAGGED_BEFORE_DROP) return kept;
    return [...kept, ...newest(macro).slice(0, MAX_PER_SOURCE)];
  };

  /**
   * One keyword search for the whole universe, with the summary read as part of the
   * headline when the story is tagged: AskNews writes a neutral title and puts the
   * company in the sentence under it. The thin-haul rule is GDELT's, for the same
   * reason: a story that names nothing we hold is only worth prompt room on a quiet
   * night.
   */
  const asknews = async (): Promise<NewsItem[]> => {
    const tagged: NewsItem[] = [];
    const macro: NewsItem[] = [];
    const articles = await fetchAskNews(
      underlyings,
      { fromTs: opts.sinceTs },
      { cacheDir: opts.cacheDir, log },
    );

    for (const article of articles) {
      if (article.ts < opts.sinceTs) continue;
      const symbols = tagSymbols(
        { title: `${article.title} ${article.summary ?? ""}`, url: article.url },
        opts.symbols,
      );
      const item: NewsItem = {
        id: idFor("asknews", article.url),
        ts: article.ts,
        source: `asknews/${article.domain}`,
        headline: article.title,
        summary: article.summary,
        url: article.url,
        symbols,
      };
      (symbols.length > 0 ? tagged : macro).push(item);
    }

    log(
      `asknews: 1 request for ${underlyings.length} underlyings answered ` +
        `${articles.length} articles, ${tagged.length} tagged`,
    );

    const newest = (list: NewsItem[]): NewsItem[] => [...list].sort((a, b) => b.ts - a.ts);
    const kept = newest(tagged).slice(0, MAX_ASKNEWS_ITEMS);
    if (tagged.length >= MIN_TAGGED_BEFORE_DROP) return kept;
    return [...kept, ...newest(macro).slice(0, MAX_PER_SOURCE)];
  };

  const batches = await Promise.all([finnhub(), edgar(), gdelt(), asknews()]);
  const merged = dedupe(batches.flat().sort((a, b) => b.ts - a.ts));
  return merged.slice(0, MAX_ITEMS).map((item) => ({
    ...item,
    symbols: withMentions(item, opts),
  }));
}

/**
 * Scheduled events between fromTs and toTs, soonest first.
 *
 * Both calendars are Finnhub's and both need the key, so with no key this returns an
 * empty list and says so in the log rather than pretending the night is quiet. The
 * earnings hour code is what makes this worth reading at all: "amc" means the release
 * lands after the US close, which is exactly when Kaaval is awake and the rToken is the
 * only place that reaction can be traded.
 */
export async function gatherCalendar(
  opts: CalendarOptions,
  log: Log = () => {},
): Promise<CalendarEvent[]> {
  const fromDate = isoDate(opts.fromTs);
  const toDate = isoDate(opts.toTs);
  const events: CalendarEvent[] = [];

  for (const underlying of [...new Set(opts.underlyings.map((u) => u.toUpperCase()))]) {
    const payload = await fetchFinnhub<{ earningsCalendar?: FinnhubEarningsRow[] }>(
      "/calendar/earnings",
      { from: fromDate, to: toDate, symbol: underlying },
      { cacheDir: opts.cacheDir, ttlMs: CALENDAR_TTL_MS, log },
    );
    for (const row of payload?.earningsCalendar ?? []) {
      if (!row.date) continue;
      const timing = timingOf(row.hour);
      const ts = earningsInstant(row.date, timing);
      if (!Number.isFinite(ts) || ts < opts.fromTs || ts > opts.toTs) continue;
      events.push({
        ts,
        kind: "earnings",
        title: `${row.symbol ?? underlying} reports quarterly results`,
        symbol: row.symbol ?? underlying,
        timing,
      });
    }
  }

  const macro = await fetchFinnhub<{ economicCalendar?: FinnhubEconomicRow[] }>(
    "/calendar/economic",
    { from: fromDate, to: toDate },
    { cacheDir: opts.cacheDir, ttlMs: CALENDAR_TTL_MS, log },
  );
  const rows = (macro?.economicCalendar ?? [])
    .filter((row) => row.impact === undefined || row.impact === "high" || row.impact === "medium")
    .slice(0, MAX_ECONOMIC_EVENTS);
  for (const row of rows) {
    if (!row.time || !row.event) continue;
    const ts = Date.parse(`${row.time.replace(" ", "T")}Z`);
    if (!Number.isFinite(ts) || ts < opts.fromTs || ts > opts.toTs) continue;
    events.push({ ts, kind: "macro", title: row.event, symbol: null, timing: "unknown" });
  }

  return events.sort((a, b) => a.ts - b.ts);
}

function symbolsFor(opts: FeedOptions, underlying: string): string[] {
  return opts.symbols.filter((s) => s.underlying.toUpperCase() === underlying).map((s) => s.symbol);
}

/** A headline that names a second ticker is news for that symbol too. */
function withMentions(item: NewsItem, opts: FeedOptions): string[] {
  const found = new Set(item.symbols);
  const text = `${item.headline} ${item.summary ?? ""}`.toUpperCase();
  for (const entry of opts.symbols) {
    const ticker = entry.underlying.toUpperCase();
    if (new RegExp(`\\b${escapeRegExp(ticker)}\\b`).test(text)) found.add(entry.symbol);
  }
  return [...found];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The same story reaches us from several outlets with the same words. Keeping the first
 * copy keeps the newest, because the list is sorted before this runs, and the survivor
 * inherits every symbol and any link its duplicates carried.
 */
function dedupe(items: NewsItem[]): NewsItem[] {
  const seen = new Map<string, NewsItem>();
  for (const item of items) {
    const key = normalise(item.headline);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { ...item, symbols: [...item.symbols] });
      continue;
    }
    existing.symbols = [...new Set([...existing.symbols, ...item.symbols])];
    if (!existing.url && item.url) existing.url = item.url;
    if (!existing.summary && item.summary) existing.summary = item.summary;
  }
  return [...seen.values()];
}

function normalise(headline: string): string {
  return headline
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function idFor(source: string, seed: string): string {
  return `${source}-${createHash("sha1").update(seed).digest("hex").slice(0, 12)}`;
}

function trimOrNull(value: string | undefined): string | null {
  const text = (value ?? "").trim();
  return text.length > 0 ? text : null;
}

function isoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function timingOf(hour: string | undefined): CalendarEvent["timing"] {
  switch ((hour ?? "").toLowerCase()) {
    case "bmo":
      return "before-open";
    case "amc":
      return "after-close";
    case "dmh":
      return "during";
    default:
      return "unknown";
  }
}

/**
 * Finnhub dates an earnings release by day and says only whether it lands before the
 * open, after the close, or during the session, so the clock time here is ours: 08:00,
 * 16:05 and 12:00 New York time. The timing field carries the source's own answer, so a
 * reader can tell the two apart.
 */
function earningsInstant(date: string, timing: CalendarEvent["timing"]): number {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return Number.NaN;
  const hour = timing === "before-open" ? 8 : timing === "after-close" ? 16 : 12;
  const minute = timing === "after-close" ? 5 : 0;
  return etInstant(year, month, day, hour, minute);
}

/**
 * The UTC instant of a New York wall-clock time. The offset is resolved twice because
 * the first guess uses the wrong side of a daylight-saving change on the two days a
 * year the clocks move. bitget/hours.ts keeps its own copy of this for the NYSE clock;
 * it is not exported there and the news feed must not reach into that module's guts.
 */
function etInstant(year: number, month: number, day: number, hour: number, minute: number): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - etOffsetMs(new Date(wall));
  return wall - etOffsetMs(new Date(first));
}

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

function etOffsetMs(date: Date): number {
  const found: Record<string, number> = {};
  for (const part of ET_PARTS.formatToParts(date)) {
    if (part.type !== "literal") found[part.type] = Number(part.value);
  }
  return (
    Date.UTC(
      found["year"] ?? 0,
      (found["month"] ?? 1) - 1,
      found["day"] ?? 1,
      found["hour"] ?? 0,
      found["minute"] ?? 0,
      found["second"] ?? 0,
    ) - date.getTime()
  );
}
