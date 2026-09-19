import { withCache } from "./cache.js";
import { companyNamesOf } from "./gdelt.js";
import { httpGet, type HttpGet } from "./http.js";
import { pace } from "./pace.js";

const BASE_URL = "https://api.asknews.app/v1/news/search";

/** AskNews documents one request every two seconds, so the gap keeps a little room. */
const MIN_SPACING_MS = 2_100;

/** Every call spends a credit, so the whole universe gets one answer per clock hour. */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/** The Pro plan refuses a request for more than ten articles with a 400. */
const DEFAULT_ARTICLES = 10;

const MAX_NAMES = 25;

const HOUR_MS = 60 * 60 * 1000;

/** Past this age the window is an archive search on AskNews' side, not a recent one. */
const HISTORICAL_AFTER_MS = 48 * HOUR_MS;

const MAX_HOURS_BACK = 48;

const MAX_SUMMARY_CHARS = 280;

export interface AskNewsOptions {
  cacheDir: string;
  ttlMs?: number;
  minSpacingMs?: number;
  /** How long one AskNews request may take. Defaults to KAAVAL_HTTP_TIMEOUT_MS. */
  timeoutMs?: number;
  apiKey?: string;
  get?: HttpGet;
  log?: (line: string) => void;
}

/** Both bounds in milliseconds. Leave toTs out to ask for the hours up to now. */
export interface AskNewsWindow {
  fromTs: number;
  toTs?: number;
}

export interface AskNewsArticle {
  id: string;
  ts: number;
  title: string;
  summary: string | null;
  url: string;
  domain: string;
}

/** The fields of one as_dicts row we read. Every one of them can be missing. */
interface RawArticle {
  article_url?: string;
  article_id?: string;
  eng_title?: string;
  title?: string;
  summary?: string;
  pub_date?: string;
  domain_url?: string;
  source_id?: string;
  language?: string;
}

/**
 * The one question a search asks, in plain words, naming every company and its ticker.
 *
 * Three live searches on 19 September 2026 decided this. Tickers as required strings
 * found good stories but missed every article that says Nvidia and never NVDA. Company
 * and index names as required strings matched any story with the word Nasdaq in it, and
 * nine of ten articles were about companies we do not trade. A natural language question
 * naming both brought back ten of ten on our names. Each search cost one credit.
 */
export function askNewsQuestion(underlyings: string[]): string {
  const seen = new Set<string>();
  const named: string[] = [];
  for (const raw of underlyings) {
    const ticker = raw.trim().toUpperCase();
    if (ticker.length === 0 || seen.has(ticker)) continue;
    seen.add(ticker);
    const name = companyNamesOf(ticker)[0];
    named.push(name === undefined ? ticker : `${display(name)} (${ticker})`);
  }
  if (named.length === 0) return "";
  return `News moving the shares of ${named.slice(0, MAX_NAMES).join(", ")}`;
}

