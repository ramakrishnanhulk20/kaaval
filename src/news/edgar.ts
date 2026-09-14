import { withCache } from "./cache.js";
import { httpGet, type HttpGet } from "./http.js";
import { pace } from "./pace.js";

const SEARCH_URL = "https://efts.sec.gov/LATEST/search-index";
const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

/** SEC's fair access note is about ten calls a second. A quarter second is far under it. */
const MIN_SPACING_MS = 250;

const DEFAULT_TTL_MS = 15 * 60 * 1000;

/** The ticker to CIK file changes when a company lists or delists, so a week is plenty. */
const TICKER_MAP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * SEC blocks requests without a descriptive User-Agent, so this is a hard requirement
 * and not a nicety. Set KAAVAL_USER_AGENT to a real contact address before a live run.
 */
const DEFAULT_USER_AGENT = "Kaaval research contact@example.com";

/**
 * Item 2.02 is "Results of Operations and Financial Condition", the code an earnings
 * release carries. It is spelled out because it is the one item that changes what a
 * brain should do tonight. Every other code is passed through as SEC publishes it.
 */
const ITEM_LABELS: Record<string, string> = {
  "2.02": "results of operations and financial condition",
};

export interface EdgarOptions {
  cacheDir: string;
  fromDate: string;
  toDate: string;
  ttlMs?: number;
  minSpacingMs?: number;
  /** How long one SEC request may take. Defaults to KAAVAL_HTTP_TIMEOUT_MS. */
  timeoutMs?: number;
  userAgent?: string;
  get?: HttpGet;
  log?: (line: string) => void;
}

export interface EdgarFiling {
  accession: string;
  cik: string;
  company: string;
  ticker: string;
  form: string;
  items: string[];
  fileDate: string;
  ts: number;
  headline: string;
  description: string | null;
  url: string;
}

interface SearchHit {
  _id?: string;
  _source?: {
    ciks?: string[];
    display_names?: string[];
    form?: string;
    items?: string[];
    file_date?: string;
    file_description?: string;
    adsh?: string;
  };
}

/**
 * Every 8-K this company filed between fromDate and toDate, newest first.
 *
 * The search is filtered by CIK rather than by keyword. A keyword search for "Tesla"
 * returned another issuer's press release on the first live call, and a search for the
 * ticker "TSLA" returned nothing at all, so the company's own number is the only filter
 * that answers the question we are asking. One 8-K submission puts several files in the
 * index (the filing itself, then each exhibit); they collapse to one filing here.
 *
 * Returns an empty list, never a throw, when the ticker is unknown to SEC or the call
 * fails, because a brain has to keep working when a feed is down. The timestamp is the
 * filing date at midnight UTC: EDGAR's search index publishes a date and no clock time.
 */
export async function fetchEdgar8k(ticker: string, opts: EdgarOptions): Promise<EdgarFiling[]> {
  const log = opts.log ?? (() => {});
  const get = opts.get ?? httpGet;
  const headers = { "User-Agent": opts.userAgent ?? process.env["KAAVAL_USER_AGENT"] ?? DEFAULT_USER_AGENT };

  let cik: string;
  try {
    const map = await tickerMap(opts, get, headers);
    const found = map[ticker.toUpperCase()];
    if (!found) {
      log(`edgar: SEC lists no company for ${ticker}, skipping its filings`);
      return [];
    }
    cik = found.cik;
  } catch (err) {
    log(`edgar: the ticker to CIK file failed, skipping filings (${message(err)})`);
    return [];
  }

  const params = new URLSearchParams({
    q: "",
    forms: "8-K",
    ciks: cik,
    startdt: opts.fromDate,
    enddt: opts.toDate,
  });
  const request = { source: "edgar", kind: "8-K", cik, from: opts.fromDate, to: opts.toDate };

  try {
    const { value } = await withCache<SearchHit[]>(
      { dir: opts.cacheDir, ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS },
      request,
      async () => {
        await pace("edgar", opts.minSpacingMs ?? MIN_SPACING_MS);
        const res = await get(`${SEARCH_URL}?${params.toString()}`, headers, opts.timeoutMs);
        if (res.status !== 200) {
          throw new Error(`edgar search answered ${res.status}`);
        }
        const body = JSON.parse(res.body) as { hits?: { hits?: SearchHit[] } };
        return body.hits?.hits ?? [];
      },
    );
    return collapse(value, ticker.toUpperCase(), cik);
  } catch (err) {
    log(`edgar: the 8-K search for ${ticker} failed, skipping it (${message(err)})`);
    return [];
  }
}

