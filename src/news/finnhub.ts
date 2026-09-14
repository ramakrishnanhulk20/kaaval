import { withCache } from "./cache.js";
import { httpGet, type HttpGet } from "./http.js";
import { pace } from "./pace.js";

const BASE_URL = "https://finnhub.io/api/v1";

/** The free key is quoted at 60 calls a minute, so one call a second leaves headroom. */
const MIN_SPACING_MS = 1_100;

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export interface FinnhubOptions {
  cacheDir: string;
  ttlMs?: number;
  minSpacingMs?: number;
  /** How long one Finnhub request may take. Defaults to KAAVAL_HTTP_TIMEOUT_MS. */
  timeoutMs?: number;
  apiKey?: string;
  get?: HttpGet;
  log?: (line: string) => void;
}

/** Fields from the company-news sample response in reference/news/source-finnhub.md. */
export interface FinnhubNewsRow {
  id?: number;
  datetime?: number;
  headline?: string;
  summary?: string;
  url?: string;
  source?: string;
  related?: string;
  category?: string;
}

/** Fields from the calendar/earnings sample response in the same file. */
export interface FinnhubEarningsRow {
  date?: string;
  hour?: string;
  symbol?: string;
  quarter?: number;
  year?: number;
  epsEstimate?: number | null;
  revenueEstimate?: number | null;
}

/** Fields from the calendar/economic sample response in the same file. */
export interface FinnhubEconomicRow {
  time?: string;
  country?: string;
  event?: string;
  impact?: string;
  estimate?: number | null;
  actual?: number | null;
}

/**
 * One read from Finnhub, cached on disk and paced.
 *
 * Returns null rather than throwing whenever the answer cannot be used: no API key, a
 * refusal, a non-JSON body. Finnhub is the only keyed source in the feed and Kaaval has
 * to keep trading without it, so a missing key is a normal state and not an error. The
 * key is added to the URL at call time only: it is never part of the cache key, so it
 * cannot end up in a filename or in a cache file on disk.
 */
export async function fetchFinnhub<T>(
  path: string,
  params: Record<string, string>,
  opts: FinnhubOptions,
): Promise<T | null> {
  const key = opts.apiKey ?? process.env["FINNHUB_API_KEY"] ?? "";
  const log = opts.log ?? (() => {});
  if (!key) {
    log(`finnhub: FINNHUB_API_KEY is not set, skipping ${path}`);
    return null;
  }

  const get = opts.get ?? httpGet;
  const request = { source: "finnhub", path, params };

  try {
    const { value } = await withCache<T | null>(
      { dir: opts.cacheDir, ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS },
      request,
      async () => {
        await pace("finnhub", opts.minSpacingMs ?? MIN_SPACING_MS);
        const query = new URLSearchParams({ ...params, token: key });
        const res = await get(`${BASE_URL}${path}?${query.toString()}`, {}, opts.timeoutMs);
        if (res.status !== 200) {
          throw new Error(`finnhub ${path} answered ${res.status}`);
        }
        return JSON.parse(res.body) as T;
      },
    );
    return value;
  } catch (err) {
    log(`finnhub: ${path} failed, skipping it (${message(err)})`);
    return null;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