/** The names are kept lower case and stripped for matching; a question reads better spelled properly. */
function display(name: string): string {
  if (name === "s p 500") return "S&P 500";
  return name.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

/**
 * Articles AskNews has for these tickers inside this window, newest first.
 *
 * One request covers every ticker and costs one credit, and the answer is cached per
 * clock hour so a five minute tick rate does not multiply the bill. Returns an empty
 * list and writes one line to the log rather than throwing, for every reason it cannot
 * answer: no key, nothing worth asking for, a refusal, a body that is not a news
 * payload. The key is sent in the Authorization header at call time only. It is never in
 * the URL and never in the cache request, so it cannot reach a filename or a cache file.
 *
 * A window that ends in the past and starts more than forty eight hours ago is an
 * archive search, and those are held behind ASKNEWS_HISTORICAL. Archive reads may be
 * metered differently, and a review rebuild asks about every hour ever traded, so the
 * default is to spend nothing until the operator turns it on.
 */
export async function fetchAskNews(
  underlyings: string[],
  window: AskNewsWindow,
  opts: AskNewsOptions,
): Promise<AskNewsArticle[]> {
  const log = opts.log ?? (() => {});
  const key = opts.apiKey ?? process.env["ASKNEWS_API_KEY"] ?? "";
  if (!key) {
    log("asknews: ASKNEWS_API_KEY is not set, skipping news search");
    return [];
  }

  const question = askNewsQuestion(underlyings);
  if (question === "") {
    log("asknews: no ticker to ask about, skipping news search");
    return [];
  }

  const now = Date.now();
  const historical = window.toTs !== undefined && window.fromTs < now - HISTORICAL_AFTER_MS;
  if (historical && process.env["ASKNEWS_HISTORICAL"] !== "1") {
    log("asknews: historical search is off (ASKNEWS_HISTORICAL is not 1), skipping news search");
    return [];
  }

  const params = new URLSearchParams({
    query: question,
    n_articles: String(DEFAULT_ARTICLES),
    return_type: "dicts",
    method: "nl",
    time_filter: "pub_date",
    languages: "en",
  });
  if (window.toTs === undefined) {
    params.set("hours_back", String(hoursBack(window.fromTs, now)));
  } else {
    params.set("start_timestamp", String(Math.floor(window.fromTs / 1000)));
    params.set("end_timestamp", String(Math.floor(window.toTs / 1000)));
    if (historical) params.set("historical", "true");
  }

  const get = opts.get ?? httpGet;
  const request = {
    source: "asknews",
    question,
    fromHour: floorHour(window.fromTs),
    toHour: floorHour(window.toTs ?? now),
    historical,
  };

  try {
    const { value } = await withCache<RawArticle[]>(
      { dir: opts.cacheDir, ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS },
      request,
      async () => {
        await pace("asknews", opts.minSpacingMs ?? MIN_SPACING_MS);
        const res = await get(
          `${BASE_URL}?${params.toString()}`,
          { Authorization: `Bearer ${key}` },
          opts.timeoutMs,
        );
        if (res.status !== 200) {
          throw new Error(`asknews answered ${res.status}`);
        }
        return readArticles(JSON.parse(res.body) as unknown);
      },
    );
    return value
      .map(toArticle)
      .filter((a): a is AskNewsArticle => a !== null)
      .sort((a, b) => b.ts - a.ts);
  } catch (err) {
    log(`asknews: news search failed, skipping it (${message(err)})`);
    return [];
  }
}

/** A body of the wrong shape is a failure, not an empty day: as_dicts null is the empty day. */
function readArticles(body: unknown): RawArticle[] {
  if (typeof body !== "object" || body === null) {
    throw new Error("asknews answered something that is not a news payload");
  }
  const dicts = (body as { as_dicts?: unknown }).as_dicts;
  if (dicts === null || dicts === undefined) return [];
  if (!Array.isArray(dicts)) {
    throw new Error("asknews answered an article list of the wrong shape");
  }
  return dicts as RawArticle[];
}

function hoursBack(fromTs: number, now: number): number {
  const hours = Math.ceil((now - fromTs) / HOUR_MS);
  if (!Number.isFinite(hours)) return 1;
  return Math.min(MAX_HOURS_BACK, Math.max(1, hours));
}

function floorHour(ts: number): number {
  return Math.floor(ts / HOUR_MS) * HOUR_MS;
}

function toArticle(raw: RawArticle): AskNewsArticle | null {
  const ts = Date.parse(raw.pub_date ?? "");
  const title = (raw.eng_title ?? raw.title ?? "").replace(/\s+/g, " ").trim();
  const url = (raw.article_url ?? "").trim();
  const id = (raw.article_id ?? "").trim() || url;
  if (!Number.isFinite(ts) || title === "" || id === "") return null;
  return { id, ts, title, summary: shortSummary(raw.summary), url, domain: domainOf(raw.domain_url) };
}

/** The prompt reads dozens of these, so a story gets a sentence or two, not a page. */
function shortSummary(value: string | undefined): string | null {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (text === "") return null;
  return text.length > MAX_SUMMARY_CHARS ? text.slice(0, MAX_SUMMARY_CHARS).trimEnd() : text;
}

function domainOf(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") return "";
  const host = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split("/")[0] ?? "";
  return host.toLowerCase();
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