interface TickerEntry {
  cik: string;
  title: string;
}

async function tickerMap(
  opts: EdgarOptions,
  get: HttpGet,
  headers: Record<string, string>,
): Promise<Record<string, TickerEntry>> {
  const { value } = await withCache<Record<string, TickerEntry>>(
    { dir: opts.cacheDir, ttlMs: TICKER_MAP_TTL_MS },
    { source: "edgar", kind: "company-tickers" },
    async () => {
      await pace("edgar", opts.minSpacingMs ?? MIN_SPACING_MS);
      const res = await get(TICKERS_URL, headers, opts.timeoutMs);
      if (res.status !== 200) {
        throw new Error(`sec company_tickers answered ${res.status}`);
      }
      const raw = JSON.parse(res.body) as Record<
        string,
        { cik_str?: number | string; ticker?: string; title?: string }
      >;
      const map: Record<string, TickerEntry> = {};
      for (const row of Object.values(raw)) {
        if (!row?.ticker || row.cik_str === undefined) continue;
        map[String(row.ticker).toUpperCase()] = {
          cik: String(row.cik_str).padStart(10, "0"),
          title: String(row.title ?? row.ticker),
        };
      }
      return map;
    },
  );
  return value;
}

function collapse(hits: SearchHit[], ticker: string, cik: string): EdgarFiling[] {
  const byAccession = new Map<string, EdgarFiling>();

  for (const hit of hits) {
    const src = hit._source;
    if (!src || !src.file_date) continue;
    if (src.ciks && src.ciks.length > 0 && !src.ciks.includes(cik)) continue;

    const id = hit._id ?? "";
    const [accessionFromId, filename] = id.split(":");
    const accession = src.adsh ?? accessionFromId ?? "";
    if (!accession || byAccession.has(accession)) continue;

    const company = companyName(src.display_names?.[0] ?? ticker);
    const items = src.items ?? [];
    const description = src.file_description && src.file_description !== "8-K" ? src.file_description : null;

    byAccession.set(accession, {
      accession,
      cik,
      company,
      ticker,
      form: src.form ?? "8-K",
      items,
      fileDate: src.file_date,
      ts: Date.parse(`${src.file_date}T00:00:00Z`),
      headline: headlineFor(company, items),
      description,
      url: filingUrl(cik, accession, filename),
    });
  }

  return [...byAccession.values()].sort((a, b) => b.ts - a.ts);
}

/** "NVIDIA CORP  (NVDA)  (CIK 0001045810)" is how EDGAR spells a company in a hit. */
function companyName(displayName: string): string {
  const cut = displayName.indexOf("  (");
  return (cut > 0 ? displayName.slice(0, cut) : displayName).trim();
}

function headlineFor(company: string, items: string[]): string {
  if (items.length === 0) return `${company} filed an 8-K with the SEC`;
  const named = items.map((code) => ITEM_LABELS[code] ?? `item ${code}`);
  return `${company} filed an 8-K with the SEC covering ${named.join(", ")}`;
}

function filingUrl(cik: string, accession: string, filename: string | undefined): string {
  const folder = accession.replace(/-/g, "");
  const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${folder}`;
  return filename ? `${base}/${filename}` : `${base}/${accession}-index.htm`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
